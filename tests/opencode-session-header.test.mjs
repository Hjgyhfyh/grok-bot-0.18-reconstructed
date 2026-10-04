import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A custom turn aimed at OpenCode Go was refused with
// `AI_APICallError: Request is missing x-opencode-session and cannot be routed
// efficiently` on every single call, so the agent answered nothing at all while
// authentication, routing and streaming were all demonstrably working. The refusal is a
// server-side routing requirement, not a fault in the key: https://opencode.ai/docs/go/
// puts it on the client — "Send a stable session ID in `x-opencode-session` for each
// conversation so we can optimize routing and prompt caching". Nothing in
// `provider-session.ts` sent it, and no test looked at the headers of the custom request,
// because `routed-provider-dispatch.test.mjs` only asserted url, authorization and body.
//
// These tests execute the real product module with a stubbed `globalThis.fetch`, so the
// header is proved on the bytes that leave the process: they read the headers of the actual
// POST to `/chat/completions`, not the option object that was supposed to produce them.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (...segments) => path.join(repoRoot, "source", ...segments);

// Nothing here may wait forever: every turn is awaited under a bounded race, so a
// regression fails the test instead of hanging the suite.
const SAFETY_CEILING_MS = 5_000;

const OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_MODEL_ID = "space-bunny-free";
const LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL_ID = "openrouter-model-777";
const CUSTOM_API_KEY = "sk-custom-endpoint-key-0000";
const OPENROUTER_API_KEY = "sk-openrouter-key-1111";

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
      model: OPENCODE_MODEL_ID,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      created: 1,
      model: OPENCODE_MODEL_ID,
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

async function writeEndpoint(baseUrl) {
  await writeFile(
    path.join(dataRoot, "settings.json"),
    `${JSON.stringify({ version: 1, inferenceCustomEndpoint: { baseUrl, modelId: OPENCODE_MODEL_ID } }, null, 2)}\n`,
    "utf8",
  );
}

function resetRequests() {
  requests.length = 0;
}

function onlyRequest() {
  assert.equal(requests.length, 1, `expected exactly one HTTP request, got ${requests.length}`);
  return requests[0];
}

function sessionHeaderOf(request) {
  return request.headers["x-opencode-session"];
}

// Bounded so a turn that never settles fails here instead of stalling `npm test`.
async function withinTurn(work) {
  const timer = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), SAFETY_CEILING_MS).unref?.());
  const running = (async () => await work())();
  const winner = await Promise.race([running.then((value) => ({ value })), timer]);
  assert.equal(winner.timedOut, undefined, "the custom turn never settled, so its request headers were never observable");
  return winner.value;
}

before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-opencode-session-"));
  dataRoot = temporary;

  // The bundle is built through a shim so the test drives the very same `conversationIdKey`
  // object the product reads: `createKey` mints a fresh `Symbol` per module instance, and two
  // independently bundled copies would each hold their own. esbuild emits the shared module
  // once, so re-exporting both through a single entry keeps them identical.
  const shim = path.join(temporary, "entry.mjs");
  await writeFile(
    shim,
    [
      `export * from ${JSON.stringify(source("host", "extensions", "inference", "provider-session.ts"))};`,
      `export { conversationIdKey } from ${JSON.stringify(source("packages", "chat-inference-proto", "client.ts"))};`,
      `export { createContext } from ${JSON.stringify(source("packages", "context", "core.ts"))};`,
      "",
    ].join("\n"),
    "utf8",
  );
  const output = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [shim],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  providerSession = await import(pathToFileURL(output).href + "?" + Date.now());

  await writeEndpoint(OPENCODE_BASE_URL);

  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
  // `getSandRootDir()` honours this absolute override, so the turns under test read the
  // custom endpoint written above instead of the real user profile.
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.OPENAI_COMPATIBLE_API_KEY = CUSTOM_API_KEY;
  process.env.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
  process.env.SAND_OPENROUTER_MODEL = OPENROUTER_MODEL_ID;

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : String(input?.url ?? input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
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

const USER_TURN = [{ role: "user", content: "hi" }];

function runCustomTurn(options) {
  return withinTurn(() => providerSession.runRoutedProviderText("custom", USER_TURN, options));
}

function runTurnInConversation(conversationId) {
  const { createContext, conversationIdKey } = providerSession;
  return withinTurn(async () => {
    const session = providerSession.createProviderPromptSession("custom");
    const executor = session.getExecutor();
    executor.appendMessages(USER_TURN);
    const result = executor.stream(createContext().with(conversationIdKey, conversationId), "invocation-custom-1");
    for await (const event of result.fullStream) void event;
    await result.response;
  });
}

test("a custom turn to OpenCode Go sends x-opencode-session on the POST to /chat/completions", async () => {
  await writeEndpoint(OPENCODE_BASE_URL);
  resetRequests();
  assert.equal(await runCustomTurn({ sessionId: "conversation-a" }), "routed");

  const request = onlyRequest();
  assert.equal(
    request.url,
    `${OPENCODE_BASE_URL}/chat/completions`,
    "the header must be proved on the chat-completions POST the endpoint actually answers",
  );
  assert.equal(request.method, "POST");
  assert.equal(
    sessionHeaderOf(request),
    "conversation-a",
    "OpenCode Go refuses a request with no x-opencode-session, so the turn produced no reply at all",
  );
  assert.equal(
    request.headers.authorization,
    `Bearer ${CUSTOM_API_KEY}`,
    "adding the session header must not disturb the working authentication",
  );
  assert.equal(request.body.model, OPENCODE_MODEL_ID, "the configured model id must still be the one requested");
});

test("every turn of one conversation reuses that conversation's session id", async () => {
  await writeEndpoint(OPENCODE_BASE_URL);
  resetRequests();
  await runTurnInConversation("conversation-stable");
  await runTurnInConversation("conversation-stable");

  assert.equal(requests.length, 2, "each turn must reach the endpoint on its own");
  const [first, second] = requests;
  assert.equal(sessionHeaderOf(first), "conversation-stable", "the first turn of a conversation named its session");
  assert.equal(
    sessionHeaderOf(second),
    sessionHeaderOf(first),
    "OpenCode Go routes and caches on a per-conversation id, so a new id per turn defeats the whole point",
  );
});

test("two conversations never share a session id", async () => {
  await writeEndpoint(OPENCODE_BASE_URL);
  resetRequests();
  await runTurnInConversation("conversation-left");
  await runTurnInConversation("conversation-right");

  const [left, right] = requests;
  assert.equal(sessionHeaderOf(left), "conversation-left");
  assert.equal(sessionHeaderOf(right), "conversation-right");
  assert.notEqual(
    sessionHeaderOf(left),
    sessionHeaderOf(right),
    "one shared id for every conversation collapses OpenCode Go's routing onto unrelated traffic",
  );
});

test("a custom turn that carries no conversation identity still sends the header, and keeps it", async () => {
  await writeEndpoint(OPENCODE_BASE_URL);
  resetRequests();
  await runCustomTurn();
  await runCustomTurn();

  const [first, second] = requests;
  assert.equal(
    typeof sessionHeaderOf(first),
    "string",
    "a caller without a conversation of its own must still be routed, not refused",
  );
  assert.ok(sessionHeaderOf(first).length > 0, "an empty session id is as unroutable as a missing one");
  assert.equal(
    sessionHeaderOf(second),
    sessionHeaderOf(first),
    "the fallback id must be stable for the life of the host process, not minted per request",
  );
});

test("the session header never leaves the process for a custom endpoint that is not OpenCode's", async () => {
  await writeEndpoint(LOCAL_BASE_URL);
  resetRequests();
  await runCustomTurn({ sessionId: "conversation-local" });

  const request = onlyRequest();
  assert.equal(
    request.url,
    `${LOCAL_BASE_URL}/chat/completions`,
    "the local endpoint must still receive the turn",
  );
  assert.equal(request.headers.authorization, `Bearer ${CUSTOM_API_KEY}`, "the local endpoint must still authenticate");
  assert.equal(
    sessionHeaderOf(request),
    undefined,
    "the custom endpoint is user supplied, so an OpenCode-specific header must not be pushed at an unrelated host",
  );

  await writeEndpoint(OPENCODE_BASE_URL);
});

test("the OpenRouter route carries no x-opencode-session", async () => {
  await writeEndpoint(OPENCODE_BASE_URL);
  resetRequests();
  await withinTurn(() => providerSession.runRoutedProviderText("openrouter", USER_TURN));

  const request = onlyRequest();
  assert.equal(request.url, `${OPENROUTER_BASE_URL}/chat/completions`);
  assert.equal(
    sessionHeaderOf(request),
    undefined,
    "only the custom endpoint asked for the header; OpenRouter must not receive an OpenCode identifier",
  );
});
