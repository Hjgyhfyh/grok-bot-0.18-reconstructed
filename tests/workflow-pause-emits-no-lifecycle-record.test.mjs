import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Pausing a routine left no trace that it had been paused.
 *
 * `WorkflowCommands` has four mutations that change what the user configured.
 * Three of them — create, update and delete — go through
 * `enqueueWorkflowMutation`, which brackets the store call with
 * `recordInactiveAutomationChanges` (and `recordAutomationChangeEvents` for the
 * active session). That is what emits the `automation-changed` timeline event
 * and the `sand.automation.lifecycle` telemetry row.
 *
 * `setAgentWorkflowEnabled` reached straight past it:
 *
 * ```ts
 * const active = this.tm.sessions.activeSession;
 * if (active?.id === agentId) { active.workflows.setEnabledForAgent(...); ... }
 * return this.tm.sessionStore.setAgentWorkflowEnabled(...);
 * ```
 *
 * so a pause wrote the file and answered with the list, and recorded nothing.
 * Measured before the fix on the real classes: a pause emitted 0 lifecycle
 * records where an update and a delete each emitted 2. It was also the only one
 * of the four that skipped the per-agent queue, so a pause could interleave with
 * a create or with the before/after snapshot a running automation takes of its
 * own diff.
 *
 * Nothing noticed it because the file write itself is correct, and the panel
 * re-renders from the returned list — so the pause looks like it worked. Only
 * the record that a routine changed is missing.
 *
 * These tests pin both halves: the record, and the queue.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-workflow-pause-record-"));
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
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "workflows", "workflow-store.ts"],
  ["host", "extensions", "transcript", "workflow-commands.ts"],
  ["host", "extensions", "transcript", "automation-runtime.ts"],
]);
const { FileWorkflowStore } = loaded["workflow-store.mjs"];
const { WorkflowCommands } = loaded["workflow-commands.mjs"];
const { AutomationRuntime } = loaded["automation-runtime.mjs"];

test.after(() => dispose());

const AGENT_ID = "11111111-2222-3333-4444-555566667777";
const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A transcript manager carrying the real `AutomationRuntime`, so the lifecycle
 * records below are the ones the host really emits.
 */
function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-workflow-pause-record-sand-"));
  roots.push(root);
  const stores = new Map();
  const storeFor = (id) => {
    if (!stores.has(id)) {
      const dir = path.join(root, "agents", id);
      mkdirSync(dir, { recursive: true });
      stores.set(id, new FileWorkflowStore(dir, path.join(root, "workflows"), () => "UTC"));
    }
    return stores.get(id);
  };
  const timeline = [];
  const telemetry = [];
  const tm = {
    sessions: { activeSession: null },
    emitTimelineEvent: (_agentId, event) => timeline.push(event),
    telemetry: { reportAutomationLifecycle: (value) => telemetry.push(value) },
    productAnalytics: { trackEvent: (_name, value) => telemetry.push(value) },
    sessionStore: {
      getUserTimeZone: () => "UTC",
      // The routine commands refuse an id that is not on disk, the same as every
      // other agent write. The agent under test here is `AGENT_ID` and it is
      // there, so the answer is true for every id this harness knows.
      agentDirExists: () => true,
      listAgentAutomations: (id) => storeFor(id).automations.listDefinitions(),
      getAgentWorkflow: (id, workflowId) => storeFor(id).get(workflowId),
      setAgentWorkflowEnabled: (id, workflowId, isEnabled) => {
        const store = storeFor(id);
        store.setEnabledForAgent(workflowId, isEnabled);
        return store.listAll();
      },
      createAgentWorkflow: (id, spec) => {
        const store = storeFor(id);
        store.create(spec);
        return store.listAll();
      },
      updateAgentWorkflow: (id, workflowId, spec) => {
        const store = storeFor(id);
        store.update(workflowId, spec);
        return store.listAll();
      },
      removeAgentWorkflow: (id, workflowId) => {
        const store = storeFor(id);
        store.remove(workflowId);
        return store.listAll();
      },
    },
    shouldEmitAutomations: () => true,
    roster: { emitter: { emit() {}, on() {}, off() {} } },
  };
  tm.automationRuntime = new AutomationRuntime(tm);
  tm.emitTimelineEvent = (_agentId, event) => timeline.push(event);
  const commands = new WorkflowCommands(tm);
  return { root, tm, commands, storeFor, timeline, telemetry };
}

function routineId(store) {
  return store.listAll().find((workflow) => workflow.source === "automation").id;
}

function armedRoutine(h) {
  h.storeFor(AGENT_ID).create({
    name: "Nightly digest",
    description: "",
    body: "Summarise overnight alerts.",
    trigger: { schedule: "0 7 * * *", isEnabled: true },
  });
  return routineId(h.storeFor(AGENT_ID));
}

test("pausing a routine records the same lifecycle evidence an update records", async () => {
  const h = harness();
  const id = armedRoutine(h);
  h.timeline.length = 0;
  h.telemetry.length = 0;

  await h.commands.setAgentWorkflowEnabled(AGENT_ID, id, false);

  assert.equal(
    h.telemetry.length > 0,
    true,
    "a pause changed what the user configured and emitted no sand.automation.lifecycle record at all, where update and delete each emit two",
  );
  assert.equal(
    h.telemetry.some((row) => row.action === "disabled"),
    true,
    "the record has to name the pause; a bare create-or-update row would not tell the user the routine was disarmed",
  );
});

test("an update and a delete on the same routine are the comparison the pause has to match", async () => {
  const h = harness();
  const id = armedRoutine(h);

  h.telemetry.length = 0;
  await h.commands.updateAgentWorkflow(AGENT_ID, id, {
    name: "Nightly digest v2",
    description: "",
    body: "Summarise overnight alerts, longer.",
    trigger: { schedule: "30 7 * * *", isEnabled: true },
  });
  const updateRecords = h.telemetry.length;

  h.telemetry.length = 0;
  await h.commands.deleteAgentWorkflow(AGENT_ID, id);
  const deleteRecords = h.telemetry.length;

  assert.equal(updateRecords > 0, true, "an update is the baseline: it does leave a lifecycle record");
  assert.equal(deleteRecords > 0, true, "a delete is the baseline: it does leave a lifecycle record");
});

test("every mutation of a routine goes through the per-agent queue", async () => {
  const counts = {};
  for (const [label, run] of [
    ["create", (h, id) => h.commands.createAgentWorkflow(id, { name: "a skill", description: "", body: "b", trigger: null })],
    ["pause", (h, id) => h.commands.setAgentWorkflowEnabled(id, id, false)],
    ["update", (h, id) => h.commands.updateAgentWorkflow(id, id, { name: "v2", description: "", body: "b2", trigger: { schedule: "0 8 * * *", isEnabled: false } })],
  ]) {
    const h = harness();
    const id = armedRoutine(h);
    let enqueued = 0;
    const real = h.tm.automationRuntime.enqueueAutomationLifecycleMutation.bind(h.tm.automationRuntime);
    h.tm.automationRuntime.enqueueAutomationLifecycleMutation = (args) => {
      enqueued += 1;
      return real(args);
    };
    await run(h, label === "pause" || label === "update" ? id : AGENT_ID);
    counts[label] = enqueued;
  }

  assert.equal(counts.create, 1, "a create is queued against the agent, so a pause cannot interleave with it");
  assert.equal(counts.pause, 1, "the pause skipped the queue entirely, so it could interleave with a create or with a run taking its own diff");
  assert.equal(counts.update, 1, "an update is queued against the agent, which is what the pause has to match");
});

test("a pause still applies the change, because recording it is not the same as making it", async () => {
  const h = harness();
  const id = armedRoutine(h);

  await h.commands.setAgentWorkflowEnabled(AGENT_ID, id, false);

  assert.equal(
    h.storeFor(AGENT_ID).get(id).trigger.isEnabled,
    false,
    "the record is not a substitute for the pause; the routine must actually be disarmed",
  );
});