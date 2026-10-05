import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The same delete answered two different ways, and the difference was the speed
 * of the second press. Measured on a live box carrying forty-nine agents: two
 * `deleteAgent` calls for one agent, issued together, both answered
 * `200 {deleted:[<id>]}` because both had already read the directory before
 * either removed it. The same two calls, issued one after the other, answered
 * `200 {deleted:[<id>]}` and then `500 No agent directory on disk for <id>` —
 * for an agent that was, at that moment, correctly and completely deleted. A
 * person who pressed "delete" twice saw an error on the state they had asked
 * for. The directory was the only witness that could tell the two cases apart,
 * and a directory that is gone cannot say whether it was deleted or never
 * existed, so the second case was answered as if it were the second.
 *
 * The decision these tests pin: a delete of an agent this process already
 * removed is a success — the requested end state holds, so the answer is a
 * success and `alreadyDeletedAgentIds` names what was gone before the call. A
 * delete of an id that was never on disk is still refused, still with the
 * sentence that names the agent, because "there is nothing to delete" and "you
 * deleted it" are different answers and a caller holding several ids needs to
 * know which one it got.
 *
 * Every test runs against the real `SandAgentSessionStore` over its own
 * temporary root, so the directory the first delete removes is a directory on a
 * disk, and the second delete has to cope with a real absence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-repeat-delete-"));
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
  ["host", "extensions", "session", "agent-session.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { AgentLifecycle, DELETED_AGENT_LEDGER_CAP } =
  loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

/**
 * "This id names no agent" is raised as `SandAgentNotFoundError`, a class this
 * file does not import: it is raised across a bundle boundary from the class's
 * own module, so `instanceof` would answer about the copy in this bundle rather
 * than about the error in hand. The name is the part that crosses.
 */
const AGENT_NOT_FOUND = "SandAgentNotFoundError";

/**
 * The record of removals and the method that writes to it are read directly.
 * `private` is erased by the build, so both are plain members here; reaching for
 * them is what lets the bound be exercised without minting and removing hundreds
 * of real agents, and it is the only way to check that a delete which did *not*
 * remove anything left no trace.
 */
const REMOVED = (lifecycle) => lifecycle.removedAgentIds;
const NOTE_REMOVED = (lifecycle, id) => lifecycle.noteRemoved(id);

const namesTheAgent = (agentId) => (error) =>
  error instanceof Error &&
  error.name === AGENT_NOT_FOUND &&
  error.message.includes(agentId);

/** An id shaped like the ones the app mints, and never handed to a create. */
const NEVER_EXISTED = "b1f0c7a4-2d63-4e58-9a17-6c0e2d5b8f34";

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-repeat-root-"));
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
 * The lifecycle over a real store and a transcript manager whose other halves are
 * recorded. Only the delete path is real; everything the delete touches besides
 * the store and the roster is a recorder that answers.
 */
function makeLifecycle(rootDir) {
  const sessionStore = new SandAgentSessionStore(rootDir);
  const forgotten = [];
  const sessions = {
    activeSession: null,
    loaded: false,
    deletedAgentIds: new Set(),
    liveSessions: new Map(),
    pendingSessionOpens: new Map(),
    tryEnsureSession: async () => null,
  };
  const tm = {
    sessions,
    sessionStore,
    trayErrors: { clearForAgent: () => {} },
    runnerRegistry: { runners: new Map(), activeGroupMemberRunners: new Map() },
    onAgentForgotten: (agentId) => forgotten.push(agentId),
    pendingWakeStore: { clearAgent: () => {} },
    boxHandoff: { boxHandoffs: new Map(), awaitingSink: new Map() },
    roster: {
      emitAsyncTasksForAgent: () => {},
      emitAgents: async () => {},
      forgetAgentSubagentWork: () => {},
      lastRunnerAsyncTasks: new Map(),
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
  };
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);
  return { lifecycle, sessionStore, forgotten };
}

async function mint(sessionStore, name) {
  const session = await sessionStore.createSession({ name, description: "" });
  return session.id;
}

test("deleting the same agent twice is two successes, and the second one says the agent was already gone", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const agentId = await mint(sessionStore, "Pressed Twice");

    const first = await lifecycle.deleteAgent(agentId);
    assert.deepEqual(first.deleted, [agentId],
      "the first delete did not remove the agent, so the second delete below proves nothing");
    assert.equal(existsSync(path.join(rootDir, agentId)), false,
      "the test proves nothing unless the agent directory is really gone before the second delete");

    // The defect: this used to reject with `No agent directory on disk for <id>`
    // for an agent that was already deleted, correctly, by the call above.
    const second = await lifecycle.deleteAgent(agentId);
    assert.deepEqual(second.alreadyDeletedAgentIds, [agentId],
      "the second delete answered success but did not say that the agent had been deleted by the first one");
    assert.deepEqual(second.deleted, [],
      "the second delete claims to have removed an agent it never touched, so the answer is not true");
    assert.deepEqual(second.failed, [],
      "the second delete reported a failure for an agent that is not on disk at all");
  } finally {
    dropRoot(base);
  }
});

test("a delete of an id that was never on disk is still refused, and the refusal names the agent", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    await mint(sessionStore, "Unrelated");

    await assert.rejects(
      () => lifecycle.deleteAgent(NEVER_EXISTED),
      (error) =>
        namesTheAgent(NEVER_EXISTED)(error) &&
        /No agent directory on disk/.test(error.message),
      "a delete of an id that never existed answered success, so a caller that lost the agent id cannot tell a typo from a delete that ran",
    );
    assert.equal(existsSync(path.join(rootDir, NEVER_EXISTED)), false,
      "the refused delete created a directory for an agent nobody created");
  } finally {
    dropRoot(base);
  }
});

test("the second delete of a batch answers success for the ids the first batch removed", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const firstId = await mint(sessionStore, "First");
    const secondId = await mint(sessionStore, "Second");

    await lifecycle.deleteAgents([firstId, secondId]);
    assert.equal(
      existsSync(path.join(rootDir, firstId)) || existsSync(path.join(rootDir, secondId)),
      false,
      "the first batch did not remove both directories, so the second batch proves nothing",
    );

    const repeat = await lifecycle.deleteAgents([firstId, secondId]);
    assert.deepEqual([...repeat.alreadyDeletedAgentIds].sort(), [firstId, secondId].sort(),
      "the repeated batch did not report the agents the first batch had already removed");
    assert.deepEqual(repeat.deleted, [],
      "the repeated batch claims to have deleted agents that were already gone before it started");
  } finally {
    dropRoot(base);
  }
});

test("a batch that mixes an already deleted agent with a live one still deletes the live one", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const goneId = await mint(sessionStore, "Gone");
    const liveId = await mint(sessionStore, "Live");

    await lifecycle.deleteAgent(goneId);
    const result = await lifecycle.deleteAgents([goneId, liveId]);

    assert.deepEqual(result.deleted, [liveId],
      "the live agent in the batch was not deleted because its neighbour had already been deleted");
    assert.deepEqual(result.alreadyDeletedAgentIds, [goneId],
      "the batch did not say which of its ids was already gone before it started");
    assert.equal(existsSync(path.join(rootDir, liveId)), false,
      "the batch reported the live agent as deleted and left its directory on disk");
  } finally {
    dropRoot(base);
  }
});

test("a batch that mixes an id that never existed with a live one deletes the live one and names the absent one", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const liveId = await mint(sessionStore, "Live");

    const result = await lifecycle.deleteAgents([NEVER_EXISTED, liveId]);

    assert.deepEqual(result.deleted, [liveId],
      "the live agent was not deleted because another id in the same batch named nothing");
    assert.deepEqual(result.missingAgentIds, [NEVER_EXISTED],
      "the caller cannot tell which id in the batch named no agent, so a typo is invisible");
    assert.equal(result.alreadyDeletedAgentIds, undefined,
      "an id that never existed was reported as already deleted, which is a claim about a delete that never ran");
  } finally {
    dropRoot(base);
  }
});

test("a batch whose ids are all unknown is refused rather than answered with an empty success", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);

    await assert.rejects(
      () => lifecycle.deleteAgents([NEVER_EXISTED, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"]),
      (error) =>
        error instanceof Error &&
        error.name === AGENT_NOT_FOUND &&
        error.message.includes(NEVER_EXISTED) &&
        error.message.includes("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
      "a batch of two ids that never existed answered success with an empty delete list",
    );
  } finally {
    dropRoot(base);
  }
});

test("an empty batch is still a no-op that answers with the current transcript", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const liveId = await mint(sessionStore, "Untouched");

    const result = await lifecycle.deleteAgents([]);

    assert.ok(Array.isArray(result.transcript),
      "the empty batch no longer answers with a transcript, which is what its caller reads");
    assert.equal(existsSync(path.join(rootDir, liveId)), true,
      "an empty batch deleted the agent that was on disk");
  } finally {
    dropRoot(base);
  }
});

test("only a delete that really removed the directory is remembered as already deleted", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore, forgotten } = makeLifecycle(rootDir);
    const deletedId = await mint(sessionStore, "Removed");
    const survivorId = await mint(sessionStore, "Survivor");

    await lifecycle.deleteAgent(deletedId);

    assert.deepEqual(forgotten, [deletedId],
      "the delete that removed the directory did not reach the host bookkeeping, so nothing can be sure it ran");
    assert.equal(REMOVED(lifecycle).has(deletedId), true,
      "a delete that removed the agent from disk was not recorded, so a repeat delete is refused as if the id never existed");
    assert.equal(REMOVED(lifecycle).has(survivorId), false,
      "an agent that was never deleted is recorded as deleted, so deleting it once more would answer success for a delete that never ran");
    assert.equal(REMOVED(lifecycle).has(NEVER_EXISTED), false,
      "an id nobody ever deleted is recorded as deleted");
  } finally {
    dropRoot(base);
  }
});

test("the record of removed ids stays bounded, because it lives for the life of the process", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const ids = [];
    for (let index = 0; index < 4; index += 1)
      ids.push(await mint(sessionStore, `Agent ${index}`));
    for (const id of ids) await lifecycle.deleteAgent(id);

    assert.equal(REMOVED(lifecycle).size, ids.length,
      "the record does not hold exactly the ids that were deleted, so the count below means nothing");
    for (const id of ids)
      assert.equal(REMOVED(lifecycle).has(id), true,
        `a delete that removed ${id} from disk is not in the record, so a repeat delete of it is refused as if the id never existed`);

    assert.ok(Number.isInteger(DELETED_AGENT_LEDGER_CAP) && DELETED_AGENT_LEDGER_CAP > 0,
      `the record of removed ids has no positive bound (${DELETED_AGENT_LEDGER_CAP}), so it grows for the life of the process`);

    // Filled through the same private the delete path uses, so the bound is
    // exercised without minting and removing hundreds of real agents on disk.
    for (let index = 0; index < DELETED_AGENT_LEDGER_CAP + 8; index += 1)
      NOTE_REMOVED(lifecycle, `synthetic-${index}`);
    assert.ok(REMOVED(lifecycle).size <= DELETED_AGENT_LEDGER_CAP,
      `the record holds ${REMOVED(lifecycle).size} ids for a bound of ${DELETED_AGENT_LEDGER_CAP}: nothing is ever evicted, so a long-running host grows a set of strings nobody can press again`);
    assert.equal(REMOVED(lifecycle).has("synthetic-0"), false,
      "the oldest ids are never evicted, so the bound above only holds while the host stays small");
  } finally {
    dropRoot(base);
  }
});

test("the ledger is per host, so a fresh host answers a repeat delete with the refusal again", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const first = makeLifecycle(rootDir);
    const agentId = await mint(first.sessionStore, "Before The Restart");
    await first.lifecycle.deleteAgent(agentId);

    // A restart builds a new runtime and a new record. The host keeps nothing
    // durable about an agent it deleted, so it cannot claim to know next time.
    const second = makeLifecycle(rootDir);
    await assert.rejects(
      () => second.lifecycle.deleteAgent(agentId),
      namesTheAgent(agentId),
      "a new host claims to remember a delete that happened in a process it never ran, so it answers success for an id it knows nothing about",
    );
  } finally {
    dropRoot(base);
  }
});
