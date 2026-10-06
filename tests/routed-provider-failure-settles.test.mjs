/*
  A routed provider failure never failed. It hung.

  `runRoutedProviderText` looped over `result.fullStream` looking only for `text-delta`
  events, then awaited `result.response`. `result.response` is an AI SDK `DelayedPromise`
  that settles in the stream's normal `flush`; a provider error ends `fullStream` with a
  single `{ type: "error" }` part *before* that point. So every routed failure produced a
  promise that stayed pending for the life of the host process — no rejection, no reply, no
  timeout, and no log line, because the error had been consumed by a branch that ignored it.

  The consequence was measured, not argued: in the coordinator's routed router
  (`inference-router.ts`), the per-agent naming queue chains every attempt onto the previous
  one. With the first attempt pending forever, prompts 2 and 3 never even reached
  `listAgents` — 3 prompts produced exactly 1 `listAgents`, and still 1 after 20 seconds.
  The agent's conversation is never named again for the rest of the session, with nothing
  on screen saying why.

  The same trap is already documented and worked around for the agent turn path in
  `tool-stream-executor.ts:1247`. This route never learned it.

  Every test here is bounded by `safetyCeiling`: a regression that restores the hang fails
  in a few seconds instead of hanging the suite forever.
*/

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A value that only exists inside this test. Never a real credential. */
const SECRET = "sk-probe-only-not-a-real-credential-0000";
const USER_TURN = [{ role: "user", content: "hi" }];
const TOUCHED_ENV = ["SAND_DATA_ROOT", "SAND_USER_DATA_DIR", "OPENAI_COMPATIBLE_API_KEY", "OPENROUTER_API_KEY", "SAND_OPENROUTER_MODEL"];

let providerSession;
let dataRoot;
const savedEnv = new Map();
const realFetch = globalThis.fetch;

/** A bound that turns a regression into a failure rather than a hang. */
function settleWithin(promise, ms) {
  let timer;
  const ceiling = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`SAFETY CEILING: the promise was still pending after ${ms}ms`)), ms); });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

function textStream(text) {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function writeEndpoint(baseUrl, modelId = "probe-model") {
  await writeFile(path.join(dataRoot, "settings.json"), JSON.stringify({ version: 1, inferenceCustomEndpoint: { baseUrl, modelId } }, null, 2), "utf8");
}

test.before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-failure-"));
  dataRoot = temporary;
  const output = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  providerSession = await import(`${pathToFileURL(output).href}?${Date.now()}`);

  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.OPENAI_COMPATIBLE_API_KEY = SECRET;
  delete process.env.OPENROUTER_API_KEY;
});

test.after(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

test("a refused connection on the custom endpoint rejects instead of hanging", { safetyCeiling: 30_000 }, async () => {
  await writeEndpoint("http://127.0.0.1:1/v1");
  await assert.rejects(
    settleWithin(providerSession.runRoutedProviderText("custom", USER_TURN), 10_000),
    (error) => {
      assert.notEqual(error.message, "SAFETY CEILING: the promise was still pending after 10000ms", "the routed turn must fail, not stay pending forever");
      assert.equal(error.message.includes(SECRET), false, "a failure must never carry the endpoint credential into its message");
      return true;
    },
    "an unreachable custom endpoint must reject the routed turn, and the rejection must name the failure",
  );
});

test("a 401 from the custom endpoint rejects, and the reply cannot leak the stored key", { safetyCeiling: 30_000 }, async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `invalid key ${SECRET}` } }), { status: 401, headers: { "content-type": "application/json" } });
  try {
    await writeEndpoint("https://api.example.com/v1");
    let thrown;
    try {
      await settleWithin(providerSession.runRoutedProviderText("custom", USER_TURN), 10_000);
      assert.fail("the routed turn resolved against a 401, so the failure was swallowed");
    } catch (error) {
      thrown = error;
    }
    assert.notEqual(thrown.message, "SAFETY CEILING: the promise was still pending after 10000ms", "a 401 must reject rather than hang");
    assert.equal(thrown.message.includes(SECRET), false, "the endpoint echoed the key back and the routed error must not repeat it to the user");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a refused OpenRouter connection rejects rather than hanging", { safetyCeiling: 30_000 }, async () => {
  // Same trap, other route: an OpenRouter failure must not become a pending promise either.
  process.env.OPENROUTER_API_KEY = SECRET;
  const realFetchOpenAi = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("probe: the OpenRouter route is unreachable"); };
  try {
    await assert.rejects(
      settleWithin(providerSession.runRoutedProviderText("openrouter", USER_TURN), 10_000),
      (error) => {
        assert.notEqual(error.message, "SAFETY CEILING: the promise was still pending after 10000ms", "the OpenRouter route must fail, not stay pending forever");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetchOpenAi;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("a successful routed turn still returns its text and its deltas", { safetyCeiling: 30_000 }, async () => {
  await writeEndpoint("https://api.example.com/v1");
  globalThis.fetch = async () => textStream("routed");
  try {
    const deltas = [];
    const text = await settleWithin(providerSession.runRoutedProviderText("custom", USER_TURN, { onTextDelta: (delta) => deltas.push(delta) }), 10_000);
    assert.equal(text, "routed", "the success path must keep returning the assistant text");
    assert.deepEqual(deltas, ["routed"], "the success path must keep streaming deltas");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a multi-part success keeps every delta and still resolves", { safetyCeiling: 30_000 }, async () => {
  const encoder = new TextEncoder();
  await writeEndpoint("https://api.example.com/v1");
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const piece of ["one ", "two ", "three"]) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: piece }, finish_reason: null }] })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const text = await settleWithin(providerSession.runRoutedProviderText("custom", USER_TURN), 10_000);
    assert.equal(text, "one two three", "every text delta must still be accumulated in order");
  } finally {
    globalThis.fetch = realFetch;
  }
});