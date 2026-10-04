import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Deleting an agent answered `200 {deleted:[id]}` and then left the agent on
 * disk, so the fifty-agent cap could never be reached down. Measured on a live
 * box carrying fifty agents: forty-eight of the fifty `store.db` files were held
 * open by the host process, and the set of held ids was exactly the set of rows
 * in `search-index.db`. `SandSearchIndexWriter.reconcile()` opens `store.db`
 * read-only for every agent directory at start-up and keeps the connection in
 * `storeConnections`, and `node:sqlite` opens its file without
 * `FILE_SHARE_DELETE`, so the unlink fails with `EBUSY`/`EPERM` and leaves
 * `store.db`, `store.db-wal` and `store.db-shm` behind - the same three files the
 * live box left. The release signal for that holder is the `agent-removed`
 * transcript mutation, and the delete published it *after* the unlink, so the
 * handle the search worker was about to close was still open while `rm` ran.
 *
 * The tests below keep a `store.db` handle open exactly the way the box does at
 * start-up. They prove that the delete now removes the directory, that the
 * release is asked for before the unlink rather than after it, that a holder
 * nobody releases is named in the error instead of being called deleted, and
 * that the sentence reaches the caller who asked for the delete.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One bundle, not three: `agent-session.ts` imports the transcript mutation bus,
// so a second bundle would hand the test a private copy of the bus and the
// subscription below would never see the mutation the delete publishes.
async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agent-delete-live-"));
  const outfile = path.join(directory, "agent-store.mjs");
  const entry = (parts) => JSON.stringify(path.join(repoRoot, ...parts));
  await build({
    stdin: {
      contents: [
        `export * as sessionStore from ${entry(["source", "host", "extensions", "session", "agent-session.ts"])};`,
        `export * as mutationBus from ${entry(["source", "host", "transcript-mutation-events.ts"])};`,
        `export * as lifecycle from ${entry(["source", "host", "extensions", "transcript", "agent-lifecycle.ts"])};`,
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
      sourcefile: "agent-store-bundle.ts",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const { SandAgentSessionStore } = loaded.sessionStore;
const { subscribeTranscriptMutations } = loaded.mutationBus;
const { AgentLifecycle, SandAgentLifecycleError } = loaded.lifecycle;

test.after(() => dispose());

/**
 * Stands in for `SandSearchIndexService` + `SandSearchIndexWriter`
 * (`source/host/extensions/content-search/`), keeping the two behaviours that
 * decide the outcome: `reconcile()` opens `store.db` read-only for every agent
 * directory and keeps the connection in a map, and a `clear-agent` job closes
 * it. The release is deferred through `setTimeout(..., 0)` so the fixture models
 * a worker hand-off instead of a close on the calling stack.
 */
class BoxSearchIndex {
  constructor(agentsRootDir) {
    this.agentsRootDir = agentsRootDir;
    this.storeConnections = new Map();
    this.ids = new Map();
    this.releasedByMutation = [];
    this.unsubscribe = subscribeTranscriptMutations((mutation) => {
      if (mutation.kind !== "agent-removed") return;
      setTimeout(() => this.clearAgent(mutation.agentId, true), 0);
    });
  }
  // search-index-writer.ts:29 `store()`
  store(agentId) {
    const cached = this.storeConnections.get(agentId);
    if (cached != null) return cached;
    const dbPath = path.join(this.agentsRootDir, agentId, "store.db");
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    this.storeConnections.set(agentId, db);
    return db;
  }
  // search-index-writer.ts:38 `reconcile()` walks every agent directory.
  reconcile() {
    for (const entry of readdirSync(this.agentsRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const db = this.store(entry.name);
      if (db == null) continue;
      db.prepare("SELECT COUNT(*) AS count FROM transcript_entries").get();
    }
  }
  // search-index-writer.ts:36 `clearAgent()` -> `evict()`
  clearAgent(agentId, viaMutation = false) {
    const db = this.storeConnections.get(agentId);
    this.storeConnections.delete(agentId);
    if (viaMutation) this.releasedByMutation.push(agentId);
    try { db?.close(); } catch {}
  }
  label(id) {
    for (const [value, name] of this.ids) if (value === id) return name;
    return "unknown";
  }
  closeAll() {
    this.unsubscribe();
    for (const agentId of [...this.storeConnections.keys()]) this.clearAgent(agentId);
  }
}

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-agents-live-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  } catch {}
}

test("an agent whose store.db the running box has indexed is removed from disk", async () => {
  const { base, rootDir } = makeRoot();
  const index = new BoxSearchIndex(rootDir);
  try {
    const store = new SandAgentSessionStore(rootDir);
    const kept = await store.createSession({ name: "Kept", description: "" });
    const victim = await store.createSession({ name: "Indexed", description: "" });
    const probe = await store.createSession({ name: "Probe", description: "" });
    index.ids = new Map([[kept.id, "kept"], [victim.id, "victim"], [probe.id, "probe"]]);

    index.reconcile();
    assert.equal(index.storeConnections.size, 3,
      "the fixture opened no store.db, so the test would pass without the box holding anything");

    // Proof that the fixture reproduces the live failure rather than looking like
    // it: with the handle open, an unlink of the same directory shape fails.
    const probeDir = path.join(rootDir, probe.id);
    let blockedByHandle = null;
    try {
      rmSync(probeDir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch (error) {
      blockedByHandle = error.code;
    }
    index.clearAgent(probe.id);
    assert.ok(blockedByHandle === "EBUSY" || blockedByHandle === "EPERM",
      `the open store.db did not block the unlink at all (rm said ${blockedByHandle}), so the test does not reproduce the live defect`);
    await store.deleteSession(probe.id);

    await store.deleteSession(victim.id);

    assert.equal(existsSync(path.join(rootDir, victim.id)), false,
      "the agent directory survived the delete, so it still holds one of the fifty slots");
    const released = index.releasedByMutation;
    assert.deepEqual(released, [probe.id, victim.id],
      `the search index was told to release ${JSON.stringify(released.map((id) => [id, index.label(id)]))} instead of store.db for exactly the two deleted agents ${JSON.stringify([probe.id, victim.id])}`);
    assert.equal(existsSync(path.join(rootDir, kept.id)), true,
      "the delete removed an agent the user never asked to delete");
    assert.equal(index.storeConnections.has(kept.id), true,
      "the delete closed a store.db handle belonging to an agent that stays");
  } finally {
    index.closeAll();
    dropRoot(base);
  }
});

test("the release is asked for before the agent directory is unlinked", async () => {
  const { base, rootDir } = makeRoot();
  const index = new BoxSearchIndex(rootDir);
  const observed = [];
  try {
    const store = new SandAgentSessionStore(rootDir);
    const victim = await store.createSession({ name: "Ordered", description: "" });
    index.reconcile();
    assert.equal(index.storeConnections.has(victim.id), true,
      "the fixture holds no store.db, so the ordering it observes means nothing");

    const unsubscribe = subscribeTranscriptMutations((mutation) => {
      if (mutation.kind !== "agent-removed" || mutation.agentId !== victim.id) return;
      observed.push({
        directoryStillOnDisk: existsSync(path.join(rootDir, victim.id)),
        handleStillHeld: index.storeConnections.has(victim.id),
      });
    });
    try {
      await store.deleteSession(victim.id);
    } catch {
      // Swallowed on purpose: this test is about the order of the announcement,
      // and a delete that also fails must still reach the assertions below.
    } finally {
      unsubscribe();
    }

    assert.equal(observed.length, 1,
      "the delete never asked any other holder of store.db to let go of it");
    assert.equal(observed[0].directoryStillOnDisk, true,
      "the delete announced the removal after it had already unlinked the directory, so every holder released its handle too late for the unlink");
    assert.equal(observed[0].handleStillHeld, true,
      "the handle was already gone when the removal was announced, so this test cannot tell a before-the-unlink release from an after-it one");
  } finally {
    index.closeAll();
    dropRoot(base);
  }
});

test("a store.db nobody releases is reported instead of being called deleted", async () => {
  const { base, rootDir } = makeRoot();
  let foreignHandle = null;
  try {
    const store = new SandAgentSessionStore(rootDir);
    const victim = await store.createSession({ name: "Stuck", description: "" });
    foreignHandle = new DatabaseSync(path.join(rootDir, victim.id, "store.db"), { readOnly: true });

    let failure = null;
    try {
      await store.deleteSession(victim.id);
    } catch (error) {
      failure = error;
    }

    assert.notEqual(failure, null,
      "the delete reported success while a holder still had store.db open, which is how a deleted agent kept its slot");
    assert.equal(failure.code, "SandAgentDeleteIncompleteError",
      "the caller cannot tell an incomplete delete from any other failure");
    assert.match(failure.message, /store\.db/,
      `the error does not name the file that is still held: ${failure.message}`);
    assert.match(failure.message, new RegExp(victim.id),
      "the error does not name the agent the user asked to delete");
  } finally {
    try { foreignHandle?.close(); } catch {}
    dropRoot(base);
  }
});

test("a directory a failed delete left behind is reclaimed once its holder lets go", async () => {
  const { base, rootDir } = makeRoot();
  let foreignHandle = null;
  try {
    const store = new SandAgentSessionStore(rootDir);
    const victim = await store.createSession({ name: "Recoverable", description: "" });
    const doomedId = victim.id;
    const beingDeleted = new Set([doomedId]);
    store.setBeingDeletedPredicate((id) => beingDeleted.has(id));
    foreignHandle = new DatabaseSync(path.join(rootDir, doomedId, "store.db"), { readOnly: true });

    await assert.rejects(store.deleteSession(doomedId),
      "the delete claimed to have removed an agent whose store.db was still held");
    assert.equal(existsSync(path.join(rootDir, doomedId)), true,
      "the test does not reproduce the leftover directory the live box keeps after every delete");

    foreignHandle.close();
    foreignHandle = null;
    await store.isAgentCapReached();

    assert.equal(existsSync(path.join(rootDir, doomedId)), false,
      "the leftover directory keeps its slot forever once the holder is gone, so the cap stays out of reach");
  } finally {
    try { foreignHandle?.close(); } catch {}
    dropRoot(base);
  }
});

// Copied from tests/agent-maintenance-false-success.test.mjs: there is no shared
// loader in this repository, and this harness is the shape that lets an
// `AgentLifecycle` run against a `sessionStore` that refuses to delete.
function createLifecycleHarness({ existingAgentIds = [], lockedAgentIds = new Set() } = {}) {
  const calls = [];
  const dirs = new Set(existingAgentIds);
  const sessions = {
    activeSession: null,
    loaded: false,
    deletedAgentIds: new Set(),
    liveSessions: new Map(),
    pendingSessionOpens: new Map(),
    tryEnsureSession: async () => null,
    openSessionOnce: async (id) => ({ id }),
    invalidateDeferredActivation() {},
    setActiveSession() {},
    setActiveTranscript() {},
    clearActiveTranscript() {},
  };
  const tm = {
    sessions,
    sessionStore: {
      agentDirExists: (id) => dirs.has(id),
      getAgentProfileText: () => ({ name: "Old", description: "Old description" }),
      writeAgentProfileFile: (id, profile) => calls.push(["writeAgentProfileFile", id, profile]),
      updateAgentProfile: async (id, profile) => ({ id, ...profile }),
      summarizeOpenSession: async (session) => ({ id: session.id }),
      deleteSession: async (id) => {
        calls.push(["deleteSession", id]);
        if (lockedAgentIds.has(id)) {
          // The shape `removeAgentDirOrFail` produces when a holder never lets go.
          const error = new Error(
            `Agent ${id} was not deleted: this app still holds store.db, store.db-wal, store.db-shm. Its slot stays taken. Quit the app, delete the folder C:\\agents\\${id}, then start it again.`,
          );
          error.code = "SandAgentDeleteIncompleteError";
          throw error;
        }
        dirs.delete(id);
      },
      listAgents: async () => [],
      listAgentRecordIds: async () => [...dirs],
      createFallbackSession: async () => { throw new Error("no fallback session is available"); },
      markSessionViewed: async () => {},
      releaseSession: async (id) => calls.push(["releaseSession", id]),
    },
    trayErrors: { clearForAgent: () => {} },
    runnerRegistry: { runners: new Map(), activeGroupMemberRunners: new Map() },
    onAgentForgotten: (id) => calls.push(["forgotten", id]),
    pendingWakeStore: { clearAgent: () => {} },
    boxHandoff: { boxHandoffs: new Map(), awaitingSink: new Map() },
    roster: {
      emitAsyncTasksForAgent: () => {},
      emitAgents: async () => {},
      forgetAgentSubagentWork: () => {},
      lastRunnerAsyncTasks: new Map(),
      reserveSnapshotStamp: () => "stamp-1",
      emitAgentUpdate: async () => {},
      emitProfileChanged: () => {},
      finalizeSummaryForRpc: (summary) => summary,
    },
    runLifecycle: {
      runningAgentIds: () => new Set(),
      drainExclusiveRuns: async () => {},
      closeSessionWhenIdle: () => {},
    },
    ackObligations: { markAckObligationLost: () => {}, ackRunTokens: new Map() },
    backgroundWakes: {
      pendingSubagentCompletions: new Map(),
      pendingShellCompletions: new Map(),
      pendingInbound: new Map(),
      pendingAgentInbound: new Map(),
      pendingChannelFailures: new Map(),
      dmPreemptedWakeAgentIds: new Map(),
    },
    groupChat: { dmPreemptedGroupMemberIds: new Map() },
    telemetry: { reportTurnInterrupt: () => {} },
    unwatchActiveSession: () => {},
  };
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);
  return { tm, lifecycle, calls, dirs, sessions };
}

test("the person deleting an agent is told which files are still held", async () => {
  const { lifecycle: manager } = createLifecycleHarness({
    existingAgentIds: ["agent-a"],
    lockedAgentIds: new Set(["agent-a"]),
  });

  let failure = null;
  try {
    await manager.deleteAgent("agent-a");
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof SandAgentLifecycleError,
    "the delete answered success for an agent that stayed on disk");
  assert.match(failure.message, /store\.db/,
    `the caller got a log tag instead of the sentence that names the blocker: ${failure.message}`);
  assert.match(failure.message, /Quit the app/,
    `the caller was not told what to do about it: ${failure.message}`);
});
