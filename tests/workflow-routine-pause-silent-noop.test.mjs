import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Pausing a routine through the wired path did nothing, and answered "done".
 *
 * The Workflows panel owns one enable toggle, and the renderer routes it to
 * `setAgentWorkflowEnabled` — confirmed in the shipped registry chunk
 * `src/app/dist/renderer/assets/index-lA9cgT4O.js`, where
 * `setEnabled:({agentId,workflowId,isEnabled}) => … setAgentWorkflowEnabled({id,workflowId,isEnabled})`.
 * That method lands in `FileWorkflowStore.setEnabledForAgent`, which guards on
 * `this.library.get(id) == null` and returns `null` before it ever reaches
 * `this.enablement.setEnabled`. A routine is not in the global SKILL library —
 * it lives in the per-agent automations store — so the guard rejects it.
 *
 * Neither caller checks the return value: `SandAgentSessionStore
 * .setAgentWorkflowEnabled` calls it and answers `listAll()`, and
 * `WorkflowCommands.setAgentWorkflowEnabled` answers the unchanged list. So the
 * caller receives HTTP 200 and a routine that is still `trigger.isEnabled: true`
 * with a live `nextRunAt`. A nightly job the user believes they paused keeps
 * waking the agent up.
 *
 * Nothing noticed it because the same call works for skills, which are the
 * common case, and because the correct store method already exists:
 * `setTriggerEnabled` pauses the routine properly and is wired to no RPC at all.
 *
 * These tests prove the refusal is reachable through the real
 * `WorkflowCommands.setAgentWorkflowEnabled` and through the real
 * `SandAgentSessionStore.setAgentWorkflowEnabled` body, and that both leave an
 * armed routine behind.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-workflow-pause-"));
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
]);
const { FileWorkflowStore } = loaded["workflow-store.mjs"];
const { WorkflowCommands } = loaded["workflow-commands.mjs"];

test.after(() => dispose());

const AGENT_ID = "11111111-2222-3333-4444-555566667777";
const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** One sandbox per test: the global workflow library is shared by every agent. */
function sandRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-workflow-pause-sand-"));
  roots.push(root);
  return root;
}

/** The exact body of `SandAgentSessionStore.setAgentWorkflowEnabled`, line 351. */
function sessionStoreSetAgentWorkflowEnabled(store, workflowId, enabled) {
  store.setEnabledForAgent(workflowId, enabled);
  return store.listAll();
}

/** A minimal `TranscriptManagerLike` that routes to the real `WorkflowCommands`. */
function transcriptManagerFor(rootDir) {
  const stores = new Map();
  const storeFor = (agentId) => {
    if (!stores.has(agentId)) {
      const agentDir = path.join(rootDir, "agents", agentId);
      mkdirSync(agentDir, { recursive: true });
      stores.set(agentId, new FileWorkflowStore(agentDir, path.join(rootDir, "workflows"), () => "UTC"));
    }
    return stores.get(agentId);
  };
  const tm = {
    sessions: { activeSession: null },
    automationRuntime: {
      enqueueAutomationLifecycleMutation: ({ mutation }) => Promise.resolve(mutation()),
      recordAutomationChangeEvents() {},
      recordInactiveAutomationChanges() {},
      listAgentAutomations: (agentId) => storeFor(agentId).listAll(),
    },
    sessionStore: {
      getUserTimeZone: () => "UTC",
      // Every routine mutation refuses an id that is not on disk, so a stub that
      // models "this agent exists" has to say so.
      agentDirExists: () => true,
      getAgentWorkflow: (agentId, id) => storeFor(agentId).get(id),
      listAgentAutomations: (agentId) => storeFor(agentId).listAll(),
      setAgentWorkflowEnabled: (agentId, id, enabled) =>
        sessionStoreSetAgentWorkflowEnabled(storeFor(agentId), id, enabled),
    },
    shouldEmitAutomations: () => true,
    roster: { emitter: { emit() {}, on() {}, off() {} } },
  };
  return { tm, storeFor };
}

function routineSpec(name) {
  return { name, description: "", body: `Recipe for ${name}.`, trigger: { schedule: "0 7 * * *", isEnabled: true } };
}

function findRoutine(workflows) {
  return workflows.find((workflow) => workflow.source === "automation");
}

test("pausing a routine through the wired method leaves it scheduled and armed", async () => {
  const rootDir = sandRoot();
  const { tm, storeFor } = transcriptManagerFor(rootDir);
  const commands = new WorkflowCommands(tm);
  const store = storeFor(AGENT_ID);
  const created = findRoutine(store.listAll());
  assert.equal(created, undefined, "the fixture starts with no routines");
  store.create(routineSpec("Nightly digest"));

  const before = findRoutine(store.listAll());
  assert.equal(before.trigger.isEnabled, true, "a fresh routine is armed, so a pause has something to undo");
  assert.notEqual(before.nextRunAt, null, "an armed routine advertises the next fire, so the refusal below is observable");

  const answer = await commands.setAgentWorkflowEnabled(AGENT_ID, before.id, false);
  const after = findRoutine(answer);

  assert.equal(answer.length, 1, "the caller was handed a normal-looking list, not an error");
  assert.notEqual(after, undefined, "the routine is still listed, so the caller has no signal that anything failed");
  assert.equal(
    after.trigger.isEnabled,
    false,
    "setAgentWorkflowEnabled(agentId, routineId, false) must stop the routine's trigger; it returned 200 with the routine still armed",
  );
  assert.equal(after.nextRunAt, null, "a paused routine must stop advertising a next fire time");
});

test("the session store answers the same pause with the routine still armed", () => {
  const rootDir = sandRoot();
  const agentDir = path.join(rootDir, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const store = new FileWorkflowStore(agentDir, path.join(rootDir, "workflows"), () => "UTC");
  store.create(routineSpec("Nightly digest"));
  const before = findRoutine(store.listAll());

  const answer = sessionStoreSetAgentWorkflowEnabled(store, before.id, false);
  const after = findRoutine(answer);

  assert.equal(answer.length, 1, "SandAgentSessionStore.setAgentWorkflowEnabled answers the whole list, so the refusal is invisible");
  assert.equal(
    after.trigger.isEnabled,
    false,
    "the session store must honour a pause it was asked for; the routine stayed armed",
  );
});

test("setEnabledForAgent names the reason instead of returning a bare null", () => {
  const rootDir = sandRoot();
  const agentDir = path.join(rootDir, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const store = new FileWorkflowStore(agentDir, path.join(rootDir, "workflows"), () => "UTC");
  store.create(routineSpec("Nightly digest"));
  const routine = findRoutine(store.listAll());

  const refused = store.setEnabledForAgent(routine.id, false);

  assert.notEqual(
    refused,
    null,
    "setEnabledForAgent returned null for a workflow that exists, and both callers read null as 'nothing to do'",
  );
  assert.equal(
    refused.trigger.isEnabled,
    false,
    "the record it returns must already carry the pause it just applied",
  );
});

test("a skill workflow pauses through the same method, which is why the defect survived", () => {
  const rootDir = sandRoot();
  const agentDir = path.join(rootDir, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const store = new FileWorkflowStore(agentDir, path.join(rootDir, "workflows"), () => "UTC");
  const skill = store.create({ name: "Plain skill", description: "", body: "Do the thing.", trigger: null });

  const answer = sessionStoreSetAgentWorkflowEnabled(store, skill.id, false);
  const after = answer.find((workflow) => workflow.id === skill.id);

  assert.equal(after.isEnabledForAgent, false, "a skill workflow pauses correctly on this path, so the routine case is invisible beside it");
  assert.equal(after.trigger, null, "a skill has no trigger to disarm, which is exactly why the two sources behave differently");
});

test("the store can pause a routine, so the missing behaviour is wiring and not capability", () => {
  const rootDir = sandRoot();
  const agentDir = path.join(rootDir, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const store = new FileWorkflowStore(agentDir, path.join(rootDir, "workflows"), () => "UTC");
  store.create(routineSpec("Nightly digest"));
  const routine = findRoutine(store.listAll());

  const paused = store.setTriggerEnabled(routine.id, false);

  assert.notEqual(paused, null, "setTriggerEnabled is the method that knows how to disarm a routine");
  assert.equal(
    paused.trigger.isEnabled,
    false,
    "setTriggerEnabled disarms the routine; setEnabledForAgent does not, so the RPC that the renderer calls cannot",
  );
});