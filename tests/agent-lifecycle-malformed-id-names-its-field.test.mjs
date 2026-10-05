import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A missing agent id used to be built into a path. Every agent-scoped write in
 * the lifecycle starts by asking the store whether the agent is on disk, and the
 * store joins that id onto the agent root, so a request that left the field out
 * reached `node:path` and answered `500 {"error":"The \"path\" argument must be
 * of type string. Received undefined"}`. Measured on a live box, that sentence
 * came back from `deleteAgent`, `updateAgent`, `setAgentHiddenFromSidebar`,
 * `setAgentNotifyOnUpdates` and `setAgentNotificationsEnabled`.
 *
 * The gateway edge now refuses the request by name, and that is not enough: the
 * coordinator reaches this class directly — `transcript-manager.ts` delegates
 * `deleteAgent`, `deleteAgents`, `updateAgent`, `setAgentUnread`,
 * `setAgentNotifyOnUpdates` and `setAgentHiddenFromSidebar` to `agentLifecycle`
 * — so the same call with the same missing field never passed the gateway at
 * all. The guard has to be here for the second door to be shut.
 *
 * These tests call the lifecycle with a real store and a real `node:path`, so a
 * missing guard produces the runtime sentence rather than a stub's imitation of
 * it. They fail against the unguarded class and pass against this one, and they
 * pin the other half: a well-formed id still reaches the store, and an id that is
 * a real uuid nobody created still gets the refusal that names the agent.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-lifecycle-id-"));
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
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

const NEVER_EXISTED = "c4a91e07-58b2-4f3d-9e6a-0d2b7f1c6a85";

/** The text of a runtime call, and of the path it was handed. */
const RUNTIME_TEXT =
  /must be of type string|Cannot read properties of|Cannot read property|Expected \d+ arguments/;

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-lifecycle-id-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

function makeLifecycle(rootDir) {
  const sessionStore = new SandAgentSessionStore(rootDir);
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
      finalizeSummaryForRpc: (summary) => summary,
      reserveSnapshotStamp: () => 1,
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
  return { lifecycle, sessionStore };
}

const refuse = async (invoke) => {
  try {
    await invoke();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const OPERATIONS = [
  ["deleteAgent", (lifecycle, id) => lifecycle.deleteAgent(id)],
  ["deleteAgents", (lifecycle, id) => lifecycle.deleteAgents([id])],
  ["updateAgent", (lifecycle, id) => lifecycle.updateAgent(id, { name: "Renamed" })],
  ["setAgentNotifyOnUpdates", (lifecycle, id) => lifecycle.setAgentNotifyOnUpdates(id, true)],
  ["setAgentHiddenFromSidebar", (lifecycle, id) => lifecycle.setAgentHiddenFromSidebar(id, true)],
];

/** The shapes a request can carry when the field was never filled in. */
const MALFORMED_IDS = [undefined, null, 42, "", []];

test("no agent-scoped command turns a missing id into a path", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);
    const refusals = [];

    for (const [command, run] of OPERATIONS) {
      for (const id of MALFORMED_IDS) {
        const message = await refuse(() => run(lifecycle, id));
        refusals.push([command, JSON.stringify(id) ?? "undefined", message]);
        assert.doesNotMatch(message ?? "", RUNTIME_TEXT,
          `${command} answered ${JSON.stringify(id)} with the text of a runtime call: "${message}"`);
        assert.match(message ?? "", new RegExp(`Malformed ${command} request`),
          `${command} answered ${JSON.stringify(id)} with "${message}", which names neither the command nor that the request is malformed`);
        assert.ok((message ?? "").includes('"id"'),
          `${command} answered ${JSON.stringify(id)} with "${message}", which does not name the field "id"`);
      }
    }

    assert.equal(refusals.length, OPERATIONS.length * MALFORMED_IDS.length,
      "the sweep did not run every command and every malformed id it claims to, so the class is not closed");
  } finally {
    dropRoot(base);
  }
});

test("a malformed id creates nothing on disk", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);
    for (const [command, run] of OPERATIONS) await refuse(() => run(lifecycle, undefined));

    assert.deepEqual(
      (await import("node:fs")).readdirSync(rootDir),
      [],
      "a refused command created a directory for an id that was never one, and that directory holds a slot of the fifty-agent cap",
    );
  } finally {
    dropRoot(base);
  }
});

test("an id that is a real uuid nobody created still gets the refusal that names the agent", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);
    for (const [command, run] of OPERATIONS) {
      const message = await refuse(() => run(lifecycle, NEVER_EXISTED));
      assert.match(message ?? "", new RegExp(NEVER_EXISTED),
        `${command} refused an id that names nothing with "${message}", which does not name the agent, so a caller holding several ids cannot tell which one is gone`);
      assert.doesNotMatch(message ?? "", RUNTIME_TEXT,
        `${command} answered a well-formed id with the text of a runtime call: "${message}"`);
    }
  } finally {
    dropRoot(base);
  }
});

test("a well-formed id still reaches the store", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const session = await sessionStore.createSession({ name: "Real", description: "" });

    await lifecycle.updateAgent(session.id, { name: "  Renamed  " });
    assert.equal(sessionStore.getAgentProfileText(session.id).name, "Renamed",
      "the guard refused a well-formed update, so the rename never reached the profile");

    await lifecycle.setAgentHiddenFromSidebar(session.id, true);
    await lifecycle.setAgentNotifyOnUpdates(session.id, false);

    const deleted = await lifecycle.deleteAgent(session.id);
    assert.deepEqual(deleted.deleted, [session.id],
      "the guard stopped a well-formed delete, so the agent stayed on disk while the caller was told it was deleted");
  } finally {
    dropRoot(base);
  }
});
