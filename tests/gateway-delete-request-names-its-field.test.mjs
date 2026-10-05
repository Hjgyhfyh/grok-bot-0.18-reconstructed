import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The delete commands answered a request that named no agent with the text of a
 * Node call. Measured on a live box, `POST /api/<command> {}`:
 *
 *   deleteAgent, deleteAgents, updateAgent, getAgentMemories, getAgentAvatar,
 *   setAgentHiddenFromSidebar, setAgentNotifyOnUpdates,
 *   setAgentNotificationsEnabled  ->  500 {"error":"The \"path\" argument must
 *                                      be of type string. Received undefined"}
 *   getConversationOutline        ->  500 {"error":"Cannot read properties of
 *                                      undefined (reading 'startsWith')"}
 *   searchAgents, searchMedia     ->  500 {"error":"Cannot read properties of
 *                                      undefined (reading 'trim')"}
 *
 * Every one of those sentences comes from a callee that trusted its arguments.
 * They name no command, no field and no remedy, and on a loopback control surface
 * they hand a caller holding a bearer token the shape of the call the host
 * expected. Two more in the same family:
 *
 *   POST /api/deleteAgents {}      ->  200 {"transcript":[…]} — the ids were read
 *   as an empty list, so a request that named nothing at all answered as a
 *   completed batch, and `{"ids":"all"}` or `{"ids":42}` did the same.
 *   POST /api/deleteAgent {"id":   ->  500 {"error":"Unexpected end of JSON
 *   input"} — one V8 sentence and a status that blames the server for the
 *   caller's typo.
 *
 * Wave 10 closed eight commands with `requireText`/`requirePath` and a `400`
 * shape; these ten carried the same leak and were simply outside it. The tests
 * below fail against the unguarded table and pass against this one, and they pin
 * the other half of the contract: a well-formed request still reaches the
 * extension with its id, and an empty `ids` array is still a legitimate
 * "delete nothing" rather than a malformed request.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-delete-args-"));
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
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "host-gateway-api.ts"],
  ["host", "gateway-server.ts"],
]);
const { createHostGatewayApi } = loaded["host-gateway-api.mjs"];
const { routeCommand } = loaded["gateway-server.mjs"];

test.after(() => dispose());

const AGENT_ID = "0d3f1c66-2a54-4c2b-9f1e-7a0b5c6d8e91";

/**
 * Extensions that record every call and do what the real ones do with their
 * first argument. Without that, a double that accepts anything would let the
 * pre-fix gateway forward a malformed request and these tests would pass on
 * broken code for the wrong reason.
 */
function recordingApi() {
  const calls = [];
  const firstUse = {
    deleteAgent: (args) => args[0].length,
    deleteAgents: (args) => args[0].length,
    updateAgent: (args) => args[0].length,
    getAgentMemories: (args) => args[0].length,
    getAgentAvatar: (args) => args[0].length,
    getConversationOutline: (args) => args[0].startsWith("/"),
    setAgentHiddenFromSidebar: (args) => args[0].length,
    setAgentNotifyOnUpdates: (args) => args[0].length,
    searchAgents: (args) => args[0].trim(),
    searchMedia: (args) => args[0].trim(),
  };
  const record = (name) => (...args) => {
    calls.push({ name, args });
    firstUse[name]?.(args);
    // Every host command is awaited or returned, so every extension answers with
    // a promise. `deleteAgent` does `noteAgentDeleted(id).catch(...)` and
    // `deleteAgents` awaits `deleteAgentSchedules`, so a recorder that answered
    // `undefined` would fail those commands for a reason of its own.
    if (name === "isEnabled") return Promise.resolve(true);
    if (name === "getAgentChannels") return Promise.resolve({ manifests: [], connections: [] });
    return Promise.resolve(undefined);
  };
  const proxy = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const telemetryApi = new Proxy({ analytics: proxy }, {
    get: (target, name) => (typeof name === "symbol"
      ? Reflect.get(target, name)
      : name in target
        ? target[name]
        : record(String(name))),
  });
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => (id === "mcp" ? { mcp: {}, listBoxServers: async () => [] } : id === "telemetry" ? telemetryApi : proxy),
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
  return { api, calls };
}

const refuse = async (invoke) => {
  try {
    await invoke();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const CASES = [
  { command: "deleteAgent", field: "id", call: (api) => api.deleteAgent({}) },
  { command: "deleteAgent", field: "id", call: (api) => api.deleteAgent({ id: "" }) },
  { command: "deleteAgent", field: "id", call: (api) => api.deleteAgent({ id: 42 }) },
  { command: "deleteAgents", field: "ids", call: (api) => api.deleteAgents({}) },
  { command: "deleteAgents", field: "ids", call: (api) => api.deleteAgents({ ids: "all" }) },
  { command: "deleteAgents", field: "ids", call: (api) => api.deleteAgents({ ids: 42 }) },
  { command: "deleteAgents", field: "ids", call: (api) => api.deleteAgents({ ids: [AGENT_ID, 7] }) },
  { command: "deleteAgents", field: "ids", call: (api) => api.deleteAgents({ ids: [AGENT_ID, ""] }) },
  { command: "updateAgent", field: "id", call: (api) => api.updateAgent({ profile: { name: "x" } }) },
  { command: "getAgentMemories", field: "id", call: (api) => api.getAgentMemories({}) },
  { command: "getAgentAvatar", field: "id", call: (api) => api.getAgentAvatar({}) },
  { command: "getConversationOutline", field: "id", call: (api) => api.getConversationOutline({}) },
  { command: "setAgentHiddenFromSidebar", field: "id", call: (api) => api.setAgentHiddenFromSidebar({ isHidden: true }) },
  { command: "setAgentNotifyOnUpdates", field: "id", call: (api) => api.setAgentNotifyOnUpdates({ isEnabled: false }) },
  { command: "setAgentNotificationsEnabled", field: "id", call: (api) => api.setAgentNotificationsEnabled({ isEnabled: false }) },
  { command: "searchAgents", field: "query", call: (api) => api.searchAgents({}) },
  { command: "searchMedia", field: "query", call: (api) => api.searchMedia({}) },
];

const ENGINE_TEXT =
  /Cannot read properties of (undefined|null)|Cannot read property|must be of type string|is not a function/;

test("every malformed request for a delete or agent command names the command and the field", async () => {
  for (const entry of CASES) {
    const { api, calls } = recordingApi();
    const message = await refuse(() => entry.call(api));
    assert.notEqual(message, null,
      `${entry.command} answered a malformed request instead of refusing it`);
    assert.doesNotMatch(message, ENGINE_TEXT,
      `${entry.command} leaked the text of a runtime call to the caller: "${message}"`);
    assert.match(message, new RegExp(`Malformed ${entry.command} request`),
      `${entry.command} refused with "${message}", which names neither the command nor that the request is malformed`);
    assert.ok(message.includes(`"${entry.field}"`),
      `${entry.command} refused with "${message}", which does not name the field "${entry.field}"`);
    assert.equal(calls.filter((call) => call.name === entry.command).length, 0,
      `${entry.command} reached the transcript manager with a request the gateway had already refused, so the refusal does not stop the call`);
  }
});

test("a malformed deleteAgents list is refused before any agent is touched", async () => {
  const { api, calls } = recordingApi();
  await refuse(() => api.deleteAgents({ ids: [AGENT_ID, null] }));

  assert.deepEqual(calls, [],
    `a refused batch still touched ${JSON.stringify(calls.map((call) => call.name))}, so the refusal happens after the work rather than instead of it`);
});

test("a well-formed delete still reaches the extension with the id it was given", async () => {
  const { api, calls } = recordingApi();
  await api.deleteAgent({ id: AGENT_ID });
  const deleted = calls.find((call) => call.name === "deleteAgent");
  assert.notEqual(deleted, undefined, "a well-formed deleteAgent never reached the transcript manager");
  assert.equal(deleted.args[0], AGENT_ID,
    "the agent id was lost on the way to the extension, so the delete would remove something nobody asked about");

  const batch = recordingApi();
  await batch.api.deleteAgents({ ids: [AGENT_ID, "second-agent"] });
  assert.deepEqual(batch.calls.find((call) => call.name === "deleteAgents").args[0],
    [AGENT_ID, "second-agent"],
    "the batch arrived at the extension in a different order or shape than the request carried");

  const update = recordingApi();
  await update.api.updateAgent({ id: AGENT_ID, profile: { name: "Renamed" } });
  assert.equal(update.calls.find((call) => call.name === "updateAgent").args[0], AGENT_ID,
    "the update lost the agent id on the way to the extension");
});

test("an empty ids array is a request to delete nothing, not a malformed request", async () => {
  const { api, calls } = recordingApi();
  const message = await refuse(() => api.deleteAgents({ ids: [] }));
  assert.equal(message, null, `an empty list was refused with "${message}"`);
  assert.equal(calls.some((call) => call.name === "deleteAgents"), true,
    "an empty list never reached the extension, so a caller asking for a no-op cannot tell it apart from a refused request");
});

test("an empty search query is a search for everything, not a malformed request", async () => {
  for (const command of ["searchAgents", "searchMedia"]) {
    const { api, calls } = recordingApi();
    const message = await refuse(() => api[command]({ query: "" }));
    assert.equal(message, null, `${command} refused an empty query with "${message}"`);
    const sent = calls.find((call) => call.name === command);
    assert.equal(sent?.args[0], "",
      `${command} replaced the empty query the caller sent, so the extension no longer sees what was asked for`);
  }
});

/** The parts of `ServerResponse` that `respondError` and `respondJson` touch. */
function fakeResponse() {
  const sent = { status: 0, headers: {}, body: "" };
  return {
    sent,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      sent.status = status;
      sent.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body) {
      sent.body = String(body ?? "");
      this.writableEnded = true;
    },
    on() {},
  };
}

const fakeRequest = () => ({ headers: {}, method: "POST", url: "/api/deleteAgent" });

const gatewayDeps = (calls) => ({
  api: new Proxy({}, {
    get: (_target, name) => (args) => {
      calls.push({ name: String(name), args });
      return { deleted: [], failed: [] };
    },
  }),
  subscribe: () => () => {},
  getHealth: () => ({ isBusy: false }),
  startedAt: 0,
});

test("a body that is not JSON is refused with the command and a status that blames the caller", async () => {
  const calls = [];
  const res = fakeResponse();
  await routeCommand(gatewayDeps(calls), "deleteAgent", '{"id":', res, fakeRequest());

  assert.equal(res.sent.status, 400,
    "a body the host cannot parse was reported as a server failure, so a client with a typo retries against a host that is fine");
  assert.match(res.sent.body, /Malformed deleteAgent request/,
    `the refusal "${res.sent.body}" names neither the command nor that the request is malformed`);
  assert.doesNotMatch(res.sent.body, /JSON input|Unexpected token/,
    `the refusal "${res.sent.body}" is the text of the parser that failed`);
  assert.deepEqual(calls, [],
    "the command ran against a body that could not be parsed, so the refusal happens after the work rather than instead of it");
});

test("a body that parses still reaches the command unchanged", async () => {
  const calls = [];
  const res = fakeResponse();
  await routeCommand(gatewayDeps(calls), "deleteAgents", JSON.stringify({ ids: [AGENT_ID] }), res, fakeRequest());

  assert.equal(res.sent.status, 200,
    `a well-formed request answered ${res.sent.status}: ${res.sent.body}`);
  assert.equal(calls.length, 1,
    "the extra parse pass changed how many times the command runs, so a mint that dedupes would run twice");
  assert.deepEqual(calls[0].args, { ids: [AGENT_ID] },
    "the command received something other than the parsed request");
});

test("an empty body is still an empty object rather than a parse failure", async () => {
  const calls = [];
  const res = fakeResponse();
  await routeCommand(gatewayDeps(calls), "deleteAgents", "", res, fakeRequest());

  assert.equal(res.sent.status, 200,
    `a request with no body answered ${res.sent.status}: ${res.sent.body}`);
  assert.deepEqual(calls[0].args, {},
    "a request with no body must reach the API as an empty object so the API can refuse it by name");
});
