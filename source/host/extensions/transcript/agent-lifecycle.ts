import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSandAgentLimitError } from "../../../shared/agents/agents.js";
import { errorLogTag, errorMessage } from "../../../shared/errors.js";
import { SandAgentLifecycleError, SandAgentNotFoundError } from "../session/agent-errors.js";
import {
  cloneAgentDir,
  cloneAgentDisplayName,
} from "../../agents/agent-clone.js";
import { CANONICAL_AVATAR_FILENAME } from "../../agents/agent-avatar.js";
import { getAgentAutomationsDir } from "../../automations/automation-store.js";
import {
  SAND_DISK_SAVER_KICKSTART_PROMPT,
  SAND_DISK_SAVER_REAUDIT_PROMPT,
} from "../../../shared/agents/disk-saver.js";
import {
  INTRODUCTION_FAILED_TRAY_TITLE,
  SAND_ONBOARDING_KICKSTART_PROMPT,
  introductionFailedTrayKey,
} from "../../../shared/agents/onboarding.js";
import { sandErrorDetail } from "../../ports/telemetry.js";
import {
  normalizeAgentInstructions,
  readAgentInstructions,
  writeAgentInstructions,
} from "../../runner/system-prompt-assembly.js";
import { SandAgentDb } from "../session/agent-db.js";
import { checkpointSandAgentDb } from "../../storage/store-db.js";
import { publishTranscriptMutation } from "../../transcript-mutation-events.js";
import { describeAgentRunError } from "./agent-run-error.js";
import { isUserMessageEntry } from "./send-message-shaping.js";
import { getTranscript } from "./transcript-store.js";
import { classifyAgentError } from "./turn-runtime.js";
import type { TranscriptManagerLike } from "./transcript-hub.js";

// Re-exported so every existing importer of this module keeps importing it from
// here. The class itself lives with `SandAgentNotFoundError` in the session
// layer, because the not-found subclass has to extend it and this module already
// imports that layer.
export { SandAgentLifecycleError };
/**
 * One agent the delete could not remove. `error` is the log tag for the host
 * log; `detail` is the sentence the person deleting the agent reads, and it says
 * which files the app still holds and where the folder is.
 */
interface DeleteFailure { readonly agentId: string; readonly error: string; readonly detail: string }
/**
 * A transcript journal directory that outlived the agent that owned it.
 *
 * The agent itself is gone either way; this says which conversation's journal did
 * not go with it, so the caller learns it here instead of finding the directory
 * on disk later and counting it as an agent nobody owns. `conversationIds` are
 * conversation ids, and for a subagent that is `subagent-<uuid>`, which is why
 * they are reported under their own names rather than as agent ids.
 */
interface TranscriptLeftover { readonly agentId: string; readonly conversationIds: string[] }
interface CreateOptions {
  purpose?: string;
  isKickstartRequested?: boolean;
  isIntroductionSuppressed?: boolean;
  configureAgentDir?(dir: string): void;
}

/**
 * Separates the instruction text from the rest of a create profile.
 *
 * The instruction does not belong to `profile.json` and cannot go into the
 * store's `createSession`, which rebuilds the profile from the fields it knows:
 * an unknown key handed to it is silently dropped, which is how a create that
 * carried instructions used to succeed while producing an agent that had none.
 * Anything that is not a plain object yields an empty instruction rather than a
 * crash, because a malformed create profile has always been the caller's
 * problem to report, not a reason to fail before the agent exists.
 */
function splitAgentInstructions(profile: unknown): {
  instructions: string;
  identity: Record<string, unknown>;
} {
  const source =
    typeof profile === "object" && profile !== null && !Array.isArray(profile)
      ? (profile as Record<string, unknown>)
      : {};
  const { instructions, ...identity } = source;
  return { instructions: normalizeAgentInstructions(instructions), identity };
}

/**
 * How many removed ids the host remembers for the life of the process.
 *
 * The record answers one question — "did *this* process delete that id?" — and a
 * host that removes an agent every minute for a month would otherwise hold 43 000
 * uuid strings, none of which anybody can press again. Eviction only costs the
 * weaker answer: a repeat delete of an id evicted long ago is refused again with
 * the sentence an id that never existed gets.
 */
export const DELETED_AGENT_LEDGER_CAP = 512;

/** What arrived instead of the field a command needs, in words a caller can act on. */
function arrivalType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "an empty string";
  return typeof value;
}

export class AgentLifecycle {
  constructor(readonly tm: TranscriptManagerLike) {}

  /**
   * The ids this process removed from disk itself.
   *
   * `deleteAgents` used to read "already deleted" off the directory alone, and a
   * directory cannot tell a second delete apart from a delete of an id nobody ever
   * created. Measured on a live box carrying forty-nine agents: two `deleteAgent`
   * calls for one agent answered `200 {deleted:[<id>]}` when they overlapped, and
   * `500 No agent directory on disk for <id>` when the second call started after
   * the first had finished. The same button, the same agent, the same end state —
   * gone, deleted correctly — produced an error only because the second call was
   * a moment slower than the first. The user had asked for the agent to be gone
   * and the agent was gone.
   *
   * So a repeat delete is a success and a delete of an id that never existed stays
   * a refusal, and this set is what tells them apart. It is process state on
   * purpose: the host keeps no durable record that an agent ever existed, and
   * inventing one on disk to serve a button is a worse trade than answering
   * clearly. A repeat delete that arrives after a restart is refused again, with
   * the sentence that names the agent.
   */
  private readonly removedAgentIds = new Set<string>();

  private noteRemoved(agentId: string): void {
    this.removedAgentIds.add(agentId);
    for (const oldest of this.removedAgentIds.keys()) {
      if (this.removedAgentIds.size <= DELETED_AGENT_LEDGER_CAP) break;
      this.removedAgentIds.delete(oldest);
    }
  }

  /**
   * Refuses an id that is not an agent id, before anything builds a path out of it.
   *
   * `agentDirExists` and every store write below join the id onto the agent root,
   * so a request that left the field out reached `node:path` and answered `500
   * {"error":"The \"path\" argument must be of type string. Received undefined"}`
   * — the text of one Node call, naming no command, no field and no remedy. These
   * commands are reachable from the coordinator as well as from the gateway, so the
   * check lives here and not only at the gateway edge.
   */
  private requireAgentId(agentId: unknown, command: string): string {
    if (typeof agentId !== "string" || agentId.length === 0)
      throw new SandAgentLifecycleError(
        `Malformed ${command} request: "id" must be a non-empty string, and ${arrivalType(agentId)} arrived.`,
      );
    return agentId;
  }

  async createAgent(
    profile: unknown,
    origin = "user",
    options: CreateOptions = {},
  ): Promise<any> {
    const previous = this.tm.sessions.activeSession;
    const next = await this.mintAgentSession(profile, origin, options);
    const now = Date.now();
    await this.tm.sessions.markSessionLeftBehind(previous, now);
    await this.tm.sessionStore.markSessionViewed(next, now);
    this.tm.sessions.invalidateDeferredActivation();
    await this.tm.sessions.replaceSession(next);
    this.tm.sessions.clearActiveTranscript(next.id);
    this.tm.roster.emit({ type: "cleared" });
    await this.tm.roster.emitAgents();
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const summary = await this.tm.sessionStore.summarizeOpenSession(next);
    if (summary == null)
      throw new SandAgentLifecycleError(
        "Failed to summarize newly created Sand agent.",
      );
    if (options.isKickstartRequested === true)
      void this.kickstartCreatedAgent(next.id);
    return {
      agent: this.withAgentInstructions(
        this.tm.roster.finalizeSummaryForRpc(summary, stamp),
        next.id,
      ),
      transcript: getTranscript(),
    };
  }

  /**
   * Puts the stored instruction text on the summary the caller gets back.
   *
   * `buildSummary` builds the agent record from `profile.json`, which by design
   * carries no instructions, so without this the only way to read an agent's own
   * brief back is to open its folder by hand. A field a caller can write but not
   * read is a field nobody can check.
   */
  private withAgentInstructions(summary: any, agentId: string): any {
    if (summary == null || typeof summary !== "object") return summary;
    return {
      ...(summary as Record<string, unknown>),
      instructions: readAgentInstructions(
        this.tm.sessionStore.getAgentDir(agentId),
      ),
    };
  }
  async kickstartCreatedAgent(agentId: string): Promise<void> {
    let ready = false;
    try {
      ready = await this.tm.execution.isRunReady();
    } catch {}
    await this.kickstartAgent(agentId, ready);
  }
  async createBackgroundAgent(
    profile: unknown,
    origin = "user",
    options: CreateOptions = {},
  ): Promise<any> {
    const session = await this.mintAgentSession(profile, origin, options);
    try {
      const transcript = session.db.getTranscriptEntries();
      await this.tm.roster.emitAgents();
      const stamp = this.tm.roster.reserveSnapshotStamp();
      const summary = await this.tm.sessionStore.summarizeOpenSession(session);
      if (summary == null)
        throw new SandAgentLifecycleError(
          "Failed to summarize newly created Sand agent.",
        );
      return {
        agent: this.tm.roster.finalizeSummaryForRpc(summary, stamp),
        transcript,
      };
    } finally {
      await session.agentStore.dispose();
      session.db.close();
    }
  }
  async mintAgentSession(
    profile: unknown,
    origin: string,
    options: CreateOptions,
  ): Promise<any> {
    const { instructions, identity } = splitAgentInstructions(profile);
    const session = await this.tm.sessionStore.createSession(
      identity,
      origin,
      options.purpose,
    );
    // Written after the directory exists, and before the caller can run a turn,
    // so the first turn of a brand new agent already carries its instructions.
    // Over the ceiling this throws and no agent is returned: half an agent is
    // worse than a refusal the user can act on.
    writeAgentInstructions(
      this.tm.sessionStore.getAgentDir(session.id),
      instructions,
    );
    options.configureAgentDir?.(this.tm.sessionStore.getAgentDir(session.id));
    if (options.isIntroductionSuppressed !== true)
      session.db.setIntroductionPending(true);
    return session;
  }

  async kickstartAgent(agentId: string, isRunReady: boolean): Promise<boolean> {
    let session: any;
    try {
      session =
        this.tm.sessions.activeSession?.id === agentId
          ? this.tm.sessions.activeSession
          : await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session) ||
      !session.db.getIntroductionPending()
    )
      return false;
    if (session.db.getTranscriptEntries().some(isUserMessageEntry)) {
      session.db.setIntroductionPending(false);
      return false;
    }
    if (!isRunReady || !this.tm.execution.canExecute) return false;
    if (this.tm.runLifecycle.inFlightRunCounts.has(session)) return true;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "turn");
        try {
          const prompt =
            session.db.getAgentPurpose() === "disk-saver"
              ? SAND_DISK_SAVER_KICKSTART_PROMPT
              : SAND_ONBOARDING_KICKSTART_PROMPT;
          const result = await runner.run(prompt, { hidden: true });
          let delivered = result.sentMessageCount > 0;
          if (!result.aborted && result.sentMessageCount === 0)
            delivered =
              await this.tm.automationRuntime.ensureHiddenTurnReply(runner);
          if (result.quiescedForUpgrade) {
            this.tm.upgradeResume.markAgentResumePending(session, "turn");
            session.db.setIntroductionPending(false);
          } else if (!result.aborted && delivered)
            session.db.setIntroductionPending(false);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "onboarding_kickstart",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
          this.tm.trayErrors.pushError({
            agentId: session.id,
            title: INTRODUCTION_FAILED_TRAY_TITLE,
            ...describeAgentRunError(error),
            dedupeKey: introductionFailedTrayKey(session.id),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "user", source: "kickstart" },
    );
    return true;
  }

  async requestDiskSaverAudit(
    agentId: string,
    isRunReady: boolean,
  ): Promise<boolean> {
    let session: any;
    try {
      session =
        this.tm.sessions.activeSession?.id === agentId
          ? this.tm.sessions.activeSession
          : await this.tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return false;
    }
    if (
      this.tm.groupChat.isGroupSession(session) ||
      this.tm.groupChat.isRemoteRoomSession(session) ||
      session.db.getAgentPurpose() !== "disk-saver"
    )
      return false;
    if (session.db.getIntroductionPending())
      return this.kickstartAgent(agentId, isRunReady);
    if (!isRunReady || !this.tm.execution.canExecute) return false;
    if (this.tm.runLifecycle.inFlightRunCounts.has(session)) return true;
    const runner = this.tm.runnerRegistry.getRunner(session);
    this.tm.runLifecycle.beginSessionRun(session);
    void this.tm.runLifecycle.enqueueExclusiveRun(
      session.id,
      async () => {
        this.tm.turnRuntime.activeRequestSources.set(session.id, "event");
        try {
          const result = await runner.run(SAND_DISK_SAVER_REAUDIT_PROMPT, {
            hidden: true,
          });
          if (result.quiescedForUpgrade)
            this.tm.upgradeResume.markAgentResumePending(session, "event");
          else if (!result.aborted && result.sentMessageCount === 0)
            await this.tm.automationRuntime.ensureHiddenTurnReply(runner);
          await this.tm.roster.emitAgentUpdate(session.id);
        } catch (error) {
          this.tm.telemetry.reportAgentError({
            source: "disk_saver_reaudit",
            conversationId: session.id,
            requestId: this.tm.runLifecycle.lastRequestIdBySession.get(
              session.id,
            ),
            error: classifyAgentError(error),
            detail: sandErrorDetail(error),
          });
        } finally {
          this.tm.runLifecycle.endSessionRun(session);
        }
      },
      { lane: "background", source: "event" },
    );
    return true;
  }

  async cloneAgent(sourceId: string): Promise<any> {
    const summary = (await this.tm.sessionStore.listAgents()).find(
      (agent: any) => agent.id === sourceId,
    );
    if (summary == null)
      throw new SandAgentLifecycleError("That agent no longer exists.");
    if (summary.isGroup)
      throw new SandAgentLifecycleError("Groups can't be duplicated yet.");
    const opened = await this.tm.sessionStore.mintAgent(
      async (agentId: string) => {
        cloneAgentDir(
          this.tm.sessionStore.getAgentDir(sourceId),
          this.tm.sessionStore.getAgentDir(agentId),
          agentId,
          cloneAgentDisplayName(summary.name),
          {
            getAutomationsDir: getAgentAutomationsDir,
            checkpointStore: (dbPath) => {
              checkpointSandAgentDb(dbPath);
            },
            rewriteIdentity: (targetDir, newAgentId, includesChatHistory) => {
              const db = new SandAgentDb(join(targetDir, "store.db"));
              try {
                db.set("agentId", newAgentId);
                db.setAgentOrigin("user");
                db.clearAgentPurpose();
                db.clearTransientState();
                if (!includesChatHistory) db.clearConversation();
                const avatarPath = join(targetDir, CANONICAL_AVATAR_FILENAME);
                const existing = db.getSandProfile();
                db.setSandProfile({
                  description: existing.description,
                  avatarPath: existsSync(avatarPath) ? avatarPath : null,
                });
              } finally {
                db.close();
              }
            },
          },
        );
        return this.openMintedSession(agentId);
      },
    );
    return this.commitOpenedSession(opened);
  }
  async commitOpenedSession(opened: {
    session: any;
    entries: any[];
    agent: any;
  }): Promise<any> {
    publishTranscriptMutation({
      kind: "agent-needs-reindex",
      agentId: opened.session.id,
    } as unknown as Parameters<typeof publishTranscriptMutation>[0]);
    const previous = this.tm.sessions.activeSession;
    const now = Date.now();
    await this.tm.sessions.markSessionLeftBehind(previous, now);
    await this.tm.sessionStore.markSessionViewed(opened.session, now);
    this.tm.sessions.invalidateDeferredActivation();
    await this.tm.sessions.replaceSession(opened.session);
    this.tm.sessions.setActiveTranscript(opened.session.id, opened.entries);
    this.tm.sessions.loaded = true;
    this.tm.roster.emit({
      type: "snapshot",
      activeAgentId: opened.session.id,
      entries: opened.entries,
    });
    await this.tm.roster.emitAgents();
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const refreshed = await this.tm.sessionStore.summarizeOpenSession(
      opened.session,
    );
    return {
      agent: this.tm.roster.finalizeSummaryForRpc(
        refreshed ?? opened.agent,
        stamp,
      ),
      transcript: getTranscript(),
    };
  }
  async openMintedSession(newId: string): Promise<any> {
    let session: any;
    try {
      session = await this.tm.sessionStore.openSession(newId);
      const entries = await this.tm.sessionStore.getTranscriptEntries(session);
      const agent = await this.tm.sessionStore.summarizeOpenSession(session);
      if (agent == null)
        throw new SandAgentLifecycleError(
          "minted agent could not be summarized",
        );
      return { session, entries, agent };
    } catch (error) {
      await this.discardMintedSession(session, newId);
      throw error;
    }
  }
  async discardMintedSession(session: any, newId: string): Promise<void> {
    if (session != null) {
      try {
        await session.agentStore.dispose();
        session.db.close();
      } catch {}
    }
    await this.tm.sessionStore.deleteSession(newId).catch((error: unknown) => {
      console.error(
        `[sand] minted-session discard left ${newId} on disk: ${errorLogTag(error)}`,
      );
    });
  }

  async deleteAgent(agentId: string): Promise<any> {
    // Checked here under this command's name, because `deleteAgents` is also the
    // batch entry point and its refusal must name the command the caller used.
    this.requireAgentId(agentId, "deleteAgent");
    const result = await this.tm.deleteAgents([agentId]);
    // A single delete that left the agent on disk answered `200` with the id in
    // `failed` and an empty `deleted`, so the caller closed its dialog on an
    // agent it still had. One target, one answer: either the directory is gone
    // or the call fails, and the failure says which files are in the way.
    //
    // An agent this process already removed is not that case and does not throw:
    // the requested end state already holds, so the answer is the same success
    // with `alreadyDeletedAgentIds` naming what was gone before the call.
    const failure = (result?.failed ?? []).find(
      (entry: any) => entry.agentId === agentId,
    );
    if (failure != null)
      throw new SandAgentLifecycleError(
        `Agent ${agentId} was not deleted: ${failure.detail ?? failure.error}`,
      );
    return result;
  }
  async deleteAgents(agentIds: readonly string[]): Promise<any> {
    const ids = new Set<string>();
    for (const id of agentIds) ids.add(this.requireAgentId(id, "deleteAgents"));
    if (ids.size === 0) return { transcript: getTranscript() };
    const absent: string[] = [];
    const present = new Set<string>();
    for (const id of ids) {
      if (this.tm.sessionStore.agentDirExists(id)) present.add(id);
      else absent.push(id);
    }
    // An id this process removed is gone on purpose, and asking again for it is
    // the same request answered twice. An id nobody ever created is a different
    // answer and keeps its refusal below, name and all.
    const alreadyDeleted = absent.filter((id) => this.removedAgentIds.has(id));
    const missing = absent.filter((id) => !this.removedAgentIds.has(id));
    // A refusal only fires when nothing in the request can be acted on. One id
    // left to delete is reason enough to run the delete; one id already deleted is
    // reason enough to succeed.
    //
    // The refusal is `SandAgentNotFoundError` rather than the lifecycle error it
    // used to be, because the host has positively established that the id names
    // nothing and `statusForCommandError` turns exactly that into `404`. A delete
    // that lost a race with a file handle stays a lifecycle error and stays `500`:
    // a client that retries on `404` must never be told to retry that one.
    if (present.size === 0 && alreadyDeleted.length === 0)
      throw new SandAgentNotFoundError(
        `No agent directory on disk for ${missing.join(", ")}`,
      );
    let result: any;
    try {
      // Nothing left to unlink, so the delete itself does no work. The answer
      // still carries both lists: a caller reads `deleted` and `failed` to learn
      // what happened, and a result without them is a different shape for the
      // same command depending on how fast the first press was.
      result =
        present.size === 0
          ? { transcript: getTranscript(), ...this.deletionOutcome([], []) }
          : await this.runDeleteAgents(present);
    } catch (error) {
      for (const id of present)
        if (this.tm.sessionStore.agentDirExists(id))
          this.tm.sessions.deletedAgentIds.delete(id);
      throw error;
    }
    const report =
      missing.length === 0 && alreadyDeleted.length === 0
        ? {}
        : {
            ...(missing.length === 0 ? {} : { missingAgentIds: missing }),
            ...(alreadyDeleted.length === 0
              ? {}
              : { alreadyDeletedAgentIds: alreadyDeleted }),
          };
    return Object.keys(report).length === 0 ? result : { ...result, ...report };
  }
  /**
   * Closes the handles that keep `store.db` and `conversation-blobs.db` open.
   * `interruptAgentForDeletion` silences the runner and waits for the exclusive
   * runs, but nothing closed a database handle, so `deleteSession` unlinked files
   * this process still held open, Windows answered `EBUSY`, and the agent kept
   * its slot. Handles go before the delete, never after it.
   */
  private async closeAgentHandles(agentId: string, session: any): Promise<void> {
    try {
      await session?.agentStore?.dispose?.();
    } catch (error) {
      console.error(
        `[sand] agent store dispose failed for ${agentId}: ${errorLogTag(error)}`,
      );
    }
    try {
      session?.db?.close?.();
    } catch (error) {
      console.error(
        `[sand] store.db close failed for ${agentId}: ${errorLogTag(error)}`,
      );
    }
    const store = this.tm.sessionStore as {
      releaseSession?(id: string): Promise<void>;
    };
    try {
      await store.releaseSession?.(agentId);
    } catch (error) {
      console.error(
        `[sand] session store release failed for ${agentId}: ${errorLogTag(error)}`,
      );
    }
  }
  private deletionOutcome(
    deleted: readonly string[],
    failed: readonly DeleteFailure[],
    transcriptLeftovers: readonly TranscriptLeftover[] = [],
  ): Record<string, unknown> {
    return {
      deleted: [...deleted],
      failed: [...failed],
      // Only present when something survived, so a clean delete keeps the exact
      // shape its callers already parse.
      ...(transcriptLeftovers.length === 0
        ? {}
        : {
            transcriptLeftovers: transcriptLeftovers.map((entry) => ({
              agentId: entry.agentId,
              conversationIds: [...entry.conversationIds],
            })),
          }),
    };
  }
  /**
   * The subagent conversation ids of one agent, read before its runner is dropped.
   *
   * A subagent owns a transcript journal directory of its own — the mirror names
   * a journal directory after the conversation id, and a subagent conversation id
   * is `subagent-<uuid>`, not an agent id. The runner is the only thing that
   * knows which subagents an agent has, and `runners.delete(id)` is the line that
   * throws that knowledge away, one line above the delete. Everything captured
   * after it is gone, which is why the capture sits before the `delete`.
   */
  private subagentConversationIds(agentId: string): string[] {
    const ids = [
      ...(this.tm.runnerRegistry.runners.get(agentId)?.listSubagents?.() ?? []),
      ...(this.tm.runnerRegistry.activeGroupMemberRunners
        .get(agentId)
        ?.listSubagents?.() ?? []),
    ];
    const seen = new Set<string>();
    const conversationIds: string[] = [];
    for (const entry of ids as Array<{ subagentId?: string } | string>) {
      const id = typeof entry === "string" ? entry : entry?.subagentId;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      conversationIds.push(id);
    }
    return conversationIds;
  }
  async runDeleteAgents(ids: ReadonlySet<string>): Promise<any> {
    const active = await this.tm.sessions.tryEnsureSession();
    const deletingActive = active != null && ids.has(active.id);
    for (const id of ids) await this.interruptAgentForDeletion(id);
    for (const id of ids) this.tm.trayErrors.clearForAgent(id);
    const deleted: string[] = [];
    const failed: DeleteFailure[] = [];
    const transcriptLeftovers: TranscriptLeftover[] = [];
    for (const id of ids) {
      if (id === active?.id) continue;
      try {
        const subagentIds = this.subagentConversationIds(id);
        this.tm.runnerRegistry.runners.delete(id);
        const session = this.tm.sessions.liveSessions.get(id);
        this.tm.sessions.liveSessions.delete(id);
        this.tm.sessions.pendingSessionOpens.delete(id);
        await this.closeAgentHandles(id, session);
        const outcome = await this.tm.sessionStore.deleteSession(id, {
          subagentIds,
        });
        if (outcome?.transcriptLeftovers?.length) {
          transcriptLeftovers.push({
            agentId: id,
            conversationIds: outcome.transcriptLeftovers,
          });
        }
        // The id was marked deleted before the unlink and the mark outlived the
        // directory: the roster skipped the agent for the rest of the run, and a
        // directory that came back later (`new SandAgentDb` recreates it) was
        // hidden from the user with no way to remove it. The directory is gone,
        // so the mark has nothing left to protect.
        this.tm.sessions.deletedAgentIds.delete(id);
        this.tm.onAgentForgotten?.(id);
        this.tm.pendingWakeStore?.clearAgent(id);
        this.tm.boxHandoff.boxHandoffs.delete(id);
        this.tm.boxHandoff.awaitingSink.clear(id);
        this.tm.roster.emitAsyncTasksForAgent(id);
        this.noteRemoved(id);
        deleted.push(id);
      } catch (error) {
        failed.push({ agentId: id, error: errorLogTag(error), detail: errorMessage(error) });
        console.error(
          `[sand] delete of agent ${id} failed: ${errorLogTag(error)}: ${errorMessage(error)}`,
        );
      }
    }
    if (!deletingActive || active == null) {
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript(), ...this.deletionOutcome(deleted, failed, transcriptLeftovers) };
    }
    try {
      return await this.finishDeletingActiveAgent(active, ids, deleted, failed, transcriptLeftovers);
    } catch (error) {
      failed.push({ agentId: active.id, error: errorLogTag(error), detail: errorMessage(error) });
      console.error(
        `[sand] delete of active agent ${active.id} failed: ${errorLogTag(error)}: ${errorMessage(error)}`,
      );
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript(), ...this.deletionOutcome(deleted, failed, transcriptLeftovers) };
    }
  }
  private async finishDeletingActiveAgent(
    active: any,
    ids: ReadonlySet<string>,
    deleted: string[],
    failed: DeleteFailure[],
    transcriptLeftovers: TranscriptLeftover[] = [],
  ): Promise<any> {
    const activeSubagentIds = this.subagentConversationIds(active.id);
    await this.closeAgentHandles(active.id, active);
    this.tm.runnerRegistry.runners.delete(active.id);
    this.tm.sessions.liveSessions.delete(active.id);
    this.tm.sessions.pendingSessionOpens.delete(active.id);
    this.tm.runLifecycle.closeSessionWhenIdle(active);
    const activeOutcome = await this.tm.sessionStore.deleteSession(active.id, {
      subagentIds: activeSubagentIds,
    });
    if (activeOutcome?.transcriptLeftovers?.length)
      transcriptLeftovers.push({
        agentId: active.id,
        conversationIds: activeOutcome.transcriptLeftovers,
      });
    this.tm.sessions.deletedAgentIds.delete(active.id);
    this.noteRemoved(active.id);
    deleted.push(active.id);
    this.tm.onAgentForgotten?.(active.id);
    this.tm.pendingWakeStore?.clearAgent(active.id);
    this.tm.boxHandoff.boxHandoffs.delete(active.id);
    this.tm.boxHandoff.awaitingSink.clear(active.id);
    this.tm.roster.emitAsyncTasksForAgent(active.id);
    const nextAgent = (await this.tm.sessionStore.listAgents(active.id)).find(
      (agent: any) => !ids.has(agent.id),
    );
    const successorIds = [
      ...(nextAgent == null ? [] : [nextAgent.id]),
      ...(await this.tm.sessionStore.listAgentRecordIds()).filter(
        (id: string) => !ids.has(id) && id !== nextAgent?.id,
      ),
    ];
    for (const successorId of successorIds) {
      let nextSession: any;
      try {
        nextSession =
          this.tm.sessions.liveSessions.get(successorId) ??
          (await this.tm.sessions.openSessionOnce(successorId));
      } catch (error) {
        console.error(
          `[sand] skipping unopenable agent ${successorId} after delete: ${errorLogTag(error)}`,
        );
        continue;
      }
      await this.tm.sessionStore.markSessionViewed(nextSession);
      this.tm.sessions.invalidateDeferredActivation();
      this.tm.sessions.setActiveSession(nextSession);
      this.tm.runLifecycle.watchActiveSession(nextSession);
      const entries =
        await this.tm.sessionStore.getTranscriptEntries(nextSession);
      this.tm.sessions.setActiveTranscript(nextSession.id, entries);
      this.tm.sessions.loaded = true;
      this.tm.roster.emit({
        type: "snapshot",
        activeAgentId: nextSession.id,
        entries,
      });
      await this.tm.roster.emitAgents();
      return { transcript: entries, ...this.deletionOutcome(deleted, failed, transcriptLeftovers) };
    }
    try {
      const next = await this.tm.sessionStore.createFallbackSession(
        (id: string) => this.tm.sessions.openSessionOnce(id),
      );
      await this.tm.sessionStore.markSessionViewed(next);
      this.tm.sessions.invalidateDeferredActivation();
      this.tm.sessions.setActiveSession(next);
      this.tm.runLifecycle.watchActiveSession(next);
      this.tm.sessions.clearActiveTranscript(next.id);
      this.tm.sessions.loaded = true;
      this.tm.roster.emit({ type: "cleared" });
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript(), ...this.deletionOutcome(deleted, failed, transcriptLeftovers) };
    } catch (error) {
      if (!isSandAgentLimitError(error)) throw error;
      this.tm.sessions.activeSession = undefined;
      this.tm.unwatchActiveSession();
      this.tm.sessions.clearActiveTranscript(null);
      this.tm.sessions.loaded = false;
      this.tm.roster.emit({ type: "cleared" });
      await this.tm.roster.emitAgents();
      return { transcript: getTranscript(), ...this.deletionOutcome(deleted, failed, transcriptLeftovers) };
    }
  }

  async interruptAgentForDeletion(agentId: string): Promise<void> {
    this.tm.sessions.deletedAgentIds.add(agentId);
    this.tm.ackObligations.markAckObligationLost(agentId, "agent_deleted");
    this.tm.ackObligations.ackRunTokens.delete(agentId);
    for (const queue of [
      this.tm.backgroundWakes.pendingSubagentCompletions,
      this.tm.backgroundWakes.pendingShellCompletions,
      this.tm.backgroundWakes.pendingInbound,
      this.tm.backgroundWakes.pendingAgentInbound,
      this.tm.backgroundWakes.pendingChannelFailures,
    ])
      queue.delete(agentId);
    this.tm.groupChat.dmPreemptedGroupMemberIds.delete(agentId);
    this.tm.backgroundWakes.dmPreemptedWakeAgentIds.delete(agentId);
    this.tm.roster.forgetAgentSubagentWork(agentId);
    this.tm.roster.lastRunnerAsyncTasks.delete(agentId);
    const groupRunner =
      this.tm.runnerRegistry.activeGroupMemberRunners.get(agentId);
    const runner = this.tm.runnerRegistry.runners.get(agentId);
    if (runner != null || groupRunner != null) {
      const wasInFlight = this.tm.runLifecycle.runningAgentIds().has(agentId);
      const hadGroup = groupRunner?.interruptAll("agent deleted") ?? false;
      const hadActiveRun =
        (runner?.interruptAll("agent deleted") ?? false) || hadGroup;
      this.tm.telemetry.reportTurnInterrupt({
        conversationId: agentId,
        reason: "agent_deleted",
        hadActiveRun,
        wasInFlight,
      });
      runner?.cancelBackgroundShellRewatches();
      groupRunner?.cancelBackgroundShellRewatches();
    }
    await this.tm.runLifecycle.drainExclusiveRuns(agentId);
    await runner?.drainBackgroundSubagents();
    await groupRunner?.drainBackgroundSubagents();
  }

  async updateAgent(agentId: string, profile: any): Promise<unknown> {
    const text = (value: unknown): string | undefined =>
      typeof value === "string" ? value.trim() : undefined;
    const avatarShape = text(profile?.avatarShape);
    const avatarColor = text(profile?.avatarColor);
    const title = text(profile?.title);
    const name = text(profile?.name);
    const description = text(profile?.description);
    this.requireAgentId(agentId, "updateAgent");
    if (!this.tm.sessionStore.agentDirExists(agentId))
      throw new SandAgentNotFoundError(
        `Agent ${agentId} no longer exists on disk.`,
      );
    // `undefined` means "this update says nothing about instructions" and the
    // stored text is left alone. A string, including the empty one, is a
    // decision: it is stored, or it clears the instruction file. The overload
    // that silently drops the field is how an edit screen with an instruction
    // box would leave the agent running its old brief with no error.
    const hasInstructions =
      typeof profile?.instructions === "string";
    const current = this.tm.sessionStore.getAgentProfileText(agentId);
    const agentDir = this.tm.sessionStore.getAgentDir(agentId);
    const trimmed = {
      ...(avatarShape === undefined ? {} : { avatarShape }),
      ...(avatarColor === undefined ? {} : { avatarColor }),
      name: name ?? current?.name ?? "Grok",
      description: description ?? current?.description ?? "",
      ...(title === undefined ? {} : { title }),
    };
    // Validated before any profile write, so an over-long instruction leaves
    // the name and description exactly as they were instead of half-applying
    // the update and then failing.
    const instructions = hasInstructions
      ? normalizeAgentInstructions(profile.instructions)
      : undefined;
    const stamp = this.tm.roster.reserveSnapshotStamp();
    const active = this.tm.sessions.activeSession;
    const summary =
      active?.id === agentId
        ? (this.tm.sessionStore.writeAgentProfileFile(agentId, trimmed),
          await this.tm.sessionStore.summarizeOpenSession(active))
        : await this.tm.sessionStore.updateAgentProfile(agentId, trimmed);
    if (instructions !== undefined)
      writeAgentInstructions(agentDir, instructions);
    await this.tm.roster.emitAgentUpdate(agentId);
    this.tm.roster.emitProfileChanged(agentId);
    if (summary == null) return null;
    return this.tm.roster.finalizeSummaryForRpc(
      this.withAgentInstructions(summary, agentId),
      stamp,
    );
  }
  async setAgentUnread(
    agentId: string,
    isUnread: boolean,
    atMs?: number,
  ): Promise<void> {
    const active = this.tm.sessions.activeSession;
    if (active?.id === agentId) {
      if (isUnread) {
        await this.tm.sessionStore.seedSessionActivityFromDbMtime(active);
        active.db.markUnread(atMs);
      } else active.db.markRead();
    } else await this.tm.sessionStore.setSessionUnread(agentId, isUnread, atMs);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  /**
   * Refuses a write about an agent that is not on disk.
   *
   * `writeSandSettingsFile` and `writeSandProfileFile` both end in
   * `mkdirSync(dirname(path), { recursive: true })`, so an unguarded write about
   * an id creates the agent directory as a side effect. Measured on a live box:
   * one `setAgentHiddenFromSidebar` for a fresh uuid answered `200` and left
   * `<root>\<uuid>\settings.json` behind -- a directory for an agent nobody
   * created, listed by no roster, and counted by the directory walk the
   * fifty-agent cap is computed from. `updateAgent` above already refuses such an
   * id; the switches are the same operation on the same id and owe the same
   * answer. The refusal names the agent, because a caller holding several ids
   * cannot otherwise tell which one is gone.
   *
   * The command name travels with the call because the refusal now runs before
   * the id is known to be usable: an id that never was a string used to reach
   * `node:path` and answer with that call's own text instead of this sentence.
   */
  private requireAgentOnDisk(agentId: string, command: string): void {
    this.requireAgentId(agentId, command);
    if (!this.tm.sessionStore.agentDirExists(agentId))
      throw new SandAgentNotFoundError(
        `Agent ${agentId} no longer exists on disk.`,
      );
  }
  async setAgentNotifyOnUpdates(
    agentId: string,
    enabled: boolean,
  ): Promise<void> {
    this.requireAgentOnDisk(agentId, "setAgentNotifyOnUpdates");
    this.tm.sessionStore.setSessionNotifyOnUpdates(agentId, enabled);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentHiddenFromSidebar(
    agentId: string,
    hidden: boolean,
  ): Promise<void> {
    this.requireAgentOnDisk(agentId, "setAgentHiddenFromSidebar");
    this.tm.sessionStore.setSessionHiddenFromSidebar(agentId, hidden);
    await this.tm.roster.emitAgentUpdate(agentId);
  }
  async setAgentAvatarBytes(
    agentId: string,
    pngBytes: Uint8Array,
  ): Promise<unknown> {
    const active = this.tm.sessions.activeSession,
      stamp = this.tm.roster.reserveSnapshotStamp();
    const summary =
      active?.id === agentId
        ? await this.tm.sessionStore.setAgentAvatarBytes(
            active.db,
            active.dbPath,
            agentId,
            pngBytes,
            agentId,
          )
        : await this.tm.sessionStore.setAgentAvatarBytesById(agentId, pngBytes);
    await this.tm.roster.emitAgentUpdate(agentId);
    this.tm.roster.emitProfileChanged(agentId);
    return summary == null
      ? null
      : this.tm.roster.finalizeSummaryForRpc(summary, stamp);
  }
  getAgentAvatar(agentId: string): Promise<unknown> {
    return this.tm.sessionStore.getAgentAvatar(agentId);
  }
}
