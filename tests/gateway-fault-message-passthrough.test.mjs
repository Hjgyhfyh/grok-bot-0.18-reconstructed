import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A host fault answered the caller with the message the fault carried, and the
 * message was the absolute path of the file the host was holding when it broke.
 *
 * `respondError` in `gateway-server.ts` is the only place an error reaches the
 * wire, and the listener in `startGatewayServer` hands it `errorMessage(error)`
 * with nothing in between. Measured on a gateway built from the shipped
 * `createHostGatewayApi` over extensions that fail the way the real ones do when
 * a store is missing or locked, **96 of the 124 commands in the table answered**
 *
 *   `500 {"error":"ENOENT: no such file or directory, open 'C:\Users\<user>\.grokbot\agents\<uuid>\store.db'"}`
 *
 * and `SQLITE_CANTOPEN` did the same with `box-secrets.json` in it. The listener
 * is below every route, so one fault shape reaches three quarters of the whole
 * HTTP surface, plus `POST /prepare-upgrade`, which is not a command at all.
 *
 * Nothing noticed for one specific reason. `gateway-no-engine-sentences.test.mjs`
 * already asserts the contract this breaks — "no answer contains an engine
 * sentence, a module name, a filesystem path or a syscall" — and its `INTERNAL_DETAIL`
 * regex lists `ENOENT` and `node:` in that same sentence. Its double answers
 * `undefined` for every method it was not told about, so no callee ever throws,
 * so the fault branch of the listener is never entered and the assertion passes
 * without ever meeting a fault. The guard was real and the thing it guards was
 * never called.
 *
 * The split this file draws is the one the status code already draws. A `4xx` is
 * the host *declining* a request on its own terms, and those sentences name the
 * field the caller has to fix; they are meant to be read and every other test in
 * this directory asserts on them word for word, so they are left exactly as they
 * are. A `5xx` is the host *breaking*, and its message comes from a filesystem, a
 * SQLite handle or a socket — none of which the caller wrote and all of which
 * describe the machine. That is the branch sanitised here, and the detail is not
 * thrown away: `classifyGatewayCommandError` still receives the error class and
 * the errno through `onCommandError`, which is where a host fault has always been
 * recorded.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `host-gateway-api.ts` imports the refusal class from `gateway-server.ts` and the
// `400` branch is `instanceof`, so both are bundled into one file.
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-fault-"));
await build({
  stdin: {
    contents: [
      `export { startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { SAND_GATEWAY_COMMANDS } from "./source/host/gateway-protocol.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "gateway-fault-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "gateway.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { startGatewayServer, SAND_GATEWAY_COMMANDS, createHostGatewayApi } = await import(
  pathToFileURL(path.join(directory, "gateway.mjs")).href + "?" + Date.now()
);
test.after(() => rmSync(directory, { recursive: true, force: true }));

const AGENT = "11111111-1111-4111-8111-111111111111";
const STORE = `C:\\Users\\probe\\.grokbot\\agents\\${AGENT}\\store.db`;

/**
 * The faults the real extensions raise. Each one names a file on this machine,
 * which is the whole point: a caller who triggers one of these learns the
 * account name, the sand root and the per-agent layout.
 */
const FAULTS = {
  missingStore: Object.assign(
    new Error(`ENOENT: no such file or directory, open '${STORE}'`),
    { code: "ENOENT" },
  ),
  lockedDatabase: new Error(
    "SQLITE_CANTOPEN: unable to open database file at C:\\Users\\probe\\.grokbot\\box-secrets.json",
  ),
  nodePathSentence: new TypeError('The "path" argument must be of type string. Received undefined'),
};

/** Everything the gate refuses on its own terms still reaches its callee. */
const SHAPES = {
  isEnabled: () => true,
  getActiveAgentId: () => AGENT,
  listAgentsSync: () => [],
  noteAgentDeleted: () => Promise.resolve(),
  listBoxServers: async () => [],
};

/**
 * An API over extensions that all raise `fault`, so one probe covers every
 * command the fault can reach. The `400`s a command answers before it calls an
 * extension are left alone — that is the host declining, which is a different
 * fact and is asserted separately below.
 */
function faultingApi(fault) {
  const record = (name) => (...args) => {
    if (SHAPES[name] != null) return SHAPES[name](record);
    throw fault;
  };
  const domain = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const analytics = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const logs = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const telemetry = new Proxy({ analytics, logs }, {
    get: (target, name) =>
      typeof name === "symbol" ? Reflect.get(target, name) : name in target ? target[name] : record(String(name)),
  });
  return createHostGatewayApi({
    extensions: {
      api: (id) => (id === "telemetry" ? telemetry : id === "mcp" ? { mcp: domain, listBoxServers: async () => [] } : domain),
    },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
}

async function withServer(api, run, extra = {}) {
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
    ...extra,
  });
  try {
    return await run(server.port);
  } finally {
    await server.close();
  }
}

function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body,
  });
}

/** The same sentences `gateway-no-engine-sentences.test.mjs` refuses to ship. */
const INTERNAL_DETAIL =
  /node:|Cannot read propert|Cannot destructure|must be of type|Received undefined|is not a function|\.ts:\d+|\.js:\d+|at Object\.|at Array\.|SQLITE|EPERM|ENOENT|EACCES|Buffer\._|URI malformed|JSON at position|Unexpected end of JSON|Unterminated string|host extension method is unavailable/;

/** A path, spelled the three ways Windows and Node spell one. */
const FILESYSTEM_PATH =
  /[A-Za-z]:\\|\.grokbot|\/home\/|\/Users\/|GrokBotLocalBox|AppData|\\store\.db|box-secrets\.json/;

test("the fault sweep covers the whole table and still reaches the commands it is about", async () => {
  const commands = Object.keys(SAND_GATEWAY_COMMANDS);
  assert.ok(commands.length >= 100,
    `the table was expected to carry the whole shipped surface, found ${commands.length} commands`);

  const fault = FAULTS.missingStore;
  const faults = [];
  const refusals = [];
  await withServer(faultingApi(fault), async (port) => {
    for (const command of commands) {
      const response = await post(port, `/api/${command}`, JSON.stringify({ id: AGENT }));
      const text = await response.text();
      if (response.status >= 500) faults.push({ command, status: response.status, text });
      else refusals.push({ command, status: response.status, text });
    }
  });

  assert.ok(faults.length >= 50,
    `a sweep over ${commands.length} commands found only ${faults.length} that answer a fault with a 5xx; a sweep that has stopped reaching the fault branch proves nothing`);
  assert.ok(refusals.length >= 10,
    `a sweep over ${commands.length} commands found only ${refusals.length} refusals before the callee; the double is refusing what the product refuses, so this file is no longer measuring the fault branch`);

  const leaked = [];
  const silent = [];
  for (const answer of faults) {
    if (FILESYSTEM_PATH.test(answer.text)) {
      leaked.push(`${answer.command} answered ${answer.status} with a path: ${answer.text.slice(0, 140)}`);
    } else if (INTERNAL_DETAIL.test(answer.text)) {
      leaked.push(`${answer.command} answered ${answer.status} with an engine sentence: ${answer.text.slice(0, 140)}`);
    } else if (!answer.text.includes(answer.command)) {
      silent.push(`${answer.command} answered ${answer.status} without naming itself: ${answer.text.slice(0, 140)}`);
    }
  }
  assert.deepEqual(leaked, [],
    `the host fault reached the caller with a detail about this machine in it:\n  ${leaked.join("\n  ")}`);
  assert.deepEqual(silent, [],
    `these faults left the caller with a sentence that names neither the command nor anything else:\n  ${silent.join("\n  ")}`);
});

test("every kind of fault a callee can raise is answered without a detail of this machine", async () => {
  const failures = [];
  await withServer(faultingApi(FAULTS.missingStore), async (port) => {
    for (const command of ["getAgentTranscript", "deleteAgent", "listAgents", "sendPrompt"]) {
      const response = await post(port, `/api/${command}`, JSON.stringify({ id: AGENT }));
      if (response.status < 500) continue;
      const text = await response.text();
      if (FILESYSTEM_PATH.test(text) || INTERNAL_DETAIL.test(text)) {
        failures.push(`ENOENT ${command}: ${text.slice(0, 140)}`);
      }
    }
  });
  await withServer(faultingApi(FAULTS.lockedDatabase), async (port) => {
    for (const command of ["getAgentTranscript", "deleteAgent", "listAgents"]) {
      const response = await post(port, `/api/${command}`, JSON.stringify({ id: AGENT }));
      if (response.status < 500) continue;
      const text = await response.text();
      if (FILESYSTEM_PATH.test(text) || INTERNAL_DETAIL.test(text)) {
        failures.push(`SQLITE ${command}: ${text.slice(0, 140)}`);
      }
    }
  });
  await withServer(faultingApi(FAULTS.nodePathSentence), async (port) => {
    for (const command of ["getAgentTranscript", "listAgents"]) {
      const response = await post(port, `/api/${command}`, JSON.stringify({ id: AGENT }));
      if (response.status < 500) continue;
      const text = await response.text();
      if (FILESYSTEM_PATH.test(text) || INTERNAL_DETAIL.test(text)) {
        failures.push(`node:path ${command}: ${text.slice(0, 140)}`);
      }
    }
  });
  assert.deepEqual(failures, [],
    `these answers carry the host's own error text to the caller:\n  ${failures.join("\n  ")}`);
});

test("the same listener does not leak a fault on the route that is not a command", async () => {
  // `/prepare-upgrade` skips `routeCommand` entirely, so it is a second place a
  // fault reaches `respondError` from, and a sweep over `/api/<command>` cannot
  // see it. `prepareForUpgrade` touches the run queue on disk, which is exactly
  // the fault it raises when the queue is gone.
  const response = await withServer(
    faultingApi(FAULTS.missingStore),
    (port) => post(port, "/prepare-upgrade", "{}"),
    { prepareForUpgrade: async () => { throw FAULTS.missingStore; } },
  );
  const text = await response.text();
  assert.equal(response.status, 500, `a fault on /prepare-upgrade answered ${response.status}: ${text.slice(0, 140)}`);
  assert.ok(!FILESYSTEM_PATH.test(text) && !INTERNAL_DETAIL.test(text),
    `a fault on /prepare-upgrade reached the caller with a detail about this machine in it: ${text.slice(0, 200)}`);
});

test("a refusal the host raises on purpose still says the field, because a caller has to act on it", async () => {
  // The other side of the split. These sentences are written for the caller:
  // they name the command and the field, and every other test in this directory
  // asserts on them word for word. Sanitising the fault branch must not reach
  // them, or the gateway starts answering a typo with "something went wrong".
  const expectations = [
    { command: "deleteAgent", field: "id" },
    { command: "searchAgents", field: "query" },
    { command: "deleteAgents", field: "ids" },
    { command: "setBoxSecrets", field: "secrets" },
  ];
  const failures = [];
  await withServer(faultingApi(FAULTS.missingStore), async (port) => {
    for (const { command, field } of expectations) {
      const response = await post(port, `/api/${command}`, "{}");
      const text = await response.text();
      // The body is JSON, so the quotes around the field arrive escaped. Read
      // the sentence rather than the envelope, or the check is about escaping.
      const sentence = String(JSON.parse(text)?.error ?? text);
      if (response.status !== 400) {
        failures.push(`${command} {} answered ${response.status}: ${sentence.slice(0, 140)}`);
      } else if (!sentence.includes(`Malformed ${command} request`) || !sentence.includes(`"${field}"`)) {
        failures.push(`${command} {} answered 400 without naming ${field}: ${sentence.slice(0, 140)}`);
      }
    }
  });
  assert.deepEqual(failures, [],
    `the fault sanitiser reached the refusals a caller has to act on:\n  ${failures.join("\n  ")}`);
});

test("the detail is still recorded for the host even though it is no longer published", async () => {
  // Sanitising the wire is only honest if the detail still reaches the one place
  // that is allowed to hold it. `onCommandError` is called from `routeCommand`
  // before the throw, and it is what makes a host fault debuggable at all.
  const seen = [];
  await withServer(
    faultingApi(FAULTS.missingStore),
    (port) => post(port, "/api/getAgentTranscript", JSON.stringify({ id: AGENT })),
    { onCommandError: (report) => seen.push(report) },
  );
  assert.ok(seen.length > 0,
    "no fault was reported to onCommandError, so the detail was discarded instead of kept");
  const report = seen[0];
  assert.equal(report.method, "getAgentTranscript",
    `the report names ${report.method} instead of the command that broke`);
  assert.equal(report.errorClass, "Error",
    `the report lost the error class, so a host fault can no longer be told from another: ${JSON.stringify(report)}`);
  assert.equal(report.errno, "ENOENT",
    `the report lost the errno, which is the one field that says what actually failed: ${JSON.stringify(report)}`);
});