import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Agent maintenance answered with a false success. `updateAgent` called
// `profile.description.trim()` with no guard, so a profile carrying only a name
// answered `500 Cannot read properties of undefined (reading 'trim')`, and the
// same call on an id with no directory on disk answered `200` with a full agent
// object and fresh timestamps because `sessionStore.updateAgentProfile` opens a
// database that does not exist and creates it. `deleteAgents` on an empty set
// answered `200 { transcript: [...] }`, and one locked agent aborted a batch
// after the hosts deleted nothing and released no box. `setAgentNotificationsEnabled`
// was `async () => undefined`: the switch in the UI reported success and changed
// nothing. Every test below fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-lifecycle-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
  ["host", "host-gateway-api.ts"],
]);
const { AgentLifecycle, SandAgentLifecycleError } = loaded["agent-lifecycle.mjs"];
const { createHostGatewayApi } = loaded["host-gateway-api.mjs"];

test.after(() => dispose());

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
      updateAgentProfile: async (id, profile) => {
        calls.push(["updateAgentProfile", id, profile]);
        return { id, name: profile.name, description: profile.description };
      },
      summarizeOpenSession: async (session) => ({ id: session.id }),
      deleteSession: async (id) => {
        calls.push(["deleteSession", id]);
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

test("a profile that carries only a name is applied instead of throwing on description.trim", async () => {
  const { tm, lifecycle, calls } = createLifecycleHarness({ existingAgentIds: ["agent-1"] });

  const summary = await lifecycle.updateAgent("agent-1", { name: "  Renamed  " });

  assert.equal(summary.name, "Renamed",
    "the submitted name never reached the stored profile");
  assert.equal(summary.description, "Old description",
    "the omitted description was dropped instead of keeping the stored one");
  assert.equal(calls.some(([name]) => name === "updateAgentProfile"), true,
    "the profile was never written for an agent that exists on disk");
});

test("updating an agent id with no directory on disk is an error, not a new agent", async () => {
  const { tm, lifecycle, calls } = createLifecycleHarness({ existingAgentIds: [] });
  const inventedId = "00000000-0000-4000-8000-000000000000";

  await assert.rejects(
    () => lifecycle.updateAgent(inventedId, { name: "x", description: "y" }),
    (error) => error instanceof SandAgentLifecycleError,
    "a caller that invented an id was told the update succeeded",
  );
  assert.equal(
    calls.some(([, id]) => id === inventedId),
    false,
    "the profile of a nonexistent agent was written anyway, which creates the directory",
  );
});

test("deleting an agent id with no directory on disk is an error, not an empty transcript", async () => {
  const { tm, lifecycle, calls } = createLifecycleHarness({ existingAgentIds: [] });

  await assert.rejects(
    () => lifecycle.deleteAgent("22222222-2222-4222-8222-222222222222"),
    (error) => error instanceof SandAgentLifecycleError,
    "a delete of an id that never existed answered success with a transcript",
  );
});

test("one locked agent no longer cancels the delete of every other agent in the batch", async () => {
  const { tm, lifecycle, calls } = createLifecycleHarness({
    existingAgentIds: ["agent-a", "agent-b"],
    lockedAgentIds: new Set(["agent-b"]),
  });

  const result = await lifecycle.deleteAgents(["agent-a", "agent-b"]);

  assert.deepEqual(result.deleted, ["agent-a"],
    "the healthy agent was not deleted because a second one stayed locked");
  assert.equal(result.failed.length, 1,
    "the caller was not told which agent stayed on disk");
  assert.equal(result.failed[0].agentId, "agent-b",
    "the failure report named the wrong agent");
  assert.match(result.failed[0].error, /EBUSY/,
    "the failure report lost the reason the agent stayed on disk");
  assert.equal(calls.some(([name, id]) => name === "forgotten" && id === "agent-a"), true,
    "the deleted agent was never released from the host bookkeeping");
});

test("setAgentNotificationsEnabled reaches the host instead of resolving to undefined", async () => {
  const seen = [];
  const manager = {
    setAgentNotifyOnUpdates: (id, isEnabled) => {
      seen.push([id, isEnabled]);
      return undefined;
    },
  };
  const api = createHostGatewayApi(createGatewayDeps({ transcript: manager }));
  await api.setAgentNotificationsEnabled({ id: "agent-1", isEnabled: false });

  assert.deepEqual(seen, [["agent-1", false]],
    "the notification switch resolved successfully while the host was never told");
});

test("a failing post-delete step does not abandon the cleanup of the other agents", async () => {
  const released = [];
  const handoffs = [];
  const api = createHostGatewayApi(
    createGatewayDeps({
      releaseAgentBox: async (agentId) => {
        if (agentId === "agent-a") throw new Error("box release refused");
        released.push(agentId);
      },
      onForgetHandoff: (agentId) => handoffs.push(agentId),
    }),
  );

  const result = await api.deleteAgents({ ids: ["agent-a", "agent-b"] });

  assert.deepEqual(handoffs, ["agent-a", "agent-b"],
    "one refused box release cancelled the handoff cleanup of every agent");
  assert.deepEqual(released, ["agent-b"],
    "the second agent was never released from its box");
  assert.equal(result.cleanupFailures?.length, 1,
    "the caller was not told that one cleanup step failed");
  assert.match(result.cleanupFailures[0].error, /releaseAgentBox/,
    "the failure report does not name the step that failed");
});

function createGatewayDeps({
  transcript = {},
  releaseAgentBox = async () => {},
  onForgetHandoff = () => {},
} = {}) {
  const noop = () => undefined;
  const stub = (extra = {}) => ({ ...extra });
  const extensions = {
    api(id) {
      if (id === "transcript")
        return stub({ deleteAgents: async () => ({ transcript: [] }), ...transcript });
      if (id === "session") return stub({ forgetHandoff: (agentId) => onForgetHandoff(agentId) });
      if (id === "automations") return stub({ deleteAgentSchedules: async () => undefined });
      if (id === "cross-user-sharing") return stub({ noteAgentDeleted: async () => undefined });
      if (id === "telemetry") {
        return stub({
          analytics: { markActive: noop, trackEvent: noop },
          logs: { reportAgentOpen: noop },
          noteSandModelExperimentActive: noop,
          reportMessageSent: noop,
        });
      }
      return stub({});
    },
  };
  return {
    extensions,
    hostEvents: { emit: noop },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox,
    handleDesktopMcpAuthCompletion: async () => undefined,
    forgetLocalToolPermission: noop,
    now: () => 0,
  };
}
