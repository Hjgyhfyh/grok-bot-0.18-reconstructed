/**
 * A retried turn restarted from nothing, so every step the model had already
 * produced was thrown away with the failed stream.
 *
 * The defect had two halves and only one of them was visible in the code.
 *
 *  1. `production-turn-run-shell-adapter.ts` called
 *     `stream.startStream(runContext, undefined, persist)` exactly once. The
 *     `undefined` is the resume point, and `createTurnRedactedRunProjection`
 *     reads it: `isResume = input.resumeFrom !== undefined` is what swaps the
 *     user's message action for `RESUME_TURN_ACTION` and rebuilds the state from
 *     the accepted checkpoint instead of the turn's base state. Without it every
 *     attempt is a first attempt, so the whole resume branch of that function was
 *     dead in production.
 *  2. There was no attempt ladder here at all. `createStreamAttempt`
 *     (`stream-attempt.ts:43,:85`) is the only place that computes the last
 *     ACCEPTED checkpoint on a retry, and nothing in the production turn path
 *     ever called it — `runnerOptions.createStreamAttempt` is a dormant option
 *     and `inactive-turn-agent-stream.ts` binds it only on the path that is not
 *     flipped. So a transient provider fault did not restart the turn; it ENDED
 *     it, and the steps the shell had already persisted were never continued.
 *
 * Why nothing noticed: a lost retry looks exactly like a provider outage. The
 * user sees one failed turn, the transcript holds the first attempt's steps, and
 * the retry code that was supposed to continue them is in a module that looks
 * exercised by `stream-retry-ladder.test.mjs`.
 *
 * What this file proves, on a real production adapter driven through
 * `createTurnRunShell`: the first provider call drops the stream with a
 * repeatable error AFTER persisting three steps, and the second call is handed
 * those three steps and the resume action. The step count the adapter hands the
 * stream before and after the retry is the evidence, and it is a real protobuf
 * `ConversationStateStructure` decoded from the redacted state the stream
 * actually received — not a counter the test increments itself.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-turn-resume-"));
  const source = relative =>
    JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { createProductionTurnRunShellAdapter } from ${source(["host", "runner", "production-turn-run-shell-adapter.ts"])};`,
    `export { createTurnAgentStreamStart, createTurnRedactedRunProjection } from ${source(["host", "runner", "turn-agent-composition.ts"])};`,
    `export { PrivacyCapability } from ${source(["packages", "redaction", "classification.js"])};`,
    `export { PrivacyMode } from ${source(["packages", "redaction", "privacy-mode.js"])};`,
    `export { createContext } from ${source(["packages", "context", "core.js"])};`,
    `export { fromRedactedConversationStateStructure } from ${source(["packages", "redacted-protos", "generated", "agent", "v1", "agent_redacted.js"])};`,
    `export { ConversationAction, ConversationStateStructure, ConversationStep, ConversationTurnStructure, AgentConversationTurnStructure, AssistantMessage, UserMessage, UserMessageAction } from ${source(["packages", "proto", "generated", "agent", "v1", "agent_pb.js"])};`,
  ].join("\n"), "utf8");
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
const {
  createProductionTurnRunShellAdapter,
  createTurnRedactedRunProjection,
  PrivacyCapability,
  PrivacyMode,
  createContext,
  fromRedactedConversationStateStructure,
  ConversationAction,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
  AgentConversationTurnStructure,
  AssistantMessage,
  UserMessage,
  UserMessageAction,
} = loaded;

const TOUCHED_ENV = [
  "SAND_FIRST_TOKEN_STALL_DEADLINE_MS",
  "SAND_FIRST_TOKEN_STALL_MAX_DEADLINE_MS",
];
const savedEnv = new Map(TOUCHED_ENV.map((name) => [name, process.env[name]]));
test.after(() => {
  for (const name of TOUCHED_ENV) {
    const saved = savedEnv.get(name);
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  dispose();
});

const encode = (value) => new TextEncoder().encode(value);

function conversationStep(text) {
  return new ConversationStep({
    step: {
      case: "assistantMessage",
      value: new AssistantMessage({ content: encode(text) }),
    },
  }).toBinary();
}

function agentTurn(userMessage, steps) {
  return new ConversationTurnStructure({
    turn: {
      case: "agentConversationTurn",
      value: new AgentConversationTurnStructure({
        userMessage: encode(userMessage),
        steps,
      }),
    },
  }).toBinary();
}

function stateWithSteps(userMessage, stepCount) {
  return new ConversationStateStructure({
    turns: [agentTurn(userMessage, Array.from({ length: stepCount }, (_, i) => conversationStep(`step-${i}`)))],
    summaryArchives: [],
    turnTimings: [],
  });
}

/**
 * Reads the step count straight out of the redacted state the stream was handed.
 * Anything less would be the test grading itself.
 */
function observedStepCount(redactedState) {
  const restored = fromRedactedConversationStateStructure(
    redactedState,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  );
  assert.equal(
    restored.turns.length,
    1,
    "the fixture must hold exactly one conversation turn, or the step count means nothing",
  );
  const turn = ConversationTurnStructure.fromBinary(restored.turns[0]);
  assert.equal(
    turn.turn.case,
    "agentConversationTurn",
    "the fixture must hold an agent turn, or the step count means nothing",
  );
  return turn.turn.value.steps.length;
}

/** A provider 429 exactly as the `ai` SDK stamps it. */
function retryableProviderFailure() {
  const error = new Error("Too Many Requests");
  error.name = "AI_APICallError";
  error.statusCode = 429;
  error.isRetryable = true;
  return error;
}

/**
 * Drives the real production adapter over a fake Agent. The fake Agent is the
 * provider: it appends steps, persists, and on the first call fails the way a
 * throttled endpoint does.
 *
 * `emitUpdate` is the relay the adapter hands `createOwner`; production passes it
 * to the Agent as its interaction-update sink. The fake Agent uses it exactly
 * the way a real stream does — a produced step is announced — because that is
 * what tells the retry ladder this turn had already started.
 */
function createFakeProvider() {
  const attempts = [];
  let calls = 0;
  let emit = () => {};
  return {
    attempts,
    bindEmit(next) {
      emit = next;
    },
    get calls() {
      return calls;
    },
    agent: {
      async runStream(ctx, state, action, mcpTools, persistCheckpoint) {
        calls += 1;
        const attempt = {
          call: calls,
          stepsOnArrival: observedStepCount(state),
          actionCase: action.action.case,
          mcpToolCount: mcpTools.length,
          canceled: ctx.canceled,
        };
        attempts.push(attempt);
        if (calls === 1) {
          // Three steps exist and are durable before the stream dies.
          emit({ type: "text-delta", text: "step-0" });
          const persisted = stateWithSteps("do the work", 3);
          await persistCheckpoint(ctx, persisted);
          attempt.persistedSteps = 3;
          throw retryableProviderFailure();
        }
        attempt.persistedSteps = null;
        return stateWithSteps("do the work", attempt.stepsOnArrival + 2);
      },
    },
  };
}

function createAdapterHarness(provider, retryReports) {
  const owner = {
    built: { agent: provider.agent },
    runContext: {
      privacyMode: PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
      commitDiskPressureReminder() {},
      dispose() {},
      scope: { cancelThisRun() {} },
    },
    buildInput: {},
    dispose() {},
  };
  const baseState = stateWithSteps("do the work", 0);
  return createProductionTurnRunShellAdapter({
    async createOwner({ emitUpdate }) {
      provider.bindEmit(emitUpdate);
      return owner;
    },
    async createRunInput() {
      return {
        runCtx: createContext(),
        trimmedPrompt: "do the work",
        promptOptions: {},
        assembleGeneratedTurnAction: async () => ({}),
        compactionEpoch: () => 0,
        action: new ConversationAction({
          action: {
            case: "userMessageAction",
            value: new UserMessageAction({
              userMessage: new UserMessage({ text: encode("do the work") }),
            }),
          },
        }),
        baseState,
        mcpTools: [],
      };
    },
    promptOptions: () => ({}),
    createSession: () => ({ getModelId: () => "test-model" }),
    context: () => createContext(),
    createSettleHost: () => ({
      conversationId: "aaaaaaaa-0000-4000-8000-000000000001",
      profilePromptSnapshots: {},
      isSubagentRunner: false,
      isRunSuperseded: () => false,
      ownsRunner: () => true,
      latestPromptMessages: () => [],
      agentStore: () => null,
      setLocalState() {},
    }),
    profilePromptSnapshots: () => ({}),
    isSubagentRunner: false,
    subagents: { sessions: new Map() },
    getConversationId: () => "aaaaaaaa-0000-4000-8000-000000000001",
    runGeneration: () => 7,
    setActiveTurnRequestSource() {},
    beginAutoReviewUserMessageEpoch() {},
    setActiveRunInterrupted() {},
    setAwaitingUserSelection() {},
    isAwaitingUserSelection: () => false,
    emitRunLifecycle() {},
    emitUpdate() {},
    cancelThisRun() {},
    onStreamRetry: (report) => retryReports.push(report),
  });
}

test("a transient provider fault resumes the turn from its last accepted checkpoint", async () => {
  // The first-token stall timer stays armed on purpose: this proves the stream
  // disarms it through the same relay a real turn uses, not that it was off.
  delete process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS;
  const provider = createFakeProvider();
  const retryReports = [];
  const shell = createAdapterHarness(provider, retryReports);

  const result = await shell.run("do the work", {
    transientStreamRetry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  });

  assert.equal(
    provider.calls,
    2,
    "the provider was called twice, so the retry actually happened inside the turn",
  );
  assert.equal(
    provider.attempts.length,
    2,
    "both attempts have to be observable, or the second call could be anything",
  );
  assert.equal(
    provider.attempts[0].stepsOnArrival,
    0,
    "the first attempt starts from the turn's base state",
  );
  assert.equal(
    provider.attempts[0].actionCase,
    "userMessageAction",
    "the first attempt carries the user's message",
  );
  assert.equal(
    provider.attempts[1].stepsOnArrival,
    3,
    "the retry must continue from the three steps the dead stream had already produced and the shell had already persisted",
  );
  assert.equal(
    provider.attempts[1].actionCase,
    "resumeAction",
    "continuing a turn means resuming it, not asking the user their question a second time",
  );
  assert.equal(
    provider.attempts[1].stepsOnArrival - provider.attempts[0].stepsOnArrival,
    provider.attempts[0].persistedSteps,
    "the difference in what the two attempts were given IS the work that would have been thrown away",
  );
  assert.equal(
    result.aborted,
    false,
    "the turn recovered on its own; the user must not be told the run failed",
  );
  assert.deepEqual(
    retryReports.map((report) => report.outcome),
    ["retried"],
    "the retry has to be reported, or a silent ladder is the same blindness as no ladder",
  );
  assert.equal(
    retryReports[0].attempt,
    1,
    "the first retry is attempt 1 in the ladder's own counting",
  );
});

test("without the resume point the retry would receive an empty turn again", () => {
  // The counterfactual that makes the assertion above mean something: feed the
  // projection what the adapter used to pass and watch the turn start over.
  const baseState = stateWithSteps("do the work", 0);
  const action = new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({
        userMessage: new UserMessage({ text: encode("do the work") }),
      }),
    },
  });
  const resumed = createTurnRedactedRunProjection({
    baseState,
    action,
    resumeFrom: stateWithSteps("do the work", 3),
    privacyMode: PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
  });
  const discarded = createTurnRedactedRunProjection({
    baseState,
    action,
    resumeFrom: undefined,
    privacyMode: PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
  });
  assert.equal(
    observedStepCount(resumed.state),
    3,
    "the resume point is what carries the produced steps into the next attempt",
  );
  assert.equal(
    observedStepCount(discarded.state),
    0,
    "the value the adapter used to pass hands over an empty turn, which is the defect in one assertion",
  );
  assert.equal(discarded.isResume, false, "undefined can never be read as a resume");
  assert.equal(resumed.isResume, true, "a checkpoint is a resume by definition");
});
