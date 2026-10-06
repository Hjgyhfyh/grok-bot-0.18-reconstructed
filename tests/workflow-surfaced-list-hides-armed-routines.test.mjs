import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A routine that was saved on time disappeared from the list the app shows.
 *
 * `FileWorkflowStore.listAllFrom` returns `[...managed, ...plugins, ...skills,
 * ...autos]`, and `limitSurfacedWorkflows` splits that into the unbounded
 * managed/plugin bucket and `user.slice(0, WORKFLOW_UI_LIMIT)` where `user` is
 * everything else. So skills always sort ahead of routines in `user`, and a
 * routine is the first thing the hundred-slot slice throws away.
 *
 * `SandAgentSessionStore.createAgentWorkflow` answers
 * `limitSurfacedWorkflows(store.listAll())` and `WorkflowCommands` does the
 * same on every create, update, pause and delete. With a hundred skills already
 * in the library — the store's own `WORKFLOW_MAX_PER_AGENT` — the routine is
 * written to disk, armed, and then omitted from the list the caller receives.
 * The Routine panel re-renders from that list, so the routine the user just made
 * is not there, and it is not there on every later refresh either.
 *
 * The count is not a round number by accident: 99 skills and 1 routine still
 * shows the routine, 100 skills and 1 routine hides it, and 100 skills and 10
 * routines hides all ten. That is a truncation, not a cap on creation.
 *
 * These tests pin the boundary exactly, through the real store and the real
 * `limitSurfacedWorkflows`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-workflow-surfaced-"));
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
  ["shared", "workflow-model.ts"],
]);
const { FileWorkflowStore } = loaded["workflow-store.mjs"];
const { limitSurfacedWorkflows, WORKFLOW_MAX_PER_AGENT, WORKFLOW_UI_LIMIT } = loaded["workflow-model.mjs"];

test.after(() => dispose());

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function storeWithSkills(skillCount) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-workflow-surfaced-sand-"));
  roots.push(root);
  const agentDir = path.join(root, "agents", "agent-a");
  mkdirSync(agentDir, { recursive: true });
  const store = new FileWorkflowStore(agentDir, path.join(root, "workflows"), () => "UTC");
  let made = 0;
  for (let index = 1; index <= skillCount && made < WORKFLOW_MAX_PER_AGENT; index += 1)
    if (store.create({ name: `skill ${index}`, description: "", body: `body ${index}`, trigger: null }) != null)
      made += 1;
  return { store, skillsMade: made };
}

function surfaced(store) {
  // The exact list `SandAgentSessionStore.createAgentWorkflow` answers with.
  return limitSurfacedWorkflows(store.listAll());
}

test("a routine created under a full skill library is armed but missing from the answer", () => {
  const { store, skillsMade } = storeWithSkills(WORKFLOW_MAX_PER_AGENT);
  assert.equal(skillsMade, WORKFLOW_MAX_PER_AGENT, "the fixture fills the library so the slice has to drop something");

  const created = store.create({
    name: "Brand new routine",
    description: "",
    body: "Run me every morning.",
    trigger: { schedule: "0 7 * * *", isEnabled: true },
  });
  assert.notEqual(created, null, "the routine was written to disk; it is not a refused create");

  const answer = surfaced(store);
  assert.equal(
    answer.some((workflow) => workflow.id === created.id),
    true,
    "createAgentWorkflow must answer with the routine it just created; the routine was saved, armed, and then omitted",
  );
});

test("the boundary is exact: the hundredth skill is what starts hiding routines", () => {
  const { store: atNinetyNine } = storeWithSkills(99);
  const visibleAt99 = atNinetyNine.create({
    name: "r99", description: "", body: "b", trigger: { schedule: "0 7 * * *", isEnabled: true },
  });
  assert.equal(
    surfaced(atNinetyNine).some((workflow) => workflow.id === visibleAt99.id),
    true,
    "ninety-nine skills and one routine still fits in the surfaced list, so this is a truncation and not a cap on creation",
  );

  const { store: atOneHundred } = storeWithSkills(100);
  const hidden = atOneHundred.create({
    name: "r100", description: "", body: "b", trigger: { schedule: "0 7 * * *", isEnabled: true },
  });
  assert.equal(
    surfaced(atOneHundred).some((workflow) => workflow.id === hidden.id),
    true,
    "at one hundred skills the routine is saved but the hundred-slot slice discards it, because skills sort before routines",
  );
});

test("truncation hides armed routines rather than refusing to create them", () => {
  const { store } = storeWithSkills(95);
  for (let index = 1; index <= 10; index += 1)
    store.create({
      name: `routine ${index}`,
      description: "",
      body: `body ${index}`,
      trigger: { schedule: `0 ${index} * * *`, isEnabled: true },
    });

  const onDisk = store.listAll().filter((workflow) => workflow.source === "automation");
  const answer = surfaced(store).filter((workflow) => workflow.source === "automation");

  assert.equal(onDisk.length, 10, "every routine was created and stored");
  assert.equal(answer.length, 10, "all ten armed routines must be listed, because each one fires the agent on its own");
  assert.equal(
    answer.length <= WORKFLOW_UI_LIMIT,
    true,
    "the surfaced list is a display limit, and this assertion documents that it is not a reason to drop a saved routine",
  );
});

test("an armed routine stays visible even when the skill library is completely full", () => {
  const { store } = storeWithSkills(100);
  const created = store.create({
    name: "Hidden but armed", description: "", body: "body", trigger: { schedule: "0 7 * * *", isEnabled: true },
  });

  const onDisk = store.get(created.id);
  const inAnswer = surfaced(store).some((workflow) => workflow.id === created.id);

  assert.notEqual(onDisk, null, "the routine is readable by id, so the list is the only surface that can hide it");
  assert.equal(onDisk.trigger.isEnabled, true, "the routine is armed and fires the agent on its own");
  assert.equal(inAnswer, true, "an armed routine must never be the thing a display limit discards; only inert skills may be truncated");
});

test("the display limit still bounds the list, so the fix does not remove the cap", () => {
  const { store } = storeWithSkills(100);
  for (let index = 1; index <= 5; index += 1)
    store.create({
      name: `armed ${index}`, description: "", body: "b", trigger: { schedule: `0 ${index} * * *`, isEnabled: true },
    });

  const answer = surfaced(store);

  assert.ok(
    answer.length <= WORKFLOW_UI_LIMIT,
    "the surfaced list is still capped, so a library that cannot fit cannot grow the reply without bound",
  );
  assert.equal(
    answer.filter((workflow) => workflow.source === "automation").length,
    5,
    "the cap is spent on skills first, because a routine that wakes the agent cannot be the item that is dropped",
  );
});