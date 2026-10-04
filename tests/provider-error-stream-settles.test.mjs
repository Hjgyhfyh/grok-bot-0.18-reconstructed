import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// An agent turn that reached the model and was refused used to hang forever and say nothing.
// The provider stream carries a single `{ type: "error" }` part and then ends, and the AI SDK
// settles `result.response`, `result.usage` and `result.providerMetadata` only in the stream's
// normal `flush` — so on an error they are DelayedPromises nobody ever resolves.
// `streamModelAndCollectToolCalls` had no `error` branch, so it dropped that part, walked to the
// end of the loop and then awaited a promise that could not resolve. The turn completed setup,
// wrote its user row, and produced neither an assistant message nor an error. Nothing in the log
// said why, which is why the credential failure it used to report loudly simply vanished.
// These tests drive the real product module with a refusing stream and prove the turn settles
// with the provider's own error instead of waiting forever.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Nothing here may wait forever: every wait on a promise that is supposed to settle is bounded,
// so a regression fails the test instead of hanging the suite.
const SAFETY_CEILING_MS = 5_000;
const REFUSAL = "the custom endpoint answered 401 Invalid API key";

let toolStreamExecutor;
let temporary;

function neverSettles() {
  // Mirrors the SDK's DelayedPromise on an errored stream: pending forever, never rejected.
  return new Promise(() => {});
}

async function* refusingStream() {
  yield { type: "error", error: new Error(REFUSAL) };
}

function refusingExecutor() {
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
    stream() {
      return {
        fullStream: refusingStream(),
        response: neverSettles(),
        usage: neverSettles(),
        extendedUsage: neverSettles(),
        providerMetadata: neverSettles(),
        invocationId: Promise.resolve("invocation-under-test"),
      };
    },
  };
}

function runTurn() {
  const executor = new toolStreamExecutor.SimplePromptToolExecutor(refusingExecutor());
  return executor.executeToolStream(
    {},
    {},
    { invocationId: "invocation-under-test", recordToolCallResult: async () => {} },
    [],
    {},
    async () => {},
    {},
    undefined,
  );
}

function settlesWithin(promise, ceilingMs) {
  return Promise.race([
    promise.then((value) => ({ settled: true, value }), (error) => ({ settled: true, error })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), ceilingMs).unref?.()),
  ]);
}

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-error-stream-"));
  const output = path.join(temporary, "tool-stream-executor.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "packages", "agent", "tool-stream-executor.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  toolStreamExecutor = await import(pathToFileURL(output).href);
});

after(async () => {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
});

test("a turn whose provider stream returns an error part settles instead of waiting forever", async () => {
  const result = runTurn();
  const outcome = await settlesWithin(result.response, SAFETY_CEILING_MS);

  assert.equal(
    outcome.settled,
    true,
    "the turn's response promise never settled, so the agent produced no reply and no error at all",
  );
  assert.equal(outcome.settled && outcome.error, undefined, "the refusal must be reported as data, not thrown out of executeToolStream");
  assert.equal(
    outcome.value.error?.message,
    REFUSAL,
    "the turn must carry the provider's own failure, otherwise the next layer cannot report it",
  );
});

test("a refused turn closes the tool call iterables, so the tool consumers waiting on them end too", async () => {
  // `executeModelStreamOnly` never awaits the response; it hands the tool-call iterable to a
  // consumer that only stops when the iterable is closed. A refused turn that skipped
  // `closeToolIterables()` would leave that consumer waiting forever behind a settled response.
  const executor = new toolStreamExecutor.SimplePromptToolExecutor(refusingExecutor());
  const streamOnly = executor.executeModelStreamOnly(
    {},
    {},
    { invocationId: "invocation-under-test" },
    [],
    {},
    {},
    undefined,
  );

  const descriptors = await settlesWithin(streamOnly.toolCallDescriptors, SAFETY_CEILING_MS);
  assert.equal(
    descriptors.settled,
    true,
    "the tool call descriptors never finished, so a consumer of this entry point waits forever on a refused turn",
  );
  assert.deepEqual(descriptors.value, [], "a stream that only refused cannot have produced tool calls");
});

test("usage and extended usage settle on a refused turn instead of hanging their readers", async () => {
  const result = runTurn();
  const usage = await settlesWithin(result.usage, SAFETY_CEILING_MS);
  const extended = await settlesWithin(result.extendedUsage, SAFETY_CEILING_MS);

  assert.equal(usage.settled, true, "nothing would ever learn the token cost of a refused turn");
  assert.equal(extended.settled, true, "the prompt-suggestion and self-summary paths await this and would hang on the same turn");
  assert.equal(usage.value?.totalTokens, 0, "a turn that never streamed has no tokens to report");
  assert.equal(extended.value?.inputTokens, 0, "a turn that never streamed has no tokens to report");
});
