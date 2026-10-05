/**
 * A tool call the model was told had been terminated was still running. The guard
 * `buildTurnTools` installs wraps every tool in `withToolTimeout`, and that wrapper raced the
 * tool against a timer: when the timer won, the model got `The <tool> tool call timed out
 * after N seconds and was terminated`, but nothing told the tool to stop. The tool held the
 * original, never-cancelled turn context, so the process it had spawned kept running, kept
 * writing and kept holding its file handles long after the turn had moved on. The shipped
 * sibling of this wrapper, `wrapToolWithTimeout` in `source/packages/agent/tools/common.ts`,
 * creates a cancellable child context precisely so its timeout can cancel it; the turn toolset
 * never did.
 *
 * The same file made three more promises that nothing checked:
 *
 *  1. A user cancel has to reach the tool. It does — the context chain propagates the abort —
 *     but nothing proved the shell stops and that the model is told the command was aborted
 *     instead of having failed.
 *  2. A very large command result has to say it was cut and by what rule. It does, at 20 000
 *     characters, keeping the head and the tail; nothing proved the middle is really gone, so a
 *     silent middle-only truncation would have looked identical from the outside.
 *  3. A failing tool must not turn the host environment into model-facing text. There was no
 *     check at all. It is a guard rather than a reproduction, so the detector is calibrated
 *     against a deliberate leak first: an assertion that cannot fail proves nothing.
 *
 * Everything here runs through the real `buildTurnTools` factory, the real `createShellTool`
 * and the real `SimplePromptToolExecutor` with the deterministic substitute provider. Only the
 * box-side executor is a stub, because a real shell would make the output size and the timing
 * depend on the machine.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every wait on a promise that is supposed to settle is bounded, so a regression fails the
// test instead of hanging the suite.
const SAFETY_CEILING_MS = 10_000;
const SHELL_OUTPUT_HARD_LIMIT = 20_000;

const { directory, loaded } = await (async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-turn-tool-guard-"));
  const source = (relative) => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, [
    `export { buildTurnTools, createTurnShellToolFactory, withToolTimeout } from ${source(["host", "runner", "tools", "turn-toolset.js"])};`,
    `export { sandToolCallExecutionTimeoutMs } from ${source(["host", "runner", "tools", "mcp-meta-tools.js"])};`,
    `export { shellStreamExecutorResource } from ${source(["packages", "agent-exec", "shell-stream.js"])};`,
    `export { SimplePromptToolExecutor } from ${source(["packages", "agent", "tool-stream-executor.js"])};`,
    `export { InteractionHandler } from ${source(["packages", "agent", "interaction-handler.js"])};`,
    `export { createContext } from ${source(["packages", "context", "core.js"])};`,
    `export { ToolTimeoutError } from ${source(["packages", "agent", "tools", "common.js"])};`,
    `export { ShellStream, ShellStreamStart, ShellStreamStdout, ShellStreamExit } from ${source(["packages", "proto", "generated", "agent", "v1", "shell_exec_pb.js"])};`,
  ].join("\n"), "utf8");
  const outfile = path.join(dir, "entry.cjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // The toolset pulls in CommonJS dependencies (`mime-types` and its internal relative
    // requires), which esbuild can only wire up inside a CommonJS output.
    format: "cjs",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    external: ["prom-client"],
    logLevel: "silent",
  });
  return { directory: dir, loaded: createRequire(import.meta.url)(outfile) };
})();

const {
  buildTurnTools,
  createTurnShellToolFactory,
  withToolTimeout,
  sandToolCallExecutionTimeoutMs,
  shellStreamExecutorResource,
  SimplePromptToolExecutor,
  InteractionHandler,
  createContext,
  ToolTimeoutError,
  ShellStream,
  ShellStreamStart,
  ShellStreamStdout,
  ShellStreamExit,
} = loaded;

const CANARY_NAME = "GROK_TURN_GUARD_CANARY";
const CANARY_VALUE = "canary-2f9c1d7b4e-secret-value";
const savedCanary = process.env[CANARY_NAME];
test.after(() => {
  if (savedCanary === undefined) delete process.env[CANARY_NAME];
  else process.env[CANARY_NAME] = savedCanary;
  rmSync(directory, { recursive: true, force: true });
});

function settlesWithin(promise, ceilingMs = SAFETY_CEILING_MS) {
  return Promise.race([
    promise.then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve({ settled: false }), ceilingMs).unref?.();
    }),
  ]);
}

function abortedError() {
  const error = new Error("the operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * The box-side shell executor, replaced so that the output and the timing are the fixture's
 * and not the machine's. `run` is an async generator of `ShellStream` events.
 */
function stubShellExecutor(run) {
  const seen = { commands: [], started: 0, finished: 0, sawAbort: false };
  return {
    seen,
    async *execute(ctx, args) {
      seen.commands.push(args.command);
      seen.started += 1;
      try {
        for await (const event of run(ctx, args, seen)) yield event;
        seen.finished += 1;
      } catch (error) {
        throw error;
      }
    },
  };
}

function stdoutEvent(data) {
  return new ShellStream({ event: { case: "stdout", value: new ShellStreamStdout({ data }) } });
}

function startEvent() {
  return new ShellStream({ event: { case: "start", value: new ShellStreamStart({}) } });
}

function exitEvent(code) {
  return new ShellStream({ event: { case: "exit", value: new ShellStreamExit({ code, cwd: "C:\\", localExecutionTimeMs: 3 }) } });
}

function shellToolset(executor, options = {}) {
  const accessor = { get: (key) => (key === shellStreamExecutorResource ? executor : undefined) };
  const host = {
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    isComputerUseSubagent: false,
    isBrowserUseSubagent: false,
    isSystemPromptOverridden: false,
    remoteBoxHasDesktop: false,
    getConversationId: () => "aaaaaaaa-0000-4000-8000-000000000002",
    getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true,
    spotlightEnabled: () => false,
    isDynamicToolsEnabled: () => false,
    factories: { externalShell: createTurnShellToolFactory({ resourceAccessor: accessor, options }) },
  };
  return buildTurnTools(host, { autoReviewModes: {}, subagentConfigs: [] }, undefined);
}

/** The deterministic substitute provider: one scripted model turn. */
function scriptedProvider(script) {
  const messages = [];
  return {
    appendMessages(incoming) {
      messages.push(...(Array.isArray(incoming) ? incoming : [incoming]));
      return this;
    },
    getState: () => messages,
    getMessages: () => messages,
    clearMessages() {
      messages.length = 0;
    },
    stream(_ctx, invocationId) {
      let finish;
      const finished = new Promise((resolve) => {
        finish = resolve;
      });
      const fullStream = (async function* () {
        try {
          yield* script;
        } finally {
          finish();
        }
      })();
      return {
        fullStream,
        response: finished.then(() => ({
          messages: [],
          id: "response-1",
          timestamp: new Date(0),
          modelId: "deterministic-substitute-provider",
        })),
        usage: Promise.resolve({ totalTokens: 1, promptTokens: 1, completionTokens: 0 }),
        extendedUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve(invocationId),
      };
    },
  };
}

function shellCall(toolCallId, command) {
  return { type: "tool-call", toolCallId, toolName: "run_terminal_cmd", args: { command } };
}

/**
 * Drives one model turn through the real executor with the real toolset and returns exactly
 * what the model receives.
 */
async function runToolTurn({ script, handle, context }) {
  const executor = new SimplePromptToolExecutor(scriptedProvider(script));
  const records = [];
  const interaction = new InteractionHandler(
    { sendUpdate: async () => {} },
    { recordToolCall: () => {} },
    "invocation-under-test",
  );
  const stream = executor.executeToolStream(
    context,
    {},
    interaction,
    handle.getAllTools(),
    {},
    async (_ctx, result, loggedToolName, errorClassification) => {
      records.push({ result, loggedToolName, errorClassification });
    },
    undefined,
    undefined,
  );
  // Production has a UI branch reading `fullStream`; `duplicateStream` only settles a write
  // once a reader takes it, so an unread branch stalls the collector forever.
  const uiBranch = (async () => {
    try {
      for await (const _chunk of stream.fullStream) { /* the tray's live copy */ }
    } catch { /* the collector reports the same failure */ }
  })();
  await uiBranch;
  return { records, modelFacing: modelFacingToolText(await stream.response) };
}

function modelFacingToolText(response) {
  for (const message of response?.messages ?? []) {
    if (message.role !== "tool") continue;
    for (const part of message.content ?? []) {
      if (part.type === "tool-result" && typeof part.result === "string") return part.result;
    }
  }
  return "";
}

function guardFailure(error) {
  return String(error?.clientVisibleErrorMessage ?? error?.message ?? "");
}

test("a tool call the model was told was terminated is actually stopped", async () => {
  const observed = { stopped: false, abortReason: "not-aborted" };
  const inner = {
    name: "HangingTool",
    async execute(ctx) {
      // A well-behaved tool: it watches its own context and stops when the turn cancels it.
      await new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          observed.stopped = true;
          observed.abortReason = ctx.signal.reason;
          resolve();
        }, { once: true });
      });
      return "done";
    },
  };
  const guarded = withToolTimeout(inner, 50);

  const outcome = await settlesWithin(
    guarded.execute(createContext(), {}, (async function* () { yield "{}"; })(), { toolCallId: "tc-1" }),
  );

  assert.equal(outcome.settled, true, "the guard never fired, so a hanging tool hangs the turn forever");
  assert.equal(
    outcome.settled && outcome.error instanceof ToolTimeoutError,
    true,
    "the guard must report a timeout, not let the tool's own value through",
  );
  assert.match(guardFailure(outcome.error), /HangingTool/, "the reported reason has to name the tool that died");
  assert.match(guardFailure(outcome.error), /timed out/i, "the reported reason has to say it was a deadline, not a crash");
  // One macrotask is enough for the abort listener the fix relies on to run.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    observed.stopped,
    true,
    "the model was told the tool was terminated and nothing terminated it: the work keeps running behind the turn",
  );
  assert.notEqual(
    observed.abortReason,
    "not-aborted",
    "the tool's context was never cancelled, so a process it spawned was never asked to stop",
  );
});

test("the guard the toolset installs for the shell tool is the short tier minus its headroom", async () => {
  const guardMs = sandToolCallExecutionTimeoutMs("run_terminal_cmd", false);
  assert.equal(
    guardMs,
    15 * 60_000 - 60_000,
    `the shell guard is no longer the short tier minus its headroom (${guardMs} ms), which changes how long a runaway command may hold the turn`,
  );

  const outcome = await settlesWithin(
    withToolTimeout({ name: "run_terminal_cmd", execute: () => new Promise(() => {}) }, 5).execute(
      createContext(), {}, (async function* () { yield "{}"; })(), { toolCallId: "tc-2" },
    ),
  );
  assert.equal(outcome.settled, true, "the guard did not fire on the short stand-in timeout");
  assert.equal(
    guardFailure(outcome.error),
    "The run_terminal_cmd tool call timed out after 0 seconds and was terminated. The execution environment may be unresponsive, or the operation needs longer than the per-call time limit.",
    "the message the model reads no longer names the tool that died, so a dead call cannot be identified",
  );
});

test("a user cancel reaches the shell tool and the model is told the command was aborted", async () => {
  let reportFirstChunk;
  const firstChunkArrived = new Promise((resolve) => {
    reportFirstChunk = resolve;
  });
  const executor = stubShellExecutor(async function* (ctx, _args, seen) {
    yield startEvent();
    yield stdoutEvent("partial output");
    reportFirstChunk();
    // The command keeps running until the turn cancels it, exactly like a real child process.
    await new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => {
        seen.sawAbort = true;
        reject(abortedError());
      }, { once: true });
    });
  });
  const handle = shellToolset(executor);
  const [turnContext, cancelTurn] = createContext().withCancel();

  const running = runToolTurn({
    script: [shellCall("tc-3", "sleep 600")],
    handle,
    context: turnContext,
  });
  await firstChunkArrived;
  cancelTurn({ intent: "User", message: "the user pressed stop" });
  const outcome = await settlesWithin(running);

  assert.equal(outcome.settled, true, "a cancelled tool call never settled");
  assert.equal(
    executor.seen.sawAbort,
    true,
    "the cancel never reached the shell, so the command is still running after the user pressed stop",
  );
  assert.equal(
    executor.seen.finished,
    0,
    "the shell executor ran to completion after the cancel, so the tool kept working in the background",
  );
  assert.equal(executor.seen.started, 1, "the tool ran more than once for one model tool call");
  assert.equal(
    outcome.value.records[0]?.errorClassification,
    "aborted",
    "a cancel the user asked for is classified as an error, so the tray paints it red",
  );
  assert.match(
    outcome.value.modelFacing,
    /abort/i,
    `the model is not told the command was aborted, so it retries a command the user deliberately stopped (${JSON.stringify(outcome.value.modelFacing.slice(0, 200))})`,
  );
});

test("a very large command result is cut by a stated rule that keeps both ends", async () => {
  const head = "HEAD-MARKER ".repeat(2_000);
  const middle = "MIDDLE-MARKER ".repeat(2_000);
  const tail = "TAIL-MARKER ".repeat(2_000);
  const executor = stubShellExecutor(async function* () {
    yield startEvent();
    yield stdoutEvent(`${head}${middle}${tail}`);
    yield exitEvent(0);
  });

  const outcome = await settlesWithin(
    runToolTurn({ script: [shellCall("tc-4", "cat everything")], handle: shellToolset(executor), context: createContext() }),
  );

  assert.equal(outcome.settled, true, "the turn never settled");
  const modelFacing = outcome.value.modelFacing;
  assert.ok(modelFacing.length > 0, "the model received no tool result at all, so the rule below proves nothing");
  assert.match(
    modelFacing,
    new RegExp(`truncated to ${SHELL_OUTPUT_HARD_LIMIT} characters`),
    "the cut is silent, so the model cannot tell a short answer from a long one that lost its middle",
  );
  assert.ok(modelFacing.includes("HEAD-MARKER"), "the head of the output was dropped, so the rule is not 'both ends'");
  assert.ok(modelFacing.includes("TAIL-MARKER"), "the tail of the output was dropped, so the rule is not 'both ends'");
  assert.equal(
    modelFacing.includes("MIDDLE-MARKER"),
    false,
    "the middle survived a cut that is supposed to drop it, so the model reads output the command never produced",
  );
  assert.ok(
    modelFacing.length < head.length + middle.length + tail.length,
    `the tool result is ${modelFacing.length} chars, which is not a cut at all`,
  );
});

test("a failing tool does not turn the host environment into model-facing text", async () => {
  process.env[CANARY_NAME] = CANARY_VALUE;
  const leaks = (text) => typeof text === "string" && text.includes(CANARY_VALUE);

  // Calibration first: a detector that cannot see a leak proves nothing about the next lines.
  assert.equal(
    leaks(`failure: ${CANARY_VALUE}`),
    true,
    "the leak detector is blind, so every assertion below about it would pass vacuously",
  );

  const spawnFailure = stubShellExecutor(async function* () {
    yield startEvent();
    const error = new Error("spawn C:\\Windows\\System32\\cmd.exe ENOENT");
    error.code = "ENOENT";
    throw error;
  });
  const spawnOutcome = await settlesWithin(
    runToolTurn({
      script: [shellCall("tc-5", "cat nowhere")],
      handle: shellToolset(spawnFailure),
      context: createContext(),
    }),
  );
  assert.equal(spawnOutcome.settled, true, "the spawn failure never settled the turn");
  assert.equal(
    leaks(spawnOutcome.value.modelFacing),
    false,
    `a spawn failure put an environment value into the model's text: ${JSON.stringify(spawnOutcome.value.modelFacing.slice(0, 300))}`,
  );
  assert.equal(
    leaks(JSON.stringify(spawnOutcome.value.records)),
    false,
    "a spawn failure put an environment value into the recorded tool result",
  );

  const guardOutcome = await settlesWithin(
    withToolTimeout({ name: "HangingTool", execute: () => new Promise(() => {}) }, 30).execute(
      createContext(), {}, (async function* () { yield "{}"; })(), { toolCallId: "tc-6" },
    ),
  );
  assert.equal(guardOutcome.settled, true, "the guard never fired, so the leak case below was never reached");
  assert.equal(
    leaks(guardFailure(guardOutcome.error)),
    false,
    "the timeout reason carries an environment value into the model",
  );
  assert.ok(
    guardFailure(guardOutcome.error).includes("HangingTool"),
    "the timeout reason must still name the tool it is about, or redacting everything is not the fix",
  );
});