import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Recording a turn's token counts could take the whole application down. Both OpenAI-compatible
// executors attach the ledger write with `void extendedUsage.then(onUsage)` and no rejection
// handler, and `SandSettingsStore.persist` ends in `renameSync`, which Windows refuses with
// `EPERM` while another process holds `settings.json`. The coordinator
// (`node-agent-coordinator/inference-router.ts:200`) and the desktop main process
// (`host/runner/turn-run-shell.ts:189`) are two processes recording into that same file, so the
// failure is an ordinary event rather than a broken disk.
//
// Measured before the fix: a turn whose ledger write failed still returned its answer, and one
// macrotask later the process had one unhandled rejection — `EISDIR ... settings.json.<pid>.tmp`
// here, the same shape as the real `EPERM ... rename`. Node terminates a process on an unhandled
// rejection by default, so the forked coordinator — plain Node — would die mid-conversation over a
// number that was only ever going to be telemetry. The neighbouring call site in
// `inference-service.ts` already carries `.catch(() => {})`; these two did not.
//
// The obligation these tests pin: a ledger write that fails costs a number, and never a turn,
// a reply, or the process.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CUSTOM_BASE_URL = "https://custom-endpoint.invalid/v1";
const CUSTOM_MODEL_ID = "custom-model-9f3c2a";
const CUSTOM_API_KEY = "sk-custom-endpoint-key-0000";
const OPENROUTER_API_KEY = "sk-openrouter-key-1111";
const TOUCHED_ENV = ["SAND_DATA_ROOT", "SAND_USER_DATA_DIR", "OPENAI_COMPATIBLE_API_KEY", "OPENROUTER_API_KEY"];

let providerSession;
let dataRoot;
let settingsPath;
let blocked = false;
const savedEnv = new Map();
const realFetch = globalThis.fetch;

/** The rejections this process saw, so a leak is asserted rather than guessed at. */
let observedRejections = [];
const noteRejection = (reason) => { observedRejections.push(reason); };

function stubStream() {
  const encoder = new TextEncoder();
  const chunks = [
    { id: "chatcmpl-stub", created: 1, model: CUSTOM_MODEL_ID, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] },
    {
      id: "chatcmpl-stub",
      created: 1,
      model: CUSTOM_MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 7 } },
    },
  ];
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

async function writeSettings() {
  await writeFile(
    settingsPath,
    `${JSON.stringify({ version: 1, inferenceProvider: "custom", inferenceCustomEndpoint: { baseUrl: CUSTOM_BASE_URL, modelId: CUSTOM_MODEL_ID } }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Makes every settings write fail without making the settings unreadable.
 *
 * `persist()` writes to `${settingsPath}.${pid}.tmp` and renames it over the real file. A
 * directory at that exact path fails the write with `EISDIR` while `load()` still reads the
 * real file, which isolates "the write threw" from "the settings are unreadable".
 */
async function blockLedgerWrites() {
  await mkdir(`${settingsPath}.${process.pid}.tmp`, { recursive: true });
  blocked = true;
}

async function unblockLedgerWrites() {
  await rm(`${settingsPath}.${process.pid}.tmp`, { recursive: true, force: true });
  blocked = false;
}

before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-usage-throw-"));
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

  globalThis.fetch = async () => stubStream();
  process.on("unhandledRejection", noteRejection);
});

after(async () => {
  process.off("unhandledRejection", noteRejection);
  globalThis.fetch = realFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

test("a turn whose ledger write fails still returns its answer", async () => {
  await writeSettings();
  await blockLedgerWrites();
  try {
    const answer = await providerSession.runRoutedProviderText("custom", [{ role: "user", content: "hi" }], { sessionId: "isolation" });
    assert.equal(answer, "hello", "a settings write that failed must not take the turn's reply with it");
  } finally {
    await unblockLedgerWrites();
  }
});

test("a turn whose ledger write fails leaves no unhandled rejection behind", async () => {
  await writeSettings();
  await blockLedgerWrites();
  try {
    await providerSession.runRoutedProviderText("custom", [{ role: "user", content: "hi" }], { sessionId: "isolation" });
  } finally {
    await unblockLedgerWrites();
  }
  // The recording runs from a promise continuation, so the rejection would surface a tick later.
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(
    observedRejections.map((reason) => String(reason?.message ?? reason).split("\n")[0]),
    [],
    "an unhandled rejection terminates a Node process by default, so a failed telemetry write must be absorbed at the call site",
  );
});

test("the ledger is still written when the settings file is writable", async () => {
  await writeSettings();
  assert.equal(blocked, false, "the block from the previous test must be released before this one");

  await providerSession.runRoutedProviderText("custom", [{ role: "user", content: "hi" }], { sessionId: "isolation" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const recorded = JSON.parse(await readFile(settingsPath, "utf8")).inferenceRouterUsage.providers.custom;
  assert.equal(recorded.requests, 1, "swallowing the failure must not disable the recording");
  assert.equal(recorded.cacheReadTokens, 7, "the provider reported 7 cached prompt tokens and they must still be counted");
});

test("both OpenAI-compatible routes attach the ledger write with a rejection handler", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const raw = await read(path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"), "utf8");
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const attaches = source.match(/void extendedUsage\.then\(onUsage\)/g) ?? [];
  assert.equal(attaches.length, 2, "both OpenAI-compatible routes must attach the ledger write, one per route");
  assert.ok(
    /function recordRoutedUsage\([^)]*\)\s*:\s*void\s*\{[^}]*try\s*\{[^}]*recordInferenceUsage/.test(source),
    "recordRoutedUsage must absorb a failed write itself; a caller cannot, because the attach site has no rejection handler",
  );
});