import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Code, ConnectError } from "@connectrpc/connect";
import { build } from "esbuild";

/**
 * The handler that reports why a turn died used to throw a second, different error instead.
 *
 * `ConnectError.findDetails(typeOrRegistry)` reads its argument before it ever looks at the
 * error's own details (`@connectrpc/connect` 1.x, `connect-error.js:92` — `"typeName" in
 * typeOrRegistry` with `typeOrRegistry === undefined`). `agent-run-error.ts` called it with no
 * registry from three places, so *every* `ConnectError`, with or without details, threw
 * `TypeError: Cannot use 'in' operator …` the moment anything asked what went wrong. The
 * abort path is the one that matters: `abstract-user-message-action-handler.ts:2129` throws a
 * `ConnectError("User aborted request", Code.Canceled)` for a turn the user stopped, and the
 * next line of the same catch asked the classifier for a description. The report died on the
 * way out, so a cancellation the user themselves caused was indistinguishable from a crash.
 * A local guard in `turn-runtime.ts` hid the crash but left the classifier itself broken, and
 * `automation-run-path.ts` calls the unguarded function.
 *
 * The second defect is quieter. `describeAgentRunError` returned `{title?, detail, actions?}`
 * and nothing else, but two readers were already written against two fields that never
 * existed: `turn-runtime.ts:847` compares `description.errorKind` to `"provider_overloaded"`
 * (the renderer does the same, at `index-lA9cgT4O.js`, to swap in the overload sentence), and
 * `automation-run-path.ts:300-302` reads both `errorKind` and `rawDetail`. Both branches were
 * dead: the classifier knows the exact reason, and the user was told "something broke".
 *
 * The third is a leak, not a missing field. When the backend sends no curated detail the
 * description fell back to `error.message`, which for `APICallError` (ai 4.3.17) is the
 * provider's own refusal text — and a provider that echoes the refusal quotes back the
 * `Authorization` header, the `x-api-key` and the entire request body. That string went
 * straight into the tray `detail`, which the renderer prints as a sentence.
 *
 * What this file proves, against live code and a real `store.db`:
 *
 *  - a `ConnectError` asked for a description returns one, and a registry-carrying one still
 *    decodes its curated detail (so the fix decodes rather than swallows);
 *  - a turn the user cancelled arrives in the error tray as a cancellation;
 *  - a provider at capacity is recognised and `errorKind` reaches the tray, whose title the
 *    renderer switches on;
 *  - the API key, the `Authorization` header and the request body reach neither the
 *    description, nor `rawDetail`, nor the tray, nor the database file on disk;
 *  - no input at all makes the classifier throw instead of describing: an error that throws
 *    while being classified must never replace the error it was describing.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-run-error-classification-"));
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
  ["host", "extensions", "transcript", "agent-run-error.ts"],
  ["host", "extensions", "transcript", "turn-runtime.ts"],
  ["host", "extensions", "session", "agent-db.ts"],
  ["host", "extensions", "inference", "provider-session.ts"],
  ["packages", "agent", "tool-stream-executor.ts"],
  ["packages", "proto", "generated", "aiserver", "v1", "utils_pb.ts"],
]);
const { describeAgentRunError, formatAgentRunError } = loaded["agent-run-error.mjs"];
const { classifyAgentError, TurnRuntime } = loaded["turn-runtime.mjs"];
const { SandAgentDb } = loaded["agent-db.mjs"];
const { createProviderPromptSession } = loaded["provider-session.mjs"];
const { SimplePromptToolExecutor } = loaded["tool-stream-executor.mjs"];
const { ErrorDetails } = loaded["utils_pb.mjs"];

test.after(() => dispose());

// A key that exists only for this run. It must never appear in a description, in a tray
// entry, on disk, or in anything this test prints.
const API_KEY = "sk-live-run-error-classification-probe-DO-NOT-LEAK-7b02";
const USER_PROMPT_MARKER = "user-secret-marker-3d17";
const SAFETY_CEILING_MS = 20_000;

const TOUCHED_ENV = [
  "SAND_DATA_ROOT",
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
      received.push({ url: req.url, authorization: req.headers.authorization, body });
      const behaviour = String(body.model ?? "");

      // A hostile provider. Every refusal quotes the credential, the header it arrived in and
      // the whole request back at the client, so any text assembled by copying the provider's
      // own message carries all three. Nothing below may be built that way.
      const hostile = [
        `probe refused (${behaviour})`,
        `authorization=${req.headers.authorization ?? ""}`,
        `x-api-key=${req.headers["x-api-key"] ?? ""}`,
        `request=${raw}`,
      ].join(" || ");

      if (behaviour.startsWith("status-")) {
        const status = Number(behaviour.slice("status-".length));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: hostile, type: "probe" } }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: hostile, type: "probe" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      serverUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolve();
    });
  });
}

function setModel(modelId) {
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify(
      { version: 1, inferenceCustomEndpoint: { baseUrl: serverUrl, modelId } },
      null,
      2,
    ),
    "utf8",
  );
}

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms: ${label}`)),
        ms,
      );
    }),
  ]);
}

/** The real provider refusal `abstract-user-message-action-handler.ts` throws out of the step. */
async function providerRefusal(modelId) {
  setModel(modelId);
  const inner = createProviderPromptSession("custom").getExecutor();
  const executor = new SimplePromptToolExecutor({
    appendMessages(messages) {
      inner.appendMessages(messages);
      return this;
    },
    getMessages: () => inner.getMessages(),
    getState: () => inner.getMessages(),
    clearMessages: () => inner.clearMessages(),
    stream(ctx, invocationId) {
      return inner.stream(ctx, invocationId, undefined, { abortSignal: ctx?.signal });
    },
  });
  executor.appendMessages([{ role: "user", content: `${USER_PROMPT_MARKER}: ping` }]);
  const result = executor.executeToolStream(
    {},
    {},
    { invocationId: `invocation-${modelId}`, recordToolCallResult: async () => {} },
    [],
    {},
    async () => {},
    {},
    undefined,
  );
  // `executeToolStream` duplicates the SDK stream and only one copy feeds `response`, so an
  // unread second copy stalls the duplication pump. In the product the other copy is consumed
  // by the interaction listener, so draining it here reproduces the shipped arrangement.
  const drained = (async () => {
    for await (const _part of result.fullStream) {
      // drained deliberately: see above
    }
  })().catch(() => {});
  const response = await withDeadline(result.response, SAFETY_CEILING_MS, modelId);
  await drained;
  const error = response?.error ?? null;
  assert.ok(error != null, `the ${modelId} refusal produced no error, so nothing is exercised`);
  return error;
}

function openAgentStore(label) {
  const base = mkdtempSync(path.join(os.tmpdir(), `grok-run-error-${label}-`));
  const agentDir = path.join(base, "agent-1");
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  const db = new SandAgentDb(dbPath);
  return { base, db, dbPath, session: { id: "agent-1", dbPath, db } };
}

/** Drives `TurnRuntime.runTurn` for real against a runner that throws `error`. */
async function runFailingTurn({ error, active = true }) {
  const opened = openAgentStore("turn");
  const liveEntries = [];
  const trayErrors = [];
  const tm = {
    sessions: { activeSession: active ? opened.session : undefined },
    sendPipeline: {
      currentTurnEpoch: () => 1,
      latestRecoverySends: new Map(),
      recoveryBreakEpochs: new Map(),
    },
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
    trayErrors: {
      pushError: (options) => {
        trayErrors.push(options);
        return { id: `tray-${trayErrors.length}` };
      },
    },
    traceFlusher: () => {},
    appendEntry: (entry) => {
      liveEntries.push(entry);
      return opened.db.appendTranscriptEntry(entry);
    },
  };
  const runtime = new TurnRuntime(tm);
  // `console.error("[sand][turn] agent run failed…", error)` is the product's own line and is
  // left alone; it is silenced here only so a full `APICallError` dump does not drown the run.
  const originalConsoleError = console.error;
  console.error = () => {};
  let rejected = null;
  try {
    await withDeadline(
      runtime.runTurn(
        opened.session,
        {
          run: async () => {
            throw error;
          },
          getObservedToolCallCount: () => 0,
        },
        `${USER_PROMPT_MARKER}: ping`,
        { selectedImages: [] },
        1,
      ),
      SAFETY_CEILING_MS,
      "runTurn",
    );
  } catch (thrown) {
    rejected = thrown;
  } finally {
    console.error = originalConsoleError;
  }
  const rows = opened.db.getTranscriptEntries();
  const onDisk = ["", "-wal", "-journal"]
    .map((suffix) => {
      try {
        return readFileSync(`${opened.dbPath}${suffix}`);
      } catch {
        return Buffer.alloc(0);
      }
    })
    .reduce((all, chunk) => Buffer.concat([all, chunk]));
  opened.db.close();
  rmSync(opened.base, { recursive: true, force: true });
  return { rows, liveEntries, trayErrors, rejected, onDisk };
}

/** Every sentence a user could read out of a description or a tray entry, as one string. */
function readableTextOf(description) {
  return JSON.stringify({
    title: description?.title,
    detail: description?.detail,
    rawDetail: description?.rawDetail,
    errorKind: description?.errorKind,
  });
}

function assertNoCredentialIn(text, where) {
  assert.ok(!text.includes(API_KEY), `${where}: the API key value reached this text`);
  assert.doesNotMatch(text, /authorization/i, `${where}: the Authorization header reached this text`);
  assert.doesNotMatch(text, /x-api-key/i, `${where}: the api key header name reached this text`);
  assert.ok(
    !text.includes(USER_PROMPT_MARKER),
    `${where}: the request body reached this text`,
  );
  assert.ok(
    !/\bat \S+ \(.*:\d+:\d+\)/.test(text),
    `${where}: a stack frame reached this text`,
  );
}

test.before(async () => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "grok-run-error-root-"));
  process.env.SAND_DATA_ROOT = dataRoot;
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

// ---------------------------------------------------------------------------
// 1. The classifier throws on the error it is asked to describe.
// ---------------------------------------------------------------------------

test("a ConnectError with no detail registry is described instead of raising a TypeError", () => {
  // The exact object `abstract-user-message-action-handler.ts:2129` throws for a turn the
  // user stopped. It carries no details, and `findDetails()` dereferences its argument first,
  // so the description used to die before it could say anything.
  const cancelled = new ConnectError("User aborted request", Code.Canceled);

  let thrown = null;
  let described = null;
  try {
    described = describeAgentRunError(cancelled);
  } catch (error) {
    thrown = error;
  }

  assert.equal(
    thrown,
    null,
    `describing a ConnectError threw ${thrown} — the handler that reports why a turn died raised a second error instead`,
  );
  assert.equal(
    typeof described?.detail,
    "string",
    "the description came back without a sentence for the user to read",
  );
  assert.ok(
    described.detail.length > 0,
    "the description came back with an empty sentence, which is no better than a throw",
  );
  assert.doesNotMatch(
    described.detail,
    /Cannot use 'in' operator/,
    "the user would be shown the classifier's own TypeError, which describes nothing about their turn",
  );
});

test("the same ConnectError still decodes its curated backend detail", () => {
  // Decoding needs a registry; refusing to pass one and swallowing the throw would turn this
  // into a test that passes while the backend's own sentence is dropped.
  const wire = new ConnectError("backend refused the turn", Code.PermissionDenied, undefined, [
    {
      type: "aiserver.v1.ErrorDetails",
      value: new ErrorDetails({
        details: { title: "Your plan does not allow this", detail: "Ask an admin to raise the limit." },
      }).toBinary(),
    },
  ]);

  const described = describeAgentRunError(wire);

  assert.equal(
    described.title,
    "Your plan does not allow this",
    "the registry-carrying detail was dropped, so the fix swallows the throw instead of decoding through it",
  );
  assert.equal(
    described.detail,
    "Ask an admin to raise the limit.",
    "the backend's own explanation was replaced by something generic",
  );
});

test("formatting a ConnectError no longer raises either", () => {
  assert.doesNotThrow(
    () => formatAgentRunError(new ConnectError("User aborted request", Code.Canceled)),
    "the second reader of the same registry-less call path still throws",
  );
});

// ---------------------------------------------------------------------------
// 2. `errorKind` never existed, so the overload branch in the tray was dead.
// ---------------------------------------------------------------------------

test("a provider at capacity is recognised and its errorKind reaches the tray", async () => {
  // The shape `isProviderCapacityError` names: a retryable provider failure carrying the
  // backend's capacity code. `classifyAgentError` already knows exactly what this is.
  const overload = Object.assign(
    new Error("the model provider reported a high load"),
    {
      name: "APICallError",
      isRetryable: true,
      displayInfo: { connectCode: "Unavailable" },
    },
  );

  assert.equal(
    classifyAgentError(overload).code,
    "SAND-E0401",
    "the classifier no longer recognises provider overload, so this test is standing somewhere else than the dead branch",
  );

  const described = describeAgentRunError(overload);
  assert.equal(
    described.errorKind,
    "provider_overloaded",
    "the classifier knows the exact reason but the tray description carries no errorKind, so the renderer cannot switch to the overload sentence",
  );

  const { trayErrors } = await runFailingTurn({ error: overload });
  assert.equal(trayErrors.length, 1, "the tray entry for a provider overload disappeared");
  assert.equal(
    trayErrors[0].errorKind,
    "provider_overloaded",
    "the errorKind is computed but does not survive into the tray the renderer reads",
  );
  assert.match(
    trayErrors[0].title,
    /overloaded/i,
    "the tray still calls a provider at capacity \"Agent failed to respond\", which names no cause the user can act on",
  );
});

test("a turn the user cancelled reaches the tray as a cancellation, not as a crash", async () => {
  const cancelled = new ConnectError("User aborted request", Code.Canceled);

  const { rows, trayErrors, rejected } = await runFailingTurn({ error: cancelled });

  assert.equal(
    rejected,
    null,
    "runTurn rejected on a cancelled turn, so the caller lost the turn entirely",
  );
  assert.equal(
    rows.filter((row) => row.kind === "notice").length,
    0,
    "a turn the user stopped was explained to the user as a failure they caused",
  );
  assert.equal(trayErrors.length, 1, "the tray entry for a cancelled turn disappeared");
  assert.equal(
    trayErrors[0].errorKind,
    "user_cancelled",
    "a turn the user stopped is still reported as an unnamed failure, so cancellation and crash look the same",
  );
  assert.doesNotMatch(
    trayErrors[0].title,
    /failed to respond/i,
    "the tray tells the user the agent failed to respond right after the user stopped it themselves",
  );
});

// ---------------------------------------------------------------------------
// 3. The description is assembled from the provider's own text.
// ---------------------------------------------------------------------------

test("the API key never reaches the description, the rawDetail, the tray or the disk", async () => {
  received.length = 0;
  const refusal = await providerRefusal("status-401");

  assert.equal(
    received[0].authorization,
    `Bearer ${API_KEY}`,
    "the probe never carried a credential, so every leak check below would pass for the wrong reason",
  );

  const described = describeAgentRunError(refusal);
  assertNoCredentialIn(readableTextOf(described), "the description");
  assertNoCredentialIn(
    JSON.stringify(described.rawDetail ?? null),
    "the rawDetail",
  );

  const { trayErrors, rows, onDisk } = await runFailingTurn({ error: refusal });
  assert.ok(onDisk.length > 0, "store.db is empty, so the on-disk check would prove nothing");
  assertNoCredentialIn(JSON.stringify(trayErrors), "the tray entry");
  assertNoCredentialIn(
    JSON.stringify(rows.filter((row) => row.kind === "notice")),
    "the transcript notice",
  );
  assert.ok(
    !onDisk.includes(Buffer.from(API_KEY, "utf8")),
    "the API key reached store.db on disk",
  );
  assert.ok(
    !onDisk.includes(Buffer.from(USER_PROMPT_MARKER, "utf8")),
    "the request body reached store.db on disk",
  );
});

test("rawDetail carries the backend sentence and refuses to carry a credential", () => {
  const clean = new ConnectError("backend refused the turn", Code.PermissionDenied, undefined, [
    {
      type: "aiserver.v1.ErrorDetails",
      value: new ErrorDetails({
        details: { title: "Monthly limit reached", detail: "It resets in 3 hours." },
      }).toBinary(),
    },
  ]);
  assert.equal(
    describeAgentRunError(clean).rawDetail,
    "It resets in 3 hours.",
    "rawDetail is absent for every error, so the branch in automation-run-path.ts that reads it is dead in a second way",
  );

  const hostile = new ConnectError("backend refused the turn", Code.PermissionDenied, undefined, [
    {
      type: "aiserver.v1.ErrorDetails",
      value: new ErrorDetails({
        details: {
          title: "Authentication failed",
          detail: `authorization: Bearer ${API_KEY} for ${USER_PROMPT_MARKER}`,
        },
      }).toBinary(),
    },
  ]);
  assertNoCredentialIn(
    readableTextOf(describeAgentRunError(hostile)),
    "a description built from a backend detail that quotes the credential",
  );
});

// ---------------------------------------------------------------------------
// 4. Every other place the classification can raise instead of describe.
// ---------------------------------------------------------------------------

test("no input makes the classifier throw instead of describing the failure", () => {
  const hostileInputs = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "plain text failure"],
    ["a symbol", Symbol("failure")],
    ["a null-prototype object", Object.create(null)],
    [
      "an object whose cause getter throws",
      Object.defineProperty({}, "cause", {
        enumerable: true,
        get() {
          throw new Error("cause is unreadable");
        },
      }),
    ],
    [
      "an object whose errors getter throws",
      Object.defineProperty({}, "errors", {
        enumerable: true,
        get() {
          throw new Error("errors is unreadable");
        },
      }),
    ],
    [
      "an object whose toString throws",
      {
        toString() {
          throw new Error("toString is broken");
        },
      },
    ],
    [
      "an object whose name getter throws",
      Object.defineProperty({}, "name", {
        enumerable: true,
        get() {
          throw new Error("name is unreadable");
        },
      }),
    ],
    [
      "a ConnectError whose findDetails throws",
      Object.assign(new ConnectError("broken", Code.Internal), {
        findDetails() {
          throw new Error("details are unreadable");
        },
      }),
    ],
    [
      "a self-referencing errors array",
      (() => {
        const error = new Error("cyclic");
        error.errors = [error];
        return error;
      })(),
    ],
    [
      "a cause chain far deeper than any real one",
      (() => {
        const head = new Error("deep");
        let node = head;
        for (let index = 0; index < 5000; index += 1) {
          node.cause = new Error(`deep-${index}`);
          node = node.cause;
        }
        return head;
      })(),
    ],
    [
      "a detail whose fields are the wrong types",
      (() => {
        const error = new ConnectError("wrong shapes", Code.Internal);
        error.findDetails = () => [
          {
            details: {
              title: 42,
              detail: null,
              buttons: [{ label: "no action at all" }, null, { action: null }],
              additionalInfo: { rateLimitReason: "sand_included_limit", nextResetAt: 7 },
            },
          },
        ];
        return error;
      })(),
    ],
  ];

  for (const [label, input] of hostileInputs) {
    let thrown = null;
    let described = null;
    try {
      described = describeAgentRunError(input);
    } catch (error) {
      thrown = error;
    }
    assert.equal(
      thrown,
      null,
      `${label}: describing the failure threw ${thrown} — a classifier that raises has replaced the error it was describing`,
    );
    assert.equal(
      typeof described?.detail,
      "string",
      `${label}: the description came back without a sentence`,
    );
    assert.ok(
      described.detail.length > 0,
      `${label}: the description came back with an empty sentence`,
    );
  }
});

test("the walk terminates on a ConnectError reached only through a cycle", () => {
  const outer = new Error("outer");
  const inner = new ConnectError("inner", Code.Internal);
  outer.cause = inner;
  inner.cause = outer;
  assert.doesNotThrow(
    () => describeAgentRunError(outer),
    "a cycle in the cause chain made the walk recurse without end",
  );
});