/**
 * A routed turn could not be cancelled, had no context window, and reported no usage. All three
 * came out of the same call site in `provider-session.ts`, where `streamText` was invoked with
 * three parameters and nothing else:
 *
 *  1. `streamText` was called without `abortSignal`. The turn context's signal — the one
 *     `stream-attempt.ts` builds with `withCancel()` and aborts on the first-token-stall
 *     deadline — never reached the provider socket, so cancel, interrupt and stall could not
 *     close a connection. The request outlived its caller.
 *  2. `extendedUsage` reported `maxTokens: 0`. Every consumer reads a non-positive `maxTokens` as
 *     "unknown": `getBackgroundSummarizationTriggerThreshold` returns `undefined`, the
 *     token-overage block is skipped, and `conversation-state.ts` never records a window, so the
 *     conversation is never compacted.
 *  3. `maxRetries` was left at the SDK default of 2, so a 429 or a 500 slept and re-sent inside
 *     one `streamText` call — a silent seven-second pause before one "Failed after 3 attempts" —
 *     and `stream_options.include_usage` was never sent, because `@ai-sdk/openai` 1.3.24 guards it
 *     behind `compatibility: "strict"` and the code asked for `"compatible"`. The provider
 *     returned no usage frame and `usage` came back empty.
 *
 * This test drives the real `ai` 4.3.17 and the real `@ai-sdk/openai` 1.3.24 against a loopback
 * OpenAI-compatible server, through `createProviderPromptSession("custom")` itself, so what is
 * asserted is the shipped code path and not a re-implementation of it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-routed-transport-"));
  const outfile = path.join(directory, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", ...entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return { module: await import(pathToFileURL(outfile).href), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { module: providerSession, dispose } = await bundle([
  "host", "extensions", "inference", "provider-session.ts",
]);
const { createProviderPromptSession, resolveRoutedContextWindow } = providerSession;
const { isRetryableProviderError, isTransientStreamError } = await bundle([
  "host", "runner", "transient-stream-error.ts",
]).then(({ module }) => module);

const TOUCHED_ENV = ["SAND_DATA_ROOT", "OPENAI_COMPATIBLE_API_KEY", "SAND_ROUTED_TEMPERATURE", "SAND_ROUTED_CONTEXT_WINDOW"];
const savedEnv = new Map(TOUCHED_ENV.map((name) => [name, process.env[name]]));

function restoreEnv() {
  for (const name of TOUCHED_ENV) {
    const saved = savedEnv.get(name);
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

let server;
let dataRoot;
let serverUrl;
const received = [];

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textChunk(content) {
  return sseFrame({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "reconstructed-probe",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function startServer() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
      received.push({ url: req.url, body });
      const behaviour = body.model ?? "";
      if (behaviour.startsWith("status-")) {
        const status = Number(behaviour.slice("status-".length));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `probe ${status}`, type: "probe" } }));
        return;
      }
      if (behaviour === "garbage-sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("<<< this is not an event stream >>>\n\n");
        return;
      }
      if (behaviour === "empty-200") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (behaviour === "break-mid-text") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(textChunk("partial answer"));
        setTimeout(() => { res.socket.destroy(); }, 20);
        return;
      }
      if (behaviour === "never-answers") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(textChunk("hello"));
      res.write(sseFrame({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "reconstructed-probe",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }));
      res.write(sseFrame({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "reconstructed-probe",
        choices: [],
        usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
      }));
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      serverUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolve();
    });
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

function setModel(modelId) {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    path.join(dataRoot, "settings.json"),
    // `parseSettings` rejects any file whose `version` is not `SETTINGS_VERSION`, so a bare
    // `{ inferenceCustomEndpoint }` silently reads back as an empty store.
    JSON.stringify({ version: 1, inferenceCustomEndpoint: { baseUrl: serverUrl, modelId } }, null, 2),
    "utf8",
  );
}

async function settleOrNull(promise, ms) {
  const marker = Symbol("pending");
  void promise.catch(() => {});
  const value = await Promise.race([promise, new Promise((resolve) => { setTimeout(() => resolve(marker), ms); })]);
  return value === marker ? null : value;
}

async function runModel(modelId, { abortSignal } = {}) {
  setModel(modelId);
  const executor = createProviderPromptSession("custom").getExecutor();
  executor.appendMessages([{ role: "user", content: "probe" }]);
  const result = executor.stream({ signal: abortSignal }, "invocation-probe");
  const responseSettled = result.response.then(() => null, (error) => error);
  const usageSettled = result.extendedUsage.then((value) => value, (error) => error);
  const errorParts = [];
  const text = [];
  let thrown = null;
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text.push(part.textDelta);
      if (part.type === "error") errorParts.push(part.error);
    }
  } catch (error) {
    // The SDK throws some transport failures straight out of the stream iteration instead of
    // emitting an `error` part; both routes have to reach the caller.
    thrown = error;
  }
  const response = await settleOrNull(responseSettled, 500);
  const extendedUsage = await settleOrNull(usageSettled, 500);
  return {
    text: text.join(""),
    errorParts,
    thrown,
    response,
    extendedUsage,
    error: response ?? thrown ?? errorParts[0] ?? null,
  };
}

test.before(async () => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "grok-sand-root-"));
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.OPENAI_COMPATIBLE_API_KEY = "probe-key-not-a-real-secret";
  delete process.env.SAND_ROUTED_TEMPERATURE;
  delete process.env.SAND_ROUTED_CONTEXT_WINDOW;
  await startServer();
});

test.after(() => {
  restoreEnv();
  server?.close();
  rmSync(dataRoot, { recursive: true, force: true });
  dispose();
});

test("a routed turn asks the provider for usage and reports real token counts", async () => {
  received.length = 0;
  const { text, response, extendedUsage } = await withDeadline(runModel("usage-probe"), 20_000, "usage probe");
  assert.equal(text, "hello", "the assistant text never reached the caller");
  assert.equal(response, null, "a successful stream must not report an error");
  assert.equal(
    received[0].body.stream_options?.include_usage,
    true,
    "without stream_options.include_usage the provider sends no usage frame and the token ledger stays empty",
  );
  assert.equal(
    Number.isFinite(extendedUsage.inputTokens) && Number.isFinite(extendedUsage.outputTokens),
    true,
    "the reported token counts were not numbers",
  );
  assert.equal(extendedUsage.inputTokens, 17, "the prompt token count from the provider was dropped");
  assert.equal(extendedUsage.outputTokens, 5, "the completion token count from the provider was dropped");
});

test("the reported context window is real, so summarization and compaction can be armed", async () => {
  const { extendedUsage } = await withDeadline(runModel("usage-probe"), 20_000, "context window probe");
  assert.ok(
    extendedUsage.maxTokens > 0,
    "a non-positive maxTokens reads as 'unknown window' and silently disables background summarization, the overage block and compaction",
  );
  assert.equal(
    resolveRoutedContextWindow("gpt-5.2"),
    400_000,
    "the context window lookup did not recognise a known model family",
  );
  assert.equal(
    resolveRoutedContextWindow("anything-else", { SAND_ROUTED_CONTEXT_WINDOW: "64000" }),
    64_000,
    "an operator override has to win over the built-in table",
  );
});

test("the sampling temperature is decided at the call site, not by the SDK default", async () => {
  received.length = 0;
  await withDeadline(runModel("temperature-probe"), 20_000, "temperature probe");
  assert.equal(received[0].body.temperature, 0, "the request left temperature to an SDK default nobody had read");
  process.env.SAND_ROUTED_TEMPERATURE = "0.7";
  received.length = 0;
  await withDeadline(runModel("temperature-probe"), 20_000, "temperature override probe");
  assert.equal(received[0].body.temperature, 0.7, "the operator override never reached the wire");
  delete process.env.SAND_ROUTED_TEMPERATURE;
});

test("a 429 is sent once and handed to the retry ladder instead of being retried inside the SDK", async () => {
  received.length = 0;
  const startedAt = Date.now();
  const { error, response } = await withDeadline(runModel("status-429"), 25_000, "429 probe");
  const elapsedMs = Date.now() - startedAt;
  assert.equal(received.length, 1, "the SDK's own default of 2 retries sent the same request again");
  assert.ok(elapsedMs < 3_000, `a single 429 cost ${elapsedMs}ms of silent SDK backoff`);
  assert.equal(response, null, "a throttled provider must not be reported as a successful response");
  assert.ok(error != null, "a 429 produced no error at all");
  assert.equal(
    isRetryableProviderError(error),
    true,
    "a throttled provider must reach the ladder as retryable",
  );
});

test("a 500 is handed to the retry ladder as retryable", async () => {
  received.length = 0;
  const { error } = await withDeadline(runModel("status-500"), 25_000, "500 probe");
  assert.equal(received.length, 1, "the SDK's own default of 2 retries sent the same request again");
  assert.ok(error != null, "a 500 produced no error at all");
  assert.equal(isRetryableProviderError(error), true, "an internal server error must reach the ladder as retryable");
});

test("a 401 is reported and is not retryable, so a bad key does not spin", async () => {
  received.length = 0;
  const { error } = await withDeadline(runModel("status-401"), 25_000, "401 probe");
  assert.ok(error != null, "a rejected credential produced no error at all");
  assert.equal(isRetryableProviderError(error), false, "a rejected credential cannot be fixed by retrying");
});

test("a body that is not an event stream neither hangs the turn nor invents an answer", async () => {
  const { text, error, extendedUsage } = await withDeadline(runModel("garbage-sse"), 20_000, "garbage probe");
  assert.equal(text, "", "a malformed body produced assistant text out of nothing");
  assert.equal(error, null, "a malformed body is not a provider transport error and must not be reported as one");
  assert.equal(
    extendedUsage?.maxTokens,
    resolveRoutedContextWindow("garbage-sse"),
    "the context window has to be reported even when the provider sent no usage frame",
  );
});

test("an empty 200 still resolves and never hangs the turn", async () => {
  const { text, error } = await withDeadline(runModel("empty-200"), 20_000, "empty 200 probe");
  assert.equal(text, "", "an empty stream produced text out of nothing");
  assert.equal(error, null, "an empty but well-formed stream is not a provider error");
});

test("a socket cut in the middle of the answer is classified as a transient failure", async () => {
  const { text, error } = await withDeadline(runModel("break-mid-text"), 20_000, "broken stream probe");
  assert.equal(text, "partial answer", "the text that did arrive was dropped instead of kept");
  assert.ok(error != null, "a truncated stream produced no error at all");
  assert.equal(
    isTransientStreamError(error),
    true,
    "a dropped provider socket must read as transient, otherwise the retry ladder never sees it",
  );
});

test("the turn context's signal closes the provider socket", async () => {
  const controller = new AbortController();
  const pending = runModel("never-answers", { abortSignal: controller.signal });
  const startedAt = Date.now();
  setTimeout(() => controller.abort(new Error("user cancelled the turn")), 100);
  const { error } = await withDeadline(pending, 5_000, "abort probe");
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 3_000, `the call took ${elapsedMs}ms to notice a cancellation`);
  assert.ok(error != null, "aborting produced neither an error nor a termination signal the caller could observe");
});