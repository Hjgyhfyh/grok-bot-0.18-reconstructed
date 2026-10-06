import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The user asked for a spare model on their own OpenAI-compatible endpoint: "if the primary model
 * fails once with an error, ALL SUBSEQUENT requests go to DeepSeek". The app had no such thing. A
 * model id the endpoint does not serve failed every single turn, forever, one provider round trip
 * at a time, and the only record was a notice saying the provider refused the request.
 *
 * The trap in that request is the word "error". A rate limit, a 500, a dropped socket, a first-token
 * stall and a context overflow are all errors, and demoting on any of them would silently move a
 * user off the model they chose because the provider was busy for a minute — a worse defect than the
 * one being fixed, because nothing in the app would say the model had changed. So the trigger here is
 * deliberately one class of one classifier: `providerRefusalOf` must call the failure
 * `model_not_found`, which needs the provider's own body to name a model AND say it is unsupported,
 * and the status must be 400 or 422.
 *
 * The word "model" in that pair turned out to be doing less work than it looked. `'response_format'
 * is not supported with this model` names a PARAMETER, not a model, and it classified as
 * `model_not_found` — so one refused capability retired a model that was fine, permanently. The
 * trigger now also requires the identifier the provider named to be the primary model id this
 * endpoint is configured with, which is the only signal that separates "my model is gone" from "this
 * model will not do that one thing".
 *
 * The other half of the threat model is a spare that cannot be STORED. A junk spare used to make the
 * whole endpoint invalid, so every turn threw "The custom endpoint is not configured" and blamed the
 * base URL and model, which were both fine; and an ordinary Save from the panel — which sends only
 * `{ baseUrl, modelId }` — deleted the stored spare, so the demotion stayed on disk but stopped
 * deciding anything and the next turn went back to the retired model.
 *
 * What this file proves, against live code:
 *
 *  - an endpoint with no spare configured behaves exactly as it did before the field existed, both
 *    in what it sends and in what it writes;
 *  - a junk spare (`""`, spaces, `null`, a name with a space, a number) leaves the endpoint valid and
 *    the turn on the primary model, and can never be demoted to;
 *  - an omitted spare means "leave the stored one alone" and only `null` clears it, proved per shape
 *    against what the Router panel actually sends;
 *  - a 400 that names an unsupported model records a demotion, and the next turn's POST body carries
 *    the spare model id — measured from the bytes the endpoint received, not from a code reading;
 *  - a 429, a 500, a network break and a context overflow each write nothing, including the two
 *    hostile bodies where a 429 and a 500 carry text that claims the model does not exist;
 *  - a refusal of one capability, a refusal that names a different model and a refusal that names no
 *    model all leave the route alone;
 *  - the demotion survives a restart: it is read back from `settings.json` and the fresh session
 *    routes to the spare on the first turn;
 *  - `getModelId()` and the `.chat()` argument agree after demotion, which is the pair that would
 *    otherwise announce one model and ask for another;
 *  - a settings write by another path does not resurrect the retired model;
 *  - the failing turn tells the user which model was retired and which one is now in use — and only
 *    the failure that moved the route says so.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-custom-fallback-"));
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
  for (const [name, file] of names)
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "inference", "provider-session.ts"],
  ["host", "extensions", "inference", "custom-model-demotion.ts"],
  ["host", "extensions", "transcript", "turn-runtime.ts"],
  ["host", "extensions", "session", "agent-db.ts"],
  ["shared", "inference-router.ts"],
  ["shared", "node", "settings", "sand-settings-store.ts"],
]);
const { createProviderPromptSession } = loaded["provider-session.mjs"];
const { customModelDemotionForFailure, applyCustomModelDemotionForFailure } =
  loaded["custom-model-demotion.mjs"];
// Read from the module that actually renders it. There used to be a second, identical copy in
// `custom-model-demotion.ts` that production never called; asserting on that copy proved a string the
// app does not print. If this import stops resolving, the rendered sentence moved — follow it.
const { TurnRuntime, customModelDemotionSentence } = loaded["turn-runtime.mjs"];
const { SandAgentDb } = loaded["agent-db.mjs"];
const { resolveEffectiveCustomModelId, activeCustomModelDemotion, isSandInferenceCustomEndpoint, normalizeSandInferenceCustomEndpoint, normalizeSandInferenceWriteEndpoint } =
  loaded["inference-router.mjs"];
const { SandSettingsStore } = loaded["sand-settings-store.mjs"];

test.after(() => dispose());

// Exists only for this run. It must never appear in a settings record, a transcript row, or
// anything this test prints.
const API_KEY = "sk-live-custom-fallback-probe-DO-NOT-LEAK-2b7d";
const PRIMARY_MODEL = "space-bunny";
const SPARE_MODEL = "deepseek-v4.1-flash";
const ANOTHER_SPARE_MODEL = "deepseek-v4.1-pro";
/** An https endpoint, for the writes that do not need the loopback probe server. */
const BASE_URL = "https://opencode.ai/zen/go/v1";
const SAFETY_CEILING_MS = 20_000;

const TOUCHED_ENV = [
  "SAND_DATA_ROOT",
  "SAND_USER_DATA_DIR",
  "OPENAI_COMPATIBLE_API_KEY",
  "SAND_ROUTED_TEMPERATURE",
  "SAND_ROUTED_CONTEXT_WINDOW",
];
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

/**
 * A loopback OpenAI-compatible endpoint that answers per model id, so a test can make the primary
 * model fail and the spare succeed and then read which id actually arrived.
 *
 * `PRIMARY_MODEL` answers 400 in the exact shape the OpenCode endpoint used:
 *   `Model space-bunny is not supported`
 */
function startServer() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const model = String(body.model ?? "");
      received.push({ url: req.url, model, raw });

      if (model === PRIMARY_MODEL) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Model ${PRIMARY_MODEL} is not supported`, type: "invalid_request_error" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 1700000000,
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 1700000000,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
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

/** The settings file, written the way the Router panel writes it, with no demotion. */
function writeEndpoint(root, endpoint) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ version: 1, inferenceProvider: "custom", inferenceCustomEndpoint: endpoint }, null, 2),
    "utf8",
  );
}

function readStoredSettings(root) {
  return JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8"));
}

function settingsStore(root) {
  return new SandSettingsStore(path.join(root, "settings.json"));
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

/** Drains the whole stream and returns the error the AI SDK carried, or `null`. */
async function runProviderTurn(prompt) {
  const executor = createProviderPromptSession("custom").getExecutor();
  executor.appendMessages([{ role: "user", content: prompt }]);
  const result = executor.stream(undefined, "probe-invocation");
  let failure = null;
  const drained = (async () => {
    for await (const part of result.fullStream) {
      if (part?.type === "error") failure ??= part.error;
    }
  })().catch(() => {});
  await withDeadline(drained, SAFETY_CEILING_MS, prompt);
  return failure;
}

/**
 * The shape the AI SDK hands on: `statusCode`, the raw `responseBody`, the parsed `data` and the
 * provider's own sentence in `message`. Built here because a test cannot make a live endpoint
 * answer every status a real one can.
 */
function wireFailure(status, body) {
  const raw = JSON.stringify(body);
  return Object.assign(new Error(typeof body?.error?.message === "string" ? body.error.message : raw), {
    name: "AI_APICallError",
    statusCode: status,
    responseBody: raw,
    data: body,
    isRetryable: false,
    requestBodyValues: [{ role: "user", content: "probe" }],
  });
}

const BASE_ENDPOINT = { baseUrl: "https://opencode.ai/zen/go/v1", modelId: PRIMARY_MODEL };

function decide(error, endpoint, inferenceProvider = "custom", demotion = undefined) {
  return customModelDemotionForFailure({ inferenceProvider, endpoint, demotion, error });
}

/** A transcript manager holding only what `TurnRuntime.runTurn` actually touches. */
function createTranscriptManager({ db, session, liveEntries }) {
  return {
    sessions: { activeSession: session },
    sendPipeline: { currentTurnEpoch: () => 1, latestRecoverySends: new Map(), recoveryBreakEpochs: new Map() },
    ackObligations: { retireAckRunToken: () => {}, fulfillAckObligation: () => {} },
    ackObligationStore: { get: () => undefined },
    widgetResponses: {
      collectUnansweredQuestionPrompts: () => ({}),
      collectUserReactionNotices: () => ({}),
    },
    telemetry: {
      startTurn: () => ({ finalize: () => {}, setModel: () => {}, setRequestId: () => {} }),
      reportTurnEmptyDelivery: () => {},
    },
    roster: { emit: () => {}, emitAgentUpdate: async () => {} },
    automationRuntime: { emitAutomations: () => {} },
    runLifecycle: { lastRequestIdBySession: new Map(), endSessionRun: () => {} },
    upgradeResume: { markAgentResumePending: () => {} },
    trayErrors: { pushError: () => ({ id: "tray-1" }) },
    traceFlusher: () => {},
    appendEntry: (entry) => {
      liveEntries.push(entry);
      return db.appendTranscriptEntry(entry);
    },
  };
}

/** Drives `TurnRuntime.runTurn` for real against a runner that throws `error`. */
async function runFailingTurn(error) {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-custom-fallback-agent-"));
  const agentDir = path.join(base, "agent-1");
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  const db = new SandAgentDb(dbPath);
  const session = { id: "agent-1", dbPath, db };
  const liveEntries = [];
  const runtime = new TurnRuntime(createTranscriptManager({ db, session, liveEntries }));
  const runner = {
    run: async () => {
      throw error;
    },
    getObservedToolCallCount: () => 0,
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runtime.runTurn(session, runner, "are you there?", { selectedImages: [] }, 1);
  } finally {
    console.error = originalConsoleError;
  }
  const rows = db.getTranscriptEntries();
  db.close();
  rmSync(base, { recursive: true, force: true });
  return { rows, liveEntries };
}

const noticeOf = (rows) => rows.find((row) => row.kind === "notice");

test.before(async () => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "grok-custom-fallback-root-"));
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.OPENAI_COMPATIBLE_API_KEY = API_KEY;
  delete process.env.SAND_ROUTED_TEMPERATURE;
  delete process.env.SAND_ROUTED_CONTEXT_WINDOW;
  await startServer();
});

test.after(() => {
  restoreEnv();
  server?.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * Runs one test against its own settings root.
 *
 * `getSandRootDir()` is read on every turn, not cached at import, so pointing `SAND_DATA_ROOT` at a
 * fresh directory per test is what makes "an endpoint with no spare" and "an endpoint with a spare"
 * two independent measurements instead of two views of one file.
 */
async function withFreshRoot(work) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-custom-fallback-case-"));
  process.env.SAND_DATA_ROOT = root;
  try {
    await work(root);
  } finally {
    process.env.SAND_DATA_ROOT = dataRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. An endpoint with no spare is the endpoint that was there before.
// ---------------------------------------------------------------------------

test("an endpoint with no spare configured resolves and sends its own model, and writes no demotion", async () => {
  await withFreshRoot(async (root) => {
    received.length = 0;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: SPARE_MODEL });

    const session = createProviderPromptSession("custom");
    assert.equal(
      session.getModelId(),
      SPARE_MODEL,
      "a route with no spare stopped reporting the model its own settings name",
    );
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "hello" }]);
    const result = executor.stream(undefined, "no-spare");
    await withDeadline(
      (async () => {
        for await (const _part of result.fullStream) {
          // drained deliberately: the whole stream has to be consumed for the request to finish
        }
      })(),
      SAFETY_CEILING_MS,
      "no-spare turn",
    );

    assert.equal(received.length, 1, "the endpoint was never called, so nothing below is exercised");
    assert.equal(
      received[0].model,
      SPARE_MODEL,
      "the wire carried a model the settings file never named",
    );

    // A model_not_found refusal on a route with no spare must leave the file exactly as it was.
    const outcome = await applyCustomModelDemotionForFailure(
      settingsStore(root),
      wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
    );
    assert.equal(
      outcome.demotion,
      undefined,
      "a route with no spare recorded a demotion, so there was nothing to demote to and the failure was swallowed",
    );
    assert.equal(
      "inferenceCustomModelDemotion" in readStoredSettings(root),
      false,
      "the settings file gained a demotion key on a route that has no spare configured",
    );
  });
});

test("the shared resolver answers the primary model when there is no demotion in force", () => {
  assert.equal(
    resolveEffectiveCustomModelId({ modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL }, undefined),
    PRIMARY_MODEL,
    "an endpoint with a spare but no demotion was routed off its primary model",
  );
  assert.equal(
    resolveEffectiveCustomModelId({ modelId: PRIMARY_MODEL }, undefined),
    PRIMARY_MODEL,
    "an endpoint with no spare stopped resolving to its own model",
  );
  assert.equal(
    isSandInferenceCustomEndpoint({ baseUrl: "https://opencode.ai/zen/go/v1", modelId: PRIMARY_MODEL }),
    true,
    "the endpoint guard started refusing an endpoint that has no spare field at all",
  );
});

/**
 * A spare this build cannot use is not a broken endpoint.
 *
 * The guard used to refuse the WHOLE endpoint when `fallbackModelId` was present but unusable. With
 * `""`, `"   "`, `null`, `"deepseek v4.1 flash"` or `42` in that one field,
 * `isSandInferenceCustomEndpoint` answered `false`, so `getInferenceCustomEndpoint()` answered
 * `undefined` and `createProviderPromptSession("custom")` threw "The custom endpoint is not
 * configured. Set its base URL and model in Settings → Router." — while both of those were fine. The
 * app stopped answering entirely, and the sentence blamed the wrong two fields. `""` and `null` are
 * exactly what a cleared form field or an older build's `JSON.stringify` produce, and the code
 * comment claimed "an endpoint without it is routed exactly as it was before this field existed",
 * which was true for an ABSENT field and false for an empty one.
 */
test("a junk spare leaves the endpoint valid and the turn on the primary model", async () => {
  const JUNK_SPARES = ["", "   ", null, "deepseek v4.1 flash", 42, true, {}, [], " ", "\n"];
  for (const junk of JUNK_SPARES) {
    const stored = { baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: junk };
    const label = `fallbackModelId = ${JSON.stringify(junk)}`;
    assert.equal(
      isSandInferenceCustomEndpoint(stored),
      true,
      `${label} made the endpoint invalid, so every turn on this route fails before it is sent`,
    );
    assert.equal(
      normalizeSandInferenceCustomEndpoint(stored)?.modelId,
      PRIMARY_MODEL,
      `${label} made the endpoint unreadable, so getInferenceCustomEndpoint() answers undefined`,
    );
    assert.equal(
      normalizeSandInferenceCustomEndpoint(stored)?.fallbackModelId,
      undefined,
      `${label} was kept as a spare, so a turn could be routed to a model id that cannot go on the wire`,
    );
    assert.equal(
      resolveEffectiveCustomModelId(stored, undefined),
      PRIMARY_MODEL,
      `${label} moved the route off the primary model`,
    );
    assert.equal(
      customModelDemotionForFailure({
        inferenceProvider: "custom",
        endpoint: stored,
        demotion: undefined,
        error: wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
      }).demotion,
      undefined,
      `${label} let the route demote to a spare that does not exist`,
    );
  }

  // And through the real entry point the app uses, not just the guard: a settings file carrying the
  // most likely junk value must still produce a working custom session on the primary model.
  await withFreshRoot(async (root) => {
    received.length = 0;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: SPARE_MODEL, fallbackModelId: "" });
    const session = createProviderPromptSession("custom");
    assert.equal(
      session.getModelId(),
      SPARE_MODEL,
      "a settings file with an empty spare made createProviderPromptSession('custom') throw, so the agent loop is dead",
    );
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "hello" }]);
    const result = executor.stream(undefined, "empty-spare-turn");
    await withDeadline(
      (async () => {
        for await (const _part of result.fullStream) {
          // drained deliberately
        }
      })(),
      SAFETY_CEILING_MS,
      "empty-spare turn",
    );
    assert.equal(received.length, 1, "an empty spare stopped the request from being sent at all");
    assert.equal(received[0].model, SPARE_MODEL, "the wire carried a model the settings file never named as the primary");
  });
});

// ---------------------------------------------------------------------------
// 2. The one failure that may demote.
// ---------------------------------------------------------------------------

test("a 400 that names the model as unsupported demotes, and the next turn's body carries the spare", async () => {
  await withFreshRoot(async (root) => {
    received.length = 0;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });

    const failure = await runProviderTurn("first turn");
    assert.ok(failure != null, "the primary model's 400 produced no error to classify");
    assert.equal(
      received[0].model,
      PRIMARY_MODEL,
      "the first turn did not run against the configured primary model",
    );

    const { rows } = await runFailingTurn(failure);
    assert.notEqual(
      noticeOf(rows),
      undefined,
      "the refused turn wrote no notice, so the user was told nothing",
    );

    const stored = readStoredSettings(root);
    assert.deepEqual(
      stored.inferenceCustomModelDemotion,
      {
        fromModelId: PRIMARY_MODEL,
        toModelId: SPARE_MODEL,
        reason: "model_not_found",
        httpStatus: 400,
        at: stored.inferenceCustomModelDemotion?.at,
      },
      "the demotion was not recorded in the settings file, so a restart would resurrect the broken model",
    );
    assert.match(
      String(stored.inferenceCustomModelDemotion.at),
      /^\d{4}-\d{2}-\d{2}T/,
      "the demotion carries no readable timestamp",
    );

    // The very next turn, from a fresh session: what actually leaves the process.
    received.length = 0;
    const nextSession = createProviderPromptSession("custom");
    assert.equal(
      nextSession.getModelId(),
      SPARE_MODEL,
      "the prompt session still reports the retired model, so the transcript would name a model the request did not use",
    );
    const nextExecutor = nextSession.getExecutor();
    nextExecutor.appendMessages([{ role: "user", content: "second turn" }]);
    const result = nextExecutor.stream(undefined, "demoted-turn");
    await withDeadline(
      (async () => {
        for await (const _part of result.fullStream) {
          // drained deliberately
        }
      })(),
      SAFETY_CEILING_MS,
      "demoted turn",
    );

    assert.equal(received.length, 1, "the demoted turn issued no request at all");
    assert.equal(
      received[0].model,
      SPARE_MODEL,
      "the POST body still asked for the retired model, so the demotion did not reach the wire",
    );
    assert.equal(
      nextSession.getModelId(),
      received[0].model,
      "getModelId() and the model in the POST body disagree after demotion",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The four classes that must NOT demote. These are the expensive false positives.
// ---------------------------------------------------------------------------

const MUST_NOT_DEMOTE = [
  {
    label: "429 rate limit",
    error: () => wireFailure(429, { error: { message: "Rate limit reached for requests" } }),
  },
  {
    label: "429 that also claims the model is unsupported",
    error: () => wireFailure(429, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
  },
  {
    label: "500 server error",
    error: () => wireFailure(500, { error: { message: "upstream exploded" } }),
  },
  {
    label: "500 that also claims the model is unknown",
    error: () => wireFailure(500, { error: { message: `unknown model: ${PRIMARY_MODEL}` } }),
  },
  {
    label: "network break",
    error: () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  },
  {
    label: "timeout",
    error: () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  },
  {
    label: "context overflow",
    error: () =>
      wireFailure(400, {
        error: { message: "This model's maximum context length is 8192 tokens, however your messages resulted in 25000 tokens" },
      }),
  },
  {
    label: "unsupported model named with no status at all",
    error: () => Object.assign(new Error(`Model ${PRIMARY_MODEL} is not supported`), { name: "AI_APICallError" }),
  },
];

test("no transient or user-fixable failure demotes the route", async () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  for (const { label, error } of MUST_NOT_DEMOTE) {
    const outcome = decide(error(), endpoint);
    assert.equal(
      outcome.demotion,
      undefined,
      `${label} demoted the route, so a temporary provider condition silently moved the user off the model they chose`,
    );
    assert.equal(outcome.recorded, false, `${label} claimed to have written a demotion`);
  }

  // The same failures through the real write path must leave the file untouched.
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: "https://opencode.ai/zen/go/v1", modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    for (const { label, error } of MUST_NOT_DEMOTE) {
      const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), error());
      assert.equal(outcome.demotion, undefined, `${label} demoted through the settings file`);
      assert.equal(
        "inferenceCustomModelDemotion" in readStoredSettings(root),
        false,
        `${label} wrote a demotion key into the settings file`,
      );
    }
  });
});

test("a 422 that names an unsupported model is the only other status that may demote", () => {
  const outcome = decide(
    wireFailure(422, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
    { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL },
  );
  assert.equal(outcome.recorded, true, "the second request-level refusal status did not demote");
  assert.equal(outcome.demotion?.httpStatus, 422, "the recorded status is not the one the provider sent");
});

/**
 * A refusal of one CAPABILITY is not a refusal of the model.
 *
 * `kindOf` calls a body `model_not_found` when it mentions a model and says something is not
 * supported. Real OpenAI-compatible providers refuse a single parameter in exactly that shape, and
 * every body below was measured classifying as `model_not_found` and therefore retiring a model that
 * was perfectly fine — permanently, because the demotion is sticky:
 *
 *   Invalid parameter: 'response_format' is not supported with this model
 *   Invalid value: 'image_url' is not supported with this model
 *   tools is not supported with this model
 *
 * The model named in the first two is the parameter. The third names none, and `tools` is sent on
 * every turn this app makes, so it is the reachable one. The model that failed in all three is the
 * configured primary, which is exactly what the route must stay on.
 */
test("a refusal of one capability does not retire the model that is fine", async () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  const CAPABILITY_REFUSALS = [
    "Invalid parameter: 'response_format' is not supported with this model",
    "Invalid value: 'image_url' is not supported with this model",
    "tools is not supported with this model",
    "Invalid parameter: 'tool_choice' is not supported with this model",
    "response_format is not supported with this model",
    "The 'json_schema' response format is not supported with this model",
    "image_url is not supported with this model",
  ];
  for (const message of CAPABILITY_REFUSALS) {
    for (const status of [400, 422]) {
      const outcome = decide(wireFailure(status, { error: { message } }), endpoint);
      assert.equal(
        outcome.demotion,
        undefined,
        `HTTP ${status} "${message}" demoted the route, so one refused capability silently moved the user off a working model`,
      );
      assert.equal(outcome.recorded, false, `HTTP ${status} "${message}" claimed to have written a demotion`);
    }
  }

  // The capability refusals must not demote through the real write path either.
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    for (const message of CAPABILITY_REFUSALS) {
      await applyCustomModelDemotionForFailure(settingsStore(root), wireFailure(400, { error: { message } }));
      assert.equal(
        "inferenceCustomModelDemotion" in readStoredSettings(root),
        false,
        `"${message}" wrote a demotion into the settings file`,
      );
    }
  });

  // The other half of the rule, and the price of it: a refusal that names a DIFFERENT model, or no
  // model, leaves the route alone too. A body that cannot name the model we sent has not proved that
  // model is gone, and demoting on a guess is the mistake this whole module exists to avoid.
  for (const message of [
    "This model is not supported",
    "The model is not available",
    "Model bogus-model-9000 is not supported",
    `Model ${SPARE_MODEL} is not supported`,
  ]) {
    assert.equal(
      decide(wireFailure(400, { error: { message } }), endpoint).demotion,
      undefined,
      `"${message}" demoted the route without naming the model this route is configured to send`,
    );
  }

  // And the trigger still fires on the refusal it was built for, naming the primary exactly.
  assert.equal(
    decide(wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }), endpoint).recorded,
    true,
    "the model-naming refusal that should demote stopped demoting",
  );
  assert.equal(
    decide(wireFailure(400, { error: { message: `Model '${PRIMARY_MODEL}' is not supported` } }), endpoint).recorded,
    true,
    "a quoted model id, which the reader already handles, stopped demoting",
  );
});

test("a refusal that names no model, and a refusal of a different class, both leave the route alone", () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  const cases = [
    { label: "a 400 that names nothing", error: wireFailure(400, { error: { message: "bad request" } }) },
    {
      label: "a 400 about the key",
      error: wireFailure(400, { error: { message: "Incorrect API key provided" } }),
    },
    {
      label: "a 400 about the content",
      error: wireFailure(400, { error: { message: "This request was flagged: it violates our content policy" } }),
    },
  ];
  for (const { label, error } of cases) {
    assert.equal(
      decide(error, endpoint).demotion,
      undefined,
      `${label} demoted the route, so a failure that says nothing about the model retired it`,
    );
  }
  assert.equal(
    decide(
      wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
      endpoint,
      "openrouter",
    ).demotion,
    undefined,
    "a spare on the custom endpoint demoted a turn routed to a different provider",
  );
  assert.equal(
    decide(
      wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
      { modelId: PRIMARY_MODEL, fallbackModelId: PRIMARY_MODEL },
    ).demotion,
    undefined,
    "a spare that is the primary model 'demoted' the route to the model that had just failed",
  );
});

test("a failure that cannot be classified at all cannot demote, and cannot raise", () => {
  const hostile = {
    name: "AI_APICallError",
    statusCode: 400,
    get data() {
      throw new Error("getter exploded");
    },
    get responseBody() {
      throw new Error("getter exploded");
    },
    get cause() {
      throw new Error("getter exploded");
    },
  };
  let outcome = "unset";
  let thrown = null;
  try {
    outcome = decide(hostile, { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
  } catch (error) {
    thrown = error;
  }
  assert.equal(
    thrown,
    null,
    `classifying a hostile failure threw ${thrown} — the catch that reports a dead turn would report this instead`,
  );
  assert.equal(outcome.demotion, undefined, "a failure whose body could not be read demoted the route");
});

// ---------------------------------------------------------------------------
// 4. Sticky across a restart, and not erasable by another write path.
// ---------------------------------------------------------------------------

test("the demotion is read back from disk and routes the first turn after a restart", async () => {
  await withFreshRoot(async (root) => {
    received.length = 0;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const settingsPath = path.join(root, "settings.json");

    await applyCustomModelDemotionForFailure(
      new SandSettingsStore(settingsPath),
      wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
    );

    // A restart is a new store over the same bytes: nothing in this process is carrying the demotion.
    const reloaded = new SandSettingsStore(settingsPath);
    const persisted = reloaded.getInferenceCustomModelDemotion();
    assert.equal(persisted?.toModelId, SPARE_MODEL, "the demotion did not survive being re-read from disk");
    assert.equal(
      resolveEffectiveCustomModelId(reloaded.getInferenceCustomEndpoint(), persisted),
      SPARE_MODEL,
      "a fresh process resolved the retired model despite the demotion on disk",
    );

    const session = createProviderPromptSession("custom");
    assert.equal(session.getModelId(), SPARE_MODEL, "the first turn after a restart asked for the retired model");
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "after restart" }]);
    const result = executor.stream(undefined, "restart-turn");
    await withDeadline(
      (async () => {
        for await (const _part of result.fullStream) {
          // drained deliberately
        }
      })(),
      SAFETY_CEILING_MS,
      "restart turn",
    );
    assert.equal(received.length, 1, "no request left the process after the restart");
    assert.equal(received[0].model, SPARE_MODEL, "the first request after a restart used the retired model");
  });
});

/**
 * The four shapes an endpoint write can have, and what each of them MEANS for the stored spare.
 *
 * The test this replaced re-saved the endpoint as `{ baseUrl, modelId, fallbackModelId }` — the spare
 * included — and called that "what the Router panel does". The panel does not send that. Its save
 * handler is `const E = { baseUrl: g.trim(), modelId: v.trim() }`
 * (`scripts/lib/router-renderer-patch.mjs`), so the shape the test used is one no user can produce,
 * and the test stayed green while the real path deleted the spare. Measured on the real shape: after a
 * plain Save of an endpoint the user had just seen demoted, `getInferenceCustomModelDemotion()`
 * answered `undefined` and `resolveEffectiveCustomModelId` answered `space-bunny` — the demoted model
 * came back on the next turn, with the record still sitting in the file.
 */
test("a save that omits the spare leaves the stored spare alone, and only an explicit null clears it", async () => {
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const settingsPath = path.join(root, "settings.json");
    const store = new SandSettingsStore(settingsPath);
    await applyCustomModelDemotionForFailure(
      store,
      wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
    );
    assert.equal(
      store.getInferenceCustomModelDemotion()?.toModelId,
      SPARE_MODEL,
      "the demotion was never recorded, so the re-saves below have nothing to preserve",
    );

    // SHAPE 1 — omitted. Exactly the object the Router panel builds.
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL });
    assert.equal(
      new SandSettingsStore(settingsPath).getInferenceCustomEndpoint()?.fallbackModelId,
      SPARE_MODEL,
      "an ordinary Save dropped the stored spare, so the demotion it was demoted to became unreachable",
    );
    assert.equal(
      new SandSettingsStore(settingsPath).getInferenceCustomModelDemotion()?.toModelId,
      SPARE_MODEL,
      "an ordinary Save made the demotion invisible, so the next turn would ask for the retired model again",
    );
    assert.equal(
      resolveEffectiveCustomModelId(
        new SandSettingsStore(settingsPath).getInferenceCustomEndpoint(),
        new SandSettingsStore(settingsPath).getInferenceCustomModelDemotion(),
      ),
      SPARE_MODEL,
      "the model the next turn would use after an ordinary Save is the model the user had just retired",
    );

    // SHAPE 2 — present and unchanged. Still the demoted route.
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    assert.equal(
      new SandSettingsStore(settingsPath).getInferenceCustomModelDemotion()?.toModelId,
      SPARE_MODEL,
      "re-saving the endpoint with its own spare erased the demotion",
    );

    // SHAPE 3 — present and changed. A spare that differs from the one the record demoted to cannot
    // route, so the record is spent rather than left on disk. It must not sit there waiting for the
    // spare to be changed back, which would resurrect a demotion the user never asked for again.
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: ANOTHER_SPARE_MODEL });
    const changed = new SandSettingsStore(settingsPath);
    assert.equal(changed.getInferenceCustomEndpoint()?.fallbackModelId, ANOTHER_SPARE_MODEL, "the new spare was not stored");
    assert.equal(changed.getInferenceCustomModelDemotion(), undefined, "a record demoting to a spare the endpoint no longer names still decided the route");
    assert.equal(resolveEffectiveCustomModelId(changed.getInferenceCustomEndpoint(), changed.getInferenceCustomModelDemotion()), PRIMARY_MODEL, "the route did not return to the primary the endpoint now names");
    // Put the old spare back: the record must not reappear from the file.
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    assert.equal(
      new SandSettingsStore(settingsPath).getInferenceCustomModelDemotion(),
      undefined,
      "restoring the spare resurrected a demotion that had already been spent on a different pairing",
    );

    // SHAPE 4 — explicit null. The one way to clear the spare.
    store.setInferenceCustomModelDemotion({ fromModelId: PRIMARY_MODEL, toModelId: SPARE_MODEL, reason: "model_not_found", httpStatus: 400, at: new Date().toISOString() });
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: null });
    const cleared = new SandSettingsStore(settingsPath);
    assert.equal(cleared.getInferenceCustomEndpoint()?.fallbackModelId, undefined, "an explicit null did not clear the stored spare");
    assert.equal(cleared.getInferenceCustomModelDemotion(), undefined, "a demotion survived the spare being cleared explicitly");
    assert.equal(
      resolveEffectiveCustomModelId(cleared.getInferenceCustomEndpoint(), cleared.getInferenceCustomModelDemotion()),
      PRIMARY_MODEL,
      "with the spare cleared the route must be the endpoint's own model",
    );

    // SHAPE 5 — a different primary. The record names a pairing that no longer exists.
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    store.setInferenceCustomModelDemotion({ fromModelId: PRIMARY_MODEL, toModelId: SPARE_MODEL, reason: "model_not_found", httpStatus: 400, at: new Date().toISOString() });
    store.setInferenceCustomEndpoint({ baseUrl: BASE_URL, modelId: "deepseek-v4-flash", fallbackModelId: SPARE_MODEL });
    assert.equal(
      new SandSettingsStore(settingsPath).getInferenceCustomModelDemotion(),
      undefined,
      "a demotion of a model the endpoint no longer names still decided the route",
    );
    assert.equal(
      new SandSettingsStore(settingsPath).getInferenceCustomEndpoint()?.modelId,
      "deepseek-v4-flash",
      "the endpoint's own model did not survive the write",
    );
  });
});

test("the three states of the spare are three different instructions, and the validator keeps them apart", () => {
  assert.deepEqual(
    normalizeSandInferenceWriteEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL }),
    { baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: undefined },
    "an absent spare was not carried through as 'say nothing about it', so the store cannot tell it from a clear",
  );
  assert.equal(
    normalizeSandInferenceWriteEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: null }).fallbackModelId,
    null,
    "an explicit null was not carried through as 'clear it'",
  );
  assert.equal(
    normalizeSandInferenceWriteEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: ` ${SPARE_MODEL} ` }).fallbackModelId,
    SPARE_MODEL,
    "a usable spare was not trimmed and kept",
  );
  for (const junk of ["", "   ", 42, true, {}, [], "deepseek v4.1 flash"]) {
    assert.equal(
      normalizeSandInferenceWriteEndpoint({ baseUrl: BASE_URL, modelId: PRIMARY_MODEL, fallbackModelId: junk }).fallbackModelId,
      undefined,
      `a junk spare (${JSON.stringify(junk)}) was not read as 'this endpoint has no spare'`,
    );
  }
  assert.equal(
    normalizeSandInferenceWriteEndpoint({ baseUrl: "http://evil.example/v1", modelId: PRIMARY_MODEL }),
    undefined,
    "a non-loopback http base URL was accepted into storage",
  );
  assert.equal(
    normalizeSandInferenceWriteEndpoint({ baseUrl: BASE_URL, modelId: "   " }),
    undefined,
    "an empty primary model id was accepted into storage",
  );
});

test("a demotion whose spare no longer exists on the endpoint decides nothing", () => {
  const record = {
    fromModelId: PRIMARY_MODEL,
    toModelId: SPARE_MODEL,
    reason: "model_not_found",
    httpStatus: 400,
    at: new Date().toISOString(),
  };
  assert.equal(
    activeCustomModelDemotion({ modelId: PRIMARY_MODEL }, record),
    undefined,
    "a demotion routed the endpoint to a model the endpoint no longer names",
  );
  assert.equal(
    activeCustomModelDemotion({ modelId: PRIMARY_MODEL, fallbackModelId: PRIMARY_MODEL }, record),
    undefined,
    "a demotion routed the endpoint to a spare that is the primary model",
  );
  assert.equal(
    resolveEffectiveCustomModelId({ modelId: PRIMARY_MODEL }, record),
    PRIMARY_MODEL,
    "without a spare in force the resolver did not answer the endpoint's own model",
  );
});

test("a demotion already in force is reported, not rewritten, by a later failure", () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  const demotion = {
    fromModelId: PRIMARY_MODEL,
    toModelId: SPARE_MODEL,
    reason: "model_not_found",
    httpStatus: 400,
    at: "2026-01-01T00:00:00.000Z",
  };
  const outcome = decide(
    wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
    endpoint,
    "custom",
    demotion,
  );
  assert.equal(outcome.recorded, false, "a second identical failure rewrote the demotion record");
  assert.equal(outcome.demotion?.at, demotion.at, "the demotion's original timestamp was replaced");
});

test("the model a session reports and the model its executor sends are one answer, read once", async () => {
  await withFreshRoot(async (root) => {
    received.length = 0;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });

    const session = createProviderPromptSession("custom");
    assert.equal(
      session.getModelId(),
      PRIMARY_MODEL,
      "a session on an undemoted route did not report the model its settings name",
    );

    // The route is demoted while this session is alive — exactly what happens when a failed turn is
    // recorded, since a turn's session already exists when the failure lands.
    await applyCustomModelDemotionForFailure(
      settingsStore(root),
      wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
    );
    assert.equal(
      new SandSettingsStore(path.join(root, "settings.json")).getInferenceCustomModelDemotion()?.toModelId,
      SPARE_MODEL,
      "the demotion was not on disk, so the executor below had nothing to disagree about",
    );

    assert.equal(
      session.getModelId(),
      PRIMARY_MODEL,
      "an established session silently changed the model it reports, so a transcript row could name a model the request did not use",
    );
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "same session" }]);
    const result = executor.stream(undefined, "same-session-turn");
    await withDeadline(
      (async () => {
        for await (const _part of result.fullStream) {
          // drained deliberately
        }
      })(),
      SAFETY_CEILING_MS,
      "same-session turn",
    );

    assert.equal(received.length, 1, "the session's executor issued no request at all");
    assert.equal(
      received[0].model,
      session.getModelId(),
      "the executor asked for a different model than the session reported, which is the disagreement this router exists to prevent",
    );
    assert.equal(received[0].model, PRIMARY_MODEL, "the request did not carry the model the session reported");
  });
});

// ---------------------------------------------------------------------------
// 5. The user is told.
// ---------------------------------------------------------------------------

test("the failing turn's notice names the retired model, the spare, and how to get back", async () => {
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const failure = await runProviderTurn("first turn");
    assert.ok(failure != null, "the primary model's 400 produced no error");

    const { rows } = await runFailingTurn(failure);
    const notice = noticeOf(rows);
    assert.ok(notice != null, "the refused turn wrote no notice");
    assert.match(notice.text, /space-bunny/, "the notice does not name the model that was retired");
    assert.match(notice.text, /deepseek-v4\.1-flash/, "the notice does not name the model now in use");
    assert.match(
      notice.text,
      /Settings/,
      "the notice does not tell the user where to change the model back",
    );
    assert.ok(!notice.text.includes(API_KEY), "the notice carries the API key");

    const sentence = customModelDemotionSentence({
      fromModelId: PRIMARY_MODEL,
      toModelId: SPARE_MODEL,
      reason: "model_not_found",
      httpStatus: 400,
      at: new Date().toISOString(),
    });
    assert.ok(
      notice.text.endsWith(sentence),
      "the notice the turn wrote is not the sentence this build renders, so a reader and a writer disagree",
    );
  });
});

test("a transient failure writes a notice that says nothing about a spare model", async () => {
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const failure = wireFailure(500, { error: { message: "upstream exploded" } });
    const { rows } = await runFailingTurn(failure);
    const notice = noticeOf(rows);
    assert.ok(notice != null, "a 500 left the user with no report at all");
    assert.doesNotMatch(
      notice.text,
      /spare model/,
      "a 500 told the user the route had moved to the spare, which it had not",
    );
    assert.equal(
      "inferenceCustomModelDemotion" in readStoredSettings(root),
      false,
      "a 500 wrote a demotion into the settings file",
    );
  });
});

/**
 * The sentence belongs to the failure that MOVED the route, not to every failure that arrives after.
 *
 * `customModelDemotionForFailure` answers with the demotion in force for any failure once one is on
 * disk — `recorded` is what distinguishes "this failure demoted" from "a demotion happens to be
 * live". The notice appended the sentence whenever a demotion existed, so a 500, a 429 and a
 * connection reset on an already-demoted route each told the user their route had just changed. It
 * had not: a 500 never demotes, by design two sections up. The route was right and only the wording
 * lied, which is exactly the kind of sentence a user learns to ignore.
 *
 * The previous test of this obligation passed only because no demotion was active when it ran. This
 * one puts a demotion on disk first, so the same 500 now runs on a route that IS on the spare.
 */
test("a failure that did not move the route does not claim it did, even when a demotion is already in force", async () => {
  const CASES = [
    { label: "a 500", error: () => wireFailure(500, { error: { message: "upstream exploded" } }) },
    { label: "a 429", error: () => wireFailure(429, { error: { message: "Rate limit reached for requests" } }) },
    { label: "a connection reset", error: () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) },
  ];
  for (const { label, error } of CASES) {
    await withFreshRoot(async (root) => {
      writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
      // Put the route on the spare the way a real refused turn does, so the failure below lands on a
      // route that is already demoted.
      const demoted = await applyCustomModelDemotionForFailure(
        settingsStore(root),
        wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }),
      );
      assert.equal(demoted.recorded, true, "the demotion the case depends on was not recorded, so the case proves nothing");

      const { rows } = await runFailingTurn(error());
      const notice = noticeOf(rows);
      assert.ok(notice != null, `${label} left the user with no report at all`);
      assert.doesNotMatch(
        notice.text,
        /spare model/,
        `${label} on an already-demoted route told the user the route had just moved to the spare`,
      );
      assert.equal(
        new SandSettingsStore(path.join(root, "settings.json")).getInferenceCustomModelDemotion()?.toModelId,
        SPARE_MODEL,
        `${label} changed the demotion that was already in force`,
      );
    });
  }

  // And the half that must keep working: the failure that really does move the route still says so.
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const { rows } = await runFailingTurn(wireFailure(400, { error: { message: `Model ${PRIMARY_MODEL} is not supported` } }));
    const notice = noticeOf(rows);
    assert.ok(notice != null, "the demoting refusal wrote no notice");
    assert.match(notice.text, /spare model/, "the failure that recorded the demotion did not tell the user the route moved");
  });
});
