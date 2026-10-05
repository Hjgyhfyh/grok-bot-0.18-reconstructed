import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSandProfilePath, writeSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "../../agents/settings-file.js";
import { SandAgentDb, ensureAgentDbDirectory } from "./agent-db.js";
import { getAgentDbPath, listAgentDirectoryIds, STORE_FILENAME } from "./session-paths.js";
import { buildSummary, readDbExtras } from "./session-summaries.js";
import { automationStoreForDbPath, channelStoreForDbPath, workflowStoreForDbPath } from "./session-store-factories.js";
import type { AgentWorkerPool } from "../../agent-isolation/agent-worker-pool.js";

export const MAX_AGENTS_PER_USER = 50;
export const DEFAULT_AGENT_AUTOMATIONS: readonly unknown[] = [];
export class SandAgentMissingError extends Error { constructor(agentId: string) { super(`Sand agent ${agentId} does not exist`); this.name = "SandAgentMissingError"; } }
export class SandAgentLimitError extends Error { constructor() { super(`Agent limit of ${MAX_AGENTS_PER_USER} reached`); this.name = "SandAgentLimitError"; } }

export interface WorkerPool { closeAll(): Promise<void> }
export interface MaterializedSession {
  id: string;
  dbPath: string;
  db: SandAgentDb;
  agentStore: { resetFromDb?(ctx: unknown): Promise<void>; getFullConversation(ctx: unknown): Promise<unknown>; dispose(): Promise<void> };
  memory: unknown;
  automations: ReturnType<typeof automationStoreForDbPath>;
  workflows: ReturnType<typeof workflowStoreForDbPath>;
  channels: ReturnType<typeof channelStoreForDbPath>;
}
export interface MaterializationHost {
  ctx: unknown;
  rootDir: string;
  createBlobWorkerPool(): AgentWorkerPool;
  createAgentStore(args: { pool: AgentWorkerPool; agentId: string; dbPath: string; db: SandAgentDb }): MaterializedSession["agentStore"];
  createMemoryStore(agentDir: string): unknown;
  resolveUserTimeZone(): string | undefined;
  agentExists(agentId: string): boolean;
  getAgentDir(agentId: string): string;
  readActiveAgentId(): string | null;
  isVisibleAgent?(agentId: string): Promise<boolean>;
  /** True while the host still holds the agent: an open session or a delete in flight. */
  isAgentInUse?(agentId: string): boolean;
  /** True when the memory extension has content stored for the agent directory. */
  hasMemory?(agentDir: string): boolean;
  runMaintenance?(session: MaterializedSession): Promise<void>;
  report?(event: Record<string, unknown>): void;
}

export class SandSessionMaterialization {
  private workerPool: AgentWorkerPool | null = null;
  private mintChain = Promise.resolve();
  constructor(readonly host: MaterializationHost) {}

  requireWorkerPool(): AgentWorkerPool { this.workerPool ??= this.host.createBlobWorkerPool(); return this.workerPool; }
  async closeWorkerPool(): Promise<void> { const pool = this.workerPool; if (pool == null) return; this.workerPool = null; await pool.closeAll(); }
  async listAgentRecordIds(): Promise<string[]> { return listAgentDirectoryIds(this.host.rootDir); }
  async countOwnedAgents(): Promise<number> { return (await this.listAgentRecordIds()).length; }
  enqueueMint<T>(run: () => Promise<T>): Promise<T> { const next = this.mintChain.then(run, run); this.mintChain = next.then(() => {}, () => {}); return next; }

  async mintAgent<T>(mint: (agentId: string) => Promise<T>): Promise<T> {
    return this.enqueueMint(async () => { if (await this.isAgentCapReached()) throw new SandAgentLimitError(); return this.runMint(randomUUID(), mint); });
  }
  private async runMint<T>(agentId: string, mint: (agentId: string) => Promise<T>): Promise<T> {
    try { return await mint(agentId); }
    catch (error) { try { await rm(this.host.getAgentDir(agentId), { recursive: true, force: true }); } catch (cleanupError) { this.host.report?.({ family: "materialize", kind: "mint_cleanup_failed", agentId, errorClass: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError }); } throw error; }
  }
  async createSession(profile?: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<MaterializedSession> { return this.mintAgent((agentId) => this.materializeSession(agentId, profile, origin, purpose)); }
  async createFallbackSession(open: (agentId: string) => Promise<MaterializedSession>): Promise<MaterializedSession> {
    return this.enqueueMint(async () => {
      if (await this.isAgentCapReached()) {
        for (const agentId of await this.listAgentRecordIds()) { try { return await open(agentId); } catch (error) { this.host.report?.({ family: "materialize", kind: "fallback_adopt_failed", agentId, errorClass: error instanceof Error ? error.name : typeof error }); } }
        throw new SandAgentLimitError();
      }
      return this.runMint(randomUUID(), (agentId) => this.materializeSession(agentId, undefined, "user"));
    });
  }
  private compose(agentId: string, dbPath: string, db: SandAgentDb): MaterializedSession {
    return { id: agentId, dbPath, db, agentStore: this.host.createAgentStore({ pool: this.requireWorkerPool(), agentId, dbPath, db }), memory: this.host.createMemoryStore(dirname(dbPath)), automations: automationStoreForDbPath(dbPath, this.host.resolveUserTimeZone), workflows: workflowStoreForDbPath(dbPath, this.host.resolveUserTimeZone), channels: channelStoreForDbPath(dbPath) };
  }
  /**
   * Mints the directory that holds the agent, and is the only place that does.
   *
   * `SandAgentDb` no longer creates one as a side effect of being opened: a late
   * read of a deleted agent's `store.db` used to run `mkdirSync` and hand back a
   * fresh empty database inside a brand new directory, which then held a slot of
   * the fifty-agent cap that `listAgents` never showed. Creating became an
   * explicit act, and the line that performs it lived in a wrapper subclass in
   * `production.ts` instead of here, so this class -- the one every host builds to
   * mint an agent -- threw `SandAgentDirectoryMissingError` and minted nothing.
   * Minting is the one operation that means "this agent now exists", so it is the
   * one that creates the directory. `openSession`, the reclaim passes and the
   * cap check never call this method and never create anything.
   */
  async materializeSession(agentId: string, profile?: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<MaterializedSession> {
    const dbPath = getAgentDbPath(this.host.rootDir, agentId);
    ensureAgentDbDirectory(dbPath);
    const db = new SandAgentDb(dbPath);
    try {
      db.set("agentId", agentId); db.setAgentOrigin(origin); if (purpose != null) db.setAgentPurpose(purpose);
      writeSandProfileFile(getSandProfilePath(dirname(dbPath)), { name: profile?.name?.trim() || "Grok", description: profile?.description?.trim() ?? "", title: profile?.title?.trim() ?? "", avatarShape: profile?.avatarShape?.trim() ?? "", avatarColor: profile?.avatarColor?.trim() ?? "" });
      writeSandSettingsFile(getSandSettingsPath(dirname(dbPath)), { notifyOnAgentUpdates: true });
      const session = this.compose(agentId, dbPath, db);
      for (const spec of DEFAULT_AGENT_AUTOMATIONS) session.automations.upsert(spec as never);
      return session;
    } catch (error) { db.close(); throw error; }
  }
  async openSession(agentId: string): Promise<MaterializedSession> {
    if (!this.host.agentExists(agentId)) throw new SandAgentMissingError(agentId);
    const dbPath = getAgentDbPath(this.host.rootDir, agentId), db = new SandAgentDb(dbPath);
    try {
      const profilePath = getSandProfilePath(dirname(dbPath));
      try { await stat(profilePath); } catch { writeSandProfileFile(profilePath, { name: db.get("name") || "Grok", description: db.getSandProfile().description, title: "", avatarShape: "", avatarColor: "" }); }
      const session = this.compose(agentId, dbPath, db);
      await session.agentStore.resetFromDb?.(this.host.ctx);
      await this.host.runMaintenance?.(session);
      return session;
    } catch (error) { db.close(); throw error; }
  }
  async isAgentCapReached(): Promise<boolean> { if (await this.countOwnedAgents() < MAX_AGENTS_PER_USER) return false; await this.reclaimPrunedPlaceholders(); return await this.countOwnedAgents() >= MAX_AGENTS_PER_USER; }
  /**
   * Decides whether a directory on disk is a placeholder. Both branches used to
   * answer "it is not": a directory with no `store.db` returned `false` on the
   * first branch, and a directory with one returned `false` on the second as
   * well, because `isVisibleAgent` asks `summarizeAgentById`, which summarizes
   * with `includeBlank: true` and therefore returns a record for an empty agent.
   * The reclaim pass could not remove anything, so every directory the roster
   * does not show kept a cap slot for good and `POST /api/createAgent` answered
   * `409 Agent limit of 50 reached` with the cap full of agents nobody could see
   * and nobody could delete.
   *
   * The question is now the one the roster actually answers: would `listAgents`
   * show this directory? An agent with a transcript, a name, a description, a
   * title, a durable footprint, or a session the host still holds is live.
   * Everything else on disk is garbage.
   */
  async isPrunedPlaceholder(agentId: string): Promise<boolean> {
    if (agentId === this.host.readActiveAgentId()) return false;
    if (this.host.isAgentInUse?.(agentId)) return false;
    // The path is joined by hand: a directory whose name is not a valid agent id
    // must turn into a reclaim, never into a thrown `SandInvalidAgentIdError`.
    const dbPath = join(this.host.rootDir, agentId, STORE_FILENAME);
    if (!existsSync(dbPath)) return true;
    let db: SandAgentDb;
    try { db = new SandAgentDb(dbPath, { recoverOnCorruption: false }); }
    catch { return true; }
    try {
      const stats = await stat(dbPath).catch(() => undefined);
      if (stats == null) return true;
      const dbStats = { mtimeMs: Number(stats.mtimeMs) };
      return await buildSummary({
        extras: readDbExtras(db, agentId, dbStats),
        dbPath,
        dirName: agentId,
        dbStats,
        includeBlank: false,
        agentHasMemory: agentDir => this.host.hasMemory?.(agentDir) === true,
      }) == null;
    } finally { db.close(); }
  }
  async reclaimPrunedPlaceholders(): Promise<void> { for (const agentId of await this.listAgentRecordIds()) { if (!await this.isPrunedPlaceholder(agentId)) continue; try { await rm(this.host.getAgentDir(agentId), { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); } catch (error) { this.host.report?.({ family: "materialize", kind: "placeholder_reclaim_failed", agentId, errorClass: error instanceof Error ? error.name : typeof error }); } } }
}
