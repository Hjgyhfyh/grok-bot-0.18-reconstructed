import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A delete that lost a race with a file handle still took the agent with it —
// and took away everything that agent was still using.
//
// `deleteAgents` marks an id as "being deleted" before it unlinks anything, and
// that mark is what makes the roster stop showing the agent while the delete is
// in flight. Two things were true afterwards when the unlink failed:
//
//   1. The mark was never taken back. `runDeleteAgents` catches a per-agent
//      failure into its `failed` list and carries on, so the `catch` in
//      `deleteAgents` that exists precisely to undo the mark for agents still on
//      disk was unreachable. `session-roster.ts` filters every id the predicate
//      names, so the agent stayed invisible for the rest of the process while its
//      directory sat on disk and `countAgents` — the walk the fifty-agent cap is
//      computed from — kept counting it. The user was told the agent was not
//      deleted and then could not find it, could not delete it from the list, and
//      still had it against the cap.
//
//   2. The gateway ran the post-delete bookkeeping anyway. `deleteAgents` loops
//      over the ids the caller sent, not over the ids the store removed, so a
//      batch whose delete failed still called `forgetDeletedAgent` for that agent:
//      `automations.deleteAgentSchedules` (the agent's cloud automation sync),
//      `session.forgetHandoff` (the handoff that lets it resume on the box),
//      `releaseAgentBox` (the box lease), and a `notification-agent-forgotten`
//      event (the push-notification baseline). Every one of those is a delete, and
//      every one of them was applied to an agent the same answer says is still
//      there.
//
// Measured on a live box, holding one file in the agent directory open with
// `FileShare.None` from another process:
//
//   POST /api/deleteAgents {"ids":["<id>"]}  200 deleted:[] failed:[{agentId,
//     detail:"Agent <id> was not deleted: this app still holds profile.json…"}]
//   POST /api/listAgents                     the id is absent
//   POST /api/countAgents                    the id is still counted
//   <root>\agents\<id>                       still on disk
//
// Releasing the handle and repeating the batch delete removed it, so the delete
// itself was always retryable — what was not recoverable is the roster hiding it
// and the bookkeeping that ran while it was hidden.
//
// Every test below fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-failedel-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

async function buildEntries(entries) {
  const directory = makeBundleDirectory();
  mkdirSync(directory, { recursive: true });
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

const { loaded, dispose } = await buildEntries([
  ["host", "extensions", "session", "agent-errors.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
  ["host", "host-gateway-api.ts"],
]);
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];
const { createHostGatewayApi } = loaded["host-gateway-api.mjs"];

test.after(() => dispose());

/**
 * A roster whose `listAgents` hides an id the way `session-roster.ts` does: the
 * predicate is the only thing that decides, and the lifecycle sets it through
 * `sessions.deletedAgentIds`.
 */
function createLifecycleHarness({ lockedAgentIds = new Set() } = {}) {
  const dirs = new Set(["agent-ok", "agent-locked"]);
  const calls = [];
  const tm = {
    sessions: {
      activeSession: undefined,
      tryEnsureSession: async () => null,
      liveSessions: new Map(),
      pendingSessionOpens: new Map(),
      deletedAgentIds: new Set(),
      openSessionOnce: async () => { throw new Error("no successor"); },
    },
    sessionStore: {
      agentDirExists: (id) => dirs.has(id),
      deleteSession: async (id) => {
        calls.push(["deleteSession", id]);
        if (lockedAgentIds.has(id)) {
          throw Object.assign(
            new Error(`Agent ${id} was not deleted: this app still holds profile.json. Its slot stays taken.`),
            { code: "SandAgentDeleteIncompleteError", leftovers: ["profile.json"] },
          );
        }
        dirs.delete(id);
        return { transcriptLeftovers: [] };
      },
      releaseSession: async () => {},
      listAgents: async () => [],
      listAgentRecordIds: async () => [...dirs],
      getAgentProfileText: () => null,
      getAgentDir: (id) => path.join("root", id),
      updateAgentProfile: async () => null,
      setSessionNotifyOnUpdates: () => {},
      setSessionHiddenFromSidebar: () => {},
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
      emitAgentUpdate: async () => {},
      emitProfileChanged: () => {},
      reserveSnapshotStamp: () => "stamp",
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
    groupChat: { dmPreemptedGroupMemberIds: new Map(), isGroupSession: () => false, isRemoteRoomSession: () => false },
    telemetry: { reportTurnInterrupt: () => {} },
  };
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);
  // The roster's one rule, verbatim from `session-roster.ts`: an id the delete
  // predicate names is not listed, whatever else is true about it.
  const visibleRoster = async () => {
    const rows = [];
    for (const id of dirs) if (!tm.sessions.deletedAgentIds.has(id)) rows.push({ id });
    return rows;
  };
  return { tm, lifecycle, calls, dirs, visibleRoster };
}

test("an agent whose delete failed is still listed by the roster", async () => {
  const { tm, lifecycle, dirs, visibleRoster } = createLifecycleHarness({ lockedAgentIds: new Set(["agent-locked"]) });

  const result = await lifecycle.deleteAgents(["agent-locked"]);

  assert.deepEqual(result.failed.map((entry) => entry.agentId), ["agent-locked"],
    "the harness stopped reproducing a delete that fails, so the rest of this file proves nothing");
  assert.equal(dirs.has("agent-locked"), true,
    "the harness no longer leaves the agent on disk, so there is nothing left to be hidden");
  const listed = await visibleRoster();
  assert.equal(listed.some((agent) => agent.id === "agent-locked"), true,
    "the agent the answer says is still on disk is invisible to the roster, so the user cannot find it, cannot delete it from the list, and still has it against the fifty-agent cap");
  assert.equal(tm.sessions.deletedAgentIds.has("agent-locked"), false,
    "the being-deleted mark outlived the failure, and the roster filters on that mark for the rest of the process");
});

test("a delete that succeeded still hides its agent while it runs and after it finishes", async () => {
  const { tm, lifecycle, visibleRoster } = createLifecycleHarness();

  await lifecycle.deleteAgents(["agent-ok"]);

  const listed = await visibleRoster();
  assert.equal(listed.some((agent) => agent.id === "agent-ok"), false,
    "the roster started showing an agent that was really deleted");
  assert.equal(tm.sessions.deletedAgentIds.has("agent-ok"), false,
    "the mark is dropped on the success path too, so the fix cannot have been 'never mark anything'");
});

test("a batch where one target is locked keeps the other target's bookkeeping and forgets nothing that survived", async () => {
  const { tm, lifecycle, dirs, visibleRoster } = createLifecycleHarness({ lockedAgentIds: new Set(["agent-locked"]) });

  const result = await lifecycle.deleteAgents(["agent-ok", "agent-locked"]);

  assert.deepEqual(result.deleted, ["agent-ok"],
    "the target that could be removed was not, so the fix would have hidden a real failure behind a pass");
  assert.equal(dirs.has("agent-ok"), false, "a successful delete left its directory behind");
  const listed = await visibleRoster();
  assert.equal(listed.some((agent) => agent.id === "agent-locked"), true,
    "the first failure abandoned the second agent's mark, so one locked agent hid the rest of the roster too");
});

/** The gateway batch command, with the post-delete bookkeeping recorded. */
function makeGateway(lifecycle) {
  const bookkeeping = [];
  const transcript = {
    deleteAgents: (ids) => lifecycle.deleteAgents(ids),
    deleteAgent: (id) => lifecycle.deleteAgent(id),
  };
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "transcript") return transcript;
        if (id === "telemetry") return { analytics: { markActive: () => {}, trackEvent: () => {} }, logs: {} };
        if (id === "cross-user-sharing") return { noteAgentDeleted: async () => bookkeeping.push(["noteAgentDeleted", id]) };
        if (id === "session") return { forgetHandoff: (agentId) => bookkeeping.push(["forgetHandoff", agentId]) };
        if (id === "automations") return { deleteAgentSchedules: async (agentId) => bookkeeping.push(["deleteAgentSchedules", agentId]) };
        return {};
      },
    },
    hostEvents: { emit: (event) => bookkeeping.push([event.kind, event.agentId]) },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async (agentId) => { bookkeeping.push(["releaseAgentBox", agentId]); },
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: (agentId) => bookkeeping.push(["forgetLocalToolPermission", agentId]),
  });
  return { api, bookkeeping };
}

test("a batch delete does not run the post-delete bookkeeping for an agent it failed to delete", async () => {
  const { lifecycle } = createLifecycleHarness({ lockedAgentIds: new Set(["agent-locked"]) });
  const { api, bookkeeping } = makeGateway(lifecycle);

  await api.deleteAgents({ ids: ["agent-locked"] });

  const forgotten = bookkeeping.filter(([step]) =>
    step === "deleteAgentSchedules" || step === "forgetHandoff" || step === "releaseAgentBox" || step === "notification-agent-forgotten");
  assert.deepEqual(forgotten, [],
    "the app destroyed the cloud automations, the box handoff and the notification baseline of an agent the same answer reports as still on disk");
});

test("the bookkeeping still runs for the agents the batch really removed", async () => {
  const { lifecycle } = createLifecycleHarness({ lockedAgentIds: new Set(["agent-locked"]) });
  const { api, bookkeeping } = makeGateway(lifecycle);

  await api.deleteAgents({ ids: ["agent-ok", "agent-locked"] });

  const steps = new Set(bookkeeping.map(([step]) => step));
  for (const step of ["deleteAgentSchedules", "forgetHandoff", "releaseAgentBox", "notification-agent-forgotten"]) {
    assert.equal(steps.has(step), true,
      `the fix stopped the bookkeeping for an agent that was really deleted, so ${step} never ran`);
  }
  const forLocked = bookkeeping.filter(([, agentId]) => agentId === "agent-locked");
  assert.deepEqual(forLocked, [],
    "the bookkeeping ran for the id whose delete failed, mixed in with the one that succeeded");
});
