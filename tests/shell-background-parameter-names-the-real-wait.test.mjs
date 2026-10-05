import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `is_background` told the model one thing and the executor did another.
//
// The parameter was described as "Whether the command should be run in the
// background". That is not a claim about latency, so a model read it as
// fire-and-forget: issue the call, carry on, collect the output whenever it
// turns up. `resolvePlan` does something else entirely. With `is_background`
// set it takes `timeout` as the block-until value and hands it to the executor
// as `ShellArgs.timeout`, so the call holds the turn for exactly that long and
// then returns — in the same turn — the output collected so far plus the shell
// id. Default is `DEFAULT_TIMEOUT_MS`, 30000 ms, which is 30 seconds of
// silence per backgrounded command.
//
// Nothing failed, so nothing looked wrong. The tool call succeeded, the model
// got a well-formed result, and the suite was green. The cost was a plan built
// on a delivery this tool never performs: the model waited for a second
// message that could not arrive, and the wait happened inside a call whose
// description had promised it would not.
//
// The number in the description was not derived from the number in the code
// either. It was absent, so every host that re-times the wait would be
// described with whatever the schema builder happened to hardcode.
//
// These tests read the description the model actually reads, and pin it to the
// number the executor is actually handed, by extracting one from the other.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-shell-background-wait-"));
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "create-shell-tool.ts"),
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "prompts", "dsv3.ts"),
      path.join(sourceRoot, "packages", "agent-exec", "shell-stream.ts"),
      path.join(sourceRoot, "packages", "proto", "generated", "agent", "v1", "shell_exec_pb.ts"),
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
  return { load, directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const built = await bundle();
test.after(() => built.dispose());

const { createShellTool } = await built.load("packages/agent/tools/core/shell/create-shell-tool");
const { getDescriptionDsv3, getParametersSchemaDsv3 } = await built.load("packages/agent/tools/core/shell/prompts/dsv3");
const { ShellStream, ShellStreamExit, ShellStreamStdout } = await built.load("packages/proto/generated/agent/v1/shell_exec_pb");
const { shellStreamExecutorResource } = await built.load("packages/agent-exec/shell-stream");
const { createContext } = await built.load("packages/context/core");

delete process.env.CURSOR_FORCED_SHELL_EGRESS;

const DEFAULT_WAIT_MS = 30_000;

/**
 * Runs the real tool with a stub stream executor and hands back both halves of
 * the claim under test: the text the model reads about `is_background`, and the
 * `ShellArgs` the executor was really given. A description that names a wait
 * the executor does not honour is the whole defect, so the test has to hold
 * both.
 */
async function probe(options = {}, rawArgs = { command: "npm run dev", is_background: true }) {
  const calls = [];
  const executor = {
    async *execute(_ctx, args) {
      calls.push(args);
      yield new ShellStream({ event: { case: "stdout", value: new ShellStreamStdout({ data: "listening on http://localhost:3000\n" }) } });
      yield new ShellStream({ event: { case: "exit", value: new ShellStreamExit({ code: 0, cwd: built.directory, localExecutionTimeMs: 12 }) } });
    },
  };
  const tool = createShellTool(
    {
      get(resource) {
        if (resource.symbol === shellStreamExecutorResource.symbol) return executor;
        throw new Error("the shell tool asked for a resource this host does not provide");
      },
    },
    { promptVersion: "dsv3-1205", ...options },
  );
  const ctx = createContext();
  const abort = new AbortController();
  const interaction = {
    getAbortSignal: () => abort.signal,
    emitPartialToolCall: async () => {},
    executeToolCall: async (interactionCtx, _call, _id, execute) => await execute(interactionCtx),
  };
  await tool.execute(ctx, interaction, (async function* () { yield JSON.stringify(rawArgs); })(), { toolCallId: "tool-call-wait", workspacePaths: [] });
  const description = tool.parameters.jsonSchema.properties.is_background.description;
  return { tool, description, calls, waitMs: calls[0]?.timeout };
}

/** The number the description puts in front of the model, as an integer. */
function advertisedWait(description) {
  const match = /(\d+)ms/.exec(description);
  assert.notEqual(match, null, `the description has to state a wait in milliseconds, and "${description}" does not`);
  return Number(match[1]);
}

test("the description names the default wait instead of leaving the model to assume fire-and-forget", async () => {
  const { description } = await probe();

  assert.match(description, new RegExp(`${DEFAULT_WAIT_MS}ms`), `the model cannot budget a wait it was never told about, and the description is "${description}"`);
  assert.match(description, /this same turn/i, `the delivery happens inside this call, and the description has to say so instead of letting the model wait for a message that never comes (was: "${description}")`);
  assert.doesNotMatch(description, /Whether the command should be run in the background/, `the old wording promises nothing about time and is exactly the sentence that let the model plan around a later message (now: "${description}")`);
});

test("the number in the description is the number the executor is handed", async () => {
  const { description, calls, waitMs } = await probe();

  assert.equal(calls.length, 1, "the call has to reach the executor once for its block-until value to be observed at all");
  assert.equal(calls[0].isBackground, true, "the parameter under test is the thing that turns this into a backgrounded run");
  assert.equal(waitMs, DEFAULT_WAIT_MS, "resolvePlan defaults the wait to DEFAULT_TIMEOUT_MS, which is what makes this a half-minute of silence");
  assert.equal(advertisedWait(description), waitMs, "the description and the executor have to quote one number, or the model is budgeting against a wait the host does not impose");
});

test("a host that re-times the wait is described with the wait it really imposes", async () => {
  const { description, waitMs } = await probe({ defaultTimeoutMs: 180_000 });

  assert.equal(waitMs, 180_000, "the stub host configured a three-minute wait, so that is the wait the run will actually sit through");
  assert.equal(advertisedWait(description), 180_000, `a description written from a hardcoded default would leave this host advertising 30000ms while it waits 180000ms (it advertises: "${description}")`);
  assert.doesNotMatch(description, /30000ms/, `the stale default must not survive next to the real one, or the model reads the wrong number first (description: "${description}")`);
});

test("the description names the one argument that skips the wait", async () => {
  const { description, waitMs } = await probe({}, { command: "npm run dev", is_background: true, timeout: 0 });

  assert.equal(waitMs, 0, "timeout 0 is the only way to hand the turn back without waiting");
  assert.match(description, /`timeout` to 0/, `the model needs to be told which argument buys an immediate return, because "background" on its own never does (description: "${description}")`);
});

test("the older prompt version tells the truth about the same parameter", async () => {
  const schema = getParametersSchemaDsv3(false, "legacy-shell", {});
  const description = schema.shape.is_background.description;

  assert.match(description, new RegExp(`${DEFAULT_WAIT_MS}ms`), `the legacy schema has no timeout parameter, so the fixed wait it imposes is all the model can be told (description: "${description}")`);
  assert.match(description, /same turn/i, `the legacy tool promises nothing here today, and the model that reads it still plans for a later message (description: "${description}")`);
});

test("the honest wording did not break the machine-readable half of the tool", async () => {
  const { tool, description } = await probe();
  const schema = tool.parameters.jsonSchema;

  assert.equal(typeof schema, "object", "the model receives a JSON Schema, not a zod object, so a long description has to survive that conversion");
  assert.equal(JSON.parse(JSON.stringify(schema)).properties.is_background.description, description, "the schema has to survive the round trip the tool transport puts it through");
  assert.deepEqual(schema.required, ["command"], "rewriting one parameter description must not disturb the fields the model is required to send");
  assert.equal(typeof schema.properties.command.description, "string", "a neighbouring parameter that was not under test still has to be described");
  assert.match(description, /`timeout`/, `the description names the timeout parameter, and it has to name it unambiguously so the model connects the sentence to the argument it can set (description: "${description}")`);

  const rendered = tool.descriptionGenerator({ allTools: {} });
  assert.equal(typeof rendered, "string", "the prompt-level description is generated from the same file and has to stay a string");
  assert.ok(rendered.length > 0, "an empty tool description would leave the model with no usage notes at all");
  assert.doesNotMatch(rendered, /Whether the command should be run in the background/, `the base description still has to stop claiming the call returns by itself (description: ${rendered})`);

  const prose = getDescriptionDsv3(false, "dsv3-1205", { defaultTimeoutMs: 180_000 });
  assert.equal(typeof prose, "string", "describing a non-default wait must not produce a non-string prompt section");
});

test("the arguments the description talks about still parse", async () => {
  const { tool } = await probe();
  const ctx = createContext();
  const abort = new AbortController();
  const interaction = {
    getAbortSignal: () => abort.signal,
    emitPartialToolCall: async () => {},
    executeToolCall: async (interactionCtx, _call, _id, execute) => await execute(interactionCtx),
  };

  await assert.rejects(
    () => tool.execute(ctx, interaction, (async function* () { yield JSON.stringify({ command: 42 }); })(), { toolCallId: "tool-call-bad", workspacePaths: [] }),
    /Invalid arguments/,
    "a parameter description is metadata, so a schema that stopped type-checking would mean the description work disturbed the schema itself",
  );
});