import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A request that named nothing was answered about the wrong thing, or with a
 * sentence borrowed from deep inside the host.
 *
 * Measured on a live box, one probe per command. Every one of these is the same
 * defect wearing a different mask:
 *
 *   `POST /api/setGroupMembers {}`          500  "The \"path\" argument must be of type string. Received undefined"
 *   `POST /api/deleteAgentMemory {}`        500  the same `node:path` sentence
 *   `POST /api/duplicateAgent {}`           500  "That agent no longer exists."
 *   `POST /api/getAgentChannels {}`         500  "Invalid Sand agent id: undefined"
 *   `POST /api/createAgentWorkflow {"id"}`  500  "Cannot read properties of undefined (reading 'trigger')"
 *   `POST /api/getSubagents {}`             200  []
 *   `POST /api/getAgentTranscriptPage {}`   200  {"entries":[]}
 *   `POST /api/setAgentAutomationEnabled {"id"}`  200  []
 *
 * The first group blames the server, and the last group is worse: it answers
 * `200` with a real, well-formed, empty answer. "This agent has no subagents" and
 * "this agent has no automations" are true of every agent in the world, so a
 * caller whose id was lost reads a success and a renderer draws an empty chat.
 * Only a caller-caused refusal can tell those two apart, and the refusal has to
 * name the command and the field the caller left out.
 *
 * Two guards keep the sweep honest. The last test replays each command with
 * every required field filled in and expects it to reach its extension, so a
 * gate that tightened past its brief fails here rather than passing quietly. And
 * the extension double answers with the shapes the real extensions answer with,
 * because a double that accepts everything would let the pre-fix gateway forward
 * a malformed request and pass for the wrong reason.
 *
 * All of these cases fail against the pre-fix code, which answers `500` or a
 * false `200`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// See the note in `gateway-request-error-is-400.test.mjs`: pointing this at a
// copy of `source/` built from `git HEAD` runs these assertions against the
// pre-fix code.
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

// `host-gateway-api.ts` imports the refusal class from `gateway-server.ts` and the
// `400` branch is `instanceof`, so the three entry points are bundled into one
// file. Three bundles would mean three copies of the class.
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-field-sweep-"));
await build({
  stdin: {
    contents: [
      `export { statusForCommandError, startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { SAND_GATEWAY_COMMANDS } from "./source/host/gateway-protocol.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: sourceRoot,
    sourcefile: "gateway-sweep-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "gateway.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { statusForCommandError, startGatewayServer, SAND_GATEWAY_COMMANDS, createHostGatewayApi } =
  await import(pathToFileURL(path.join(directory, "gateway.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

const AGENT = "11111111-1111-4111-8111-111111111111";

/**
 * One entry per command that cannot answer without a field the caller left out.
 * `body` is the request as sent and `field` is the field the refusal must name,
 * so an entry carrying `{id}` is probing the *second* required field.
 */
const CASES = [
  { command: "getAgentTranscript", body: {}, field: "id" },
  { command: "getAgentTranscriptPage", body: {}, field: "id" },
  { command: "getAgentTranscriptWindow", body: {}, field: "id" },
  { command: "getAgentTranscriptTail", body: {}, field: "id" },
  { command: "getAgentThread", body: {}, field: "id" },
  { command: "getAgentThread", body: { id: AGENT }, field: "rootId" },
  { command: "sendPrompt", body: {}, field: "prompt" },
  { command: "respondToWidget", body: {}, field: "value" },
  { command: "resolveAutoReviewApproval", body: {}, field: "agentId" },
  { command: "resolveAutoReviewApproval", body: { agentId: AGENT }, field: "resolution" },
  { command: "resolveLocalToolPermission", body: {}, field: "resolution" },
  { command: "resolveLocalToolPermission", body: { resolution: "yes" }, field: "resolution" },
  { command: "submitSecret", body: {}, field: "value" },
  { command: "reactToMessage", body: {}, field: "emoji" },
  { command: "searchAgents", body: {}, field: "query" },
  { command: "searchMedia", body: {}, field: "query" },

  { command: "deleteAgent", body: {}, field: "id" },
  { command: "deleteAgents", body: {}, field: "ids" },
  { command: "duplicateAgent", body: {}, field: "id" },
  { command: "updateAgent", body: {}, field: "id" },
  { command: "setAgentUnread", body: {}, field: "id" },
  { command: "setAgentNotificationsEnabled", body: {}, field: "id" },
  { command: "setAgentNotifyOnUpdates", body: {}, field: "id" },
  { command: "setAgentHiddenFromSidebar", body: {}, field: "id" },
  { command: "openAgentWindowed", body: {}, field: "id" },
  { command: "openAgentTail", body: {}, field: "id" },

  { command: "kickstartAgent", body: {}, field: "id" },
  { command: "requestDiskSaverAudit", body: {}, field: "id" },
  { command: "createGroup", body: {}, field: "name" },
  { command: "setGroupMembers", body: {}, field: "id" },

  { command: "getAgentMemories", body: {}, field: "id" },
  { command: "deleteAgentMemory", body: {}, field: "id" },
  { command: "clearAgentMemories", body: {}, field: "id" },
  { command: "getAgentAutomations", body: {}, field: "id" },

  { command: "createAgentAutomation", body: {}, field: "id" },
  { command: "createAgentAutomation", body: { id: AGENT }, field: "spec.trigger" },
  { command: "updateAgentAutomation", body: {}, field: "id" },
  { command: "updateAgentAutomation", body: { id: AGENT }, field: "automationId" },
  { command: "updateAgentAutomation", body: { id: AGENT, automationId: "auto-1" }, field: "spec" },
  { command: "deleteAgentAutomation", body: { id: AGENT }, field: "automationId" },
  { command: "runAgentAutomationNow", body: { id: AGENT }, field: "automationId" },
  { command: "setAgentAutomationEnabled", body: { id: AGENT }, field: "automationId" },

  { command: "broadcastToAgents", body: {}, field: "targets" },
  { command: "broadcastToAgents", body: { targets: "all" }, field: "message" },

  { command: "getAgentWorkflows", body: {}, field: "id" },
  { command: "createAgentWorkflow", body: {}, field: "id" },
  { command: "createAgentWorkflow", body: { id: AGENT }, field: "spec" },
  { command: "updateAgentWorkflow", body: {}, field: "id" },
  { command: "updateAgentWorkflow", body: { id: AGENT }, field: "workflowId" },
  { command: "updateAgentWorkflow", body: { id: AGENT, workflowId: "wf-1" }, field: "spec" },
  { command: "setAgentWorkflowEnabled", body: { id: AGENT }, field: "workflowId" },
  { command: "deleteAgentWorkflow", body: { id: AGENT }, field: "workflowId" },
  { command: "runAgentWorkflowNow", body: { id: AGENT }, field: "workflowId" },
  { command: "importAgentWorkflowText", body: {}, field: "id" },
  { command: "importAgentWorkflowText", body: { id: AGENT }, field: "markdown" },
  { command: "importAgentWorkflowUrl", body: {}, field: "id" },
  { command: "importAgentWorkflowUrl", body: { id: AGENT }, field: "url" },
  { command: "portAgentLocalSkills", body: {}, field: "id" },
  { command: "getConversationOutline", body: {}, field: "id" },

  { command: "getAgentChannels", body: {}, field: "id" },
  { command: "connectChannel", body: {}, field: "id" },
  { command: "connectChannel", body: { id: AGENT }, field: "platform" },
  { command: "connectChannel", body: { id: AGENT, platform: "slack" }, field: "token" },
  { command: "disconnectChannel", body: {}, field: "id" },
  { command: "disconnectChannel", body: { id: AGENT }, field: "platform" },
  { command: "refreshChannel", body: {}, field: "id" },
  { command: "getListenerConnectUrl", body: {}, field: "platform" },

  { command: "getSubagents", body: {}, field: "id" },
  { command: "getAsyncTasks", body: {}, field: "id" },
  { command: "setAgentAvatarBytes", body: {}, field: "id" },
  { command: "setAgentAvatarBytes", body: { id: AGENT, pngBase64: 42 }, field: "pngBase64" },
  { command: "getAgentAvatar", body: {}, field: "id" },
  { command: "getCloudAgentInfo", body: {}, field: "bcId" },

  { command: "executeRoutedMcpTool", body: {}, field: "name" },
  { command: "executeRoutedMcpTool", body: { name: "routed" }, field: "toolName" },
  { command: "executeRoutedMcpTool", body: { name: "routed", toolName: "tool" }, field: "providerIdentifier" },
  { command: "setBoxSecrets", body: {}, field: "secrets" },
  { command: "setBoxSecrets", body: { secrets: [] }, field: "secrets" },
];

/** A value each field accepts, so the accepting path can be exercised. */
const COMPLETE = {
  ids: [AGENT],
  secrets: { token: "x" },
  spec: { name: "wf", trigger: { type: "cron" } },
  pngBase64: "iVBORw0KGgo=",
  markdown: "# workflow",
  url: "https://example.test/wf.md",
  resolution: "allow-once",
  query: "probe",
};

/**
 * `resolution` is the one field two commands disagree about: the local-tool
 * permission card answers with one of four words and the auto-review approval
 * card with one of two, and they share the field name. A single fixture value
 * made `resolveAutoReviewApproval` fail its own accepting-path case for a reason
 * that has nothing to do with the field under test.
 */
const COMPLETE_RESOLUTION = {
  resolveLocalToolPermission: "allow-once",
  resolveAutoReviewApproval: "approved",
};

/** Every field a command is known to need, filled with a value it accepts. */
function completeBodyFor(command) {
  const body = {};
  for (const entry of CASES) {
    if (entry.command !== command) continue;
    if (!(entry.field in body)) body[entry.field] = AGENT;
    for (const [key, value] of Object.entries(entry.body)) body[key] = value;
  }
  for (const [field, value] of Object.entries(COMPLETE)) {
    if (field in body) body[field] = value;
  }
  if ("targets" in body) body.targets = ["all"];
  if (COMPLETE_RESOLUTION[command] != null && "resolution" in body) {
    body.resolution = COMPLETE_RESOLUTION[command];
  }
  // `spec.trigger` is named as its own field because that is what the refusal
  // says; on the wire it lives inside `spec`.
  if ("spec" in body || "spec.trigger" in body) body.spec = COMPLETE.spec;
  return body;
}

/**
 * The shapes the real extensions answer with. A double that answers everything
 * with `undefined` would make a later `.length` or `.total` throw for a reason
 * that has nothing to do with the field under test.
 */
const SHAPES = {
  isEnabled: () => true,
  getActiveAgentId: () => AGENT,
  listAgentsSync: () => [],
  getAgentAutomations: () => [],
  createAgentAutomation: () => [],
  getSubagents: () => [],
  getAsyncTasks: () => [],
  getAgentChannels: () => ({ manifests: [], connections: [] }),
  broadcastToAgents: () => ({ total: 0, scheduled: 0 }),
  getAgentTranscript: () => ({ entries: [] }),
  getAgentTranscriptPage: () => ({ entries: [] }),
  getAgentTranscriptWindow: () => ({ entries: [] }),
  getAgentTranscriptTail: () => ({ entries: [] }),
  openAgentWindowed: () => ({ entries: [] }),
  openAgentTail: () => ({ entries: [] }),
  switchAgent: () => ({}),
  searchAgents: () => [],
  searchMedia: () => [],
  cloneAgent: () => ({ agent: { id: AGENT } }),
  // `deleteAgent` chains `.catch` onto this one, so a double that answers
  // `undefined` fails for a reason that has nothing to do with the fields.
  noteAgentDeleted: () => Promise.resolve(),
  createExecutor: (record) => ({ execute: record("execute") }),
};

/**
 * Calls that read the host's state or mark it busy rather than doing the work
 * the command is for. Several commands mark the app active before they check
 * their arguments and two search for `isEnabled` before they read `query`, so an
 * unfiltered record reads as "the extension ran" for a request that never got
 * past the gate.
 */
const READ_ONLY = new Set([
  "markActive",
  "trackEvent",
  "reportMessageSent",
  "reportAgentOpen",
  "noteSandModelExperimentActive",
  "isEnabled",
  "getActiveAgentId",
  "listAgentsSync",
]);

/**
 * An API over extensions that record every call, so a test can tell "the gateway
 * refused before the extension" from "the extension was reached and objected".
 */
function recordingApi() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    if (SHAPES[name] != null) return SHAPES[name](record);
    return undefined;
  };
  const domain = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const analytics = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const logs = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const telemetry = new Proxy({ analytics, logs }, {
    get: (target, name) =>
      typeof name === "symbol" ? Reflect.get(target, name) : name in target ? target[name] : record(String(name)),
  });
  const extensions = {
    api: (id) => (id === "telemetry" ? telemetry : id === "mcp" ? { mcp: domain, listBoxServers: async () => [] } : domain),
  };
  const api = createHostGatewayApi({
    extensions,
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    // `kickstartAgent` and `requestDiskSaverAudit` reach a host dependency rather
    // than an extension. Recorded anyway: an unrecorded call is a call a test
    // cannot see, and "answered 200 without doing anything" is the defect these
    // two were closed for.
    kickstartIfPending: async (agentId) => {
      calls.push({ name: "kickstartIfPending", args: [agentId] });
      return false;
    },
    requestDiskSaverAudit: async (agentId) => {
      calls.push({ name: "requestDiskSaverAudit", args: [agentId] });
      return false;
    },
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
  return { api, calls, domainCalls: () => calls.filter((call) => !READ_ONLY.has(call.name)) };
}

async function post(port, command, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text };
  }
  return { status: response.status, body: parsed };
}

async function withServer(api, run) {
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
  });
  try {
    return await run(server.port);
  } finally {
    await server.close();
  }
}

/** Sentences that name an engine, a module, a file or a syscall instead of a field. */
const INTERNAL_DETAIL =
  /node:|Cannot read propert|must be of type|Received undefined|is not a function|\.ts:\d+|\.js:\d+|at Object\.|SQLITE|EPERM|ENOENT|EACCES|Buffer\._/;

test("the sweep covers the whole argument-taking command surface", () => {
  // A sweep that silently stopped matching would pass on every answer. Two
  // guards: every entry names a command the table really serves, and the entries
  // outnumber the body-taking commands by enough to be a sweep and not a sample.
  const commands = [...new Set(CASES.map((entry) => entry.command))];
  const missing = commands.filter((command) => !Object.hasOwn(SAND_GATEWAY_COMMANDS, command));
  assert.deepEqual(missing, [],
    `these sweep entries name a command the table does not serve, so they would never run: ${missing.join(", ")}`);
  assert.ok(CASES.length >= 60,
    `the sweep was expected to cover the argument-taking surface, found ${CASES.length} cases`);
  const bodyTaking = Object.keys(SAND_GATEWAY_COMMANDS).filter((command) => SAND_GATEWAY_COMMANDS[command].length >= 2);
  assert.ok(commands.length >= bodyTaking.length * 0.4,
    `the sweep reached ${commands.length} of ${bodyTaking.length} commands that take a body`);
  assert.equal(statusForCommandError(new Error("boom")), 500,
    "the status mapping this sweep relies on changed, so a `400` here would prove nothing");
});

test("every command that cannot answer without a field refuses before it acts", async () => {
  const failures = [];
  for (const entry of CASES) {
    const { api, domainCalls } = recordingApi();
    const answer = await withServer(api, (port) => post(port, entry.command, entry.body));
    const message = String(answer.body?.error ?? JSON.stringify(answer.body));
    const label = `${entry.command} ${JSON.stringify(entry.body)}`;

    if (answer.status !== 400) {
      failures.push(`${label} answered ${answer.status}: ${message}`);
    } else if (!message.startsWith(`Malformed ${entry.command} request`)) {
      failures.push(`${label} refused without naming the command: ${message}`);
    } else if (!message.includes(`"${entry.field}"`)) {
      failures.push(`${label} refused without naming "${entry.field}": ${message}`);
    } else if (INTERNAL_DETAIL.test(message)) {
      failures.push(`${label} leaked an internal detail: ${message}`);
    } else if (domainCalls().length > 0) {
      failures.push(`${label} reached ${JSON.stringify(domainCalls().map((call) => call.name))} before being refused`);
    }
  }
  assert.deepEqual(failures, [],
    `these commands answered a request that named nothing instead of refusing it:\n  ${failures.join("\n  ")}`);
});

test("a command with several required fields names all of them at once", async () => {
  // First-field-wins costs the caller a round trip per guess, and it makes the
  // order the checks happen to be written in a contract nobody should depend on.
  const MULTI = [
    { command: "connectChannel", fields: ["id", "platform", "token"] },
    { command: "disconnectChannel", fields: ["id", "platform"] },
    { command: "executeRoutedMcpTool", fields: ["name", "toolName", "providerIdentifier"] },
    { command: "getAgentThread", fields: ["id", "rootId"] },
  ];
  const failures = [];
  for (const entry of MULTI) {
    const { api } = recordingApi();
    const answer = await withServer(api, (port) => post(port, entry.command, {}));
    const message = String(answer.body?.error ?? "");
    if (answer.status !== 400) {
      failures.push(`${entry.command} answered ${answer.status} for {} instead of naming what it needs`);
      continue;
    }
    const unnamed = entry.fields.filter((field) => !message.includes(`"${field}"`));
    if (unnamed.length > 0) {
      failures.push(`${entry.command} refused {} as "${message}" without naming ${unnamed.join(", ")}`);
    }
  }
  assert.deepEqual(failures, [],
    `these commands made the caller guess the rest of the body:\n  ${failures.join("\n  ")}`);
});

test("a command with one required field names only that one", async () => {
  // The other direction: a single-field refusal must not become a list of every
  // field the command touches, or the message stops being about what is wrong.
  const { api } = recordingApi();
  const answer = await withServer(api, (port) => post(port, "deleteAgent", {}));
  const message = String(answer.body?.error ?? "");

  assert.equal(answer.status, 400, `a delete that named no agent answered ${answer.status}`);
  assert.ok(message.includes('"id"'), `the refusal names no field: ${message}`);
  assert.equal((message.match(/"/g) ?? []).length, 2,
    `the refusal names more than the one missing field: ${message}`);
});

test("a command that needs no field is not refused for having none", () => {
  // The other direction. `listAgents` and `countAgents` read no request at all,
  // and `getTranscript` answers about the active conversation when it is given
  // no id — all three are real requests. A gate that refused them would have
  // turned working calls into errors.
  const refused = new Set(CASES.filter((entry) => entry.field === "id").map((entry) => entry.command));
  for (const command of ["listAgents", "countAgents", "getTranscript", "listAllAutomations", "getHostSettings", "getTrays", "getListenerIntegrations"]) {
    assert.ok(!refused.has(command),
      `${command} was added to the refusal sweep, so a request that needs no id is now refused`);
  }
});

test("a request that carries every required field still reaches the extension", async () => {
  const failures = [];
  for (const command of new Set(CASES.map((entry) => entry.command))) {
    const body = completeBodyFor(command);
    const { api, domainCalls } = recordingApi();
    const answer = await withServer(api, (port) => post(port, command, body));
    if (answer.status === 400) {
      failures.push(`${command} refused a complete request: ${answer.body?.error}`);
    } else if (answer.status !== 200) {
      failures.push(`${command} answered ${answer.status} for a complete request: ${JSON.stringify(answer.body)}`);
    } else if (domainCalls().length === 0) {
      failures.push(`${command} answered 200 without reaching an extension, so the gate tightened past its brief`);
    }
  }
  assert.deepEqual(failures, [],
    `the refusals took more than they should have:\n  ${failures.join("\n  ")}`);
});