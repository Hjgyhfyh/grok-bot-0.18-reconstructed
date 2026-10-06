import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The cache-read fix reads `result.providerMetadata.openai.cachedPromptTokens`, and it reads
// `result.usage.promptTokens` for the input count, then writes both into the same ledger row.
// Those two sources do not cover the same span of work. `ai@4.3.17` accumulates `streamText`
// usage over every step (`addLanguageModelUsage`, index.mjs:5938) but resolves
// `providerMetadataPromise` with the LAST step only (index.mjs:5478). So on any turn that takes
// more than one step — which is every turn with a tool call, because both OpenAI-compatible
// executors pass `maxSteps: 8` — the input and output counts cover all steps while the cache-read
// count covers one. Nothing noticed because every stub in the suite answers with a single step,
// where the last step and the only step are the same request and the two sources coincide.
//
// Measured before the fix, with two steps reporting `cached_tokens` 500 and 900 and prompt tokens
// 1000 and 1100: the ledger held `inputTokens: 2100, outputTokens: 50, cacheReadTokens: 900`.
// 500 measured cache reads were dropped and the panel claimed 900 cache hits against 2100 input
// tokens, when the provider had reported 1400. These tests pin the arithmetic the ledger must
// satisfy: one cache count per step, all of them counted.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CUSTOM_BASE_URL = "https://custom-endpoint.invalid/v1";
const CUSTOM_MODEL_ID = "custom-model-9f3c2a";
const CUSTOM_API_KEY = "sk-custom-endpoint-key-0000";
const OPENROUTER_API_KEY = "sk-openrouter-key-1111";

/** One stubbed HTTP answer: the SSE chunks for a single provider request. */
const STEP_ONE_CHUNK = (usage) => [
  {
    id: "chatcmpl-stub",
    created: 1,
    model: CUSTOM_MODEL_ID,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-stub",
    created: 1,
    model: CUSTOM_MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage,
  },
];

const TEXT_CHUNK = (usage) => [
  {
    id: "chatcmpl-stub",
    created: 1,
    model: CUSTOM_MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-stub",
    created: 1,
    model: CUSTOM_MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  },
];

const TOOLS = [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object", properties: {} }, source: {} }];
const executeTool = async () => "looked";

const TOUCHED_ENV = ["SAND_DATA_ROOT", "SAND_USER_DATA_DIR", "OPENAI_COMPATIBLE_API_KEY", "OPENROUTER_API_KEY", "SAND_OPENROUTER_MODEL"];

let providerSession;
let dataRoot;
let settingsPath;
/** The usage chunk each successive HTTP request answers with, in order. */
let scriptedSteps = [];
let requestCount = 0;
const savedEnv = new Map();
const realFetch = globalThis.fetch;

function stubStream(chunks) {
  const encoder = new TextEncoder();
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function resetSettings() {
  await writeFile(
    settingsPath,
    `${JSON.stringify({ version: 1, inferenceProvider: "custom", inferenceCustomEndpoint: { baseUrl: CUSTOM_BASE_URL, modelId: CUSTOM_MODEL_ID } }, null, 2)}\n`,
    "utf8",
  );
}

async function readLedger(provider = "custom") {
  return JSON.parse(await readFile(settingsPath, "utf8")).inferenceRouterUsage.providers[provider];
}

/** Runs one tool-calling turn whose steps answer with the given usage chunks, in order. */
async function runToolTurn(steps) {
  await resetSettings();
  scriptedSteps = steps;
  requestCount = 0;
  await providerSession.runRoutedProviderText(
    "custom",
    [{ role: "user", content: "hi" }],
    { sessionId: "cache-multi-step-test", tools: TOOLS, executeTool },
  );
  // The recording runs from the `extendedUsage.then(onUsage)` continuation, so one macrotask
  // turn is enough for every step of the turn to have been written.
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { ledger: await readLedger(), requests: requestCount };
}

before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-cache-multistep-"));
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
  delete process.env.SAND_OPENROUTER_MODEL;

  globalThis.fetch = async () => {
    const chunks = scriptedSteps[Math.min(requestCount, scriptedSteps.length - 1)];
    requestCount += 1;
    return stubStream(chunks);
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

test("a two-step turn counts the cache reads of both steps, not only the last one", async () => {
  const { ledger, requests } = await runToolTurn([
    STEP_ONE_CHUNK({ prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 500 } }),
    TEXT_CHUNK({ prompt_tokens: 1100, completion_tokens: 30, total_tokens: 1130, prompt_tokens_details: { cached_tokens: 900 } }),
  ]);

  assert.equal(requests, 2, "the stub must actually drive a two-step turn, or the test proves nothing");
  assert.equal(ledger.inputTokens, 2100, "the input count already covers both steps (1000 + 1100)");
  assert.equal(ledger.outputTokens, 50, "the output count already covers both steps (20 + 30)");
  assert.equal(
    ledger.cacheReadTokens,
    1400,
    "the provider reported 500 + 900 cached prompt tokens; recording 900 keeps only the last step's count",
  );
});

test("a three-step turn counts the cache reads of every step", async () => {
  const { ledger } = await runToolTurn([
    STEP_ONE_CHUNK({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 100 } }),
    STEP_ONE_CHUNK({ prompt_tokens: 1200, completion_tokens: 10, total_tokens: 1210, prompt_tokens_details: { cached_tokens: 200 } }),
    TEXT_CHUNK({ prompt_tokens: 1500, completion_tokens: 10, total_tokens: 1510, prompt_tokens_details: { cached_tokens: 300 } }),
  ]);

  assert.equal(ledger.inputTokens, 3700, "every step's prompt tokens reach the ledger");
  assert.equal(
    ledger.cacheReadTokens,
    600,
    "100 + 200 + 300 cached prompt tokens were reported across the three steps; only the last one may not be kept",
  );
});

test("a multi-step turn that reports no cache data still records zero", async () => {
  const { ledger } = await runToolTurn([
    STEP_ONE_CHUNK({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 }),
    TEXT_CHUNK({ prompt_tokens: 1100, completion_tokens: 10, total_tokens: 1110 }),
  ]);

  assert.equal(
    ledger.cacheReadTokens,
    0,
    "no step reported a cache read, so the honest total is zero and not the last step's or a previous turn's value",
  );
  assert.equal(ledger.inputTokens, 2100, "the turn is still counted when no step reports cache usage");
});

test("the source reads every step's provider metadata, not only the final step's", async () => {
  const raw = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"), "utf8");
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // `result.providerMetadata` legitimately survives — the session still hands it to other
  // consumers — so the guard targets the usage-record lines, which is where the last-step read
  // was. Scanning the whole file for the substring would also match the prose above.
  const usageLines = source.split("\n").filter(line => /cacheReadTokens:\s*cachedPromptTokens\(/.test(line));
  assert.equal(
    usageLines.length,
    2,
    `both OpenAI-compatible routes build one usage record each; found ${usageLines.length}, so one of them is not covered`,
  );
  for (const line of usageLines) {
    assert.ok(
      /Promise\.all\(\[[^\n]*result\.steps[^\n]*\]\)/.test(line),
      `a usage record does not read result.steps, so only the final step's cache count reaches it: ${line}`,
    );
    assert.ok(
      /\[value,\s*steps\]/.test(line),
      `a usage record still destructures a single providerMetadata instead of the step list: ${line}`,
    );
  }
});