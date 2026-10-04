import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The Task tool was offered with `turn.subagentConfigs` hardcoded to `[]`, and
// `task-subagent-preparation.ts:493` resolves a bare Task call through
// `findSubagentConfigByName(...) ?? subagentConfigs[0]` and throws
// `ToolCallArgParseError("No subagent types are available.")` when that is
// `undefined`. Every subagent dispatch therefore died on the first call, and the
// whole feature read as "subagents do not work" rather than as one empty array.
//
// The second half of this file pins the limits that were absent for the same
// reason: nothing capped how many children a runner could hold open, and nothing
// stopped a subagent from being built as if it were the parent — it was handed
// the parent's turn shell flags, so `buildTurnTools` offered it `Task`, and a
// Task call inside it reached `createSubagentRunner` with no session map to
// dispatch into.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-subagent-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.cjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      // The composition root pulls in CommonJS dependencies (`mime-types` and
      // its internal relative requires), which esbuild can only wire up inside
      // a CommonJS output.
      format: "cjs",
      platform: "node",
      target: "node22",
      mainFields: ["module", "main"],
      logLevel: "silent",
    });
  }
  const require = createRequire(import.meta.url);
  const loaded = {};
  for (const [name, file] of names) loaded[name] = require(file);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "runner", "turn-agent-composition.ts"],
  ["packages", "agent", "tools", "core", "subagent", "subagent-config.ts"],
]);
const {
  buildSandSubagentConfigsForRun,
  createSandGeneralPurposeSubagentConfig,
  SAND_MAX_ACTIVE_SUBAGENTS,
  SAND_MAX_SUBAGENT_DEPTH,
} = loaded["turn-agent-composition.cjs"];

const { getSubagentTypeName } = loaded["subagent-config.cjs"];

test.after(() => dispose());

const NO_BOX = {
  isSubagentRunner: false,
  remoteBoxHasDesktop: false,
  remoteBoxAvailable: true,
  browserUseSubagentEnabled: false,
  isSystemPromptOverridden: false,
  isMultitaskEnabled: false,
};

function names(configs) {
  return configs.map((config) => getSubagentTypeName(config.subagent_type));
}

test("a box with no monitor still offers a subagent to dispatch", () => {
  const configs = buildSandSubagentConfigsForRun(NO_BOX);
  assert.ok(configs.length > 0, "an empty list is what made every Task call throw");
});

test("the first entry is generalPurpose, because that is what a bare Task call resolves to", () => {
  const configs = buildSandSubagentConfigsForRun(NO_BOX);
  assert.equal(
    names(configs)[0],
    "generalPurpose",
    "task-subagent-preparation.ts:493 falls back to subagentConfigs[0], so a different first entry silently changes the default subagent",
  );
});

test("every offered config carries the fields the Task schema reads", () => {
  for (const config of buildSandSubagentConfigsForRun(NO_BOX)) {
    assert.equal(typeof config.description, "string", "Task builds its schema description from this field");
    assert.equal(typeof config.permissionMode, "number", "an absent permissionMode reads as UNSPECIFIED and narrows the subagent");
    assert.equal(
      getSubagentTypeName(config.subagent_type),
      getSubagentTypeName(createSandGeneralPurposeSubagentConfig().subagent_type),
      "sanity: the reader used by the assertion must agree with the factory",
    );
  }
});

test("computerUse and browserUse are absent on a box with no monitor", () => {
  const offered = names(buildSandSubagentConfigsForRun(NO_BOX));
  assert.ok(
    !offered.includes("computerUse") && !offered.includes("browserUse"),
    "the reconstructed box installs noMonitorComputerUseExecutor, so these two types would fail on first dispatch",
  );
});

test("a monitored box gets the desktop subagent types", () => {
  const offered = names(buildSandSubagentConfigsForRun({
    ...NO_BOX,
    remoteBoxHasDesktop: true,
    browserUseSubagentEnabled: true,
  }));
  assert.ok(offered.includes("computerUse"), "a monitored box must be able to delegate a GUI task");
  assert.ok(offered.includes("browserUse"), "browserUse was enabled by the experiment flag");
});

test("the concurrency cap is a number a runner can actually enforce", () => {
  assert.equal(typeof SAND_MAX_ACTIVE_SUBAGENTS, "number", "createSubagentRunner compares against this");
  assert.ok(SAND_MAX_ACTIVE_SUBAGENTS > 0, "a cap of zero would refuse every dispatch");
});

test("the depth cap leaves room for exactly one level of nesting", () => {
  assert.equal(SAND_MAX_SUBAGENT_DEPTH, 1, "a parent may spawn a child; a child may not spawn");
});

// The builder above is only half the fix. The live defect was in the
// composition root, and a green builder proves nothing about it: the runner can
// still hand `buildTurnTools` an empty list. These read the composition source
// for the exact shapes the defect took, so reintroducing either one fails here
// even though the builder stays correct.
const compositionSource = readFileSync(
  path.join(repoRoot, "source", "host", "host-runner-composition.ts"),
  "utf8",
);

test("the runner no longer hands Task an empty subagent list", () => {
  assert.ok(
    !/subagentConfigs:\s*\[\s*\]/.test(compositionSource),
    "an empty list here is what made every Task call throw 'No subagent types are available.'",
  );
  assert.ok(
    /buildSandSubagentConfigsForRun\(/.test(compositionSource),
    "the real list must reach the turn, or the builder is dead code",
  );
});

test("a subagent is no longer spawned without a run shell", () => {
  // The pattern matches an assignment, not a mention: the fix's own comment
  // quotes `productionTurnRunShell: undefined` when explaining the defect, and a
  // guard that cannot tell a comment from code is a guard that rots.
  assert.ok(
    !/productionTurnRunShell:\s*undefined\s*,/.test(compositionSource),
    "a child with no shell and no runStep returns undefined, and createSubagentRunner throws 'production subagent result is not bound'",
  );
  assert.ok(
    /productionTurnRunShell:\s*buildProductionTurnRunShellInput\(/.test(compositionSource),
    "the child must get a shell built for its own scope",
  );
});

test("a subagent's tool host reports itself as a subagent runner", () => {
  assert.ok(
    /lazyToolHost\(scope\.isSubagentRunner\)/.test(compositionSource),
    "with isSubagentRunner hardcoded false, buildTurnTools offers Task inside a subagent, which is how nesting got past the depth limit",
  );
});