import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The two OpenAI-compatible routes in `provider-session.ts` built their usage record from
// `result.usage` and hardcoded `cacheReadTokens: 0, cacheWriteTokens: 0`, because
// `@ai-sdk/openai` 1.3.24 puts `usage.prompt_tokens_details.cached_tokens` in
// `result.providerMetadata.openai.cachedPromptTokens` and AI SDK v4's usage object has no
// field for it. Nothing noticed because every stubbed provider in the suite answered with a
// usage frame that carried no `prompt_tokens_details` at all, so 0 was indistinguishable
// from "reported". Against the live endpoint the provider reported 140 cached prompt
// tokens per turn and the Router usage panel still showed 0. These tests stub a provider
// that DOES report `prompt_tokens_details.cached_tokens`, so a dropped number is a failure,
// and they also pin the opposite obligation: a provider that reports no cache usage must
// still record 0 rather than an invented count.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CUSTOM_BASE_URL = "https://custom-endpoint.invalid/v1";
const CUSTOM_MODEL_ID = "custom-model-9f3c2a";
const CUSTOM_API_KEY = "sk-custom-endpoint-key-0000";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = "sk-openrouter-key-1111";
const OPENROUTER_MODEL_ID = "openrouter-model-777";

/**
 * What the stubbed provider reports in `usage.prompt_tokens_details.cached_tokens`.
 * 140 is the value the live endpoint actually returned during measurement.
 *
 * This feeds the stubbed RESPONSE only. The assertions below quote their own literals on
 * purpose: an expectation that shares a constant with the input is not an expectation, and
 * flipping it changes both sides at once and proves nothing.
 */
const PROVIDER_REPORTED_CACHED_TOKENS = 140;

const TOUCHED_ENV = [
  "SAND_DATA_ROOT",
  "SAND_USER_DATA_DIR",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENROUTER_API_KEY",
  "SAND_OPENROUTER_MODEL",
];

let providerSession;
let dataRoot;
let settingsPath;
let usageFrame = { prompt_tokens: 1659, completion_tokens: 30, total_tokens: 1689 };
const savedEnv = new Map();
const realFetch = globalThis.fetch;

/** An OpenAI-compatible SSE stream whose final frame carries `usage`. */
function chatCompletionStream(text) {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      created: 1,
      model: CUSTOM_MODEL_ID,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      created: 1,
      model: CUSTOM_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usageFrame,
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function resetSettings() {
  await writeFile(
    settingsPath,
    `${JSON.stringify({
      version: 1,
      inferenceProvider: "custom",
      inferenceCustomEndpoint: { baseUrl: CUSTOM_BASE_URL, modelId: CUSTOM_MODEL_ID },
    }, null, 2)}\n`,
    "utf8",
  );
}

/** Runs one real turn through the product module and returns the recorded ledger entry. */
async function runTurnAndReadLedger(provider) {
  await resetSettings();
  await providerSession.runRoutedProviderText(provider, [{ role: "user", content: "hi" }], { sessionId: "cache-test" });
  // `recordInferenceUsage` writes synchronously from the `extendedUsage.then(onUsage)`
  // continuation, so one macrotask turn is enough for the file to be complete.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  return settings.inferenceRouterUsage.providers[provider];
}

before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cache-usage-"));
  dataRoot = temporary;
  settingsPath = path.join(dataRoot, "settings.json");
  const output = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  providerSession = await import(pathToFileURL(output).href);

  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.OPENAI_COMPATIBLE_API_KEY = CUSTOM_API_KEY;
  process.env.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
  process.env.SAND_OPENROUTER_MODEL = OPENROUTER_MODEL_ID;

  globalThis.fetch = async () => chatCompletionStream("cached");
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

test("the custom route records the cache read count the provider reported", async () => {
  usageFrame = {
    prompt_tokens: 1659,
    completion_tokens: 30,
    total_tokens: 1689,
    prompt_tokens_details: { cached_tokens: PROVIDER_REPORTED_CACHED_TOKENS },
  };

  const ledger = await runTurnAndReadLedger("custom");

  assert.equal(ledger.requests, 1, "the turn under test must be recorded exactly once");
  assert.equal(
    ledger.cacheReadTokens,
    140,
    "the provider reported 140 cached prompt tokens; recording 0 is the dropped-count defect",
  );
});

test("the OpenRouter route records the cache read count the provider reported", async () => {
  usageFrame = {
    prompt_tokens: 1659,
    completion_tokens: 30,
    total_tokens: 1689,
    prompt_tokens_details: { cached_tokens: PROVIDER_REPORTED_CACHED_TOKENS },
  };

  const ledger = await runTurnAndReadLedger("openrouter");

  assert.equal(
    ledger.cacheReadTokens,
    140,
    "the OpenRouter route dropped the cached prompt tokens the provider reported",
  );
});

test("input and output token counts are still recorded alongside the cache count", async () => {
  usageFrame = {
    prompt_tokens: 1659,
    completion_tokens: 30,
    total_tokens: 1689,
    prompt_tokens_details: { cached_tokens: PROVIDER_REPORTED_CACHED_TOKENS },
  };

  const ledger = await runTurnAndReadLedger("custom");

  assert.equal(ledger.inputTokens, 1659, "reading the cache count must not disturb the input token count");
  assert.equal(ledger.outputTokens, 30, "reading the cache count must not disturb the output token count");
  assert.equal(ledger.cacheWriteTokens, 0, "the OpenAI chat API reports no cache write count, so none is invented");
});

test("a provider that reports no cache usage still records 0 rather than an invented count", async () => {
  usageFrame = { prompt_tokens: 1659, completion_tokens: 30, total_tokens: 1689 };

  const ledger = await runTurnAndReadLedger("custom");

  assert.equal(
    ledger.cacheReadTokens,
    0,
    "no prompt_tokens_details means no measured cache read; the ledger must not fabricate one",
  );
  assert.equal(ledger.inputTokens, 1659, "the turn must still be counted when the provider reports no cache usage");
});

test("a cached_tokens value of 0 is recorded as 0, not dropped", async () => {
  usageFrame = {
    prompt_tokens: 1659,
    completion_tokens: 30,
    total_tokens: 1689,
    prompt_tokens_details: { cached_tokens: 0 },
  };

  const ledger = await runTurnAndReadLedger("custom");

  assert.equal(ledger.cacheReadTokens, 0, "a provider that reports a genuine zero cache read records zero");
  assert.equal(ledger.requests, 1, "the turn must still be recorded when the provider reports a zero cache read");
});

test("the source no longer hardcodes a zero cache read in either OpenAI-compatible route", async () => {
  const raw = await readFile(
    path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"),
    "utf8",
  );
  // The explanatory comment above `cachedPromptTokens` quotes the old literal on purpose,
  // so comments are removed before scanning. A guard that matches prose is measuring the
  // documentation, not the code.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const hardcoded = source.match(/cacheReadTokens:\s*0/g) ?? [];
  assert.equal(
    hardcoded.length,
    0,
    `a hardcoded cacheReadTokens: 0 survived in provider-session.ts (${hardcoded.length} occurrence(s))`,
  );

  // A static guard that finds nothing proves nothing, so prove the read sites exist.
  const readSites = source.match(/cacheReadTokens:\s*cachedPromptTokens\(/g) ?? [];
  assert.ok(
    readSites.length >= 2,
    `expected both OpenAI-compatible routes to read the provider's cache count, found ${readSites.length}`,
  );
});
