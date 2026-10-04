import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Code, ConnectError } from "@connectrpc/connect";
import { build } from "esbuild";

/**
 * An agent could go fourteen user messages without a single reply, and nothing anywhere said
 * why. `abstract-user-message-action-handler.ts` throws `response.error` out of the step when
 * the provider refuses, `stream-attempt.ts` rethrows it, `SandAgentRunner.run` lets it through,
 * and the only record left was one `console.error` line and an error tray entry that the next
 * message pushed off screen. The transcript writer never saw the failure: it is fed by
 * `send-pipeline`, which has no idea a provider was involved. Measured on a live machine, the
 * transcript held fourteen `message` rows with `role: "user"` and zero rows of any other kind.
 *
 * Two failure shapes reached that silence, and only one of them threw. A 401, 429, 500 or a
 * dropped socket threw and landed in the tray. An empty `200`, or a body that is not an event
 * stream at all, is not an error for the AI SDK: the step finishes with no text and no error,
 * the reply-nudge ladder runs three times and fails three times, `reportTurnEmptyDelivery`
 * fires — and the user is still looking at nothing.
 *
 * What this file proves, against live code and a real `store.db`:
 *
 *  - a turn that dies on the provider leaves a `notice` row in the agent's own database, with a
 *    sentence that names what happened;
 *  - that sentence never carries the API key, the `Authorization` header, the request body or
 *    a stack. The stub server is deliberately hostile: it echoes all four back in its error
 *    message, so a note assembled by copying the provider's text cannot pass;
 *  - an empty provider answer is explained too, because nothing threw there;
 *  - a turn the user cancelled writes nothing, because they already know why.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-turn-failure-"));
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
  ["packages", "agent", "tool-stream-executor.ts"],
  ["host", "extensions", "transcript", "turn-runtime.ts"],
  ["host", "extensions", "session", "agent-db.ts"],
]);
const { createProviderPromptSession } = loaded["provider-session.mjs"];
const { SimplePromptToolExecutor } = loaded["tool-stream-executor.mjs"];
const { TurnRuntime } = loaded["turn-runtime.mjs"];
const { SandAgentDb } = loaded["agent-db.mjs"];

test.after(() => dispose());

// A key that exists only for this run. It must never appear in a transcript row, in the
// database file, or in anything this test prints.
const API_KEY = "sk-live-turn-failure-probe-DO-NOT-LEAK-9c41";
const USER_PROMPT_MARKER = "user-secret-marker-4f21";
const SYSTEM_PROMPT_MARKER = "warm, concise desktop assistant";
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

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

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

      // A hostile provider: it answers a refusal by quoting the credential, the header it
      // arrived in and the whole request back at the client. Any note built by copying the
      // provider's own message leaks all three, so this branch is the leak trap.
      const hostile = [
        `probe refused (${behaviour})`,
        `authorization=${req.headers.authorization ?? ""}`,
        `x-api-key=${req.headers["x-api-key"] ?? ""}`,
        `request=${raw}`,
      ].join(" || ");

      if (behaviour.startsWith("status-")) {
        const status = Number(behaviour.slice("status-".length));
        const headers = { "content-type": "application/json" };
        if (status === 429) headers["retry-after"] = "7";
        res.writeHead(status, headers);
        res.end(JSON.stringify({ error: { message: hostile, type: "probe" } }));
        return;
      }
      if (behaviour === "empty-200") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (behaviour === "garbage-sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("<<< this is not an event stream >>>\n\n");
        return;
      }
      if (behaviour === "break-mid-text") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          sseFrame({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: behaviour,
            choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: null }],
          }),
        );
        setTimeout(() => {
          res.socket.destroy();
        }, 20);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sseFrame({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: behaviour,
          choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
        }),
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

/**
 * Runs one turn through the shipped provider route and the shipped tool-stream executor and
 * returns what the step carries — the same object `abstract-user-message-action-handler` reads
 * from `response.error` and throws.
 *
 * `fullStream` has to be drained: `executeToolStream` duplicates the SDK stream and only one of
 * the two copies feeds `response`, so an unread copy stalls the duplication pump and the turn
 * never settles. In the product the other copy is consumed by the interaction listener
 * (`abstract-user-message-action-handler.ts` passes `result.fullStream` to `consumeStream`), so
 * draining it here reproduces the shipped arrangement rather than working around a defect.
 */
async function runProviderTurn(modelId, prompt) {
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
      return inner.stream(ctx, invocationId, undefined, {
        abortSignal: ctx?.signal,
      });
    },
  });
  executor.appendMessages([{ role: "user", content: prompt }]);
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
  const parts = [];
  const drained = (async () => {
    for await (const part of result.fullStream) parts.push(part.type);
  })().catch(() => {});
  const response = await withDeadline(
    result.response,
    SAFETY_CEILING_MS,
    modelId,
  );
  await drained;
  return { response, parts };
}

/** The step error `abstract-user-message-action-handler.ts` throws on `response.error`. */
async function providerTurnError(modelId, prompt) {
  const { response } = await runProviderTurn(modelId, prompt);
  return response?.error ?? null;
}

/** A transcript manager holding only what `TurnRuntime.runTurn` actually touches. */
function createTranscriptManager({ db, session, active, liveEntries }) {
  const trayErrors = [];
  const emptyDeliveries = [];
  const rosterEmits = [];
  const tm = {
    sessions: { activeSession: active ? session : undefined },
    sendPipeline: {
      currentTurnEpoch: () => 1,
      latestRecoverySends: new Map(),
      recoveryBreakEpochs: new Map(),
    },
    ackObligations: {
      retireAckRunToken: () => {},
      fulfillAckObligation: () => {},
    },
    ackObligationStore: { get: () => undefined },
    widgetResponses: {
      collectUnansweredQuestionPrompts: () => ({}),
      collectUserReactionNotices: () => ({}),
    },
    telemetry: {
      startTurn: () => ({
        finalize: () => {},
        setModel: () => {},
        setRequestId: () => {},
      }),
      reportTurnEmptyDelivery: (report) => {
        emptyDeliveries.push(report);
      },
    },
    roster: {
      emit: (event) => {
        rosterEmits.push(event);
      },
      emitAgentUpdate: async () => {},
    },
    automationRuntime: { emitAutomations: () => {} },
    runLifecycle: {
      lastRequestIdBySession: new Map(),
      endSessionRun: () => {},
    },
    upgradeResume: { markAgentResumePending: () => {} },
    trayErrors: {
      pushError: (options) => {
        trayErrors.push(options);
        return { id: `tray-${trayErrors.length}` };
      },
    },
    traceFlusher: () => {},
    // Mirrors `SessionRuntime.appendEntry`: the live row first, then the durable one.
    appendEntry: (entry) => {
      liveEntries.push(entry);
      rosterEmits.push({ type: "appended", entry });
      return db.appendTranscriptEntry(entry);
    },
  };
  return { tm, trayErrors, emptyDeliveries, rosterEmits };
}

function openAgentStore(label) {
  const base = mkdtempSync(path.join(os.tmpdir(), `grok-turn-failure-${label}-`));
  const agentDir = path.join(base, "agent-1");
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  const db = new SandAgentDb(dbPath);
  const session = { id: "agent-1", dbPath, db };
  return { base, db, dbPath, session };
}

/** Drives `TurnRuntime.runTurn` for real against a runner that throws `error`. */
async function runFailingTurn({ error, active }) {
  const opened = openAgentStore("turn");
  const liveEntries = [];
  const { tm, trayErrors, emptyDeliveries } = createTranscriptManager({
    db: opened.db,
    session: opened.session,
    active,
    liveEntries,
  });
  const runtime = new TurnRuntime(tm);
  const runner = {
    run: async () => {
      throw error;
    },
    getObservedToolCallCount: () => 0,
  };
  // `console.error("[sand][turn] agent run failed…", error)` is the product's own line and is
  // left alone; it is silenced here only so a full `APICallError` dump does not drown the run.
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runtime.runTurn(opened.session, runner, "are you there?", {
      selectedImages: [],
    }, 1);
  } finally {
    console.error = originalConsoleError;
  }
  const rows = opened.db.getTranscriptEntries();
  opened.db.close();
  rmSync(opened.base, { recursive: true, force: true });
  return { rows, liveEntries, trayErrors, emptyDeliveries };
}

function assertNoSecretReachedTheNote(note, where) {
  assert.equal(typeof note?.text, "string", `${where}: the note carries no text at all`);
  assert.ok(
    !note.text.includes(API_KEY),
    `${where}: the note carries the API key value`,
  );
  assert.doesNotMatch(
    note.text,
    /authorization/i,
    `${where}: the note carries the Authorization header`,
  );
  assert.ok(
    !note.text.includes(USER_PROMPT_MARKER),
    `${where}: the note carries the request body`,
  );
  assert.ok(
    !note.text.includes(SYSTEM_PROMPT_MARKER),
    `${where}: the note carries the system prompt out of the request body`,
  );
  assert.doesNotMatch(
    note.text,
    /\bat \S+ \(.*:\d+:\d+\)/,
    `${where}: the note carries a stack frame`,
  );
  const serialized = JSON.stringify(note);
  assert.ok(!serialized.includes(API_KEY), `${where}: the note row carries the API key`);
  assert.ok(
    !serialized.includes(USER_PROMPT_MARKER),
    `${where}: the note row carries the request body`,
  );
}

test.before(async () => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "grok-sand-root-"));
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

test("a turn refused with 401 leaves a note in the agent's own store.db", async () => {
  received.length = 0;
  const error = await providerTurnError(
    "status-401",
    `${USER_PROMPT_MARKER}: what is the deploy status?`,
  );
  assert.ok(error != null, "the refusal produced no error to report at all");
  assert.equal(
    received.length,
    1,
    "the stub was never called, so this test would pass without exercising the provider at all",
  );
  assert.equal(
    received[0].authorization,
    `Bearer ${API_KEY}`,
    "the probe never carried a credential, so the leak trap below would be vacuous",
  );

  const { rows } = await runFailingTurn({ error, active: true });

  const note = rows.find((row) => row.kind === "notice");
  assert.ok(
    note != null,
    `the refused turn wrote no note to store.db; rows were ${JSON.stringify(rows.map((row) => row.kind))}`,
  );
  assert.match(
    note.text,
    /401/,
    "the note does not say which failure happened, so the user still has nothing to act on",
  );
  assert.match(
    note.text,
    /API key/i,
    "a 401 is a credential refusal, and the note has to say so",
  );
  assertNoSecretReachedTheNote(note, "401 note");
});

test("a 429 says rate limiting and a 500 says the provider is at fault", async () => {
  const throttled = await providerTurnError("status-429", `${USER_PROMPT_MARKER}: ping`);
  assert.ok(throttled != null, "the 429 produced no error at all");
  const throttleRows = (await runFailingTurn({ error: throttled, active: true })).rows;
  const throttleNote = throttleRows.find((row) => row.kind === "notice");
  assert.ok(throttleNote != null, "a throttled turn left no note in store.db");
  assert.match(
    throttleNote.text,
    /rate limit/i,
    "a 429 was reported as an unnamed failure, so the user cannot tell waiting will help",
  );
  assert.match(
    throttleNote.text,
    /7s/,
    "the provider's Retry-After was dropped, so the user does not know how long to wait",
  );
  assertNoSecretReachedTheNote(throttleNote, "429 note");

  const broken = await providerTurnError("status-500", `${USER_PROMPT_MARKER}: ping`);
  assert.ok(broken != null, "the 500 produced no error at all");
  const brokenRows = (await runFailingTurn({ error: broken, active: true })).rows;
  const brokenNote = brokenRows.find((row) => row.kind === "notice");
  assert.ok(brokenNote != null, "a 500 left no note in store.db");
  assert.match(
    brokenNote.text,
    /provider failed with a server error/i,
    "a 500 is a provider-side fault and the note has to say which side is at fault",
  );
  assertNoSecretReachedTheNote(brokenNote, "500 note");
});

test("a socket cut mid-answer is reported as a broken connection", async () => {
  const error = await providerTurnError("break-mid-text", `${USER_PROMPT_MARKER}: ping`);
  assert.ok(error != null, "a truncated stream produced no error at all");

  const { rows } = await runFailingTurn({ error, active: true });

  const note = rows.find((row) => row.kind === "notice");
  assert.ok(note != null, "a dropped provider socket left no note in store.db");
  assert.match(
    note.text,
    /connection to the model provider broke/i,
    "a dropped socket was reported as an unnamed failure instead of a connection problem",
  );
  assertNoSecretReachedTheNote(note, "socket-cut note");
});

test("a turn the user cancelled writes nothing, because they already know why", async () => {
  // The exact object `abstract-user-message-action-handler` throws when `ctx.signal.aborted`
  // and the step carries no provider error.
  const cancelled = new ConnectError("User aborted request", Code.Canceled);

  const { rows, trayErrors } = await runFailingTurn({ error: cancelled, active: true });

  assert.equal(
    rows.filter((row) => row.kind === "notice").length,
    0,
    "a cancelled turn was explained to the user as a failure they caused",
  );
  assert.equal(
    trayErrors.length,
    1,
    "the existing tray error for a cancelled turn disappeared, which is a regression of its own",
  );
});

test("an empty provider answer is explained even though nothing threw", async () => {
  const { response, parts } = await runProviderTurn(
    "empty-200",
    `${USER_PROMPT_MARKER}: ping`,
  );
  assert.equal(
    response?.error ?? null,
    null,
    "an empty but well-formed stream must not be reported as a provider error, or this test would prove the wrong thing",
  );
  assert.equal(
    parts.includes("text-delta"),
    false,
    "the provider answered with text, so the silence this test is about did not happen",
  );
  assert.ok(parts.length > 0, "the stream produced no parts at all, so nothing was exercised");

  const opened = openAgentStore("empty");
  const liveEntries = [];
  const { tm, emptyDeliveries } = createTranscriptManager({
    db: opened.db,
    session: opened.session,
    active: true,
    liveEntries,
  });
  const runtime = new TurnRuntime(tm);
  // What `SandAgentRunner.run` returns when a step finished with nothing streamed and nothing
  // sent: the reply-nudge ladder then runs three times and fails three times.
  const runner = {
    run: async () => ({
      sentMessageCount: 0,
      reacted: false,
      aborted: false,
      streamOutputProduced: false,
    }),
    getObservedToolCallCount: () => 0,
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runtime.runTurn(
      opened.session,
      runner,
      `${USER_PROMPT_MARKER}: ping`,
      { selectedImages: [] },
      1,
    );
  } finally {
    console.error = originalConsoleError;
  }
  const rows = opened.db.getTranscriptEntries();
  opened.db.close();
  const note = rows.find((row) => row.kind === "notice");
  rmSync(opened.base, { recursive: true, force: true });

  assert.equal(
    emptyDeliveries.length,
    1,
    "the empty delivery was never reported, so this test is not standing where the silence is",
  );
  assert.ok(
    note != null,
    "an empty provider answer left the chat with no explanation at all, which is the exact silence this file is about",
  );
  assert.match(
    note.text,
    /model provider answered with nothing/i,
    "the note does not say that the provider answered with nothing",
  );
  assertNoSecretReachedTheNote(note, "empty-answer note");
});

test("the database file itself never holds the key, even on disk", async () => {
  const opened = openAgentStore("disk");
  const { tm } = createTranscriptManager({
    db: opened.db,
    session: opened.session,
    active: true,
    liveEntries: [],
  });
  const runtime = new TurnRuntime(tm);
  const error = await providerTurnError(
    "status-401",
    `${USER_PROMPT_MARKER}: deploy status`,
  );
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runtime.runTurn(
      opened.session,
      {
        run: async () => {
          throw error;
        },
        getObservedToolCallCount: () => 0,
      },
      `${USER_PROMPT_MARKER}: deploy status`,
      { selectedImages: [] },
      1,
    );
  } finally {
    console.error = originalConsoleError;
  }
  // `store.db` runs in WAL mode (`agent-db-recovery.ts:29`), so a freshly appended row is
  // still in the `-wal` sidecar. Reading only the main file would call a leaked row clean.
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

  assert.ok(onDisk.length > 0, "store.db is empty, so the on-disk check would prove nothing");
  assert.ok(
    !onDisk.includes(Buffer.from(API_KEY, "utf8")),
    "the API key reached store.db on disk",
  );
  assert.ok(
    !onDisk.includes(Buffer.from(USER_PROMPT_MARKER, "utf8")),
    "the request body reached store.db on disk",
  );
});

test("a backend that rejects the turn with its own title keeps that title", async () => {
  // The shape `walkForBackendConnectError` recognises: a `ConnectError` whose `findDetails`
  // answers with a curated title. `PermissionDenied` is used because `[unavailable]` is one of
  // the transient-stream message tokens and would be classified as a broken connection first.
  const backend = new ConnectError("account limit reached", Code.PermissionDenied);
  backend.findDetails = () => [
    { details: { title: "Model provider is overloaded", detail: "try later" } },
  ];

  const { rows } = await runFailingTurn({ error: backend, active: true });

  const note = rows.find((row) => row.kind === "notice");
  assert.ok(note != null, "a backend refusal left no note in store.db");
  assert.match(
    note.text,
    /Model provider is overloaded/,
    "the backend's own curated title was dropped, so the user loses the one sentence written for them",
  );
});

test("a cancelled turn still reaches the error tray and never throws out of the handler", async () => {
  // The exact object `abstract-user-message-action-handler.ts:2129` throws when `ctx.signal`
  // aborted and the step carries no provider error. `ConnectError.findDetails()` throws when
  // called with no registry, and `findBackendConnectError` calls it that way, so the handler
  // meant to report this turn used to throw a TypeError out of its own catch block instead.
  const cancelled = new ConnectError("User aborted request", Code.Canceled);

  let rejected = null;
  try {
    await runFailingTurn({ error: cancelled, active: true });
  } catch (error) {
    rejected = error;
  }
  assert.equal(
    rejected,
    null,
    "runTurn rejected on a cancelled turn, so the caller lost the turn entirely",
  );
});