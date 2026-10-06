import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Pressing stop on a parent agent did not stop its subagents. It reported them as
// failures, and in one ordering it did not stop them at all.
//
// `SandAgentRunner.interruptAll` walked `this.subagents.sessions` and called
// `session.interrupt(reason)` on each child. That reaches the child's own abort —
// the model stream, a waiting shell, a permission ask — and nothing else. The
// bookkeeping that decides what an interrupted child MEANS lives in the runtime
// next to it: `abortingSubagents` (set only by `abortSubagent`, which is what the
// `StopSubagent` tool calls), `pendingSubagentSteers`, and `onPendingWakeDisarmed`.
// `interruptAll` set none of them, so the runtime settled every child as an
// ordinary outcome of a run that had failed for a reason the parent never had.
//
// Two things came out of that, and both were measured on the real classes:
//
//   1. `settleBackgroundSubagentTurn` treats a queued steer as work to resume. It
//      relaunches the child on the steer prompt UNLESS `abortingSubagents` holds
//      the id. `MessageSubagent` queues a steer and interrupts the child; the
//      relaunch is already in flight when the user presses stop a moment later.
//      The stop interrupted the child, the queued steer relaunched it, and the
//      child kept running with the parent's stop already delivered. Nothing was
//      reported and the wake marker stayed armed, so the agent looked idle while
//      its work continued.
//
//   2. With no steer queued, each interrupted child reached
//      `onBackgroundSubagentSettled` with `status: "error"` and the text "The
//      background task was interrupted before it finished." `RunnerRegistry`
//      wires that handler to `CompletionRevivals.handleBackgroundSubagentCompletion`,
//      which calls `runner.run(buildSubagentRevivalPrompt(...))`. One stop of two
//      children produced two fresh hidden model turns on the agent the user had
//      just stopped, each opening with "[A background task just completed]". The
//      same path leaves the durable pending-wake marker in the store, so a
//      restart rearms work the user deliberately ended.
//
// `StopSubagent` already had the right behaviour for the identical event: no
// revival, no relaunch, no wake left armed. The two ways to end a subagent
// disagreed, and the one a person can press was the wrong one.
//
// The fix routes `interruptAll` through `abortSubagent` — the same runtime
// bookkeeping `StopSubagent` uses — instead of reaching into the session. A child
// that exists but has not been dispatched yet has no run to abort, so it keeps
// the raw `session.interrupt` fallback.
//
// Everything below drives the real `SandAgentRunner`, the real
// `createSubagentRuntime` behind it, the real `CompletionRevivals`, and the real
// `SandSubagentHostAdapter`. The only stubbed things are the child runner's own
// turn (`run`/`interrupt`, which in production is a nested `SandAgentRunner`) and
// the transcript manager `CompletionRevivals` talks to. No checkpointer, no
// dispatch and no settle path is mocked.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-parent-stop-"));
  const source = relative =>
    JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(
    entry,
    [
      `export { SandAgentRunner } from ${source(["host", "runner", "sand-agent-runner.ts"])};`,
      `export { CompletionRevivals } from ${source(["host", "extensions", "transcript", "completion-revivals.ts"])};`,
      `export { SandSubagentHostAdapter, SandSubagentDispatchError } from ${source(["host", "runner", "agent-adapters.ts"])};`,
    ].join("\n"),
    "utf8",
  );
  const outfile = path.join(directory, "entry.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    banner: {
      js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const { SandAgentRunner, CompletionRevivals, SandSubagentHostAdapter, SandSubagentDispatchError } = loaded;

test.after(() => dispose());

const PARENT_AGENT_ID = "aaaaaaaa-0000-4000-8000-00000000feed";
const SETTLE_TICKS = 6;
/** Bounded: every settle in this file is a microtask chain, not a timer of its own. */
const settle = async () => {
  for (let i = 0; i < SETTLE_TICKS; i += 1) await new Promise(done => setTimeout(done, 5));
};

function createRunner({ wakeEvents = [] } = {}) {
  return new SandAgentRunner({
    conversationId: PARENT_AGENT_ID,
    transport: { onUpdate() {} },
    onPendingWakeArmed: event => wakeEvents.push(["armed", event.workId]),
    onPendingWakeDisarmed: event => wakeEvents.push(["disarmed", event.workId]),
  });
}

/**
 * A child subagent whose turn resolves only when it is interrupted. In production
 * this is a nested `SandAgentRunner` reached through `createSubagentRunner`; the
 * abort signal it reads is the one `interrupt` fires, and that is the only thing
 * this fixture has to stand in for. It resolves with `aborted: true`, which is
 * exactly what the real `runner.run` resolves with when its turn is aborted —
 * `host-runner-composition.ts:3114` reads `aborted` off the child's own result.
 */
function createChild(label, log, { failWith } = {}) {
  let settleCurrentRun;
  let interrupts = 0;
  let runs = 0;
  const session = {
    async run(prompt) {
      runs += 1;
      log.push({ label, kind: "run", prompt: String(prompt).slice(0, 60) });
      if (failWith !== undefined) throw failWith;
      return await new Promise(resolve => {
        settleCurrentRun = resolve;
      });
    },
    interrupt(reason) {
      interrupts += 1;
      log.push({ label, kind: "interrupt", reason });
      const resolve = settleCurrentRun;
      settleCurrentRun = undefined;
      if (resolve !== undefined) resolve({ text: "partial work", aborted: true });
    },
    getResolvedOutline: async () => [],
    getObservedToolCallCount: () => 0,
    getActivitySnapshot: () => [],
    getTranscriptPath: () => path.join("C:", "transcripts", label, `${label}.jsonl`),
  };
  return { session, interrupts: () => interrupts, runs: () => runs };
}

/** Dispatches `children` through the real runtime, exactly as `runSession` does. */
function dispatch(runner, children, ids) {
  children.forEach((child, index) => {
    runner.subagents.sessions.set(ids[index], child.session);
    runner.subagents.dispatchBackgroundSubagent({
      subagentAgentId: ids[index],
      subagentType: "generalPurpose",
      toolCallId: `call-${index + 1}`,
      prompt: `work item ${index + 1}`,
      run: () => child.session.run(`work item ${index + 1}`),
    });
  });
}

/* ------------------------------------------------------------------ */
/* 1. Three concurrent children, each with its own id and transcript.  */
/* ------------------------------------------------------------------ */

test("three subagents dispatched together each get their own id, their own transcript and their own run", async () => {
  const log = [];
  const runner = createRunner();
  const children = ["alpha", "beta", "gamma"].map(label => createChild(label, log));
  const ids = ["subagent-alpha", "subagent-beta", "subagent-gamma"];
  dispatch(runner, children, ids);
  await settle();

  const running = runner.subagents.listRunningSubagents();
  assert.equal(
    running.length,
    3,
    "the fixture must have three children in flight, or the rest of this file measures nothing",
  );
  assert.deepEqual(
    [...new Set(running.map(info => info.subagentId))].sort(),
    ids,
    "two children shared one id, so the parent's status list cannot tell them apart and a stop reaches only one",
  );
  assert.deepEqual(
    [...new Set(running.map(info => info.transcriptPath))].sort(),
    children.map(child => child.session.getTranscriptPath()).sort(),
    "each child has to report its own transcript, or the parent reads the wrong play-by-play while a subagent works",
  );
  assert.deepEqual(
    children.map(child => child.runs()),
    [1, 1, 1],
    "a dispatch started each child more than once, so one Task call is doing the work of three",
  );

  // Leave nothing running for the next test.
  for (const id of ids) runner.subagents.abortSubagent(id);
  await settle();
});

/* ------------------------------------------------------------------ */
/* 2. The stop reaches every child.                                     */
/* ------------------------------------------------------------------ */

test("stopping the parent interrupts all three children and leaves none running", async () => {
  const log = [];
  const runner = createRunner();
  const children = ["one", "two", "three"].map(label => createChild(label, log));
  const ids = ["subagent-one", "subagent-two", "subagent-three"];
  dispatch(runner, children, ids);
  await settle();

  assert.equal(
    runner.hasRunningSubagents(),
    true,
    "the registry says nothing is running while three children are in flight, so the stop reports a no-op",
  );

  runner.interruptAll("the user pressed stop");
  await settle();

  assert.deepEqual(
    children.map(child => child.interrupts()),
    [1, 1, 1],
    "a child never received the stop, so the work the user cancelled is still running",
  );
  assert.equal(
    runner.subagents.listRunningSubagents().length,
    0,
    "a child is still running after the parent was stopped",
  );
  assert.equal(
    runner.hasRunningSubagents(),
    false,
    "the parent still reports a running subagent after the stop",
  );
});

/* ------------------------------------------------------------------ */
/* 3. THE DEFECT: a queued steer relaunches a stopped child.           */
/* ------------------------------------------------------------------ */

test("a child with a steering message in flight is dropped by the stop instead of being relaunched", async () => {
  const log = [];
  const runner = createRunner();
  const child = createChild("steered", log);
  dispatch(runner, [child], ["subagent-steered"]);
  await settle();

  // `MessageSubagent` queues a steer and interrupts the child. The runtime
  // relaunches it on the steer prompt the moment that run settles, and it does
  // so UNLESS the id is already marked as aborting — so the steer is still
  // sitting in the queue when the user presses stop on the very next line.
  assert.equal(
    runner.subagents.steerSubagent("subagent-steered", "change of plan"),
    "ok",
    "the fixture could not steer the child, so the relaunch it is supposed to trigger was never armed",
  );
  runner.interruptAll("the user pressed stop");
  await settle();

  assert.equal(
    runner.subagents.listRunningSubagents().length,
    0,
    "the child was relaunched by the queued steer AFTER the stop, so stopping the parent did not stop its work",
  );
  const runs = log.filter(entry => entry.kind === "run");
  assert.equal(
    runs.length,
    1,
    `expected only the child's original turn; the stop was followed by ${runs.length - 1} relaunch(es): ${JSON.stringify(runs)}`,
  );
  assert.equal(
    child.interrupts(),
    2,
    "the steer and the stop each interrupt the child, so a different count means one of the two never arrived",
  );
});

/* ------------------------------------------------------------------ */
/* 4. THE DEFECT: every stopped child is reported as a failed task.   */
/* ------------------------------------------------------------------ */

test("stopping the parent does not report its children to the host as finished background tasks", async () => {
  const log = [];
  const completions = [];
  const runner = createRunner();
  runner.subagents.setBackgroundSubagentHandler(completion => completions.push(completion));
  const children = ["a", "b"].map(label => createChild(label, log));
  dispatch(runner, children, ["subagent-a", "subagent-b"]);
  await settle();

  runner.interruptAll("the user pressed stop");
  await settle();

  assert.deepEqual(
    completions,
    [],
    "a child the user deliberately stopped was handed to the host as a background task that finished, which is how a cancelled turn comes back to life saying its work was interrupted",
  );
  assert.deepEqual(
    runner.subagents.listSubagents().map(record => record.status),
    ["aborted", "aborted"],
    "a stopped child must be recorded as aborted; anything else reports the stop as a failure",
  );
});

test("the stop disarms the durable wake marker every stopped child armed", async () => {
  const wakeEvents = [];
  const runner = createRunner({ wakeEvents });
  const log = [];
  const children = ["w1", "w2"].map(label => createChild(label, log));
  dispatch(runner, children, ["subagent-w1", "subagent-w2"]);
  await settle();
  assert.deepEqual(
    wakeEvents,
    [["armed", "subagent-w1"], ["armed", "subagent-w2"]],
    "the fixture did not arm two wakes, so there is nothing here to disarm",
  );

  runner.interruptAll("the user pressed stop");
  await settle();

  // The runtime disarms a marker when the abort is requested AND again when the
  // child settles, and `PendingWakeRearm.disarmPendingWake` early-returns on the
  // second call, so the count is not the obligation. What has to hold is that
  // every marker a stopped child armed is disarmed, and that nothing is left
  // armed without a disarm to match it.
  const armedIds = wakeEvents.filter(([kind]) => kind === "armed").map(([, workId]) => workId);
  const disarmedIds = wakeEvents.filter(([kind]) => kind === "disarmed").map(([, workId]) => workId);
  assert.deepEqual(
    [...new Set(disarmedIds)].sort(),
    [...new Set(armedIds)].sort(),
    "a wake marker stays in the pending-wake store, so a restart re-arms and revives the parent for work the user ended",
  );
});

/* ------------------------------------------------------------------ */
/* 5. The whole chain: one stop, no new model turn on the parent.      */
/* ------------------------------------------------------------------ */

test("one stop starts no new hidden turn on the parent that was stopped", async () => {
  const log = [];
  const parentTurns = [];
  const revivalReports = [];
  const clearedWakes = [];
  const runner = createRunner();

  // The transcript manager surface `CompletionRevivals` reads. Everything it
  // touches is listed, so a new field cannot quietly become an unfaked gap.
  const manager = {
    sessions: {
      deletedAgentIds: new Set(),
      resolveBackgroundSession: async () => ({ id: PARENT_AGENT_ID }),
    },
    telemetry: { reportSubagentRevival: report => revivalReports.push(report) },
    pendingWakes: {
      clearSettledPendingWake: settled => clearedWakes.push(settled),
    },
    execution: { canExecute: true },
    runnerRegistry: { getRunner: () => runner },
    runLifecycle: {
      beginSessionRun() {},
      endSessionRun() {},
      enqueueExclusiveRun: async (_id, task) => await task(),
    },
    turnRuntime: { activeRequestPrompts: new Map(), activeRequestSources: new Map() },
    widgetResponses: { collectUnansweredQuestionPrompts: () => ({}) },
    roster: { emitAgentUpdate: async () => {} },
    upgradeResume: { markAgentResumePendingForQuiescedRevival() {} },
  };
  const revivals = new CompletionRevivals(manager);
  runner.setBackgroundSubagentHandler(completion =>
    revivals.handleBackgroundSubagentCompletion(completion),
  );

  // The only thing stubbed on the parent: `runSubagentRevival` calls
  // `runner.run(prompt, options)`, and this records what it would have run.
  const realRun = runner.run.bind(runner);
  runner.run = async (prompt, options) => {
    parentTurns.push({ prompt: String(prompt), options });
    return { aborted: false, sentMessageCount: 0 };
  };

  try {
    const children = ["r1", "r2"].map(label => createChild(label, log));
    dispatch(runner, children, ["subagent-r1", "subagent-r2"]);
    await settle();
    assert.equal(
      parentTurns.length,
      0,
      "the parent was already reviving before the stop, so this measures the wrong moment",
    );

    runner.interruptAll("the user pressed stop");
    await settle();

    assert.equal(
      parentTurns.length,
      0,
      `pressing stop once started ${parentTurns.length} new model turn(s) on the parent: ${JSON.stringify(parentTurns.map(turn => turn.prompt.slice(0, 120)))}`,
    );
    assert.ok(
      !parentTurns.some(turn => turn.prompt.includes("A background task just completed")),
      "the parent was revived with a 'your background task just completed' prompt after the user stopped it, so the agent answers a task that was cancelled",
    );
    assert.deepEqual(
      revivalReports,
      [],
      "the host was told the stopped children were revived, so telemetry counts a cancellation as a delivery",
    );
  } finally {
    runner.run = realRun;
    for (const id of ["subagent-r1", "subagent-r2"]) runner.subagents.abortSubagent(id);
    await settle();
  }
});

/* ------------------------------------------------------------------ */
/* 6. What the stop must NOT change: a real failure still reports.     */
/* ------------------------------------------------------------------ */

test("a subagent that fails on its own still reports its error to the parent exactly once", async () => {
  const log = [];
  const completions = [];
  const runner = createRunner();
  runner.subagents.setBackgroundSubagentHandler(completion => completions.push(completion));
  const child = createChild("boom", log, { failWith: new Error("model provider exploded") });
  dispatch(runner, [child], ["subagent-boom"]);
  await settle();

  assert.equal(
    completions.length,
    1,
    "a subagent that threw reported anything other than one completion, so the parent either never hears about the failure or hears about it twice",
  );
  assert.equal(completions[0].subagentAgentId, "subagent-boom", "the completion names the wrong child");
  assert.equal(completions[0].status, "error", "a thrown subagent turn was reported as a success");
  assert.equal(
    completions[0].result,
    "model provider exploded",
    "the parent's failure report loses the reason the subagent gave",
  );
  assert.deepEqual(
    runner.subagents.listSubagents().map(record => record.status),
    ["error"],
    "the registry records a failed child as done, so the parent's task list is wrong",
  );
});

/* ------------------------------------------------------------------ */
/* 7. Depth. The cap is enforced where the subagent is minted.         */
/* ------------------------------------------------------------------ */

test("the adapter mints depth 1 and refuses depth 2 before a runner exists for it", async () => {
  const built = [];
  const adapter = new SandSubagentHostAdapter(
    new Map(),
    (id, args) => {
      built.push({ id, depth: args.subagentDepth });
      return { run: async () => ({ text: "", aborted: false }), interrupt() {} };
    },
    {
      isRunning: () => false,
      allocateComputerUseWindow: () => ({}),
      freeComputerUseWindow: () => {},
      dispatch: () => {},
    },
    { depth: 0, maxDepth: 1 },
  );
  const context = { get: () => undefined };

  const first = await adapter.createOrResumeSession(context, {
    subagentType: "generalPurpose",
    toolCallId: "call-1",
    prompt: "do the work",
  });
  assert.deepEqual(built, [{ id: first, depth: 1 }], "a Task dispatch from the agent the user talks to must mint exactly one depth-1 child");
  assert.equal(adapter.subagentDepthOf(first), 1, "the depth a child was minted at is not readable, so a resumed child reports a recomputed one");

  await assert.rejects(
    adapter.createOrResumeSession(context, {
      subagentType: "generalPurpose",
      toolCallId: "call-2",
      prompt: "go deeper",
      subagentDepth: 2,
    }),
    error =>
      error instanceof SandSubagentDispatchError
      && error.message.includes("nesting depth is limited to 1"),
    "a child that reaches Task anyway is not stopped by name, so the user reads a stack error instead of the nesting limit",
  );
  assert.equal(built.length, 1, "a refused dispatch still built a runner, so the guard only moved the failure one layer down");
});