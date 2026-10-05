/**
 * A turn whose model provider went silent used to hang with nothing at all in the tray: no
 * answer, no error, no retry notice, and the provider socket left open. None of the four
 * turn-level obligations below could be checked before, because every one of them needs the
 * model to call a tool at a chosen moment and a free-running model produces false results —
 * four of the six "defects" this session turned out to be were exactly that.
 *
 * The fix is a deterministic substitute provider driven through the REAL stack:
 * `createProductionTurnRunShellAdapter` → `createTurnRunShell` → `createStreamAttempt` →
 * `createTurnAgentStreamStart` → the REAL `SimplePromptToolExecutor` → the REAL toolset built
 * by `buildTurnTools`. Only the Agent itself is a seam, because everything above it is the
 * code that has to be right. The provider scripts decide, per attempt, whether the model is
 * slow, mid-stream drop, huge, or binary.
 *
 * What the old code got wrong, and what each test now pins:
 *
 *  1. The first-token deadline existed but nothing said so. The ladder retried silently and
 *     then threw `FirstTokenStallError` with no tray event; a user who pressed stop saw a tray
 *     that never changed. The retry report is the only thing the surface ever learns, so the
 *     turn must emit one per attempt and end with a message that names the stall.
 *  2. A stalled attempt was cancelled but never awaited, so the abandoned provider stream kept
 *     its socket and could still deliver a tool call after the next attempt had started. Two
 *     answers, one turn. The stream must be observed closed.
 *  3. `SAND_FIRST_TOKEN_STALL_DEADLINE_MS=0` is documented as the kill switch. It has to
 *     actually disable the timer, or it is a dead switch.
 *  4. A user cancel that the turn reports as a failure trains people to ignore red states.
 *     `run()` must resolve `aborted: true` and the model must deliver nothing afterwards.
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

// Nothing below may wait forever: every wait on a promise that is supposed to settle is
// bounded, so a regression fails the test instead of hanging the suite.
const SAFETY_CEILING_MS = 20_000;

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-turn-stall-"));
  const source = (relative) => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { createProductionTurnRunShellAdapter } from ${source(["host", "runner", "production-turn-run-shell-adapter.ts"])};`,
    `export { createTurnAgentStreamStart, createTurnRedactedRunProjection } from ${source(["host", "runner", "turn-agent-composition.ts"])};`,
    `export { buildTurnTools } from ${source(["host", "runner", "tools", "turn-toolset.js"])};`,
    `export { SimplePromptToolExecutor } from ${source(["packages", "agent", "tool-stream-executor.js"])};`,
    `export { InteractionHandler } from ${source(["packages", "agent", "interaction-handler.js"])};`,
    `export { PrivacyCapability } from ${source(["packages", "redaction", "classification.js"])};`,
    `export { PrivacyMode } from ${source(["packages", "redaction", "privacy-mode.js"])};`,
    `export { createContext } from ${source(["packages", "context", "core.js"])};`,
    `export { fromRedactedConversationStateStructure } from ${source(["packages", "redacted-protos", "generated", "agent", "v1", "agent_redacted.js"])};`,
    `export { ConversationAction, ConversationStateStructure, ConversationStep, ConversationTurnStructure, AgentConversationTurnStructure, AssistantMessage, UserMessage, UserMessageAction } from ${source(["packages", "proto", "generated", "agent", "v1", "agent_pb.js"])};`,
  ].join("\n"), "utf8");
  const outfile = path.join(directory, "entry.cjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // The toolset pulls in CommonJS dependencies (`mime-types` and its internal
    // relative requires), which esbuild can only wire up inside a CommonJS output —
    // the same shape `scripts/lib/clean-build.mjs` builds.
    format: "cjs",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    external: ["prom-client"],
    logLevel: "silent",
  });
  const require = createRequire(import.meta.url);
  const loaded = require(outfile);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const {
  createProductionTurnRunShellAdapter,
  buildTurnTools,
  SimplePromptToolExecutor,
  InteractionHandler,
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
    step: { case: "assistantMessage", value: new AssistantMessage({ content: encode(text) }) },
  }).toBinary();
}

function stateWithSteps(userMessage, stepCount) {
  return new ConversationStateStructure({
    turns: [
      new ConversationTurnStructure({
        turn: {
          case: "agentConversationTurn",
          value: new AgentConversationTurnStructure({
            userMessage: encode(userMessage),
            steps: Array.from({ length: stepCount }, (_, index) => conversationStep(`step-${index}`)),
          }),
        },
      }).toBinary(),
    ],
    summaryArchives: [],
    turnTimings: [],
  });
}

function observedStepCount(redactedState) {
  const restored = fromRedactedConversationStateStructure(
    redactedState,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  );
  const turn = ConversationTurnStructure.fromBinary(restored.turns[0]);
  assert.equal(turn.turn.case, "agentConversationTurn", "the fixture must hold an agent turn");
  return turn.turn.value.steps.length;
}

/** The exact failure an interrupted provider socket reports. */
function abortedProviderError() {
  const error = new Error("the operation was aborted");
  error.name = "AbortError";
  return error;
}

/** A provider that stays silent until the turn cancels it, then records the close. */
async function* neverSendsAFirstToken(ctx, observation) {
  await new Promise((_resolve, reject) => {
    if (ctx.signal.aborted) {
      observation.closed = true;
      reject(abortedProviderError());
      return;
    }
    ctx.signal.addEventListener(
      "abort",
      () => {
        observation.closed = true;
        reject(abortedProviderError());
      },
      { once: true },
    );
  });
}

/**
 * The deterministic substitute provider. Each script is one model turn; `calls` counts them
 * so a test can assert the ladder really re-entered the provider instead of faking a retry.
 */
function scriptedProvider(script) {
  const messages = [];
  let calls = 0;
  const observations = [];
  return {
    calls: () => calls,
    observations,
    appendMessages(incoming) {
      messages.push(...(Array.isArray(incoming) ? incoming : [incoming]));
      return this;
    },
    getState: () => messages,
    getMessages: () => messages,
    clearMessages() {
      messages.length = 0;
    },
    stream(ctx, invocationId, tools, options) {
      const index = calls;
      calls += 1;
      const observation = { call: index + 1, closed: false, sawAbortSignal: false };
      observations.push(observation);
      let finish;
      const finished = new Promise((resolve) => {
        finish = resolve;
      });
      const fullStream = (async function* () {
        try {
          yield* script[index]?.({ ctx, tools, options, observation }) ?? [];
        } finally {
          finish();
        }
      })();
      return {
        fullStream,
        // The real SDK settles `response` in the stream's own flush, never by a second
        // consumer: `duplicateStream` already splits `fullStream`, so draining it here
        // would kill the branch the collector is reading.
        response: finished.then(() => ({
          messages: [],
          id: `response-${index + 1}`,
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

/**
 * The same model turn, planned for every attempt the ladder may make. An attempt past the end
 * of the script would come back with nothing at all, which reads as a recovered turn.
 */
function plannedAttempts(makeTurn, count) {
  return Array.from({ length: count }, () => makeTurn);
}

/**
 * One recording delivery tool standing in for `SendMessage`.
 */
function deliveryToolset(record) {
  return {
    name: "SendMessage",
    toolIdentifier: "SEND_MESSAGE",
    async execute(_ctx, _interaction, argsStream, meta) {
      let raw = "";
      for await (const chunk of argsStream) raw += chunk;
      record.push({ toolCallId: meta?.toolCallId, raw });
      return { toJson: () => ({ delivered: true }) };
    },
    render: (_ctx, result) => ({ content: [{ type: "text", text: "delivered" }], isError: false }),
    // The failure path serialises through this shape before `render` sees it, so it has to
    // look like a generated message rather than an `Error`.
    serializeError: (error) => ({
      toJson: () => ({ error: error instanceof Error ? error.message : String(error) }),
      result: { case: "error", value: {} },
    }),
  };
}

function buildHandle(delivered) {
  const host = {
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    isComputerUseSubagent: false,
    isBrowserUseSubagent: false,
    isSystemPromptOverridden: false,
    remoteBoxHasDesktop: false,
    getConversationId: () => "aaaaaaaa-0000-4000-8000-000000000001",
    getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true,
    spotlightEnabled: () => false,
    isDynamicToolsEnabled: () => false,
    factories: { sendMessage: () => deliveryToolset(delivered) },
  };
  return buildTurnTools(host, { autoReviewModes: {}, subagentConfigs: [] }, undefined);
}

/**
 * The Agent seam. Everything above it — the adapter, the attempt ladder, the stream start,
 * the redaction projection — is the real product code; only the Agent class is replaced so
 * the deterministic provider can drive the real `SimplePromptToolExecutor`.
 */
function providerAgent(script, delivered) {
  const provider = scriptedProvider(script);
  const handle = buildHandle(delivered);
  return {
    provider,
    agent: {
      async runStream(ctx, state, action, mcpTools, persistCheckpoint) {
        const stepsOnArrival = observedStepCount(state);
        const actionCase = action.action.case;
        const interaction = new InteractionHandler(
          { sendUpdate: async () => {} },
          { recordToolCall: () => {} },
          "invocation-under-test",
        );
        const stream = new SimplePromptToolExecutor(provider).executeToolStream(
          ctx,
          state,
          interaction,
          handle.getAllTools(),
          {},
          async () => {},
          undefined,
          undefined,
        );
        // Production has a UI branch reading `fullStream`; `duplicateStream` only settles a
        // write once a reader takes it, so an unread branch stalls the collector forever.
        const uiBranch = (async () => {
          try {
            for await (const _chunk of stream.fullStream) { /* the tray's live copy */ }
          } catch { /* the collector reports the same failure */ }
        })();
        await uiBranch;
        // A dropped provider stream does not reject the response: the collector catches it and
        // carries it as `response.error` (tool-stream-executor.ts:1244), so the turn owner is
        // the one that has to rethrow. Skipping that step hides the failure from the ladder.
        const response = await stream.response;
        if (response?.error !== undefined && response?.error !== null) throw response.error;
        const produced = stateWithSteps("do the work", stepsOnArrival + 1);
        await persistCheckpoint(ctx, produced);
        return produced;
      },
    },
  };
}

function createShell({ agent, retryReports }) {
  const owner = {
    built: { agent },
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
    async createOwner() {
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

test("a provider that never sends a first token ends the turn with a stall the tray can report", async () => {
  process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS = "60";
  process.env.SAND_FIRST_TOKEN_STALL_MAX_DEADLINE_MS = "80";
  const delivered = [];
  const { provider, agent } = providerAgent(
    plannedAttempts(({ ctx, observation }) => neverSendsAFirstToken(ctx, observation), 2),
    delivered,
  );
  const retryReports = [];
  const shell = createShell({ agent, retryReports });

  const outcome = await settlesWithin(
    shell.run("do the work", { transientStreamRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } }),
  );

  assert.equal(outcome.settled, true, "the turn never settled, so the user waits forever with no explanation");
  assert.equal(
    outcome.settled && outcome.error?.name,
    "FirstTokenStallError",
    `the surface must be able to tell a stall from a provider fault or a user cancel; observed ${JSON.stringify(outcome.settled ? outcome.error?.message ?? outcome.value : "unsettled")}`,
  );
  assert.match(
    outcome.settled ? String(outcome.error?.message) : "",
    /did not start responding/,
    "the reported reason has to say the provider was silent; without it the tray can only say 'failed'",
  );
  assert.equal(
    provider.calls(),
    2,
    "the ladder must have re-entered the provider, otherwise the retry is decoration",
  );
  assert.deepEqual(
    observationsClosed(provider),
    [true, true],
    "an abandoned attempt must have its stream closed, or the orphan can still deliver after the next attempt",
  );
  assert.deepEqual(
    retryReports.map((report) => report.outcome),
    ["retried", "exhausted"],
    "the tray is told nothing about a stall unless the attempt layer reports every outcome",
  );
  assert.deepEqual(
    delivered,
    [],
    "a stalled turn delivered a message anyway, so the user got an answer with no visible failure",
  );
});

function observationsClosed(provider) {
  return provider.observations.map((observation) => observation.closed);
}

test("the first-token deadline doubles per retry and stops at the ceiling", async () => {
  process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS = "60";
  // The ladder doubles 60 -> 120 and is then held at the ceiling. A ceiling of
  // 90 made the intended growth a 30ms difference, which is smaller than how far
  // a timer overshoots on a loaded machine: both attempts then land on the
  // ceiling and the ladder stops looking like it grows even though it did. The
  // growth has to sit above the measurement noise or the test measures the clock.
  process.env.SAND_FIRST_TOKEN_STALL_MAX_DEADLINE_MS = "180";
  const delivered = [];
  const startedAt = [];
  const { agent } = providerAgent(
    [
      ({ ctx, observation }) => {
        startedAt.push(Date.now());
        return neverSendsAFirstToken(ctx, observation);
      },
      ({ ctx, observation }) => {
        startedAt.push(Date.now());
        return neverSendsAFirstToken(ctx, observation);
      },
      ({ ctx, observation }) => {
        startedAt.push(Date.now());
        return neverSendsAFirstToken(ctx, observation);
      },
    ],
    delivered,
  );
  const retryReports = [];
  const shell = createShell({ agent, retryReports });

  const outcome = await settlesWithin(
    shell.run("do the work", { transientStreamRetry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }),
  );

  assert.equal(outcome.settled, true, "the ladder never finished");
  assert.equal(
    startedAt.length,
    3,
    "the fixture must make three attempts observable, or the gaps below mean nothing",
  );
  const firstGap = startedAt[1] - startedAt[0];
  const secondGap = startedAt[2] - startedAt[1];
  assert.ok(firstGap >= 40, `the first deadline was not waited out at all (${firstGap} ms)`);
  assert.ok(
    secondGap > firstGap,
    `the deadline did not grow on the retry (${firstGap} ms then ${secondGap} ms): an uncapped ladder outlives the run lease`,
  );
  assert.ok(
    secondGap < 2_000,
    `the second deadline was capped by nothing (${secondGap} ms): the ceiling is what keeps the ladder inside the lease`,
  );
});

test("SAND_FIRST_TOKEN_STALL_DEADLINE_MS=0 turns the deadline off instead of shortening it", async () => {
  process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS = "0";
  delete process.env.SAND_FIRST_TOKEN_STALL_MAX_DEADLINE_MS;
  const delivered = [];
  const { provider, agent } = providerAgent(
    [
      async function* ({ observation }) {
        // Slower than the default 150 s deadline, and no abort listener at all: with the
        // kill switch off the turn must simply wait this out.
        await new Promise((resolve) => setTimeout(resolve, 150));
        observation.closed = true;
        yield { type: "text-delta", textDelta: "hello" };
      },
    ],
    delivered,
  );
  const retryReports = [];
  const shell = createShell({ agent, retryReports });

  const outcome = await settlesWithin(
    shell.run("do the work", { transientStreamRetry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }),
  );

  assert.equal(outcome.settled, true, "the turn never settled");
  assert.equal(
    outcome.settled && outcome.error,
    undefined,
    "a slow-but-working provider was failed even though the deadline was switched off",
  );
  assert.equal(outcome.value?.aborted, false, "the turn must report a normal completion, not a cancellation");
  assert.deepEqual(retryReports, [], "a turn that finished must not announce retries");
});

test("a user cancel during a live turn is reported as a cancel, not as a failure", async () => {
  delete process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS;
  const delivered = [];
  let releaseFirstDelta;
  const firstDeltaArrived = new Promise((resolve) => {
    releaseFirstDelta = resolve;
  });
  const { provider, agent } = providerAgent(
    [
      async function* ({ ctx, observation }) {
        yield { type: "text-delta", textDelta: "working" };
        releaseFirstDelta();
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              observation.closed = true;
              reject(abortedProviderError());
            },
            { once: true },
          );
        });
      },
    ],
    delivered,
  );
  const retryReports = [];
  const shell = createShell({ agent, retryReports });

  const running = shell.run("do the work", { transientStreamRetry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } });
  await firstDeltaArrived;
  shell.interrupt("the user pressed stop");
  const outcome = await settlesWithin(running);

  assert.equal(outcome.settled, true, "the cancelled turn never settled");
  assert.equal(
    outcome.settled && outcome.error,
    undefined,
    "a cancel the user asked for must not come back as a failure the tray paints red",
  );
  assert.equal(outcome.value?.aborted, true, "the tray cannot say 'cancelled' without this flag");
  assert.deepEqual(
    observationsClosed(provider),
    [true],
    "the provider socket stayed open after the cancel, so the turn is still burning the endpoint",
  );
  assert.deepEqual(delivered, [], "a cancelled turn delivered a message to the user afterwards");
  assert.deepEqual(retryReports, [], "a cancelled turn must not be announced as a retry");
});

test("a stream that dies in the middle of an answer settles the turn instead of hanging", async () => {
  delete process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS;
  const delivered = [];
  const { agent } = providerAgent(
    [
      async function* () {
        yield { type: "text-delta", textDelta: "half an ans" };
        throw new Error("terminated");
      },
      async function* () {
        yield { type: "text-delta", textDelta: "recovered" };
      },
    ],
    delivered,
  );
  const retryReports = [];
  const shell = createShell({ agent, retryReports });

  const outcome = await settlesWithin(
    shell.run("do the work", { transientStreamRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } }),
  );

  assert.equal(outcome.settled, true, "a stream that dies mid-arguments left the turn hanging forever");
  assert.equal(
    outcome.settled && outcome.error,
    undefined,
    "the ladder is supposed to restart a dropped stream, not to end the turn on it",
  );
  assert.deepEqual(
    retryReports.map((report) => report.outcome),
    ["retried"],
    "the tray is not told that the provider dropped mid-stream",
  );
  assert.deepEqual(
    delivered,
    [],
    "a stream that died mid-answer still reached the user, so a torn message was delivered",
  );
});