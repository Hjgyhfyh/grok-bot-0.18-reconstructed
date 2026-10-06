import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The fallback model never fired in the real app, and the reason was measured.
 *
 * The trigger could only move the route when `providerRefusalOf` classified the failure as
 * `model_not_found`, and that classifier needs the provider's own refusal SENTENCE to arrive on the
 * error object. Driven through the real `streamText` path against a local 400 endpoint, the sentence
 * does arrive when the body is JSON — `APICallError` carries `statusCode`, `responseBody`, `data` and
 * `message`, and the demotion is recorded. The previous engineer measured that and concluded the body
 * was reachable, which is true for that shape and only that shape.
 *
 * Two reachable live shapes erase it, also measured here through the same real path:
 *
 *   - HTTP 400 with an EMPTY body — `message` becomes the bare status text `"Bad Request"` and
 *     `responseBody` becomes `""`. The notice this produces is verbatim the one the user reported:
 *     "The model provider refused the request (HTTP 400). The provider gave no reason. Sending the
 *     message again usually works; if it keeps failing, check the base URL and the model id in
 *     Settings → Router." No demotion, no spare, the route stays on a model the endpoint does not
 *     have, forever, one provider round trip at a time.
 *   - HTTP 400 with a body that is not JSON at all (an HTML error page, a proxy in the way) — `data`
 *     is undefined and `message` is again just "Bad Request".
 *
 * A 200 carrying an error frame in its body loses the status as well, so not even the 4xx gate can
 * see it.
 *
 * So the primary signal is no longer a sentence. It is the endpoint's own model catalogue:
 * `GET <baseUrl>/models`. For the endpoint this feature was built for, that document is reachable
 * with NO credential and is the provider's own ground truth — measured live, 43 entries at
 * `https://opencode.ai/zen/go/v1/models`, identical with no `authorization` header and with a garbage
 * one, listing `space-bunny` and not listing `space-bunny-free`. A list of ids cannot be reworded,
 * omitted or dropped on a broken error path, so a model absent from it is proof that does not depend
 * on anything the provider chose to say about the failure.
 *
 * What this file proves against live code:
 *
 *  - a provider 400 whose body is EMPTY now demotes, because the catalogue says the model is absent,
 *    and the next real turn's POST body carries the spare model id — read from the bytes the endpoint
 *    received, not from a code reading;
 *  - a catalogue that lists the model demotes nothing, and a catalogue that does not answer at all
 *    (timeout, 5xx, non-JSON, refused URL) demotes nothing either: "the endpoint did not answer" is
 *    never treated as "the model is gone", and no outbound request is made for the failure classes
 *    that must not demote;
 *  - HTTP 429, HTTP 500, a connection reset, a first-token stall and a context overflow each still
 *    refuse to demote, including the hostile pair where a 429 and a 500 carry a body claiming the
 *    model does not exist;
 *  - a 429, a 500 and a reset do not even reach for the catalogue, so a provider that is busy for a
 *    minute is not asked a second question;
 *  - the prose classifier is unchanged and still demotes on its own when the body is legible.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-"));
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
  ["host", "extensions", "inference", "endpoint-model-catalogue.ts"],
  ["host", "extensions", "transcript", "turn-runtime.ts"],
  ["host", "extensions", "transcript", "provider-refusal-reason.ts"],
  ["shared", "inference-router.ts"],
  ["shared", "node", "settings", "sand-settings-store.ts"],
]);
const { createProviderPromptSession } = loaded["provider-session.mjs"];
const { customModelDemotionForFailure, applyCustomModelDemotionForFailure } =
  loaded["custom-model-demotion.mjs"];
const { probeEndpointCatalogue, catalogueModelIds, catalogueHasModelId } =
  loaded["endpoint-model-catalogue.mjs"];
const { describeProviderTurnFailure, providerHttpStatusOf } = loaded["turn-runtime.mjs"];
const { readProviderRefusal } = loaded["provider-refusal-reason.mjs"];
const { normalizeSandInferenceCustomModelDemotion, isSandInferenceCustomModelDemotion } =
  loaded["inference-router.mjs"];
const { SandSettingsStore } = loaded["sand-settings-store.mjs"];

test.after(() => dispose());

const PRIMARY_MODEL = "space-bunny-free";
const SPARE_MODEL = "deepseek-v4.1-flash";

/**
 * The endpoint's exact refusal body, captured live from `https://opencode.ai/zen/go/v1`: content
 * type `text/plain;charset=UTF-8`, and `Model space-bunny-free is not supported` inside the provider's
 * own error object. The local server answers the same bytes, so a turn against it is the same turn.
 */
const PROVIDER_ERROR_BODY = JSON.stringify({
  type: "error",
  error: { type: "ModelError", message: `Model ${PRIMARY_MODEL} is not supported` },
});

/** A catalogue that lists `space-bunny` and NOT the id this route is configured to send. */
const CATALOGUE_WITHOUT_PRIMARY = {
  object: "list",
  data: [
    { id: "space-bunny", object: "model" },
    { id: "deepseek-v4.1-flash", object: "model" },
    { id: "kimi-k3", object: "model" },
  ],
};
const CATALOGUE_WITH_PRIMARY = {
  object: "list",
  data: [
    { id: PRIMARY_MODEL, object: "model" },
    { id: SPARE_MODEL, object: "model" },
  ],
};

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

const SAFETY_CEILING_MS = 20_000;

let server;
let dataRoot;
let serverUrl;
/** Every request the endpoint received, in order, with the model id parsed out of the POST body. */
let received;
/** How every chat request should be answered. Replaced by each test. */
let answerChat;
/** What `GET /v1/models` should do. Replaced by each test. */
let answerCatalogue;
/** How many times the catalogue was fetched. */
let catalogueRequests;

function startServer() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url.endsWith("/models")) {
        catalogueRequests += 1;
        answerCatalogue(req, res);
        return;
      }
      let model = "";
      try {
        model = String(JSON.parse(raw).model ?? "");
      } catch {
        model = "";
      }
      received.push({ method: req.method, url: req.url, model, raw });
      answerChat(model, req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      serverUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolve();
    });
  });
}

const jsonCatalogue = (payload) => (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

/** The endpoint answering an SSE success, so a demoted turn completes instead of failing again. */
function answerWithSuccess(model, res) {
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
}

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

/**
 * Drives one REAL streaming turn through `provider-session.ts` and returns the error the AI SDK
 * carried out of the stream. This is the production failure path, not a hand-built error object: the
 * point of the exercise is what the streaming route actually attaches to a failure.
 */
async function runRealTurnToFailure(prompt) {
  const executor = createProviderPromptSession("custom").getExecutor();
  executor.appendMessages([{ role: "user", content: prompt }]);
  const result = executor.stream(undefined, `probe-${prompt}`);
  let failure = null;
  await withDeadline(
    (async () => {
      for await (const part of result.fullStream) if (part?.type === "error") failure ??= part.error;
    })(),
    SAFETY_CEILING_MS,
    prompt,
  );
  return failure;
}

async function withFreshRoot(work) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-case-"));
  process.env.SAND_DATA_ROOT = root;
  try {
    await work(root);
  } finally {
    process.env.SAND_DATA_ROOT = dataRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

test.before(async () => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-root-"));
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.OPENAI_COMPATIBLE_API_KEY = "sk-live-catalogue-probe-DO-NOT-LEAK-3f19";
  delete process.env.SAND_ROUTED_TEMPERATURE;
  delete process.env.SAND_ROUTED_CONTEXT_WINDOW;
  received = [];
  catalogueRequests = 0;
  answerCatalogue = jsonCatalogue(CATALOGUE_WITHOUT_PRIMARY);
  answerChat = (model, _req, res) => {
    if (model === PRIMARY_MODEL) {
      res.writeHead(400, { "content-type": "text/plain;charset=UTF-8" });
      res.end(PROVIDER_ERROR_BODY);
      return;
    }
    answerWithSuccess(model, res);
  };
  await startServer();
});

test.after(() => {
  restoreEnv();
  server?.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The defect: the reason is lost, and the catalogue is what survives.
// ---------------------------------------------------------------------------

test("a 400 whose body is empty loses the provider's reason entirely, which is the defect", async () => {
  await withFreshRoot(async (root) => {
    received = [];
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    // The measured production shape: the provider refuses with no body at all.
    answerChat = (_model, _req, res) => {
      res.writeHead(400, { "content-type": "text/plain;charset=UTF-8" });
      res.end("");
    };

    const failure = await runRealTurnToFailure("empty body turn");
    assert.ok(failure != null, "the endpoint's 400 produced no error object on the streaming path");
    assert.equal(
      providerHttpStatusOf(failure),
      400,
      "the status did not survive the streaming path, so the failure is not even recognisable as a refusal",
    );
    assert.equal(
      failure.responseBody,
      "",
      "the streaming path attached a body where the endpoint sent none, so this test is not measuring the empty-body shape",
    );
    assert.equal(
      readProviderRefusal(failure).namedSomething,
      false,
      "the classifier found a reason in an empty body, so the defect this file exists for is not reproducible",
    );
    assert.equal(
      describeProviderTurnFailure(failure)?.text,
      "The model provider refused the request (HTTP 400). The provider gave no reason. Sending the message again usually works; if it keeps failing, check the base URL and the model id in Settings → Router.",
      "the notice for an unreadable 400 changed, so the wording the user reported is no longer what this path produces",
    );

    // And the pure prose trigger, on that same real error, cannot fire. This is the bug.
    assert.equal(
      customModelDemotionForFailure({
        inferenceProvider: "custom",
        endpoint: { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL },
        demotion: undefined,
        error: failure,
      }).recorded,
      false,
      "the prose trigger demoted on an empty body, which it could not have done",
    );
  });
});

test("the catalogue reaches the model list with no credential, and says the primary is absent", async () => {
  const listing = await probeEndpointCatalogue({ baseUrl: serverUrl, modelId: PRIMARY_MODEL });
  assert.equal(
    listing.verdict,
    "absent",
    "the catalogue did not report the configured model as absent from a list that does not carry it",
  );
  assert.equal(
    listing.models.includes("space-bunny"),
    true,
    "the catalogue did not carry the model the endpoint does have, so the probe read the wrong document",
  );
  assert.equal(
    listing.models.includes(PRIMARY_MODEL),
    false,
    "the catalogue carried the absent model, so the fixture is wrong",
  );
  // The probe must not have sent a credential, and the endpoint must have answered a plain GET.
  assert.ok(catalogueRequests > 0, "the catalogue was never fetched, so this test proved nothing");
});

// ---------------------------------------------------------------------------
// 2. The repair, end to end through the real session path.
// ---------------------------------------------------------------------------

test("the first real turn records the demotion from the catalogue and the second real turn sends the spare", async () => {
  await withFreshRoot(async (root) => {
    received = [];
    catalogueRequests = 0;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    // The measured production shape again: refusal with no body, and a catalogue that does not list
    // the configured model. The turn cannot be classified; the catalogue can.
    answerChat = (model, _req, res) => {
      if (model === PRIMARY_MODEL) {
        res.writeHead(400, { "content-type": "text/plain;charset=UTF-8" });
        res.end("");
        return;
      }
      answerWithSuccess(model, res);
    };
    answerCatalogue = jsonCatalogue(CATALOGUE_WITHOUT_PRIMARY);

    // ---- TURN 1, over the real streaming path. ----
    const first = await runRealTurnToFailure("first turn");
    assert.ok(first != null, "the first turn produced no failure to hand to the trigger");
    assert.equal(
      received.length,
      1,
      "the first turn did not issue exactly one request",
    );
    assert.equal(
      received[0].model,
      PRIMARY_MODEL,
      "the first turn did not run against the configured primary model",
    );

    // The trigger runs where the app runs it, with the real store and the real catalogue probe.
    const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), first);
    assert.equal(
      outcome.recorded,
      true,
      "the trigger did not record a demotion for a model the endpoint's own catalogue does not list",
    );
    assert.equal(
      outcome.basis,
      "catalogue",
      "the demotion was credited to the prose classifier, which cannot read an empty body",
    );
    assert.equal(
      outcome.demotion?.fromModelId,
      PRIMARY_MODEL,
      "the demotion does not name the model it retired",
    );
    assert.equal(
      outcome.demotion?.toModelId,
      SPARE_MODEL,
      "the demotion does not name the spare it moved to",
    );
    assert.equal(
      outcome.demotion?.reason,
      "model_absent_from_catalogue",
      "the recorded reason does not say which signal decided",
    );
    assert.equal(
      "inferenceCustomModelDemotion" in readStoredSettings(root),
      true,
      "the demotion was reported but never written, so a restart would resurrect the broken model",
    );
    assert.equal(
      isSandInferenceCustomModelDemotion(
        normalizeSandInferenceCustomModelDemotion(readStoredSettings(root).inferenceCustomModelDemotion),
      ),
      true,
      "the record written for the catalogue signal is not a record this build can vouch for",
    );

    // ---- TURN 2, over the real streaming path. ----
    received = [];
    answerChat = (model, _req, res) => {
      if (model === PRIMARY_MODEL) {
        res.writeHead(400, { "content-type": "text/plain;charset=UTF-8" });
        res.end("");
        return;
      }
      answerWithSuccess(model, res);
    };
    const session = createProviderPromptSession("custom");
    assert.equal(
      session.getModelId(),
      SPARE_MODEL,
      "the prompt session still reports the retired model, so the transcript would name a model the request did not use",
    );
    const executor = session.getExecutor();
    executor.appendMessages([{ role: "user", content: "second turn" }]);
    const result = executor.stream(undefined, "demoted-turn");
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
    // THE MEASURED BYTES. `received[0].raw` is the literal request body the endpoint read off the
    // socket; these two lines assert on those bytes and on nothing derived from them.
    assert.equal(
      received[0].url,
      "/v1/chat/completions",
      "the second turn did not POST to the chat completions path",
    );
    const modelBytes = received[0].raw.match(/"model":"([^"]*)"/)?.[1];
    assert.equal(
      modelBytes,
      SPARE_MODEL,
      `the second request's body carried the wrong model id; the bytes the endpoint received were ${JSON.stringify(modelBytes)}`,
    );
    assert.equal(
      received[0].raw.includes(`"model":"${PRIMARY_MODEL}"`),
      false,
      "the retired model id is still somewhere in the second request's bytes",
    );
    assert.equal(
      received[0].model,
      SPARE_MODEL,
      "the POST body still asked for the retired model, so the demotion did not reach the wire",
    );
    assert.equal(
      session.getModelId(),
      received[0].model,
      "getModelId() and the model in the POST body disagree after demotion",
    );
    // The primary model was never asked for a second time: the demotion is what changed the request.
    assert.equal(
      received.some((request) => request.model === PRIMARY_MODEL),
      false,
      "the demoted turn still sent a request for the retired model",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The catalogue's other two answers, and the classes that must not demote.
// ---------------------------------------------------------------------------

test("a catalogue that lists the model, and a catalogue that does not answer, both refuse to demote", async () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  const realFailure = await (async () => {
    const previousRoot = process.env.SAND_DATA_ROOT;
    const root = mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-shape-"));
    process.env.SAND_DATA_ROOT = root;
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    answerChat = (_model, _req, res) => {
      res.writeHead(400, { "content-type": "text/plain;charset=UTF-8" });
      res.end("");
    };
    try {
      return await runRealTurnToFailure("unreadable refusal");
    } finally {
      process.env.SAND_DATA_ROOT = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  })();
  assert.equal(
    readProviderRefusal(realFailure).namedSomething,
    false,
    "the failure used for these cases carried a readable reason, so they would prove the wrong thing",
  );

  // Present: the model exists, so nothing moves even though the turn failed.
  assert.equal(
    customModelDemotionForFailure({ inferenceProvider: "custom", endpoint, demotion: undefined, error: realFailure, catalogueVerdict: "present" }).recorded,
    false,
    "a catalogue that lists the configured model demoted the route off it",
  );
  // Unknown: the endpoint did not answer. Not evidence of absence.
  assert.equal(
    customModelDemotionForFailure({ inferenceProvider: "custom", endpoint, demotion: undefined, error: realFailure, catalogueVerdict: "unknown" }).recorded,
    false,
    "a catalogue that did not answer was treated as proof the model is gone",
  );
  // Never asked at all: the same as unknown.
  assert.equal(
    customModelDemotionForFailure({ inferenceProvider: "custom", endpoint, demotion: undefined, error: realFailure }).recorded,
    false,
    "an unasked catalogue decided that the model is gone",
  );

  // The same three non-answers through the real write path, with a probe that never answers.
  await withFreshRoot(async (root) => {
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    for (const verdict of ["present", "unknown"]) {
      const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), realFailure, async () => ({
        verdict,
        endpoint: "http://127.0.0.1/v1/models",
        models: [],
      }));
      assert.equal(outcome.recorded, false, `a catalogue answering "${verdict}" demoted through the settings file`);
      assert.equal(
        "inferenceCustomModelDemotion" in readStoredSettings(root),
        false,
        `a catalogue answering "${verdict}" wrote a demotion key`,
      );
    }
  });
});

test("an endpoint whose catalogue fails in every way decides nothing", async () => {
  const failures = [
    { label: "a timeout", impl: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) },
    { label: "a 500", impl: async () => new Response("upstream exploded", { status: 500 }) },
    { label: "a 404", impl: async () => new Response("not found", { status: 404 }) },
    { label: "a non-JSON body", impl: async () => new Response("<html>oops</html>", { status: 200 }) },
    { label: "a JSON body that is not a list", impl: async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 200 }) },
    { label: "a connection reset", impl: () => Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })) },
  ];
  for (const { label, impl } of failures) {
    const listing = await probeEndpointCatalogue({
      baseUrl: "https://api.example.com/v1",
      modelId: PRIMARY_MODEL,
      fetchImpl: impl,
    });
    assert.equal(
      listing.verdict,
      "unknown",
      `${label} from the catalogue was read as an answer about the model`,
    );
    // And it can never write a demotion, even with a failure the prose cannot read.
    const outcome = await applyCustomModelDemotionForFailure(
      settingsStore(mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-fail-"))),
      Object.assign(new Error("Bad Request"), { name: "AI_APICallError", statusCode: 400, responseBody: "", isRetryable: false }),
      async () => listing,
    );
    assert.equal(outcome.recorded, false, `${label} from the catalogue demoted the route`);
  }

  // A base URL the shared guard refuses never reaches the network at all.
  let called = 0;
  const refused = await probeEndpointCatalogue({
    baseUrl: "http://evil.example.com/v1",
    modelId: PRIMARY_MODEL,
    fetchImpl: async () => { called += 1; return new Response("{}", { status: 200 }); },
  });
  assert.equal(refused.verdict, "unknown", "an insecure base URL was probed and its answer trusted");
  assert.equal(called, 0, "a base URL that is not https and not loopback was probed anyway");
});

test("a 429, a 500 and a connection reset never demote and never even reach for the catalogue", async () => {
  const cases = [
    {
      label: "HTTP 429",
      answer: (_model, _req, res) => {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit reached for requests" } }));
      },
    },
    {
      label: "HTTP 500",
      answer: (_model, _req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
      },
    },
    {
      label: "a connection reset",
      answer: (_model, _req, res) => {
        res.socket.destroy();
      },
    },
  ];

  for (const { label, answer } of cases) {
    await withFreshRoot(async (root) => {
      received = [];
      catalogueRequests = 0;
      writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
      // The catalogue claims the model is absent. A trigger that asked it would demote; the point is
      // that these failures never ask.
      answerCatalogue = jsonCatalogue(CATALOGUE_WITHOUT_PRIMARY);
      answerChat = answer;

      const failure = await runRealTurnToFailure(label);
      assert.ok(failure != null, `${label} produced no error object on the streaming path`);

      let probes = 0;
      const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), failure, async (args) => {
        probes += 1;
        return probeEndpointCatalogue({ ...args, fetchImpl: async () => new Response(JSON.stringify(CATALOGUE_WITHOUT_PRIMARY), { status: 200 }) });
      });
      assert.equal(
        outcome.recorded,
        false,
        `${label} demoted the route, so a temporary provider condition silently moved the user off the model they chose`,
      );
      assert.equal(
        "inferenceCustomModelDemotion" in readStoredSettings(root),
        false,
        `${label} wrote a demotion key into the settings file`,
      );
      assert.equal(probes, 0, `${label} asked the endpoint's catalogue, so a busy provider was asked a second question`);
      assert.equal(catalogueRequests, 0, `${label} put a request on the wire for a model list it had no business asking about`);
    });
  }
});

test("a 429 and a 500 that claim the model does not exist still do not demote", async () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  for (const status of [429, 500]) {
    const body = JSON.stringify({ error: { message: `Model ${PRIMARY_MODEL} is not supported` } });
    const error = Object.assign(new Error(`Model ${PRIMARY_MODEL} is not supported`), {
      name: "AI_APICallError",
      statusCode: status,
      responseBody: body,
      data: { error: { message: `Model ${PRIMARY_MODEL} is not supported` } },
      isRetryable: false,
    });
    // The 429/500 pair is refused at two different places, and both are asserted so neither is
    // credited for the other's work.
    const reading = readProviderRefusal(error);
    assert.equal(
      reading.namedSomething,
      true,
      `the hostile ${status} body was not read at all, so this test no longer exercises the gate`,
    );
    if (status === 429) {
      // A 429 IS a 4xx, so the prose classifier does read it as model_not_found. The trigger's own
      // status set, not the classifier, is what refuses it — the same double check the module header
      // documents ("the status must be 400 or 422, checked again here").
      assert.equal(
        reading.refusal?.kind,
        "model_not_found",
        "a 429 body stopped classifying as model_not_found, so the trigger's status set is no longer the deciding check",
      );
      assert.equal(reading.refusal?.httpStatus, 429, "the 429 lost its status in the reading");
    } else {
      // A 5xx is outside the 4xx range the classifier names, so it never becomes a refusal at all.
      assert.equal(
        reading.refusal,
        undefined,
        `a ${status} body was classified as a refusal, so the classifier's 4xx bound no longer holds`,
      );
    }
    assert.equal(
      customModelDemotionForFailure({ inferenceProvider: "custom", endpoint, demotion: undefined, error }).recorded,
      false,
      `a ${status} whose body claims the model is unsupported demoted the route`,
    );
    // And the catalogue cannot rescue it either: the gate refuses before the catalogue is asked.
    let probes = 0;
    const root = mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-hostile-"));
    const previous = process.env.SAND_DATA_ROOT;
    process.env.SAND_DATA_ROOT = root;
    try {
      writeEndpoint(root, { baseUrl: "https://api.example.com/v1", modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
      const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), error, async () => {
        probes += 1;
        return { verdict: "absent", endpoint: "https://api.example.com/v1/models", models: [] };
      });
      assert.equal(outcome.recorded, false, `a ${status} demoted through the real write path`);
      assert.equal(probes, 0, `a ${status} reached for the catalogue, so a rate limit caused a second outbound request`);
    } finally {
      process.env.SAND_DATA_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a first-token stall does not demote", async () => {
  const endpoint = { modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL };
  const stall = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "AI_RetryError",
    lastError: Object.assign(new Error("first token timeout"), { name: "TimeoutError" }),
  });
  assert.equal(
    customModelDemotionForFailure({ inferenceProvider: "custom", endpoint, demotion: undefined, error: stall }).recorded,
    false,
    "a first-token stall demoted the route, so a slow minute moved the user off the model they chose",
  );

  let probes = 0;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-fallback-catalogue-stall-"));
  const previous = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = root;
  try {
    writeEndpoint(root, { baseUrl: "https://api.example.com/v1", modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), stall, async () => {
      probes += 1;
      return { verdict: "absent", endpoint: "https://api.example.com/v1/models", models: [] };
    });
    assert.equal(outcome.recorded, false, "a first-token stall demoted through the real write path");
    assert.equal(probes, 0, "a first-token stall reached for the catalogue");
  } finally {
    process.env.SAND_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a context overflow does not demote, even with a catalogue that says the model is absent", async () => {
  await withFreshRoot(async (root) => {
    received = [];
    writeEndpoint(root, { baseUrl: serverUrl, modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    answerCatalogue = jsonCatalogue(CATALOGUE_WITHOUT_PRIMARY);
    // The provider explains itself: the request is too big. That is a 400, so the status alone would
    // let the catalogue be asked — the body naming a cause is what must stop it.
    answerChat = (_model, _req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is 8192 tokens, however your messages resulted in 25000 tokens",
          },
        }),
      );
    };

    const failure = await runRealTurnToFailure("context overflow turn");
    assert.ok(failure != null, "the oversized request produced no failure to classify");
    assert.equal(
      readProviderRefusal(failure).namedSomething,
      true,
      "the classifier did not read the provider's own explanation, so this case does not exercise the gate",
    );

    let probes = 0;
    const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), failure, async (args) => {
      probes += 1;
      return probeEndpointCatalogue({ ...args, fetchImpl: async () => new Response(JSON.stringify(CATALOGUE_WITHOUT_PRIMARY), { status: 200 }) });
    });
    assert.equal(
      outcome.recorded,
      false,
      "a context overflow demoted the route, so a too-long conversation retired a model that was fine",
    );
    assert.equal(
      "inferenceCustomModelDemotion" in readStoredSettings(root),
      false,
      "a context overflow wrote a demotion key into the settings file",
    );
    assert.equal(probes, 0, "a context overflow asked the catalogue, which had nothing to do with the failure");
    assert.equal(catalogueRequests, 0, "a context overflow put a model-list request on the wire");
  });
});

// ---------------------------------------------------------------------------
// 4. The catalogue is a set of ids, and the reader must treat it as one.
// ---------------------------------------------------------------------------

test("the catalogue reader accepts the provider's document and refuses to invent a model list", () => {
  assert.deepEqual(
    catalogueModelIds(CATALOGUE_WITHOUT_PRIMARY),
    ["space-bunny", SPARE_MODEL, "kimi-k3"],
    "the reader did not produce the ids the provider's document carries",
  );
  // An empty list is a real answer: this endpoint serves nothing.
  assert.deepEqual(catalogueModelIds({ object: "list", data: [] }), [], "an empty catalogue was not read as empty");
  // Anything else is not a catalogue, and must not be read as an empty one.
  for (const payload of [null, 42, "list", {}, { data: {} }, { data: "x" }, { object: "list" }]) {
    assert.equal(
      catalogueModelIds(payload),
      null,
      `a payload that is not a model list (${JSON.stringify(payload)}) was read as one`,
    );
  }
  // `{id}` and bare strings, which serve the same purpose, and `model` as the fallback key.
  assert.deepEqual(
    catalogueModelIds({ data: ["a-model", { model: "b-model" }] }),
    ["a-model", "b-model"],
    "the reader did not handle the bare-string and `model`-key shapes providers use",
  );
  // Duplicates and unusable entries are dropped, not passed on.
  assert.deepEqual(
    catalogueModelIds({ data: [{ id: "dup" }, { id: "dup" }, { id: "" }, { id: 7 }, null, "dup"] }),
    ["dup"],
    "the reader kept a duplicate or a non-string entry",
  );
  // Ids are compared exactly and case-insensitively, never by prefix.
  assert.equal(catalogueHasModelId(["space-bunny"], "space-bunny"), true, "an exact id was not found");
  assert.equal(catalogueHasModelId(["space-bunny"], "SPACE-BUNNY"), true, "a case difference hid an id that exists");
  assert.equal(catalogueHasModelId(["space-bunny"], "space-bunny-free"), false, "a longer id matched a shorter one");
  assert.equal(catalogueHasModelId(["space-bunny-free"], "space-bunny"), false, "a shorter id matched a longer one");
  assert.equal(catalogueHasModelId(["space-bunny"], "  "), false, "an empty id was found in the catalogue");
});

test("the endpoint's own 401 does not stand in for the catalogue", async () => {
  // The demotion probe sends no credential on purpose. An endpoint that guards its model list answers
  // 401, which must decide nothing rather than be read as "the model is gone".
  const listing = await probeEndpointCatalogue({
    baseUrl: "https://api.example.com/v1",
    modelId: PRIMARY_MODEL,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }),
  });
  assert.equal(listing.verdict, "unknown", "an unauthorized model list was read as an answer about the model");
});

/**
 * A body the classifier cannot read is not an explanation, and reading it as one is what kept the
 * spare model unused in the real app.
 *
 * `readProviderRefusal` used to answer `namedSomething: true` whenever a reason existed but no cause
 * could be classified — so a 400 carrying prose this build does not understand was reported as
 * "the body explained itself", and the consumer skips the catalogue on exactly that answer. Live, the
 * broken route answered 400 with something the classifier could not read, the catalogue was never
 * asked, and the demotion never happened; the notice said "the provider gave no reason" while the
 * gate believed the provider had given one.
 *
 * The two readings the consumer distinguishes are therefore: a CAUSE we classified (skip the
 * catalogue, the prose already decided) and everything else (the catalogue is the only signal left).
 */
test("a 400 whose body names no cause we can classify still lets the catalogue decide", async () => {
  const unclassifiable = Object.assign(new Error("Bad Request"), {
    name: "AI_APICallError",
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "Nope" } }),
    data: { error: { message: "Nope" } },
  });

  assert.equal(
    readProviderRefusal(unclassifiable).namedSomething,
    false,
    "an unreadable refusal was reported as having named a cause, so the catalogue is skipped and the route stays broken",
  );
  // The notice must not change: neither reading can name a cause, so both say the provider gave none.
  assert.match(
    describeProviderTurnFailure(unclassifiable)?.text ?? "",
    /gave no reason/,
    "the wording for an unreadable refusal changed, so the transcript now claims a cause it does not have",
  );

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-catalogue-blank-prose-"));
  try {
    writeEndpoint(root, { baseUrl: "https://api.example.com/v1", modelId: PRIMARY_MODEL, fallbackModelId: SPARE_MODEL });
    const outcome = await applyCustomModelDemotionForFailure(settingsStore(root), unclassifiable, async () => ({
      verdict: "absent",
      endpoint: "https://api.example.com/v1",
      models: ["space-bunny", SPARE_MODEL],
    }));
    assert.equal(
      outcome.recorded,
      true,
      "the catalogue was not consulted for a refusal whose body explained nothing, so the spare was never used",
    );
    assert.equal(outcome.demotion?.toModelId, SPARE_MODEL, "the route was not moved to the spare model");
    assert.equal(
      readStoredSettings(root).inferenceCustomModelDemotion?.toModelId,
      SPARE_MODEL,
      "the demotion was not persisted",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
