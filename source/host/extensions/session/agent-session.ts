import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorLogTag } from "../../../shared/errors.js";
import { SandAgentNotFoundError } from "./agent-errors.js";
import { removeTranscriptJournals as removeConversationTranscriptJournals } from "./agent-transcript-journal.js";
import { getSandProfilePath, readSandProfileFile, writeSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "../../agents/settings-file.js";
import { AUTOMATION_UI_LIMIT } from "../../automations/automation.js";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { deleteSandAgentDbWriteGeneration, getSandAgentDbWriteGeneration } from "../../storage/store-db.js";
import { limitSurfacedWorkflows, type WorkflowSpec } from "../../../shared/workflow-model.js";
import { SandAgentDb, type AwaitingUserResponse, type TranscriptEntry } from "./agent-db.js";
import { recoverAgentWithMissingDb, setAgentAvatarBytes } from "./session-mutations.js";
import { getAgentAvatar, getAgentAvatarPng, getAgentProfileText, updateAgentProfile } from "./session-profile-files.js";
import { listAgents, summarizeAgentById } from "./session-roster.js";
import { buildSummary, loadAgentDbExtras, type DbExtras } from "./session-summaries.js";
import { SandConnectorSecretStore } from "./connector-secret-store.js";
import { ensureConversationCapacityForTurn } from "./conversation-size-limits.js";
import { expirePendingAutoReviewApprovalEntries, expirePendingLocalToolPermissionAskEntries } from "./pending-card-sweeps.js";
import { ACTIVE_AGENT_FILENAME, CONVERSATION_BLOBS_FILENAME, getAgentDbPath, getConnectorSecretsRoot, listAgentDirectoryIds, STORE_FILENAME, statIfExists } from "./session-paths.js";
import { automationStoreForDbPath, channelStoreForDbPath, NO_SESSION_MEMORY, workflowStoreForDbPath } from "./session-store-factories.js";
import { publishTranscriptMutation } from "../../transcript-mutation-events.js";
import { reportSessionDiagnostic } from "./session-diagnostics.js";

/**
 * Retry budget for one `rm` of an agent directory. `node:fs/promises.rm`
 * retries the child that failed with `EBUSY`/`EPERM` for the whole budget, so
 * one call both waits for a holder in another thread to let go and then deletes
 * in one step (measured on this machine: a handle released 100 ms into an `rm`
 * finished the unlink at 153 ms). `maxRetries: 6, retryDelay: 50` was measured
 * at 8.4 s before giving up, which is far too long to hold a delete open; these
 * values were measured at 3.4 s, which is several orders above a worker hand-off
 * and short enough that a delete which cannot succeed says so promptly.
 */
const AGENT_DIR_RM_RETRIES = 6;
const AGENT_DIR_RM_RETRY_DELAY_MS = 20;

export interface OpenAgentSession {
  id: string;
  dbPath: string;
  db: SandAgentDb;
  agentStore: { getFullConversation?(ctx: unknown): Promise<unknown>; dispose(): Promise<void> };
}
export interface SessionMemoryProvider {
  agentHasContent(agentDir: string): boolean;
  createAgentStore?(agentDir: string): unknown;
}
export interface MaterializationPort {
  closeWorkerPool?(): Promise<void>;
  listAgentRecordIds?(): Promise<string[]>;
  countOwnedAgents?(): Promise<number>;
  mintAgent?(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession>;
  createSession?(profile: Partial<SandAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession>;
  createFallbackSession?(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession>;
  openSession?(agentId: string): Promise<OpenAgentSession>;
  requireWorkerPool?(): { collectConversationGarbage(args: Record<string, unknown>): Promise<unknown> };
  isAgentCapReached?(): Promise<boolean>;
}
export interface ConversationStatePort {
  getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]>;
  getSessionOutline(session: OpenAgentSession): Promise<unknown>;
  getAgentOutline(agentId: string): Promise<unknown>;
  getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]>;
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[];
  readAgentTranscriptPage(agentId: string, query: { beforeSeq?: number; sinceMs?: number; untilMs?: number; limit?: number }): ReturnType<SandAgentDb["getTranscriptPage"]>;
  readAgentTranscriptWindow(agentId: string, query: { beforeSeq?: number; limit?: number }): ReturnType<SandAgentDb["getTranscriptWindow"]>;
  readAgentTranscriptTail(agentId: string, query: { beforeSeq?: number; limit?: number }): ReturnType<SandAgentDb["getTranscriptTail"]>;
  readAgentThread(agentId: string, rootId: string): ReturnType<SandAgentDb["getThread"]>;
}
export interface AgentSessionStoreOptions {
  materialization?: MaterializationPort;
  createMaterialization?(store: SandAgentSessionStore): MaterializationPort;
  conversationState?: ConversationStatePort;
  createConversationState?(store: SandAgentSessionStore): ConversationStatePort;
  onAgentRemoved?(agentId: string): void;
}

export function resolveProfileName(trimmedName: string, current?: { name?: string } | null): string { if (trimmedName) return trimmedName; if (current?.name?.trim()) return current.name; return "Grok"; }

export class SandAgentSessionStore {
  private memory: SessionMemoryProvider = NO_SESSION_MEMORY;
  private isAgentBeingDeleted: (id: string) => boolean = () => false;
  private resolveUserTimeZone: () => string | undefined;
  private readonly extrasCache = new Map<string, { key: string; extras: DbExtras }>();
  private readonly openSessions = new Map<string, OpenAgentSession>();
  readonly connectorSecrets: SandConnectorSecretStore;
  readonly materialization: MaterializationPort | undefined;
  readonly conversationState: ConversationStatePort | undefined;

  constructor(readonly rootDir = getSandAgentsRootDir(), resolveUserTimeZone: () => string | undefined = () => undefined, readonly options: AgentSessionStoreOptions = {}) {
    this.resolveUserTimeZone = resolveUserTimeZone;
    this.connectorSecrets = new SandConnectorSecretStore(getConnectorSecretsRoot(rootDir));
    this.materialization = options.materialization ?? options.createMaterialization?.(this);
    this.conversationState = options.conversationState ?? options.createConversationState?.(this);
  }
  getRootDir(): string { return this.rootDir; }
  setMemory(memory: SessionMemoryProvider): void { this.memory = memory; }
  createMemoryStore(agentDir: string): unknown { return this.memory.createAgentStore?.(agentDir) ?? NO_SESSION_MEMORY.createAgentStore(); }
  setBeingDeletedPredicate(predicate: (id: string) => boolean): void { this.isAgentBeingDeleted = predicate; }
  setUserTimeZoneResolver(resolve: () => string | undefined): void { this.resolveUserTimeZone = resolve; }
  getUserTimeZone(): string | undefined { return this.resolveUserTimeZone(); }
  async closeWorkerPool(): Promise<void> { await this.materialization?.closeWorkerPool?.(); }
  async listAgentRecordIds(): Promise<string[]> { return this.materialization?.listAgentRecordIds?.() ?? this.listAgentIds(); }
  async countOwnedAgents(): Promise<number> { return this.materialization?.countOwnedAgents?.() ?? (await this.listAgentIds()).length; }

  getAgentDir(agentId: string): string { return join(this.rootDir, agentId); }
  agentExists(agentId: string): boolean { return existsSync(getAgentDbPath(this.rootDir, agentId)); }
  agentDirExists(agentId: string): boolean { return existsSync(this.getAgentDir(agentId)); }
  writeAgentProfileFile(agentId: string, profile: Partial<SandAgentProfile> & { name: string; description: string }): void {
    const path = getSandProfilePath(this.getAgentDir(agentId)), current = readSandProfileFile(path), name = resolveProfileName(profile.name.trim(), current);
    writeSandProfileFile(path, { name, description: profile.description.trim(), title: profile.title?.trim() ?? current?.title ?? "", avatarShape: profile.avatarShape?.trim() ?? current?.avatarShape ?? "", avatarColor: profile.avatarColor?.trim() ?? current?.avatarColor ?? "" });
  }
  async withAgentDb<T>(agentId: string, fn: (db: SandAgentDb, dbPath: string) => T | Promise<T>): Promise<T> { const dbPath = getAgentDbPath(this.rootDir, agentId), db = new SandAgentDb(dbPath); try { return await fn(db, dbPath); } finally { db.close(); } }

  private async createLocalSession(profile: Partial<SandAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession> {
    let id = randomUUID(); while (this.agentDirExists(id)) id = randomUUID();
    mkdirSync(this.getAgentDir(id), { recursive: true });
    this.writeAgentProfileFile(id, { name: profile.name ?? "Grok", description: profile.description ?? "", ...(profile.title == null ? {} : { title: profile.title }), ...(profile.avatarShape == null ? {} : { avatarShape: profile.avatarShape }), ...(profile.avatarColor == null ? {} : { avatarColor: profile.avatarColor }) });
    const dbPath = getAgentDbPath(this.rootDir, id), db = new SandAgentDb(dbPath); db.set("agentId", id); db.setAgentOrigin(origin); if (purpose != null) db.setAgentPurpose(purpose); db.setIntroductionPending(true);
    return { id, dbPath, db, agentStore: { dispose: async () => {} } };
  }
  async createSession(profile: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<OpenAgentSession> { await this.reclaimDanglingAgentDirs(); return this.track(this.materialization?.createSession != null ? this.materialization.createSession(profile, origin, purpose) : this.createLocalSession(profile, origin, purpose)); }
  async mintAgent(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> { await this.reclaimDanglingAgentDirs(); if (this.materialization?.mintAgent != null) return this.track(this.materialization.mintAgent(mint)); let id = randomUUID(); while (this.agentDirExists(id)) id = randomUUID(); return this.track(mint(id)); }
  async createFallbackSession(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> { await this.reclaimDanglingAgentDirs(); if (this.materialization?.createFallbackSession != null) return this.track(this.materialization.createFallbackSession(open)); const [agentId] = await this.listAgentIds(); if (agentId == null) throw new Error("No fallback session is available"); return this.track(open(agentId)); }
  async openSession(agentId: string): Promise<OpenAgentSession> { if (this.materialization?.openSession != null) return this.track(this.materialization.openSession(agentId)); if (!this.agentExists(agentId)) throw new SandAgentNotFoundError(`Agent missing: ${agentId}`); const dbPath = getAgentDbPath(this.rootDir, agentId); return this.track(Promise.resolve({ id: agentId, dbPath, db: new SandAgentDb(dbPath), agentStore: { dispose: async () => {} } })); }
  private track<T extends { id: string }>(opening: Promise<T>): Promise<T> { return opening.then((opened) => { this.openSessions.set(opened.id, opened as unknown as OpenAgentSession); return opened; }); }

  /**
   * Releases every handle this store still holds for one agent: the agent store
   * and the `node:sqlite` connection to `store.db`. Windows refuses to unlink an
   * open file, so a caller that deleted the directory first could never remove
   * `store.db` and the agent stayed on disk forever. Handles are released here,
   * before the unlink, because after the unlink the path is gone and there is
   * nothing left to close.
   */
  async releaseSession(agentId: string): Promise<void> {
    const session = this.openSessions.get(agentId);
    this.openSessions.delete(agentId);
    if (session == null) return;
    try { await session.agentStore.dispose(); }
    catch (error) { reportSessionDiagnostic({ family: "store_db", kind: "agent_store_dispose_failed", agentId, errorClass: errorLogTag(error) }); }
    try { session.db.close(); }
    catch (error) { reportSessionDiagnostic({ family: "store_db", kind: "store_db_close_failed", agentId, errorClass: errorLogTag(error) }); }
  }
  /**
   * Terminates the blob worker that owns `conversation-blobs.db`. The worker pool
   * is shared by every agent and is swept only after a five-minute idle timeout,
   * so without this call the second `node:sqlite` handle in the agent directory
   * outlives the delete request and `rm` fails with `EBUSY` on Windows.
   */
  private async releaseBlobWorker(agentId: string): Promise<void> {
    const pool = this.materialization?.requireWorkerPool?.() as unknown as { connections?: Map<string, { close(): Promise<void> }> } | undefined;
    const connections = pool?.connections;
    if (connections == null) return;
    const connection = connections.get(join(this.getAgentDir(agentId), CONVERSATION_BLOBS_FILENAME));
    if (connection == null) return;
    connections.delete(join(this.getAgentDir(agentId), CONVERSATION_BLOBS_FILENAME));
    try { await connection.close(); }
    catch (error) { reportSessionDiagnostic({ family: "store_db", kind: "blob_worker_close_failed", agentId, errorClass: errorLogTag(error) }); }
  }
  /**
   * Removes the transcript journals of the conversations this agent owns.
   *
   * The agent's own journal is one directory. Its subagents each own one too,
   * under `agent-transcripts/subagent-<uuid>/`, because the mirror names a
   * journal directory after the conversation id and a subagent conversation id
   * is not an agent id. Nothing else in the host ever removed those, so every
   * deleted agent left one directory per subagent it had ever run, and the
   * journal count on a long-lived box grew for good. They are removed by name,
   * from the ids the caller captured while the runner still knew them, and never
   * by sweeping the transcript directory: a subagent conversation has no agent
   * directory of its own, so a sweep cannot tell a dead subagent's journal from
   * a live agent's, and it would eat the journals of agents that are alive.
   *
   * A journal that survives — a live session still holding a file in it — is
   * returned to the caller instead of being reported to a log nobody reads and
   * forgotten. That is the difference between "the transcript went with the
   * agent" and "the transcript went, except the part that stayed".
   */
  private async removeTranscriptJournals(agentId: string, subagentIds: readonly string[]): Promise<string[]> {
    const outcome = await removeConversationTranscriptJournals({ agentsRootDir: this.rootDir, conversationIds: [agentId, ...subagentIds] });
    for (const refusal of outcome.refused) reportSessionDiagnostic({ family: "store_db", kind: "transcript_journal_id_refused", agentId: refusal.conversationId, errorClass: refusal.reason });
    for (const conversationId of outcome.leftovers) reportSessionDiagnostic({ family: "store_db", kind: "transcript_journal_remove_failed", agentId: conversationId, errorClass: "journal_directory_still_present" });
    return outcome.leftovers;
  }
  /**
   * Releases `store.db` in every holder that is not this store, then unlinks the
   * agent directory and proves it is gone.
   *
   * Measured on a live box carrying fifty agents: forty-eight of the fifty
   * `store.db` files were held open by the host process, and the set of held ids
   * was exactly the set of rows in `search-index.db`. The holder is
   * `SandSearchIndexWriter.storeConnections`
   * (`extensions/content-search/search-index-writer.ts:23`): `reconcile()` opens
   * `store.db` read-only for every agent directory and caches the connection
   * until a `clear-agent` job evicts it. `node:sqlite` opens its file without
   * `FILE_SHARE_DELETE`, so `DeleteFile` on `store.db` fails and `rm` leaves
   * exactly `store.db`, `store.db-wal` and `store.db-shm` behind. Renaming the
   * directory aside does not help: `MoveFileEx` on a directory whose subtree
   * holds such a handle fails with the same `EPERM`, measured. The only way to
   * free the slot is to release the handle first.
   *
   * The release signal for that holder is the `agent-removed` transcript
   * mutation: the content-search extension subscribes to it and forwards it as a
   * `clear-agent` index job. The mutation used to be published after the unlink,
   * so the handle the worker was about to close was still open while `rm` ran
   * and every delete of every agent failed. It is published before the first
   * attempt now.
   *
   * The release itself crosses into another thread, so the unlink has to wait
   * for it. It does: one `rm` retries the failing child for its whole budget and
   * finishes by itself once the handle is gone mid-call (measured - a handle
   * released 100 ms into an `rm` produced a finished unlink at 153 ms). A
   * directory that is still there after both passes is a failure, and the caller
   * is told which files are left instead of being handed a success.
   */
  private async removeAgentDirOrFail(agentId: string): Promise<void> {
    const dir = this.getAgentDir(agentId);
    let failure: unknown;
    publishTranscriptMutation({ kind: "agent-removed", agentId });
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.releaseSession(agentId);
      await this.releaseBlobWorker(agentId);
      try { await rm(dir, { recursive: true, force: true, maxRetries: AGENT_DIR_RM_RETRIES, retryDelay: AGENT_DIR_RM_RETRY_DELAY_MS }); }
      catch (error) {
        failure = error;
        reportSessionDiagnostic({ family: "store_db", kind: "agent_dir_remove_failed", agentId, errorClass: errorLogTag(error) });
      }
      if (!existsSync(dir)) return;
    }
    const leftovers = await readdir(dir).catch(() => [] as string[]);
    const error = new Error(
      `Agent ${agentId} was not deleted: this app still holds ${leftovers.join(", ") || "the agent directory"}. Its slot stays taken. Quit the app, delete the folder ${dir}, then start it again.`,
      failure === undefined ? undefined : { cause: failure },
    );
    Object.assign(error, { code: "SandAgentDeleteIncompleteError", agentId, leftovers });
    throw error;
  }
  async deleteSession(agentId: string, options: { subagentIds?: readonly string[] } = {}): Promise<{ transcriptLeftovers: string[] }> { const dbPath = getAgentDbPath(this.rootDir, agentId); this.extrasCache.delete(agentId); await this.removeAgentDirOrFail(agentId); deleteSandAgentDbWriteGeneration(dbPath); const transcriptLeftovers = await this.removeTranscriptJournals(agentId, options.subagentIds ?? []); this.options.onAgentRemoved?.(agentId); return { transcriptLeftovers }; }

  activeAgentPointerPath(): string { return join(this.rootDir, ACTIVE_AGENT_FILENAME); }
  readActiveAgentId(): string | null { try { const parsed = JSON.parse(readFileSync(this.activeAgentPointerPath(), "utf8")) as { activeAgentId?: unknown }; const id = parsed.activeAgentId; return typeof id === "string" && id.length > 0 ? id : null; } catch { return null; } }
  writeActiveAgentId(agentId: string): void { try { mkdirSync(this.rootDir, { recursive: true }); const path = this.activeAgentPointerPath(), temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify({ activeAgentId: agentId })); renameSync(temp, path); } catch {} }

  async updateAgentProfile(agentId: string, profile: Partial<SandAgentProfile> & { name: string; description: string }): Promise<Record<string, unknown> | null> { return updateAgentProfile(this.profileFilesHost(), agentId, profile); }
  getAgentProfileText(agentId: string): SandAgentProfile | null { return getAgentProfileText(this, agentId); }
  getAgentAvatar(agentId: string) { return getAgentAvatar(this, agentId); }
  getAgentAvatarPng(agentId: string) { return getAgentAvatarPng(this, agentId); }
  async setAgentAvatarBytes(db: SandAgentDb, dbPath: string, agentId: string, pngBytes: Uint8Array | null, activeAgentId?: string) { return setAgentAvatarBytes({ memory: this.memory }, db, dbPath, agentId, pngBytes, activeAgentId); }
  async setAgentAvatarBytesById(agentId: string, pngBytes: Uint8Array | null) { return this.withAgentDb(agentId, (db, dbPath) => this.setAgentAvatarBytes(db, dbPath, agentId, pngBytes, undefined)); }
  async summarizeOpenSession(session: OpenAgentSession): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath);
    if (this.isAgentBeingDeleted(session.id)) return null;
    return await buildSummary({
      extras: loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      activeAgentId: session.id,
      includeBlank: true,
      agentHasMemory: candidate => this.memory.agentHasContent(candidate),
    });
  }
  async summarizeSession(session: OpenAgentSession, activeAgentId?: string): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath);
    if (this.isAgentBeingDeleted(session.id)) return null;
    const extras = dbStats == null
      ? loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats)
      : await this.loadCachedExtras({
          dirName: session.id,
          dbPath: session.dbPath,
          dbStats,
          readExtras: () => loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
        });
    if (this.isAgentBeingDeleted(session.id)) return null;
    return await buildSummary({
      extras,
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      includeBlank: true,
      agentHasMemory: candidate => this.memory.agentHasContent(candidate),
    });
  }
  private async loadCachedExtras(args: { dirName: string; dbPath: string; dbStats: { size: number; mtimeMs: number }; readExtras?: () => DbExtras | null }): Promise<DbExtras | null> {
    const walStats = await statIfExists(`${args.dbPath}-wal`);
    const generation = getSandAgentDbWriteGeneration(args.dbPath);
    const key = `${generation}:${args.dbStats.size}:${args.dbStats.mtimeMs}:${walStats?.size ?? -1}:${walStats?.mtimeMs ?? -1}`;
    const cached = this.extrasCache.get(args.dirName);
    if (cached?.key === key && existsSync(getSandProfilePath(join(this.rootDir, args.dirName)))) return cached.extras;
    if (this.isAgentBeingDeleted(args.dirName)) return null;
    const extras = args.readExtras?.() ?? this.readExtrasFromDisk(args.dbPath, args.dirName, args.dbStats);
    if (extras != null) this.extrasCache.set(args.dirName, { key, extras });
    return extras;
  }
  private readExtrasFromDisk(dbPath: string, dirName: string, dbStats: { size: number; mtimeMs: number }): DbExtras | null {
    let db: SandAgentDb;
    try { db = new SandAgentDb(dbPath, { recoverOnCorruption: false }); }
    catch (error) {
      reportSessionDiagnostic({ family: "store_db", kind: "unreadable", agentId: dirName, errorClass: errorLogTag(error) });
      return null;
    }
    try { return loadAgentDbExtras(db, dbPath, dirName, dbStats); }
    finally { db.close(); }
  }
  private reseedMinimalStoreDbIfMissing(dbPath: string): void { const db = new SandAgentDb(dbPath); db.close(); }
  private rosterHost() { return { rootDir: this.rootDir, isAgentBeingDeleted: (id: string) => this.isAgentBeingDeleted(id), memory: this.memory, loadCachedExtras: (args: { dirName: string; dbPath: string; dbStats: { size: number; mtimeMs: number } }) => this.loadCachedExtras(args), recoverAgentWithMissingDb: (args: { dbPath: string; dirName: string; activeAgentId?: string }) => recoverAgentWithMissingDb({ memory: this.memory, isAgentBeingDeleted: (id: string) => this.isAgentBeingDeleted(id), reseedMinimalStoreDbIfMissing: (path: string) => this.reseedMinimalStoreDbIfMissing(path) }, args), pruneExtrasCache: (ids: Set<string>) => { for (const id of this.extrasCache.keys()) if (!ids.has(id)) this.extrasCache.delete(id); } }; }
  async summarizeAgentById(agentId: string, activeAgentId?: string): Promise<Record<string, unknown> | null> { return summarizeAgentById(this.rosterHost(), agentId, activeAgentId); }
  async listAgents(activeAgentId?: string): Promise<Record<string, unknown>[]> { return listAgents(this.rosterHost(), activeAgentId); }
  async listAgentIds(): Promise<string[]> { return listAgentDirectoryIds(this.rootDir); }

  async getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]> { return this.conversationState?.getTranscriptEntries(session) ?? session.db.getTranscriptEntries(); }
  async getSessionOutline(session: OpenAgentSession): Promise<unknown> { if (this.conversationState == null) throw new Error("Session conversation-state provider is required"); return this.conversationState.getSessionOutline(session); }
  async getAgentOutline(agentId: string): Promise<unknown> { if (this.conversationState == null) throw new Error("Session conversation-state provider is required"); return this.conversationState.getAgentOutline(agentId); }
  async getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]> { return this.conversationState?.getAgentTranscriptEntries(agentId) ?? this.withAgentDb(agentId, (db) => db.getTranscriptEntries()); }
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[] { return this.conversationState?.readAgentTranscriptEntries(agentId) ?? []; }
  readAgentTranscriptPage(agentId: string, query: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }) { return this.conversationState?.readAgentTranscriptPage(agentId, query) ?? { entries: [] }; }
  readAgentTranscriptWindow(agentId: string, query: { beforeSeq?: number; limit: number }) { return this.conversationState?.readAgentTranscriptWindow(agentId, query) ?? { entries: [], threadCounts: {} }; }
  readAgentTranscriptTail(agentId: string, query: { beforeSeq?: number; limit: number }) { return this.conversationState?.readAgentTranscriptTail(agentId, query) ?? { entries: [] }; }
  readAgentThread(agentId: string, rootId: string) { return this.conversationState?.readAgentThread(agentId, rootId) ?? { entries: [] }; }

  async markSessionViewed(session: OpenAgentSession, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): Promise<void> { session.db.markViewed(at, options); }
  markSessionViewedNow(session: OpenAgentSession, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): void { session.db.markViewed(at, options); }
  markSessionActivity(session: OpenAgentSession, at = Date.now()): void { session.db.markActivity(at); }
  async markAgentViewed(agentId: string, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): Promise<void> { try { await this.withAgentDb(agentId, (db) => db.markViewed(at, options)); } catch {} }
  async setSessionUnread(agentId: string, unread: boolean, at = Date.now()): Promise<void> { await this.withAgentDb(agentId, (db) => unread ? db.markUnread(at) : db.markRead(at)); }
  setSessionNotifyOnUpdates(agentId: string, enabled: boolean): void { writeSandSettingsFile(getSandSettingsPath(this.getAgentDir(agentId)), { notifyOnAgentUpdates: enabled }); }
  setSessionHiddenFromSidebar(agentId: string, hidden: boolean): void { writeSandSettingsFile(getSandSettingsPath(this.getAgentDir(agentId)), { hiddenFromSidebar: hidden }); }
  async setAwaitingUserResponse(agentId: string, state: AwaitingUserResponse | null): Promise<void> { await this.withAgentDb(agentId, (db) => { db.setAwaitingUserResponse(state); }); }
  async setAwaitingUserResponseForTab(agentId: string, tabId: string, state: AwaitingUserResponse | null, options?: { ifSinceBefore?: number }): Promise<boolean> { return this.withAgentDb(agentId, (db) => db.setAwaitingUserResponseForTab(tabId, state, options)); }
  async expirePendingAutoReviewApprovals(agentId: string, onlyRequestId?: string): Promise<string[]> { return this.withAgentDb(agentId, (db) => expirePendingAutoReviewApprovalEntries(db as never, onlyRequestId)); }
  async expirePendingLocalToolPermissionAsks(args: { agentId: string; onlyRequestId?: string; ifPendingBeforeMs?: number }): Promise<string[]> { return this.withAgentDb(args.agentId, (db) => expirePendingLocalToolPermissionAskEntries(db as never, { ...(args.onlyRequestId == null ? {} : { onlyRequestId: args.onlyRequestId }), ...(args.ifPendingBeforeMs == null ? {} : { ifPendingBeforeMs: args.ifPendingBeforeMs }) })); }
  async clearAgentMemoryPromptSnapshot(agentId: string): Promise<void> { await this.withAgentDb(agentId, (db) => db.clearMemoryPromptSnapshot()); }
  async ensureConversationCapacityForTurn(session: OpenAgentSession): Promise<void> { if (this.materialization?.requireWorkerPool == null) return; await ensureConversationCapacityForTurn({ requireWorkerPool: () => this.materialization?.requireWorkerPool?.() as never }, session.dbPath, session.db); }

  automationStoreFor(agentId: string) { return automationStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone); }
  listAgentAutomations(agentId: string) { return this.automationStoreFor(agentId).list().slice(0, AUTOMATION_UI_LIMIT); }
  setAgentAutomationEnabled(agentId: string, automationId: string, enabled: boolean) { const store = this.automationStoreFor(agentId); store.setEnabled(automationId, enabled); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  createAgentAutomation(agentId: string, spec: Parameters<ReturnType<SandAgentSessionStore["automationStoreFor"]>["upsert"]>[0]) { const store = this.automationStoreFor(agentId); store.upsert(spec); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  updateAgentAutomation(agentId: string, automationId: string, spec: Parameters<ReturnType<SandAgentSessionStore["automationStoreFor"]>["update"]>[1]) { const store = this.automationStoreFor(agentId); store.update(automationId, spec); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  removeAgentAutomation(agentId: string, automationId: string) { const store = this.automationStoreFor(agentId); store.remove(automationId); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  workflowStoreFor(agentId: string) { return workflowStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone); }
  async listAgentWorkflows(agentId: string) { return limitSurfacedWorkflows(this.workflowStoreFor(agentId).listAll()); }
  async getAgentWorkflow(agentId: string, workflowId: string) { return this.workflowStoreFor(agentId).get(workflowId); }
  createAgentWorkflow(agentId: string, spec: WorkflowSpec) { const store = this.workflowStoreFor(agentId); store.create(spec); return limitSurfacedWorkflows(store.listAll()); }
  updateAgentWorkflow(agentId: string, workflowId: string, spec: WorkflowSpec) { const store = this.workflowStoreFor(agentId); store.update(workflowId, spec); return limitSurfacedWorkflows(store.listAll()); }
  async setAgentWorkflowEnabled(agentId: string, workflowId: string, enabled: boolean) { const store = this.workflowStoreFor(agentId); store.setEnabledForAgent(workflowId, enabled); return limitSurfacedWorkflows(store.listAll()); }
  removeAgentWorkflow(agentId: string, workflowId: string) { const store = this.workflowStoreFor(agentId); store.remove(workflowId); return limitSurfacedWorkflows(store.listAll()); }
  async importAgentWorkflowMarkdown(agentId: string, markdown: string, fallbackName?: string) { const store = this.workflowStoreFor(agentId), imported = store.importMarkdown(markdown, fallbackName); return { workflows: limitSurfacedWorkflows(store.listAll()), result: imported == null ? { imported: [], skipped: [{ source: "pasted skill", reason: "empty or invalid" }] } : { imported: [imported], skipped: [] } }; }
  async importAgentWorkflowSource(agentId: string, source: string, fallbackName?: string) { const store = this.workflowStoreFor(agentId), imported = store.importLiveSource(source, fallbackName); return { workflows: limitSurfacedWorkflows(store.listAll()), result: imported == null ? { imported: [], skipped: [{ source, reason: "could not link" }] } : { imported: [imported], skipped: [] } }; }
  async portAgentLocalSkills(agentId: string) { const store = this.workflowStoreFor(agentId), result = store.portLocalSkills(homedir(), process.cwd()); return { workflows: limitSurfacedWorkflows(store.listAll()), result }; }

  openChannelStore(agentId: string) { return channelStoreForDbPath(getAgentDbPath(this.rootDir, agentId)); }
  listAgentChannels(agentId: string) { return this.openChannelStore(agentId).listConnections().filter((connection) => this.connectorSecrets.getSecret(agentId, connection.platform, "token") != null); }
  listChannelConfigs(agentId: string): Array<{ platform: string; token: string; label: string }> { const store = this.openChannelStore(agentId), configs = []; for (const platform of store.listPlatforms()) { const token = this.connectorSecrets.getSecret(agentId, platform, "token"); if (token != null) configs.push({ platform, token, label: store.readLabel(platform) ?? platform }); } return configs; }
  storeConnectorCredential(agentId: string, platform: string, field: string, value: string): boolean { if (!this.connectorSecrets.setSecret(agentId, platform, field, value)) return false; this.openChannelStore(agentId).writeMetadata(platform, ""); return true; }
  disconnectChannel(agentId: string, platform: string): boolean { this.connectorSecrets.removeAgentPlatform(agentId, platform); return this.openChannelStore(agentId).remove(platform); }
  async listAllAutomationsFrom(options: { definitionsOnly: boolean }) { const result = []; for (const agentId of await this.listAgentIds()) { try { const store = this.automationStoreFor(agentId), automations = options.definitionsOnly ? store.listDefinitions() : store.list(); for (const automation of automations) result.push({ agentId, automation }); } catch {} } return result; }
  async listAllAutomations() { return this.listAllAutomationsFrom({ definitionsOnly: false }); }
  async listAllAutomationDefinitions() { return this.listAllAutomationsFrom({ definitionsOnly: true }); }
  private async removeAgentDir(agentId: string, kind: string): Promise<boolean> {
    // This runs on every create, mint and cap check, so it must not spend the
    // eight-second retry budget of `removeAgentDirOrFail` on a directory that no
    // holder will ever release.
    try { await rm(this.getAgentDir(agentId), { recursive: true, force: true, maxRetries: 3, retryDelay: AGENT_DIR_RM_RETRY_DELAY_MS }); return true; }
    catch (error) { reportSessionDiagnostic({ family: "store_db", kind, agentId, errorClass: errorLogTag(error) }); return false; }
  }
  /**
   * Removes an agent directory that has no `store.db` left, and one whose agent
   * was already deleted. The cap counts directories, so a leftover directory
   * held its slot forever. A deleted agent came back because every late read of
   * `store.db` recreates its directory: `new SandAgentDb(...)` runs
   * `mkdirSync(dirname(dbPath))` before it opens anything. The transcript manager
   * keeps a deleted id in its deleted set, so the roster hides the resurrected
   * directory and the user can never delete it by hand either. The id in that
   * set is proof enough that the directory is garbage.
   */
  private async reclaimDanglingAgentDirs(): Promise<void> {
    const activeId = this.readActiveAgentId();
    for (const agentId of await this.listAgentIds()) {
      if (agentId === activeId || this.openSessions.has(agentId)) continue;
      // The path is joined by hand: a directory whose name is not a valid agent
      // id must not turn a cap check into a thrown `SandInvalidAgentIdError`.
      if (!this.isAgentBeingDeleted(agentId) && existsSync(join(this.getAgentDir(agentId), STORE_FILENAME))) continue;
      await this.removeAgentDir(agentId, this.isAgentBeingDeleted(agentId) ? "resurrected_dir_reclaim_failed" : "dangling_dir_reclaim_failed");
    }
  }
  async isAgentCapReached(): Promise<boolean> { await this.reclaimDanglingAgentDirs(); return await this.materialization?.isAgentCapReached?.() ?? false; }
  async statOpenDb(args: { dbPath: string; agentId: string }) { try { return await stat(args.dbPath); } catch { return undefined; } }
  private profileFilesHost() { return { memory: this.memory, withAgentDb: <T>(agentId: string, fn: (db: SandAgentDb, dbPath: string) => T | Promise<T>) => this.withAgentDb(agentId, fn), statOpenDb: (args: { dbPath: string; agentId: string }) => this.statOpenDb(args), writeAgentProfileFile: (agentId: string, profile: Partial<SandAgentProfile> & { name: string; description: string }) => this.writeAgentProfileFile(agentId, profile) }; }
}
