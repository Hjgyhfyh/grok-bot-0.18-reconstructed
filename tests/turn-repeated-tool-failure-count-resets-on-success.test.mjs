/**
 * A counter that is never reset is worse than no counter at all.
 *
 * The previous defect was that nothing counted repeated refusals, and the fix is a
 * ledger in `source/host/runner/tools/turn-toolset.ts` that counts identical failing
 * calls per turn and grows the refusal text once a run is long enough. That ledger
 * is a claim: "you have now issued this call N times in a row". If a single
 * successful call did not clear it, the sentence would still be true — the run
 * length would simply be counting failures across a success — and it would be
 * saying it to agents that were working perfectly well. After a while every user
 * would learn to ignore it, and the one time it mattered it would carry no weight.
 *
 * So this file proves the reset in both directions:
 *
 *  - after a successful call the ledger is empty, read straight off the ledger and
 *    not inferred from the text;
 *  - and the counter is still counting afterwards. Ten refusals with a success in
 *    the middle must NOT warn, while the sixth refusal after that success MUST. The
 *    second half matters as much as the first: a "reset" that also zeroes the
 *    counter would make the first assertion pass forever, and this is the only
 *    assertion here that would notice.
 *
 * It drives the real `buildTurnTools` and the real `createShellTool`. Only the
 * box-side stream executor is a stub, so the outcome is the fixture's and not the
 * machine's.
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
const REFUSAL_REASON = "The user declined this action on their computer. Do not retry it.";

const { directory, loaded } = await (async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-turn-loop-reset-"));
  const source = (relative) => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(dir, "entry.ts");
  writeFileSync(entry, [
    `export { buildTurnTools, createTurnShellToolFactory, repeatedToolFailureLedgerForTurn } from ${source(["host", "runner", "tools", "turn-toolset.js"])};`,
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
  shellStreamExecutorResource,
  InteractionHandler,
  createContext,
  ShellStream,
  ShellStreamStart,
  ShellRejected,
  ShellStreamExit,
} = loaded;

test.after(() => rmSync(directory, { recursive: true, force: true }));

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

function exitEvent() {
  return new ShellStream({
    event: { case: "exit", value: { code: 0, cwd: "C:\\", localExecutionTimeMs: 2 } },
  });
}

function rejectedEvent(command) {
  return new ShellStream({
    event: {
      case: "rejected",
      value: new ShellRejected({ command, workingDirectory: "", reason: REFUSAL_REASON }),
    },
  });
}

/** The box-side stream executor: `refused` names the one command that is turned down. */
function stubShellExecutor(refused) {
  return {
    async *execute(_ctx, args) {
      yield startEvent();
      if (args.command === refused) {
        yield rejectedEvent(args.command);
        return;
      }
      yield exitEvent();
    },
  };
}

/**
 * Every string the shipped refusal serializer puts in front of the model and the
 * user. Collected by walking the object instead of naming one field, so a change in
 * the proto runtime's field layout cannot turn this into a test of the layout.
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

async function callOnce(tool, command, toolCallId) {
  const outcome = await settlesWithin(
    tool.execute(
      createContext(),
      new InteractionHandler({ sendUpdate: async () => {} }, { recordToolCall: () => {} }, "invocation-under-test"),
      (async function* () { yield JSON.stringify({ command }); })(),
      { toolCallId },
    ),
  );
  assert.equal(outcome.settled, true, `the ${command} call never settled, so the turn hangs instead of reporting it`);
  return outcome;
}

async function refuseOnce(tool, command, toolCallId) {
  const outcome = await callOnce(tool, command, toolCallId);
  assert.equal(
    outcome.settled && outcome.error instanceof Error,
    true,
    `the refused call ${command} resolved instead of throwing, so the model was never told anything`,
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
    getConversationId: () => "aaaaaaaa-0000-4000-8000-00000000000a",
    getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true,
    spotlightEnabled: () => false,
    isDynamicToolsEnabled: () => false,
    factories: { externalShell: createTurnShellToolFactory({ resourceAccessor: accessor, options: {} }) },
  };
  return buildTurnTools(host, turn, undefined);
}

test("a successful call clears the count, and the count starts over from one", async () => {
  const turn = { autoReviewModes: {}, subagentConfigs: [] };
  const refused = "npm run deploy";
  const ledger = repeatedToolFailureLedgerForTurn(turn);
  const tool = shellToolset(stubShellExecutor(refused), turn).getAllTools()[0];

  for (let attempt = 1; attempt <= SILENT_REFUSALS; attempt += 1) {
    const text = await refuseOnce(tool, refused, `tc-reset-a-${attempt}`);
    assert.equal(
      text.includes(NOTICE_MARKER),
      false,
      `refusal ${attempt} already interrupted the model, so the run is shorter than the agreed ${SILENT_REFUSALS}`,
    );
    assert.equal(
      ledger.readStreak()?.count,
      attempt,
      `the ledger read ${String(ledger.readStreak()?.count)} after ${attempt} refusals, so it is not counting at all`,
    );
  }

  const success = await callOnce(tool, "npm run build", "tc-reset-success");
  assert.equal(
    success.settled && success.error,
    undefined,
    `the command that should have succeeded failed, so the reset below would be proving nothing (${String(success.settled && success.error)})`,
  );
  assert.equal(
    ledger.readStreak(),
    undefined,
    "a command that worked did not clear the count, so the next refusal would be blamed on refusals that are no longer adjacent to it",
  );

  // Ten refusals in total with a success in the middle. If the counter had never
  // reset, the sixth of these would already have interrupted the model.
  for (let attempt = 1; attempt <= SILENT_REFUSALS; attempt += 1) {
    const text = await refuseOnce(tool, refused, `tc-reset-b-${attempt}`);
    assert.equal(
      text.includes(NOTICE_MARKER),
      false,
      `refusal ${SILENT_REFUSALS + attempt} was warned about even though a successful command intervened, so the count is lying (${JSON.stringify(text.slice(0, 300))})`,
    );
  }

  const text = await refuseOnce(tool, refused, "tc-reset-final");

  assert.ok(
    text.includes(NOTICE_MARKER),
    "the counter never restarted after the success, so it is permanently deaf: a genuine six-in-a-row run would also be silent",
  );
  assert.match(
    text,
    new RegExp(`call ${SILENT_REFUSALS + 1} times in a row`),
    `the restarted run is reported with the wrong length, so the count the model reads is not the count that happened (${JSON.stringify(text.slice(0, 300))})`,
  );
});