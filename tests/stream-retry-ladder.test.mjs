/**
 * The transient-retry ladder never fired for a real provider failure. Two defects sat on the
 * same path and both looked like "the provider was down":
 *
 *  1. `isRetryableProviderError` read `value.retryable === true`, while `ai` 4.3.17 stamps its
 *     `APICallError` with `isRetryable` (`ai/dist/index.mjs:289`). Every 429 and every 500 came
 *     back "not retryable", so `runWithTransientRetry` rethrew on the first attempt.
 *  2. `TRANSIENT_MESSAGE_TOKENS` carried the phrase "connection terminated" but not the word a
 *     dropped provider socket actually produces: "terminated". An interrupted response body was
 *     classified as a terminal fault.
 *
 * On top of that, the per-attempt first-token deadline doubled without a ceiling
 * (`base * 2 ** retries` -> 150 s, 300 s, 600 s). The 900 s run lease expired while the third
 * attempt was still waiting for its first token, and `run-lifecycle.ts` swallows the late
 * `endSessionRun`, so a turn that was still running got recorded as finished.
 *
 * `createStreamAttempt` also rejected a first-token stall without awaiting the stream it had
 * just cancelled. The orphan kept running and could still call `SendMessage` after the next
 * attempt had started, so one stalled turn delivered two answers.
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-stream-ladder-"));
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
  ["host", "runner", "transient-stream-error.ts"],
  ["host", "runner", "stream-attempt.ts"],
]);
const {
  DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS,
  DEFAULT_FIRST_TOKEN_STALL_MAX_DEADLINE_MS,
  isRetryableProviderError,
  messageLooksTransient,
  resolveFirstTokenStallMaxDeadlineMs,
  runWithTransientRetry,
  shouldRetryTurnAttempt,
} = loaded["transient-stream-error.mjs"];
const { createStreamAttempt } = loaded["stream-attempt.mjs"];

const TOUCHED_ENV = ["SAND_FIRST_TOKEN_STALL_DEADLINE_MS", "SAND_FIRST_TOKEN_STALL_MAX_DEADLINE_MS"];
const savedEnv = new Map(TOUCHED_ENV.map((name) => [name, process.env[name]]));
test.after(() => {
  for (const name of TOUCHED_ENV) {
    const saved = savedEnv.get(name);
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  dispose();
});

test("a 429 stamped by the ai SDK is retryable even though it never carries `retryable`", () => {
  const apiError = { name: "AI_APICallError", statusCode: 429, isRetryable: true, message: "Too Many Requests" };
  assert.equal(
    apiError.retryable,
    undefined,
    "the fixture must reproduce the SDK spelling, otherwise the test proves nothing",
  );
  assert.equal(
    isRetryableProviderError(apiError),
    true,
    "a throttled provider is retryable and the ladder has to own the backoff",
  );
});

test("a 500 stamped by the ai SDK is retryable", () => {
  assert.equal(
    isRetryableProviderError({ name: "AI_APICallError", statusCode: 500, isRetryable: true, message: "Internal Server Error" }),
    true,
    "an internal server error is retryable",
  );
});

test("a 401 is still not retryable, so the ladder cannot spin on a bad credential", () => {
  assert.equal(
    isRetryableProviderError({ name: "AI_APICallError", statusCode: 401, isRetryable: false, message: "Unauthorized" }),
    false,
    "a rejected credential cannot be fixed by retrying",
  );
});

test("a provider marked terminal stays terminal even when the message looks transient", () => {
  assert.equal(
    isRetryableProviderError({ terminal: true, isRetryable: true, message: "connection terminated" }),
    false,
    "an explicitly terminal fault must not be retried",
  );
});

test("the bare word 'terminated' from a dropped socket is a transient message", () => {
  assert.equal(
    messageLooksTransient("terminated"),
    true,
    "an interrupted response body reports 'terminated', not the longer 'connection terminated'",
  );
});

test("the backoff ladder re-issues the call when the SDK marks the failure retryable", async () => {
  let attempts = 0;
  const value = await runWithTransientRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw { name: "AI_APICallError", statusCode: 429, isRetryable: true, message: "Too Many Requests" };
      return "ok";
    },
    {
      maxAttempts: 4,
      baseDelayMs: 0,
      maxDelayMs: 0,
      sleep: async () => {},
      // The exact predicate `stream-attempt.ts` installs on the policy.
      isRetryable: (error) => shouldRetryTurnAttempt({ canceled: false, error, streamOutputProduced: false, resumeCheckpointAvailable: false }),
    },
  );
  assert.equal(value, "ok", "the third attempt succeeded and its value must reach the caller");
  assert.equal(attempts, 3, "the ladder gave up before the provider recovered");
});

test("the per-attempt first-token deadline is capped so the ladder cannot outlive the run lease", () => {
  assert.equal(
    resolveFirstTokenStallMaxDeadlineMs({}),
    DEFAULT_FIRST_TOKEN_STALL_MAX_DEADLINE_MS,
    "an unset ceiling lets a single stalled attempt grow past the 900s run lease",
  );
  const ceiling = DEFAULT_FIRST_TOKEN_STALL_MAX_DEADLINE_MS;
  const ladder = [0, 1, 2].map((retries) => Math.min(DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS * 2 ** retries, ceiling));
  assert.deepEqual(ladder, [150_000, 300_000, 300_000], "the third attempt doubled past the ceiling");
  assert.ok(
    ladder.reduce((sum, value) => sum + value, 0) < 900_000,
    "the run lease is 900s, so the whole first-token ladder has to fit inside it with room for backoff",
  );
});

test("an operator ceiling below the built-in default wins", () => {
  assert.equal(
    resolveFirstTokenStallMaxDeadlineMs({ SAND_FIRST_TOKEN_STALL_MAX_DEADLINE_MS: "45000" }),
    45_000,
    "an operator ceiling has to win over the built-in default",
  );
});

function makeAttemptHost(overrides = {}) {
  const state = { streamOutputProduced: false, canceled: false, cancelCount: 0, deadlineMs: 0, fireDeadline: () => {}, retries: [] };
  const host = {
    // `maxAttempts: 1` runs a single attempt through `runStreamOnce`, so the test observes the
    // stall path itself instead of the ladder re-entering it.
    transientStreamRetry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ctx: {
      get canceled() { return state.canceled; },
      withCancel() {
        const controller = new AbortController();
        return [{ signal: controller.signal }, (reason) => { state.cancelCount += 1; controller.abort(reason); }];
      },
    },
    hidden: true,
    setStreamOutputProduced(value) { state.streamOutputProduced = value; },
    getStreamOutputProduced() { return state.streamOutputProduced; },
    async persistCheckpoint() {},
    createDeadlineTimer(callback, deadlineMs) {
      state.deadlineMs = deadlineMs;
      state.fireDeadline = callback;
      return { cancel() {}, restart() {} };
    },
    setDeadlineHooks() {},
    clearDeadlineHookIf() {},
    setTraceAttributes() {},
    emitRetrying() {},
    reportTurnRetry(info) { state.retries.push(info); },
    ...overrides,
  };
  return { host, state };
}

test("a stalled attempt rejects only after the stream it cancelled has finished", async () => {
  const order = [];
  process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS = "1000";
  const { host, state } = makeAttemptHost({
    startStream(ctx) {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          // The orphan keeps working for a tick after the cancel, exactly like a provider stream
          // that already has a buffered tool call in flight.
          setTimeout(() => {
            order.push("orphan-tool-call");
            reject(new Error("stream aborted by the stall deadline"));
          }, 40);
        }, { once: true });
      });
    },
  });
  const running = createStreamAttempt(host).run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.deadlineMs, 1_000, "the first attempt did not use the configured stall deadline");
  state.fireDeadline();
  const error = await running.then(() => null, (reason) => reason);
  order.push("rejected");
  assert.equal(
    error?.name,
    "FirstTokenStallError",
    "a stalled attempt has to be reported as a stall, whatever the abandoned stream did",
  );
  assert.deepEqual(
    order,
    ["orphan-tool-call", "rejected"],
    "the rejection landed before the cancelled stream had finished, leaving an orphan that could still deliver a message",
  );
});

test("a checkpoint failure that races a provider failure is attached as the cause, not reported as the reason", async () => {
  process.env.SAND_FIRST_TOKEN_STALL_DEADLINE_MS = "0";
  const providerFailure = new Error("provider returned 500");
  const { host } = makeAttemptHost({
    persistCheckpoint() { throw new Error("checkpoint write failed"); },
    async startStream(_ctx, _resumeFrom, persist) {
      await persist({}, { id: "checkpoint" }).catch(() => {});
      throw providerFailure;
    },
  });
  const error = await createStreamAttempt(host).run().then(() => null, (reason) => reason);
  assert.equal(
    error,
    providerFailure,
    "the provider's own error has to survive; a persistence failure cannot replace the reported cause",
  );
  assert.equal(
    error?.cause?.message,
    "checkpoint write failed",
    "the persistence failure has to stay reachable, just not as the headline",
  );
});