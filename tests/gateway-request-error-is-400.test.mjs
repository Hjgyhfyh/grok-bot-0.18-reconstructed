import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A refusal the host makes about the caller's own request was answered with the
 * one status that says the host broke.
 *
 * `statusForCommandError` knew four answers and none of them was `400`. A field
 * check that raised a plain `Error` therefore reached the caller as `500`, and
 * `500` is the answer a client retries — it invites a retry of a request that
 * can never succeed as written. The message was already right and named the
 * command and the field; the status said the server broke. Measured on a live
 * box: `POST /api/deleteAgent {}` answered
 * `500 {"error":"Malformed deleteAgent request: \"id\" must be a non-empty string."}`,
 * and `POST /api/deleteAgent {"id":` — the same mistake on the same endpoint —
 * answered `400`, because the JSON gate already had a status and the field gates
 * did not. `readBody` even raised a dedicated `SandGatewayRequestError` for a body
 * over the size ceiling, and nothing looked at the class.
 *
 * The `400` is matched by `instanceof` and checked before the `409` and `404`
 * branches. A malformed request never reached a callee, so it cannot also be a
 * limit refusal or a missing agent, and keeping the branches apart is what lets
 * each message stay about one fact. Matching by `name` instead would make the
 * answer depend on a string: a subclass that renamed itself would fall through
 * to `500`, and any unrelated error wearing that name would be handed a `400`
 * that blames the caller for a host fault. Both directions are asserted below.
 *
 * The tests drive a real HTTP server over loopback with the real API in front of
 * it, so what is asserted is the status a caller receives and not the shape of
 * an internal return value. They all fail against the pre-fix code, which
 * answers `500` for each of them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Falsification hook. Pointing this at a copy of `source/` whose two owned files
// came from `git HEAD` runs these same assertions against the pre-fix code, which
// is how each one was shown to fail before it was shown to pass. It is not set
// by `npm test`, so the suite always measures the working tree unless someone
// deliberately asks for the old one.
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

/**
 * `gateway-server.ts` and `host-gateway-api.ts` are bundled together on purpose.
 * `host-gateway-api.ts` imports `SandGatewayRequestError` from `gateway-server.ts`,
 * and the `400` branch is `instanceof`; bundling them as two independent files
 * would give each its own copy of the class, every refusal would miss the branch
 * and the whole file would pass for the wrong reason.
 */
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-request-error-status-"));
await build({
  stdin: {
    contents: [
      `export { SandGatewayRequestError, statusForCommandError, startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: sourceRoot,
    sourcefile: "gateway-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "gateway.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { SandGatewayRequestError, statusForCommandError, startGatewayServer, createHostGatewayApi } =
  await import(pathToFileURL(path.join(directory, "gateway.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

/**
 * An API over extensions that record every call, so a test can tell "the gateway
 * refused before the extension" from "the extension was reached and objected".
 */
function recordingApi() {
  const calls = [];
  const proxy = new Proxy({}, {
    get: (_target, name) => (...args) => {
      calls.push({ name: String(name), args });
      return undefined;
    },
  });
  const telemetry = new Proxy({ analytics: proxy }, {
    get: (target, name) => (typeof name === "symbol" ? Reflect.get(target, name) : name in target ? target[name] : () => undefined),
  });
  const extensions = { api: (id) => (id === "telemetry" ? telemetry : id === "mcp" ? { mcp: proxy, listBoxServers: async () => [] } : proxy) };
  const api = createHostGatewayApi({
    extensions,
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
  assert.notEqual(typeof api.deleteAgent, "undefined",
    "the gateway returned no deleteAgent at all, so this test would be measuring nothing");
  return { api, calls };
}

/** The real server, on loopback, with a token the test supplies itself. */
async function withServer(api, run) {
  const reported = [];
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
    onCommandError: (report) => reported.push(report),
    onCommandComplete: (report) => reported.push(report),
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };
  try {
    return await run(call);
  } finally {
    await server.close();
  }
}

test("the sweep found the three statuses it is guarding", () => {
  // A guard that matched nothing would pass on every answer. These three are the
  // whole contract: the status that blames the caller, the one that blames the
  // state, and the one that blames nothing in particular.
  assert.equal(statusForCommandError(new SandGatewayRequestError("x")), 400,
    "the class the whole file is about no longer reaches 400, so none of these tests proves anything");
  assert.equal(statusForCommandError(new Error("boom")), 500,
    "an ordinary fault stopped being a 500");
  assert.equal(statusForCommandError(Object.assign(new Error("busy"), { name: "SandAgentLimitError" })), 409,
    "the limit refusal stopped being a 409, so the 400 could be taking its place");
});

test("a request that names no agent is answered 400 over the wire, not 500", async () => {
  const { api, calls } = recordingApi();
  const answer = await withServer(api, (call) => call("/api/deleteAgent", "{}"));

  assert.equal(answer.status, 400,
    `a delete that named no agent came back as ${answer.status}, which tells the caller the server broke and invites a retry of a request that can never succeed`);
  assert.match(answer.body.error, /^Malformed deleteAgent request/,
    `the refusal does not name the command: ${JSON.stringify(answer.body.error)}`);
  assert.ok(answer.body.error.includes('"id"'),
    `the refusal does not name the field the caller has to fix: ${JSON.stringify(answer.body.error)}`);
  assert.equal(calls.length, 0,
    "the lifecycle was reached with a request the gateway had already refused");
});

test("the JSON gate keeps its own 400 and is not folded into the field refusal", async () => {
  const { api } = recordingApi();
  const answer = await withServer(api, (call) => call("/api/deleteAgent", '{"id":'));

  assert.equal(answer.status, 400,
    `a body that is not JSON came back as ${answer.status}; it is the caller's truncated write`);
  assert.match(answer.body.error, /the body is not valid JSON/,
    `the JSON gate no longer names the body as the fault: ${JSON.stringify(answer.body.error)}`);
  assert.doesNotMatch(answer.body.error, /"id"/,
    "the JSON gate blamed a named field, so a caller who sent valid JSON for every field would go looking for the wrong one");
  assert.doesNotMatch(answer.body.error, /JSON at position|Unexpected end of JSON|Unterminated string/,
    `a V8 parser sentence reached the caller: ${JSON.stringify(answer.body.error)}`);
});

test("both 400s carry the command they are about, so a caller can tell them apart", async () => {
  const { api } = recordingApi();
  await withServer(api, async (call) => {
    const unparsable = await call("/api/deleteAgent", '{"id":');
    const wrongShape = await call("/api/deleteAgent", "{}");

    assert.notEqual(unparsable.body.error, wrongShape.body.error,
      "the two 400s are the same sentence, so a caller cannot tell whether to fix its encoder or its payload");
    assert.ok(unparsable.body.error.includes("deleteAgent") && wrongShape.body.error.includes("deleteAgent"),
      `a refusal lost the command it belongs to: ${unparsable.body.error} / ${wrongShape.body.error}`);
    assert.ok(wrongShape.body.error.includes('"id"'),
      `the field refusal names no field: ${JSON.stringify(wrongShape.body.error)}`);
  });
});

test("a refusal the caller caused is not reported to the host fault telemetry", async () => {
  const { api } = recordingApi();
  const reported = [];
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
    onCommandError: (report) => reported.push(report),
    onCommandComplete: (report) => reported.push(report),
  });
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/deleteAgent`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: "{}",
    });
  } finally {
    await server.close();
  }
  assert.deepEqual(reported.filter((report) => report.method === "deleteAgent"), [],
    "a malformed request was filed as a host fault, so a caller bug raises the host's own error count");
});

test("the 400 branch is an instanceof test, so renaming the class cannot break it", () => {
  // A subclass that renames itself is the case a `name === "..."` comparison
  // loses. The refusal still names the caller's mistake, and it is still the
  // caller's mistake, whatever the class calls itself.
  class RenamedRefusal extends SandGatewayRequestError {
    constructor(message) {
      super(message);
      this.name = "SomethingCompletelyDifferent";
    }
  }
  const renamed = new RenamedRefusal("Malformed deleteAgent request: \"id\" must be a non-empty string.");
  assert.equal(statusForCommandError(renamed), 400,
    "a refusal that renamed itself stopped being answered 400, so the answer depends on a string the class chose");

  // And the other direction: the name alone must never buy the 400, or any host
  // fault wearing it would be reported as the caller's.
  const impostor = new Error("the secrets store could not be opened");
  impostor.name = "SandGatewayRequestError";
  assert.equal(statusForCommandError(impostor), 500,
    "an ordinary host fault wearing the refusal's name was answered as the caller's mistake");
  assert.equal(statusForCommandError({ name: "SandGatewayRequestError" }), 500,
    "a plain object wearing the name was answered 400, so a non-Error reached the caller's branch");
});

test("the 400 branch is decided before the 409 and 404 branches", () => {
  // A subclass that also wears a name the other branches match must still be a
  // `400`: a request the host refused on its own terms never reached the callee
  // that would have raised a limit or a missing agent.
  const limitLooking = new SandGatewayRequestError("Malformed deleteAgent request: \"id\" must be a non-empty string.");
  limitLooking.name = "SandAgentLimitError";
  assert.equal(statusForCommandError(limitLooking), 400,
    "a malformed request was reported as a state refusal, so a client stopped retrying a request it must fix");

  const missingLooking = new SandGatewayRequestError("Malformed deleteAgent request: \"id\" must be a non-empty string.");
  missingLooking.name = "SandAgentNotFoundError";
  assert.equal(statusForCommandError(missingLooking), 400,
    "a malformed request was reported as a missing agent, so the caller went looking for an agent that was never named");
});

test("a body over the size ceiling is the caller's fault too", () => {
  // `readBody` already raised a dedicated class for this; nothing read it. The
  // class is checked here directly because the ceiling is a third of a gigabyte
  // and allocating one is not something a test should do.
  assert.equal(statusForCommandError(new SandGatewayRequestError("Request body is too large.")), 400,
    "a body past the size ceiling is still answered 500, so a client retries an upload that can never fit");
});