/**
 * An agent took the same tool refusal twenty times in a row, invented a wrong
 * explanation for it and spent ten minutes looking for a way around it. The user
 * watched a "working" indicator the whole time and got not one word.
 *
 * Nothing was watching, and the two mechanisms that looked like they might be were
 * both answering a different question:
 *
 *  - The first-token stall deadline is per model RESPONSE. It starts at 150 ms,
 *    doubles per retry, and `createStreamAttempt` re-arms it every time the stream
 *    produces output (`stream-attempt.ts:69`). An agent making dozens of
 *    millisecond-long tool calls produces output constantly, so the gap between two
 *    outputs never approaches the deadline no matter how long the whole turn runs.
 *    That deadline is not broken, and this test does not touch it.
 *  - The shipped loop detector (`loop-detection/agent-loop-detector.ts`) only sees
 *    the model repeating TEXT in its own output. It throws `AgentLoopError` with
 *    `loopType: "singleMessage"`, and a bare tool call carries no text for it to
 *    match. It never sees a repeated failing call.
 *
 * So the turn had no counter of any kind. Refusal one and refusal twenty were
 * indistinguishable, which is why the model had no reason to stop and the user had
 * nothing to read.
 *
 * This test drives the real `buildTurnTools`, the real `createShellTool` and a real
 * `ShellToolRejectedError` — the exact refusal the box emits — and asserts that
 * the sixth identical refusal is the first one that says so, with the count in the
 * sentence. Only the box-side stream executor is a stub, because a real shell would
 * make the outcome depend on the machine.
 *
 * It reads the notice out of `tool.serializeError(...)`, which is the one object
 * `executeToolResultOrError` (`tools/core.ts:152`) hands to BOTH readers: the model
 * gets it as the tool result, and `interactionHandler.emitToolCallError` forwards
 * the same object to the user's tool tray. Asserting on it covers the agent and the
 * user with a single string, and no renderer change is involved.
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

// Every wait on a promise that is supposed to settle is bounded, so a regression
// fails the test instead of hanging the suite.
const SAFETY_CEILING_MS = 10_000;
const NOTICE_MARKER = "You have now issued this exact";
const SILENT_REFUSALS = 5;

const { directory, loaded } = await (async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-turn-refusal-loop-"));
  const source = (relative) => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, [
    `export { buildTurnTools, createTurnShellToolFactory, repeatedToolFailureLedgerForTurn, REPEATED_TOOL_FAILURE_NOTICE_AFTER } from ${source(["host", "runner", "tools", "turn-toolset.js"])};`,
    `export { shellStreamExecutorResource } from ${source(["packages", "agent-exec", "shell-stream.js"])};`,
    `export { InteractionHandler } from ${source(["packages", "agent", "interaction-handler.js"])};`,
    `export { createContext } from ${source(["packages", "context", "core.js"])};`,
    `export { ShellStream, ShellStreamStart, ShellRejected, ShellStreamExit } from ${source(["packages", "proto", "generated", "agent", "v1", "shell_exec_pb.js"])};`,
  ].join("\n"), "utf8");
  const outfile = path.join(dir, "entry.cjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // The toolset pulls in CommonJS dependencies (`mime-types` and its internal
    // relative requires), which esbuild can only wire up inside a CommonJS output.
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
  repeatedToolFailureLedgerForTurn,
  REPEATED_TOOL_FAILURE_NOTICE_AFTER,
  shellStreamExecutorResource,
  InteractionHandler,
  createContext,
  ShellStream,
  ShellStreamStart,
  ShellRejected,
  ShellStreamExit,
} = loaded;

test.after(() => rmSync(directory, { recursive: true, force: true }));

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function startEvent() {
  return new ShellStream({ event: { case: "start", value: new ShellStreamStart({}) } });
}

function exitEvent(code) {
  return new ShellStream({
    event: {
      case: "exit",
      value: { code, cwd: "C:\\", localExecutionTimeMs: 2 },
    },
  });
}

/** The refusal the box emits when it will not run a command. */
function rejectedEvent(command, reason) {
  return new ShellStream({
    event: {
      case: "rejected",
      value: new ShellRejected({ command, workingDirectory: "", reason }),
    },
  });
}

/**
 * The box-side stream executor, replaced so the outcome is the fixture's and not the
 * machine's. `refuse` decides whether this call is turned down or completes.
 */
function stubShellExecutor(refuse) {
  return {
    async *execute(_ctx, args) {
      yield startEvent();
      if (refuse(args.command)) {
        yield rejectedEvent(args.command, "The user declined this action on their computer. Do not retry it.");
        return;
      }
      yield exitEvent(0);
    },
  };
}

/**
 * The refusal text the model and the user both read, for one refused call.
 *
 * `serializeError` is the shipped path that turns a thrown refusal into the object
 * `executeToolResultOrError` sends to both readers, so every string it carries is
 * collected here rather than one hand-picked field. A hand-picked field would make
 * this test pass or fail on the proto runtime's field layout instead of on whether
 * the model is told anything.
 */
function refusalText(serialized) {
  const parts = [];
  const walk = (value) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(serialized);
  return parts.join("\n");
}

/** The refusal text the model and the user both read, for one refused call. */
async function refuseOnce(tool, command, toolCallId) {
  const outcome = await settlesWithin(
    tool.execute(
      createContext(),
      new InteractionHandler({ sendUpdate: async () => {} }, { recordToolCall: () => {} }, "invocation-under-test"),
      (async function* () { yield JSON.stringify({ command }); })(),
      { toolCallId },
    ),
  );
  assert.equal(outcome.settled, true, `the ${command} refusal never settled, so the turn hangs instead of reporting it`);
  assert.equal(
    outcome.settled && outcome.error instanceof Error,
    true,
    `the call that was refused resolved instead of throwing, so the model was never told anything (${JSON.stringify(String(outcome.settled && outcome.value)?.slice(0, 200))})`,
  );
  return refusalText(tool.serializeError(outcome.error));
}

function shellToolset(executor, turn) {
  const accessor = { get: (key) => (key === shellStreamExecutorResource ? executor : undefined) };
  const host = {
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    isComputerUseSubagent: false,
    isBrowserUseSubagent: false,
    isSystemPromptOverridden: false,
    remoteBoxHasDesktop: false,
    getConversationId: () => "aaaaaaaa-0000-4000-8000-000000000009",
    getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true,
    spotlightEnabled: () => false,
    isDynamicToolsEnabled: () => false,
    factories: { externalShell: createTurnShellToolFactory({ resourceAccessor: accessor, options: {} }) },
  };
  return buildTurnTools(host, turn, undefined);
}

test("the refusal that ends a run tells the model it has repeated itself, with the count", async () => {
  const turn = { autoReviewModes: {}, subagentConfigs: [] };
  const tool = shellToolset(stubShellExecutor(() => true), turn).getAllTools()[0];
  const command = "npm run migrate";

  for (let attempt = 1; attempt <= SILENT_REFUSALS; attempt += 1) {
    const text = await refuseOnce(tool, command, `tc-loop-${attempt}`);
    assert.equal(
      text.includes(NOTICE_MARKER),
      false,
      `refusal ${attempt} already interrupted the model, so "say it after ${REPEATED_TOOL_FAILURE_NOTICE_AFTER}" is not the rule the turn is running`,
    );
  }

  const text = await refuseOnce(tool, command, `tc-loop-${SILENT_REFUSALS + 1}`);

  assert.equal(
    REPEATED_TOOL_FAILURE_NOTICE_AFTER,
    SILENT_REFUSALS,
    `the notice fires after ${REPEATED_TOOL_FAILURE_NOTICE_AFTER} silent refusals, which is not the agreed number`,
  );
  assert.ok(
    text.includes(NOTICE_MARKER),
    `the ${SILENT_REFUSALS + 1}th identical refusal is still silent, so an agent can loop twenty times in a row with no word about it (${JSON.stringify(text.slice(0, 300))})`,
  );
  assert.match(
    text,
    new RegExp(`${escapeForRegExp(tool.name)} call ${SILENT_REFUSALS + 1} times in a row`),
    "the sentence carries no count, names the wrong run length, or does not name the tool it is about",
  );
  assert.match(
    text,
    /Do not issue this call again/i,
    "the model is told it is looping but not what to do instead, so the sentence costs tokens and changes nothing",
  );
  assert.match(
    text,
    /send the user a message/i,
    "nothing tells the model to talk to the user, which is the only way the ten-minute silence ends",
  );
  assert.ok(
    text.includes("The user declined this action on their computer."),
    "the notice replaced the refusal it belongs to, so the model no longer knows WHY the call failed",
  );
});

test("a refusal the model kept changing is not a loop", async () => {
  const turn = { autoReviewModes: {}, subagentConfigs: [] };
  const tool = shellToolset(stubShellExecutor(() => true), turn).getAllTools()[0];

  // Six refusals, no two of them the same call. An agent that is trying things is
  // exactly what the sentence is supposed to interrupt, so counting this would make
  // the warning a lie within a week.
  for (let attempt = 1; attempt <= SILENT_REFUSALS + 1; attempt += 1) {
    const text = await refuseOnce(tool, `npm run try-${attempt}`, `tc-vary-${attempt}`);
    assert.equal(
      text.includes(NOTICE_MARKER),
      false,
      `refusal ${attempt} used a command the model had never tried before, and was still called a repeat (${JSON.stringify(text.slice(0, 300))})`,
    );
  }
});

test("one ledger per turn: the count survives the toolset being rebuilt for the next model step", async () => {
  const turn = { autoReviewModes: {}, subagentConfigs: [] };
  const executor = stubShellExecutor(() => true);
  const command = "rm -rf build";

  // `buildTurnTools` runs again for every model step of a turn, and it builds a new
  // tool array every time. A counter made inside it would read one on the sixth
  // step — which is the twenty-in-a-row case itself.
  for (let step = 1; step <= SILENT_REFUSALS; step += 1) {
    const tool = shellToolset(executor, turn).getAllTools()[0];
    const text = await refuseOnce(tool, command, `tc-step-${step}`);
    assert.equal(
      text.includes(NOTICE_MARKER),
      false,
      `model step ${step} interrupted the model, so the ledger is not surviving the rebuild it has to survive`,
    );
  }

  const tool = shellToolset(executor, turn).getAllTools()[0];
  const text = await refuseOnce(tool, command, "tc-step-final");

  assert.ok(
    text.includes(NOTICE_MARKER),
    "six identical refusals spread over six model steps produced no warning, which is precisely the measured ten minutes of silence",
  );
});

test("a second turn starts from one, so a fresh agent is never accused of a loop it has not entered", async () => {
  const executor = stubShellExecutor(() => true);
  const command = "git push --force";

  const firstTurn = { autoReviewModes: {}, subagentConfigs: [] };
  for (let attempt = 1; attempt <= SILENT_REFUSALS; attempt += 1) {
    await refuseOnce(shellToolset(executor, firstTurn).getAllTools()[0], command, `tc-first-${attempt}`);
  }
  const secondTurn = { autoReviewModes: {}, subagentConfigs: [] };
  const text = await refuseOnce(shellToolset(executor, secondTurn).getAllTools()[0], command, "tc-second-1");

  assert.equal(
    text.includes(NOTICE_MARKER),
    false,
    "a brand new turn was told it had already looped, because the counter is shared across turns instead of being per turn",
  );
  assert.equal(
    repeatedToolFailureLedgerForTurn(firstTurn),
    repeatedToolFailureLedgerForTurn(firstTurn),
    "the same turn asked for its ledger twice and got two ledgers, so the count can never exceed one",
  );
});