import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// An operation about a deleted agent rebuilt that agent's directory, and the
// rebuilt directory answered with a failure about something else.
//
// `AgentLifecycle` refuses a stale id on the commands the user presses from the
// sidebar (`updateAgent`, `setAgentUnread`, `setAgentNotifyOnUpdates`,
// `setAgentHiddenFromSidebar`, `setAgentAvatarBytes`) and on `deleteAgent`,
// `duplicateAgent` and `deleteAgents`. The automation and routine commands were
// never given the same check, and their stores create directories as a matter of
// course:
//
//   AgentWorkflowEnablement.#write()    mkdirSync(this.agentDir, { recursive: true })
//   WatchedDirectory.startWatching()    mkdirSync(this.root,     { recursive: true })
//   WatchedDirectory.writeFileAtomic()  mkdirSync(dirname(path), { recursive: true })
//
// `automationStoreFor` and `workflowStoreFor` hand out a store rooted at
// `<agentsRoot>/<id>`, so every one of those `mkdirSync` calls is a create of the
// directory a delete removed. A directory that comes back holds a slot of the
// fifty-agent cap that the directory walk counts, while `listAgents` never shows
// it and no delete can reach it. That is the same shape as the settings-reader
// defect this repository already fixed (`ensureSettingsFile`), reached from a
// different command.
//
// Measured on this machine, every command below driven through its real runtime
// over a real `SandAgentSessionStore`, against an id whose directory existed and
// was then deleted:
//
//   createAgentWorkflow        answered 200 (no refusal), no directory
//   updateAgentWorkflow        answered 200 (no refusal), no directory
//   setAgentWorkflowEnabled    answered 200 (no refusal), no directory
//   removeAgentWorkflow        answered 200 (no refusal), no directory
//   importAgentWorkflowMarkdown answered 200 (no refusal), no directory
//   setAgentAutomationEnabled  answered 200 (no refusal), no directory
//   removeAgentAutomation      answered 200 (no refusal), no directory
//   createAgentAutomation      answered 500 AND REBUILT <root>\agents\<id>\automations
//
// Every test below fails against the code as it stood before the guard was added
// to `AutomationRuntime` and `WorkflowCommands`.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-staleagent-"));
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
  for (const [name, file] of names)
    loaded[name] = await import(pathToFileURL(file).href + "?" + Date.now());
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

// One bundle. `statusForCommandError` decides the status with
// `error instanceof SandAgentNotFoundError`, so the class the runtimes raise and
// the class the mapping tests have to be the same class — which they only are
// when both sides come out of one build.
const { loaded, dispose } = await bundle([
  ["host", "gateway-server.ts"],
  ["host", "extensions", "session", "agent-session.ts"],
  ["host", "extensions", "transcript", "automation-runtime.ts"],
  ["host", "extensions", "transcript", "workflow-commands.ts"],
]);
const { statusForCommandError } = loaded["gateway-server.mjs"];
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { AutomationRuntime } = loaded["automation-runtime.mjs"];
const { WorkflowCommands } = loaded["workflow-commands.mjs"];

test.after(() => dispose());

/**
 * A real store, the real automation and routine runtimes over it, and one agent
 * whose directory is on disk and then removed — the shape a real delete leaves,
 * rather than a uuid nobody ever created.
 */
async function makeWorld(deletedIds) {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-staleagent-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  const store = new SandAgentSessionStore(rootDir);
  const tm = {
    sessionStore: store,
    sessions: { activeSession: undefined },
    automationConfigChanged: () => {},
    telemetry: {
      reportTurnInterrupt: () => {},
      reportAgentError: () => {},
      reportAutomationLifecycle: () => {},
      analytics: { trackEvent: () => {} },
    },
    roster: { emitter: { emit: () => {}, on: () => {}, off: () => {} } },
    productAnalytics: { trackEvent: () => {} },
    shouldEmitAutomations: () => false,
    shouldEmitWorkflows: () => false,
  };
  const automationRuntime = new AutomationRuntime(tm);
  const workflowCommands = new WorkflowCommands(tm);
  tm.automationRuntime = automationRuntime;

  const live = (await store.createSession({ name: "Alive" })).id;
  for (const id of deletedIds) {
    const dir = path.join(rootDir, id);
    mkdirSync(dir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    tm,
    store,
    automationRuntime,
    workflowCommands,
    live,
    rootDir,
    dirOf: (id) => path.join(rootDir, id),
    drop: async () => {
      // Windows refuses to unlink an open file and `createSession` handed back a
      // live `store.db` handle, so teardown closes it before it removes anything.
      // Without that the cleanup raises EPERM and hides the real failure.
      await store.releaseSession(live).catch(() => {});
      await store.closeWorkerPool();
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

const GONE = "22222222-2222-4222-8222-222222222222";

const AUTOMATION = {
  name: "Nightly",
  prompt: "do the thing",
  trigger: { type: "cron", schedule: "0 8 * * *" },
  isEnabled: true,
};
const ROUTINE = { name: "Nightly", body: "do the thing", trigger: null };

const COMMANDS = [
  {
    command: "createAgentWorkflow",
    run: (world, id) => world.workflowCommands.createAgentWorkflow(id, ROUTINE),
  },
  {
    command: "updateAgentWorkflow",
    run: (world, id) =>
      world.workflowCommands.updateAgentWorkflow(id, "wf-1", {
        ...ROUTINE,
        body: "changed",
      }),
  },
  {
    command: "setAgentWorkflowEnabled",
    run: (world, id) => world.workflowCommands.setAgentWorkflowEnabled(id, "wf-1", false),
  },
  {
    command: "deleteAgentWorkflow",
    run: (world, id) => world.workflowCommands.deleteAgentWorkflow(id, "wf-1"),
  },
  {
    command: "importAgentWorkflowMarkdown",
    run: (world, id) =>
      world.workflowCommands.importAgentWorkflowMarkdown(id, "# Nightly\n\nDo the thing."),
  },
  {
    command: "portAgentLocalSkills",
    run: (world, id) => world.workflowCommands.portAgentLocalSkills(id),
  },
  {
    command: "createAgentAutomation",
    run: (world, id) => world.automationRuntime.createAgentAutomation(id, AUTOMATION),
  },
  {
    command: "setAgentAutomationEnabled",
    run: (world, id) =>
      world.automationRuntime.setAgentAutomationEnabled(id, "auto-1", false),
  },
  {
    command: "deleteAgentAutomation",
    run: (world, id) => world.automationRuntime.deleteAgentAutomation(id, "auto-1"),
  },
  {
    command: "runAgentAutomationNow",
    run: (world, id) => world.automationRuntime.runAgentAutomationNow(id, "auto-1"),
  },
];

for (const { command, run } of COMMANDS) {
  test(`${command} about a deleted agent is 404 and leaves no directory behind`, async () => {
    const world = await makeWorld([GONE]);
    try {
      assert.equal(existsSync(world.dirOf(GONE)), false,
        "the test proves nothing unless the agent's directory really is gone before the command runs");

      const error = await Promise.resolve()
        .then(() => run(world, GONE))
        .then(() => null, (raised) => raised);

      // The directory first: it is the worse of the two facts, and a caller that
      // only ever sees the status never learns the slot is gone.
      assert.equal(existsSync(world.dirOf(GONE)), false,
        `\`${command}\` rebuilt the directory of an agent that was deleted, and that directory holds a slot of the fifty-agent cap that no roster shows and no delete can reach`);
      assert.equal(statusForCommandError(error), 404,
        `\`${command}\` answered ${statusForCommandError(error)} for an id that names nothing, so a stale id reads as a host fault and the caller retries a request that can never succeed`);
      assert.equal(readdirSync(world.rootDir).includes(GONE), false,
        `\`${command}\` left the agent's name back in the agents root`);
    } finally {
      await world.drop();
    }
  });
}

test("the same commands still work for an agent that is on disk", async () => {
  // The guard has to be narrow in both directions: refusing a real agent would
  // break the whole routines and automations surface, which is a worse failure
  // than the one it replaces.
  const world = await makeWorld([]);
  try {
    const routines = await world.workflowCommands.createAgentWorkflow(world.live, ROUTINE);
    const automations = await world.automationRuntime.createAgentAutomation(world.live, AUTOMATION);

    assert.equal(routines.length, 1,
      "creating a routine for an agent that is on disk stopped working, so the refusal was widened past the ids that exist");
    assert.equal(automations.length, 1,
      "creating an automation for an agent that is on disk stopped working");
    assert.equal(existsSync(world.dirOf(world.live)), true,
      "the live agent's directory disappeared during its own routine creation");
  } finally {
    await world.drop();
  }
});

test("a routine for a deleted agent cannot become a cap slot the roster never shows", async () => {
  // The whole reason this matters: `countAgents` is the directory walk, and a
  // directory that comes back is counted by it and listed by nothing.
  const world = await makeWorld([GONE]);
  try {
    await Promise.resolve()
      .then(() => world.automationRuntime.createAgentAutomation(GONE, AUTOMATION))
      .catch(() => undefined);

    assert.equal(readdirSync(world.rootDir).includes(GONE), false,
      "the automation store recreated the agents root entry for an id that names nothing, and the cap is computed from that directory");
  } finally {
    await world.drop();
  }
});
