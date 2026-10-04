/**
 * The system prompt described a machine that does not exist. `remoteBoxHasDesktop`
 * was the literal `true` in four places in the composition root, so a run on a
 * box whose only computer-use executor is `noMonitorComputerUseExecutor` — one
 * whose every method throws `SandBoxNoMonitorAvailableError` — was still told it
 * had a desktop, a `Screenshot` tool, a `request_box_help` handoff, and two
 * subagent types that drive that desktop. Nothing threw. The model dispatched
 * `computerUse`, got an error, and the feature read as flaky.
 *
 * Two instructions were wrong on their own terms, independent of any box:
 *
 * 1. "When ending a turn with SendMessage, make sure to add a short assistant
 *    message afterwards to actually complete the turn." It contradicts the
 *    paragraph above it: SendMessage *is* the delivery, and the turn completes
 *    on the tool call. Following the second rule makes the model send twice.
 * 2. Two sections sent the model to Read `/home/box/reference/*.md`.
 *    `writeSandBoxReferenceDocs()` builds that path with `path.join`, so on
 *    Windows the docs land under `C:\home\box\reference`, which no box mount
 *    exposes. The instruction was to read files that are not there.
 *
 * These tests drive the real `buildSandBaseSystemPrompt` and the real
 * `omitUnavailableToolLines`. They prove the desktop section is dropped whole
 * when there is no desktop, that the desktop tool names do not survive the drop,
 * that each account-gated family switches its own text off, and that the two
 * self-contradicting instructions are gone.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-prompt-truth-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.cjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
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
  ["host", "runner", "system-prompt.ts"],
  ["host", "runner", "system-prompt-assembly.ts"],
]);

const {
  buildSandBaseSystemPrompt,
  resolveSandToolCapabilities,
  SAND_FULL_TOOL_CAPABILITIES,
  SAND_TOOL_CAPABILITY_REPRESENTATIVES,
} = loaded["system-prompt.cjs"];
const { omitUnavailableToolLines, unavailableToolNames } = loaded["system-prompt-assembly.cjs"];

test.after(() => dispose());

const NO_TOOLS = resolveSandToolCapabilities(undefined);

const DESKTOP_NAMES = ["Screenshot", "Computer", "request_box_help"];

test("a run with no optional tool is told about no optional tool", () => {
  const missing = new Set(unavailableToolNames(NO_TOOLS));
  for (const family of ["screenshot", "generateImage", "fileTransfer", "mcpTools", "subagentManagement"]) {
    const representative = SAND_TOOL_CAPABILITY_REPRESENTATIVES[family];
    assert.ok(missing.has(representative), `${family} must report its representative as missing`);
  }
});

test("the desktop tool names travel with one family, because one predicate governs them", () => {
  const missing = new Set(unavailableToolNames(NO_TOOLS));
  for (const name of DESKTOP_NAMES) {
    assert.ok(
      missing.has(name),
      `${name} is gated on the same monitor flag as Screenshot; dropping one and not the others teaches a half-existing desktop`,
    );
  }
});

test("line filtering removes a desktop bullet that names a missing tool", () => {
  const section = [
    "- Drive the desktop with Computer when the task needs a GUI.",
    "- Hand the box over with request_box_help at a login.",
    "- Shell and Read work regardless of the desktop.",
  ].join("\n");
  const filtered = omitUnavailableToolLines(section, NO_TOOLS);
  assert.ok(!filtered.includes("Computer"), "a bullet naming a missing tool must not survive");
  assert.ok(!filtered.includes("request_box_help"), "same for the handoff tool");
  assert.ok(filtered.includes("Shell and Read"), "unrelated guidance must not be thrown away");
});

test("a fully wired turn is still taught every optional tool", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
    referenceDocsAvailable: false,
  });
  for (const [family, representative] of Object.entries(SAND_TOOL_CAPABILITY_REPRESENTATIVES)) {
    assert.ok(prompt.includes(representative), `the fully wired prompt dropped ${family}'s ${representative}`);
  }
});

test("the box desktop section disappears whole when there is no monitor", () => {
  const withoutDesktop = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: { ...NO_TOOLS, boxDesktop: false },
    referenceDocsAvailable: false,
  });
  assert.ok(
    !withoutDesktop.includes("## The box desktop"),
    "the section header itself names a desktop the box cannot show",
  );
});

test("the prompt does not order a read of reference docs that were never written", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
    referenceDocsAvailable: false,
  });
  assert.ok(
    !prompt.includes("/home/box/reference"),
    "writeSandBoxReferenceDocs uses path.join, so on Windows those docs are at C:\\home\\box\\reference and no box mount exposes them",
  );
});

test("the reference sections return when the caller proves the docs are on the box", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
    referenceDocsAvailable: true,
  });
  assert.ok(
    prompt.includes("/home/box/reference"),
    "a box that really has the docs must still get the runbook",
  );
});

test("the prompt no longer tells the model to send a second message after SendMessage", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
    referenceDocsAvailable: false,
  });
  assert.ok(
    !/add a short assistant message afterwards to actually complete the turn/.test(prompt),
    "SendMessage is the delivery; a second message makes the agent answer twice",
  );
});

// The prompt is only half the story: the composition root is what feeds the
// desktop flag, and it fed a literal `true`. A correct prompt builder with a
// hardcoded input still describes a box that does not exist, so the input is
// pinned here too.
const compositionSource = readFileSync(
  path.join(repoRoot, "source", "host", "host-runner-composition.ts"),
  "utf8",
);

test("the composition root no longer hardcodes a desktop it cannot prove", () => {
  assert.ok(
    !/remoteBoxHasDesktop:\s*true\b/.test(compositionSource),
    "four call sites passed a literal true, which is how a monitor-less box was described as having a monitor",
  );
  assert.ok(
    /remoteBoxHasDesktop:\s*boxHasMonitorDesktop\(\)/.test(compositionSource),
    "the flag must come from the box's own computer-use executor",
  );
});