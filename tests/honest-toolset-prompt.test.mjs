/**
 * The system prompt promised tools the turn did not carry.
 *
 * A live request captured off `https://opencode.ai/zen/go/v1` carried 28 tools
 * and a 74853-character system prompt. That prompt named CopyToBox (x4),
 * CopyFromBox (x4), GetMcpTools (x2), CallMcpTool (x2), Screenshot (x4),
 * GenerateImage (x2), CheckSubagent (x3), MessageSubagent (x2) and StopSubagent
 * (x2) — none of which were in the tools array. Nothing caught it because the
 * prompt was a module-level constant built once from `cloudAgentsEnabled` alone,
 * with no input describing what the turn actually offers. The model then
 * hallucinated the missing names: asked in Russian what it could do, it listed
 * CopyToBox, CopyFromBox, GetMcpTools and CallMcpTool as its own tools.
 *
 * The gate for each family is optional in the toolset build, so each prompt line
 * is now conditioned on the same capability that decides whether the tool is
 * offered. A missing capability resolver now means "offer no optional family"
 * rather than "assume every family", which is the defect itself.
 *
 * These tests render the prompt for a turn that has none of the optional tools
 * and assert it names none of them, and render it again for a fully wired turn
 * to prove the guidance was moved, not deleted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-honest-prompt-"));
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
  ["host", "runner", "system-prompt.ts"],
  ["host", "runner", "system-prompt-assembly.ts"],
]);
const {
  buildSandBaseSystemPrompt,
  resolveSandToolCapabilities,
  SAND_FULL_TOOL_CAPABILITIES,
  SAND_TOOL_CAPABILITY_REPRESENTATIVES,
} = loaded["system-prompt.mjs"];
const { omitUnavailableToolLines, unavailableToolNames } = loaded["system-prompt-assembly.mjs"];
test.after(() => dispose());

// Every tool the defect report says the prompt promised but the turn lacked.
const OPTIONAL_FAMILY_TOOLS = {
  screenshot: ["Screenshot"],
  generateImage: ["GenerateImage"],
  fileTransfer: ["CopyToBox", "CopyFromBox"],
  mcpTools: ["GetMcpTools", "CallMcpTool"],
  subagentManagement: ["CheckSubagent", "MessageSubagent", "StopSubagent"],
};

const NO_OPTIONAL_TOOLS = resolveSandToolCapabilities(undefined);

test("a turn with no optional tools is told about none of them", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: NO_OPTIONAL_TOOLS,
  });
  const absent = Object.values(OPTIONAL_FAMILY_TOOLS).flat();
  for (const tool of absent) {
    assert.equal(
      prompt.includes(tool),
      false,
      `the prompt named ${tool}, a tool this turn does not carry, so the model either invents it or denies having tools`,
    );
  }
});

// FALSIFICATION GUARD. Temporarily flip this to build the prompt as if every
// optional family were present — the exact behaviour that shipped — and the
// suite above must fail. Restore to false to prove the assertions bite.
const FALSIFY_AS_IF_ALL_TOOLS_PRESENT = false;

test("the no-optional-tools assertion fails against the old always-everything prompt", () => {
  const prompt = FALSIFY_AS_IF_ALL_TOOLS_PRESENT
    ? buildSandBaseSystemPrompt({
      cloudAgentsEnabled: true,
      tools: SAND_FULL_TOOL_CAPABILITIES,
    })
    : buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: NO_OPTIONAL_TOOLS });
  const absent = Object.values(OPTIONAL_FAMILY_TOOLS).flat();
  const named = absent.filter((tool) => prompt.includes(tool));
  assert.deepEqual(
    named,
    [],
    FALSIFY_AS_IF_ALL_TOOLS_PRESENT
      ? "falsification failed: rendering every family did not name a missing tool, so this test cannot detect the defect"
      : "the prompt named a tool the turn does not carry",
  );
});

test("the missing-tool guard found something to check", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
  });
  const named = Object.values(OPTIONAL_FAMILY_TOOLS).flat().filter((tool) => prompt.includes(tool));
  assert.equal(
    named.length,
    Object.values(OPTIONAL_FAMILY_TOOLS).flat().length,
    "a guard that matches nothing would pass for the wrong reason: the fully wired prompt must still name every optional tool",
  );
});

test("a fully wired turn is still told how to use every optional tool", () => {
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
  });
  for (const [family, tools] of Object.entries(OPTIONAL_FAMILY_TOOLS)) {
    for (const tool of tools) {
      assert.equal(
        prompt.includes(tool),
        true,
        `${tool} was dropped from the prompt, but the ${family} family is offered, so the guidance was deleted instead of made conditional`,
      );
    }
  }
});

test("one family at a time: turning a family off silences exactly that family", () => {
  const full = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
  });
  for (const [family, tools] of Object.entries(OPTIONAL_FAMILY_TOOLS)) {
    const without = buildSandBaseSystemPrompt({
      cloudAgentsEnabled: true,
      tools: { ...SAND_FULL_TOOL_CAPABILITIES, [family]: false },
    });
    for (const tool of tools) {
      assert.equal(
        without.includes(tool),
        false,
        `${tool} survived after the ${family} family was switched off`,
      );
    }
    for (const [other, otherTools] of Object.entries(OPTIONAL_FAMILY_TOOLS)) {
      if (other === family) continue;
      for (const tool of otherTools) {
        assert.equal(
          without.includes(tool),
          true,
          `switching off ${family} also removed ${tool}, which belongs to the still-offered ${other} family`,
        );
      }
    }
    assert.ok(
      full.length > without.length,
      `switching off ${family} did not shorten the prompt at all, so the condition is probably not wired to that family`,
    );
  }
});

test("an absent capability resolver offers nothing rather than assuming everything", () => {
  // The default is the whole point of the fix. Before it, "no resolver" was
  // indistinguishable from "every tool present", which is how the prompt came
  // to describe nine tools the turn did not have.
  assert.deepEqual(
    resolveSandToolCapabilities(undefined),
    {
      screenshot: false,
      generateImage: false,
      fileTransfer: false,
      mcpTools: false,
      subagentManagement: false,
    },
    "with no toolset to consult, the prompt assumed every optional tool was present",
  );
});

test("a resolver that knows one tool enables exactly its own family", () => {
  const onlyMcp = new Set(["GetMcpTools", "CallMcpTool", "SendMessage", "Shell"]);
  const resolved = resolveSandToolCapabilities((name) => onlyMcp.has(name));
  assert.equal(resolved.mcpTools, true, "GetMcpTools was offered, so its family must be on");
  assert.equal(resolved.fileTransfer, false, "CopyToBox was absent, so its family must be off");
  assert.equal(resolved.screenshot, false, "Screenshot was absent, so its family must be off");
  assert.equal(resolved.subagentManagement, false, "CheckSubagent was absent, so its family must be off");
});

test("every capability representative names a tool the prompt actually describes", () => {
  const full = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
  });
  for (const [family, representative] of Object.entries(SAND_TOOL_CAPABILITY_REPRESENTATIVES)) {
    assert.equal(
      full.includes(representative),
      true,
      `${family} is gated on ${representative}, but the fully wired prompt never names it, so the gate tracks a tool the prompt does not describe`,
    );
  }
});

test("cloud agents stay independent of the optional-tool families", () => {
  // The cloud-agent variant is chosen by team policy, not by the toolset. A
  // change to the capability plumbing must not have leaked into it.
  const disabled = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: false,
    tools: NO_OPTIONAL_TOOLS,
  });
  assert.equal(
    disabled.includes("## Cloud agents disabled"),
    false,
    "the cloud-agents-disabled notice belongs to system-prompt-assembly, not to this builder",
  );
  assert.equal(
    disabled.includes("CloudAgent tool"),
    false,
    "the cloud-agents-disabled variant still teaches the CloudAgent tool",
  );
  assert.ok(
    disabled.length > 10_000,
    "the prompt collapsed to almost nothing, which would break every turn rather than just the dishonest lines",
  );
});

// The box section is rendered outside system-prompt.ts, and it documents
// CopyToBox/CopyFromBox in two dedicated bullets. Conditioning only the base
// prompt would leave those two promises standing.
const BOX_SECTION = [
  "## Your box",
  "- Alongside the user's computer you have the box, with structured file reads (Read) and a shell (Shell).",
  "- Your box and the user's computer are separate machines, so a path on one is not visible to the other. Move files across with CopyToBox / CopyFromBox.",
  "- CopyToBox (their computer -> your box): copies a file from the user's computer into your box, verbatim.",
  "- CopyFromBox (your box -> their computer): copies a file from your box onto the user's actual computer.",
  "- Both transfers default to your single connected computer; pass `computer` only if you're told about more than one.",
].join("\n");

test("a host-rendered section loses the bullets for tools the turn lacks", () => {
  const filtered = omitUnavailableToolLines(BOX_SECTION, NO_OPTIONAL_TOOLS);
  assert.equal(
    filtered.includes("CopyToBox"),
    false,
    "the box section still teaches CopyToBox, so conditioning the base prompt alone did not make the prompt honest",
  );
  assert.equal(
    filtered.includes("CopyFromBox"),
    false,
    "the box section still teaches CopyFromBox",
  );
  assert.equal(
    filtered.includes("- Both transfers default"),
    false,
    "a bullet about transferring files survived with no transfer tool to transfer with",
  );
});

test("the section filter keeps everything when the family is offered", () => {
  assert.equal(
    omitUnavailableToolLines(BOX_SECTION, SAND_FULL_TOOL_CAPABILITIES),
    BOX_SECTION,
    "the box section lost CopyToBox/CopyFromBox guidance even though the turn offers them",
  );
});

test("the section filter leaves prose that only passes over a tool name", () => {
  const prose = "Read reads a file on your own computer, the same filesystem Shell and CopyToBox act on. Use ExternalRead only for the user's files.";
  assert.equal(
    omitUnavailableToolLines(prose, NO_OPTIONAL_TOOLS),
    prose,
    "a prose sentence was deleted over one tool name, throwing away guidance that is still true about Read and Shell",
  );
});

test("the section filter really removed something", () => {
  assert.ok(
    omitUnavailableToolLines(BOX_SECTION, NO_OPTIONAL_TOOLS).length < BOX_SECTION.length,
    "the filter matched no bullet, so it would have passed for the wrong reason",
  );
  // Asserted by name rather than by count: the original nine came from a live
  // capture, and the list has since grown (the box desktop, the Cursor cloud
  // agent and the MCP management tools joined it). A count would rot silently;
  // naming them fails the moment one is dropped and passes when one is added.
  const listed = new Set(unavailableToolNames(NO_OPTIONAL_TOOLS));
  for (const name of [
    "CopyToBox",
    "CopyFromBox",
    "GetMcpTools",
    "CallMcpTool",
    "Screenshot",
    "GenerateImage",
    "CheckSubagent",
    "MessageSubagent",
    "StopSubagent",
  ]) {
    assert.ok(
      listed.has(name),
      `${name} was named by the captured prompt but was never carried, so the filter must still hide its lines`,
    );
  }
  for (const name of ["Computer", "request_box_help", "CloudAgent"]) {
    assert.ok(
      listed.has(name),
      `${name} is absent from this build, so a prompt line naming it would be a promise the turn cannot keep`,
    );
  }
});
