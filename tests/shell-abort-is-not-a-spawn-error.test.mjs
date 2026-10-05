import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A cancelled shell call was reported to the model as a failure to launch it.
//
// `classifyError` in `tools/core.ts` reads `ToolCallAbortedError` correctly —
// it is the one branch that returns `ToolErrorClassification.ABORTED` — and
// `serializeShellError` in the shell tool threw that reading away: an abort is
// not a `ShellToolRejectedError`, not a permission denial and not a timeout, so
// it fell through to the catch-all and became `ShellSpawnError`. The model then
// received "Error: Command failed to spawn: Aborted" and, correctly reading it,
// concluded the machine could not start processes and began retrying, asking the
// user to check the environment, or giving up on the task. The user saw an
// assistant that stopped mid-turn. The classification was right on one side of
// the call and thrown away on the other.
//
// Nothing caught it: the abort path needs a user who interrupts a shell call,
// `ShellStreamExit.aborted` covers the gentler case where the process was killed
// and an exit event still arrives, and no test asked the model what it was told.
//
// These tests call the real `serializeError` and the real renderer.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-shell-abort-classification-"));
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "create-shell-tool.ts"),
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "formatters.ts"),
      path.join(sourceRoot, "packages", "agent", "tools", "common.ts"),
      path.join(sourceRoot, "packages", "agent-exec", "shell-stream.ts"),
      path.join(sourceRoot, "packages", "agent-exec", "smart-mode-classifier.ts"),
      path.join(sourceRoot, "packages", "proto", "generated", "agent", "v1", "shell_exec_pb.ts"),
      path.join(sourceRoot, "packages", "proto", "generated", "agent", "v1", "smart_mode_classifier_exec_pb.ts"),
      path.join(sourceRoot, "packages", "context", "core.ts"),
    ],
    outdir: directory,
    outbase: sourceRoot,
    entryNames: "[dir]/[name]",
    chunkNames: "chunks/[hash]",
    outExtension: { ".js": ".mjs" },
    banner: REQUIRE_BANNER,
    mainFields: ["module", "main"],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const load = (relative) => import(pathToFileURL(path.join(directory, `${relative}.mjs`)).href);
  return { load, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const built = await bundle();
test.after(() => built.dispose());

const { createShellTool } = await built.load("packages/agent/tools/core/shell/create-shell-tool");
const { shellStreamExecutorResource } = await built.load("packages/agent-exec/shell-stream");
const { ToolCallAbortedError } = await built.load("packages/agent/tools/common");
const { createContext } = await built.load("packages/context/core");

// `createShellTool` resolves the executor at construction time, so it has to be
// a resource rather than a lazy lookup. Nothing here ever runs a command.
function toolFor() {
  const never = {
    async *execute() { throw new Error("this test only exercises error serialization and never reaches an executor"); },
  };
  return createShellTool({
    get(resource) {
      if (resource.symbol === shellStreamExecutorResource.symbol) return never;
      throw new Error("this test only exercises error serialization and never reaches an executor");
    },
  }, { promptVersion: "dsv3-1205" });
}

function shellResultOf(serialized) {
  const result = serialized.tool.value?.result;
  assert.notEqual(result, undefined, "the serialized error has to carry a shell result the renderer can draw");
  return result;
}

test("a cancelled call is told to the model as a cancellation, not as a failed launch", async () => {
  const tool = toolFor();
  const serialized = tool.serializeError(new ToolCallAbortedError());
  const shellResult = shellResultOf(serialized);

  assert.equal(shellResult.result.case, "failure", "a cancel is not a spawn failure: the case name is the first thing the renderer branches on");
  assert.equal(shellResult.result.value.aborted, true, "the flag the renderer reads to say the user stopped this has to be set");

  const rendered = await tool.render(createContext(), shellResult);
  const text = rendered.content.map((part) => part.text).join("");

  assert.match(text, /Command was aborted by the user\./, "the model has to be told what happened, or it will repair an environment that was never broken");
  assert.equal(text.includes("failed to spawn"), false, "'failed to spawn' names the environment as the cause, and it is the sentence this defect put in front of the model");
});

test("an aborted call reports no exit code rather than a number the transport invented", async () => {
  const tool = toolFor();
  const shellResult = shellResultOf(tool.serializeError(new ToolCallAbortedError()));
  const rendered = await tool.render(createContext(), shellResult);
  const text = rendered.content.map((part) => part.text).join("");

  assert.equal(text.includes("Exit code: 0"), false, "a killed command reported code 0 teaches the model that it finished, which is the opposite of what happened");
  assert.match(text, /Exit code: unavailable/, "the honest line names the missing exit status and why it is missing");
});

test("a genuine spawn failure is still reported as a spawn failure", async () => {
  // The other half of the fix. An abort-shaped check that matched too much
  // would make a real spawn error look like a user cancel, and the model would
  // sit still waiting for a user who was never asked.
  const tool = toolFor();
  const shellResult = shellResultOf(tool.serializeError(new Error("spawn npm ENOENT")));

  assert.equal(shellResult.result.case, "spawnError", "an executable that is not on PATH is the environment's fault and must keep saying so");
  const rendered = await tool.render(createContext(), shellResult);
  const text = rendered.content.map((part) => part.text).join("");
  assert.match(text, /Command failed to spawn: spawn npm ENOENT/, "the spawn error has to reach the model word for word, or the model cannot act on it");
  assert.equal(text.includes("aborted"), false, "a real spawn error must not borrow the cancellation's wording");
});

test("the platform AbortError the DOM throws is a cancellation too", async () => {
  // `interaction-handler.ts` throws `ToolCallAbortedError`, but a context that
  // is cancelled underneath the call raises a plain `AbortError`, and both
  // reach this function.
  const tool = toolFor();
  const shellResult = shellResultOf(tool.serializeError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));

  assert.equal(shellResult.result.case, "failure", "a DOM AbortError means the same thing as the host's own abort error");
  assert.equal(shellResult.result.value.aborted, true, "and it has to set the flag the renderer reads, not just change the case name");
});