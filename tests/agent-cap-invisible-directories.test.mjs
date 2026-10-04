import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";

// `POST /api/createAgent` answered `409 Agent limit of 50 reached` while the
// sidebar showed forty-five agents, and no delete ever freed a slot. The cap
// counts directories, and directories outlived their agents for two separate
// reasons. A directory with no `store.db` was never reclaimed. A directory with
// nothing but `store.db` was worse: it came back after its agent was deleted,
// because `new SandAgentDb(...)` runs `mkdirSync(dirname(dbPath))` before it
// opens anything, so one late read of the deleted agent's database rebuilt it.
// Nothing removed it, because `reclaimDanglingAgentDirs` only removes a
// directory without a database and `isPrunedPlaceholder` answered "not a
// placeholder" on both of its branches — the missing-database branch returned
// `false`, and the other asked `summarizeAgentById`, which summarizes with
// `includeBlank: true` and therefore never returns `null`. The transcript manager
// kept the deleted id in its deleted set for the rest of the run, so the roster
// hid the leftover and the user could not delete it either. On top of that a
// delete whose `rm` gave up half way answered `deleted` for an agent that was
// still on disk. The tests below fail against that code and pass against this
// one, and every one of them runs on its own temporary root.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agent-cap-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "session", "agent-db.ts"],
  ["host", "extensions", "session", "agent-session.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const { ensureAgentDbDirectory } = loaded["agent-db.mjs"];
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { SandSessionMaterialization, MAX_AGENTS_PER_USER } = loaded["session-materialization.mjs"];
const { AgentLifecycle, SandAgentLifecycleError } = loaded["agent-lifecycle.mjs"];

/**
 * Opening a store no longer creates the directory it reads from, so minting has
 * to. The production host does this in a subclass of the materialization
 * (`extensions/session/production.ts`); this is the same line, so the cap is
 * still decided by the real materialization rather than by a stub.
 */
class ExplicitDirectoryMaterialization extends SandSessionMaterialization {
  async materializeSession(agentId, profile, origin, purpose) {
    ensureAgentDbDirectory(path.join(this.host.rootDir, agentId, "store.db"));
    return await super.materializeSession(agentId, profile, origin, purpose);
  }
}

test.after(() => dispose());

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-agents-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

/**
 * Wires the store the way the host does: a real materialization over the real
 * `SandSessionMaterialization`, so the cap is decided by the code under test
 * rather than by a stub that counts directories the way the old code did.
 */
function makeStore(rootDir) {
  const store = new SandAgentSessionStore(rootDir);
  store.materialization = new ExplicitDirectoryMaterialization({
    ctx: {},
    rootDir,
    createBlobWorkerPool: () => ({ connections: new Map() }),
    createAgentStore: () => ({ dispose: async () => {} }),
    createMemoryStore: () => ({}),
    resolveUserTimeZone: () => undefined,
    agentExists: (agentId) => store.agentExists(agentId),
    getAgentDir: (agentId) => store.getAgentDir(agentId),
    readActiveAgentId: () => store.readActiveAgentId(),
    report: () => {},
  });
  return store;
}

async function createNamedAgent(store, name) {
  const session = await store.createSession({ name, description: "" });
  await store.releaseSession(session.id);
  return session.id;
}

/**
 * Builds the state the box was found in: a real directory that the roster does
 * not show. It has a database and a profile, but the profile carries no name,
 * no description and no title, and the agent never received a message, so
 * `listAgents` drops it while the cap, which counts directories, keeps counting
 * it. This is what a directory that survives a half-finished delete looks
 * like once the product has written the defaults into it.
 */
async function makeLeftoverDirectory(store) {
  const session = await store.createSession({ name: "", description: "" });
  await store.releaseSession(session.id);
  await rm(path.join(store.getAgentDir(session.id), "settings.json"), { force: true });
  return session.id;
}

test("the cap stops counting directories the roster cannot show", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    for (let index = 0; index < MAX_AGENTS_PER_USER - 5; index++)
      await createNamedAgent(store, `Live ${index}`);
    const leftovers = [];
    for (let index = 0; index < 5; index++)
      leftovers.push(await makeLeftoverDirectory(store));

    assert.equal((await store.listAgentIds()).length, MAX_AGENTS_PER_USER,
      "the test proves nothing unless the disk really holds a full cap of directories");
    assert.equal((await store.listAgents()).length, MAX_AGENTS_PER_USER - 5,
      "the leftover directories were supposed to be the ones the roster hides");

    assert.equal(await store.isAgentCapReached(), false,
      "five directories the user cannot see kept the cap shut");
    for (const agentId of leftovers)
      assert.equal(existsSync(path.join(rootDir, agentId)), false,
        "a directory the roster cannot show still occupies a slot after the cap check");
    assert.equal((await store.listAgentIds()).length, MAX_AGENTS_PER_USER - 5,
      "the reclaim removed live agents instead of the leftover directories");
    assert.equal((await store.listAgents()).length, MAX_AGENTS_PER_USER - 5,
      "the roster lost an agent that the reclaim was supposed to keep");
  } finally {
    dropRoot(base);
  }
});

test("a directory with no store.db is a placeholder, not a kept agent", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    const materialization = store.materialization;
    const agentId = "55555555-5555-4555-8555-555555555555";
    mkdirSync(path.join(rootDir, agentId), { recursive: true });
    writeFile(path.join(rootDir, agentId, "profile.json"), "{}");

    assert.equal(await materialization.isPrunedPlaceholder(agentId), true,
      "a directory with no database answered 'not a placeholder' and held its cap slot forever");
  } finally {
    dropRoot(base);
  }
});

test("a late read of a deleted agent's database does not keep a cap slot", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    const deletedId = await createNamedAgent(store, "Doomed");
    await store.deleteSession(deletedId);
    assert.equal(existsSync(path.join(rootDir, deletedId)), false,
      "the delete left the agent on disk, so the rest of this test proves nothing");

    // One late read of the database of an agent that no longer exists. This is
    // what an in-flight roster pass or a queued unread marker does. The store
    // used to `mkdirSync` its directory first, so the read handed back a fresh,
    // empty database inside a brand new directory that held a cap slot nobody
    // could see or delete.
    await store.markAgentViewed(deletedId).catch(() => {});
    assert.equal(existsSync(path.join(rootDir, deletedId)), false,
      "reading the store of a deleted agent rebuilt its directory, so the cap slot it held was never freed");
    assert.deepEqual(await readdir(rootDir), [],
      "the leftover this defect leaves behind is a directory holding exactly one empty store.db");

    const deleted = new Set([deletedId]);
    store.setBeingDeletedPredicate((agentId) => deleted.has(agentId));
    try {
      await store.isAgentCapReached();
      assert.equal(existsSync(path.join(rootDir, deletedId)), false,
        "a directory rebuilt for an agent that was already deleted held its cap slot forever");
    } finally {
      store.setBeingDeletedPredicate(() => false);
    }
  } finally {
    dropRoot(base);
  }
});

test("a delete that cannot remove the directory fails instead of reporting success", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    const agentId = await createNamedAgent(store, "Busy");
    const dbPath = path.join(rootDir, agentId, "store.db");
    const holder = new DatabaseSync(dbPath);
    holder.exec("SELECT count(*) FROM sqlite_master");

    let failure = null;
    try {
      await store.deleteSession(agentId);
    } catch (error) {
      failure = error;
    }
    assert.notEqual(failure, null,
      "the delete answered success while the directory was still on disk");
    assert.equal(failure?.code, "SandAgentDeleteIncompleteError",
      "the caller cannot tell that the agent stayed on disk from an ordinary filesystem error");
    assert.ok(Array.isArray(failure?.leftovers) && failure.leftovers.includes("store.db"),
      "the failure did not say which file kept the agent on disk");
    assert.equal(existsSync(path.join(rootDir, agentId)), true,
      "the test proves nothing unless the held handle really kept the directory");

    holder.close();
    await store.deleteSession(agentId);
    assert.equal(existsSync(path.join(rootDir, agentId)), false,
      "the agent stayed on disk after the handle that blocked it was released");
  } finally {
    dropRoot(base);
  }
});

function createLifecycleHarness({ existingAgentIds = [], lockedAgentIds = new Set() } = {}) {
  const dirs = new Set(existingAgentIds);
  const sessions = {
    activeSession: null,
    loaded: false,
    deletedAgentIds: new Set(),
    liveSessions: new Map(),
    pendingSessionOpens: new Map(),
    tryEnsureSession: async () => null,
    invalidateDeferredActivation() {},
    setActiveSession() {},
    setActiveTranscript() {},
    clearActiveTranscript() {},
  };
  const tm = {
    sessions,
    sessionStore: {
      agentDirExists: (id) => dirs.has(id),
      getAgentProfileText: () => null,
      writeAgentProfileFile() {},
      updateAgentProfile: async () => null,
      summarizeOpenSession: async () => null,
      deleteSession: async (id) => {
        if (lockedAgentIds.has(id)) {
          const error = new Error(`EBUSY: resource busy or locked, unlink '${id}\\store.db'`);
          error.code = "EBUSY";
          throw error;
        }
        dirs.delete(id);
      },
      listAgents: async () => [],
      listAgentRecordIds: async () => [...dirs],
      createFallbackSession: async () => {
        throw new Error("no fallback session is available");
      },
      markSessionViewed: async () => {},
      releaseSession: async () => {},
    },
    trayErrors: { clearForAgent: () => {} },
    runnerRegistry: { runners: new Map(), activeGroupMemberRunners: new Map() },
    onAgentForgotten: () => {},
    pendingWakeStore: { clearAgent: () => {} },
    boxHandoff: { boxHandoffs: new Map(), awaitingSink: new Map() },
    roster: {
      emitAsyncTasksForAgent: () => {},
      emitAgents: async () => {},
      forgetAgentSubagentWork: () => {},
      lastRunnerAsyncTasks: new Map(),
      reserveSnapshotStamp: () => "stamp-1",
      emitAgentUpdate: async () => {},
      emitProfileChanged: async () => {},
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
  return { tm, lifecycle, dirs, sessions };
}

test("deleting one agent that stays on disk is an error, not a successful delete", async () => {
  const { lifecycle } = createLifecycleHarness({
    existingAgentIds: ["agent-a"],
    lockedAgentIds: new Set(["agent-a"]),
  });

  await assert.rejects(
    () => lifecycle.deleteAgent("agent-a"),
    (error) => error instanceof SandAgentLifecycleError && /EBUSY/.test(error.message),
    "a delete that left the agent on disk answered success and closed the caller's dialog",
  );
});

test("a delete that removed the agent forgets its deleted mark", async () => {
  const { lifecycle, sessions } = createLifecycleHarness({ existingAgentIds: ["agent-a"] });

  const result = await lifecycle.deleteAgent("agent-a");

  assert.deepEqual(result.deleted, ["agent-a"],
    "the agent that was removed from disk was not reported as deleted");
  assert.equal(sessions.deletedAgentIds.has("agent-a"), false,
    "the deleted mark outlived the directory, so a rebuilt one would be hidden from the user forever");
});