import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The routed-provider dispatcher used to be covered only by source-text regexes in
// `publication-packaging.test.mjs`. Deleting the `custom` branch from
// `runRoutedProviderText` therefore sent every custom turn to OpenRouter while the
// suite stayed green. These tests execute the real product module with a stubbed
// `globalThis.fetch`, so the two routes are distinguished by what they actually send.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CUSTOM_BASE_URL = "https://custom-endpoint.invalid/v1";
const CUSTOM_MODEL_ID = "custom-model-9f3c2a";
const CUSTOM_API_KEY = "sk-custom-endpoint-key-0000";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = "sk-openrouter-key-1111";
const OPENROUTER_MODEL_ID = "openrouter-model-777";

const TOUCHED_ENV = [
  "SAND_DATA_ROOT",
  "SAND_USER_DATA_DIR",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENROUTER_API_KEY",
  "SAND_OPENROUTER_MODEL",
];

let providerSession;
let dataRoot;
const requests = [];
const savedEnv = new Map();
const realFetch = globalThis.fetch;

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
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
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

function headerRecord(init) {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-provider-"));
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
  providerSession = await import(pathToFileURL(output).href);

  await writeFile(
    path.join(dataRoot, "settings.json"),
    `${JSON.stringify({
      version: 1,
      inferenceCustomEndpoint: { baseUrl: CUSTOM_BASE_URL, modelId: CUSTOM_MODEL_ID },
    }, null, 2)}\n`,
    "utf8",
  );

  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
  // `getSandRootDir()` honours this absolute override, so the dispatch under test
  // reads the custom endpoint written above instead of the real user profile.
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.OPENAI_COMPATIBLE_API_KEY = CUSTOM_API_KEY;
  process.env.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
  process.env.SAND_OPENROUTER_MODEL = OPENROUTER_MODEL_ID;

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : String(input?.url ?? input),
      method: init?.method ?? "GET",
      headers: headerRecord(init),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return chatCompletionStream("routed");
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

function resetRequests() {
  requests.length = 0;
}

function onlyRequest() {
  assert.equal(requests.length, 1, `expected exactly one HTTP request, got ${requests.length}`);
  return requests[0];
}

const USER_TURN = [{ role: "user", content: "hi" }];

test("runRoutedProviderText(\"custom\") sends the turn to the configured custom endpoint, not to OpenRouter", async () => {
  resetRequests();
  const text = await providerSession.runRoutedProviderText("custom", USER_TURN);
  assert.equal(text, "routed");

  const request = onlyRequest();
  assert.equal(
    request.url,
    `${CUSTOM_BASE_URL}/chat/completions`,
    "the custom route must issue its request against the configured custom baseUrl",
  );
  assert.ok(
    !request.url.startsWith(OPENROUTER_BASE_URL),
    `the custom route leaked to OpenRouter: ${request.url}`,
  );
  assert.deepEqual(
    requests.filter(candidate => candidate.url.startsWith(OPENROUTER_BASE_URL)),
    [],
    "no request in a custom turn may reach https://openrouter.ai/api/v1",
  );
});

test("runRoutedProviderText(\"custom\") authenticates with the custom key and asks for the configured model", async () => {
  resetRequests();
  await providerSession.runRoutedProviderText("custom", USER_TURN);

  const request = onlyRequest();
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, `Bearer ${CUSTOM_API_KEY}`);
  assert.notEqual(
    request.headers.authorization,
    `Bearer ${OPENROUTER_API_KEY}`,
    "the custom route must not present the OpenRouter key",
  );
  assert.equal(request.body.model, CUSTOM_MODEL_ID, "the custom route must request the configured modelId");
  assert.notEqual(request.body.model, OPENROUTER_MODEL_ID);
});

test("the custom and OpenRouter routes are distinguishable inside one test run", async () => {
  resetRequests();
  await providerSession.runRoutedProviderText("custom", USER_TURN);
  await providerSession.runRoutedProviderText("openrouter", USER_TURN);
  assert.equal(requests.length, 2);

  const [custom, openrouter] = requests;
  assert.equal(custom.url, `${CUSTOM_BASE_URL}/chat/completions`);
  assert.equal(custom.headers.authorization, `Bearer ${CUSTOM_API_KEY}`);
  assert.equal(custom.body.model, CUSTOM_MODEL_ID);

  assert.equal(openrouter.url, `${OPENROUTER_BASE_URL}/chat/completions`);
  assert.equal(openrouter.headers.authorization, `Bearer ${OPENROUTER_API_KEY}`);
  assert.equal(openrouter.body.model, OPENROUTER_MODEL_ID);

  assert.notEqual(custom.url, openrouter.url);
  assert.notEqual(custom.headers.authorization, openrouter.headers.authorization);
  assert.notEqual(custom.body.model, openrouter.body.model);
});

test("ProviderPromptExecutor.stream(\"custom\") routes to the custom endpoint as well", async () => {
  resetRequests();
  const session = providerSession.createProviderPromptSession("custom");
  assert.equal(session.getModelId(), CUSTOM_MODEL_ID);

  const executor = session.getExecutor();
  executor.appendMessages(USER_TURN);
  const result = executor.stream(undefined, "invocation-custom-1");

  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta") text += event.textDelta;
  }
  await result.response;
  assert.equal(text, "routed");

  const request = onlyRequest();
  assert.equal(
    request.url,
    `${CUSTOM_BASE_URL}/chat/completions`,
    "the streaming custom branch must issue its request against the configured custom baseUrl",
  );
  assert.equal(request.headers.authorization, `Bearer ${CUSTOM_API_KEY}`);
  assert.equal(request.body.model, CUSTOM_MODEL_ID);
});
