import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The gateway answered a caller's mistake with the text of a V8 engine fault.
 *
 * A measured sweep of the whole command table — 122 commands × sixteen malformed
 * bodies, sent over a real loopback server — found ten commands that answered
 * `500` to a body which parses cleanly and is simply not a request:
 *
 *   `POST /api/dismissWidget null`           500  "Cannot read properties of null (reading 'agentId')"
 *   `POST /api/openAgent null`               500  the same shape, reading 'id'
 *   `POST /api/refreshMcp null`              500  "Cannot destructure property 'completion' of 'object null' as it is null."
 *   `POST /api/setHostSettings null`         500  the same shape
 *
 * plus `createAgent`, `setWindowFocused`, `broadcastToAgents`, `setBoxMigrating`,
 * `resumeBoxAfterRecreate` and `listBoxMcpServers`. `null` is valid JSON, so the
 * parse gate waved it through, and every command that reads a named field then
 * threw one line later. Each message named neither the command nor the body, and
 * each carried the one status that tells a client to retry.
 *
 * This file is the sweep itself, kept as a guard rather than a one-off: it
 * re-sends every malformed body to every command and asserts that nothing
 * answers `500` and that no answer contains an engine sentence, a module name, a
 * filesystem path or a syscall. The two guards at the end keep it from decaying
 * into a pass that proves nothing — one checks the table is still the whole
 * surface, the other checks that the sweep still finds refusals to make.
 *
 * The sweep fails against the pre-fix code on all ten commands above.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// See the note in `gateway-request-error-is-400.test.mjs`: pointing this at a
// copy of `source/` built from `git HEAD` runs these assertions against the
// pre-fix code.
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-v8-sweep-"));
await build({
  stdin: {
    contents: [
      `export { startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { SAND_GATEWAY_COMMANDS } from "./source/host/gateway-protocol.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: sourceRoot,
    sourcefile: "gateway-v8-sweep-entry.ts",
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

/** The shapes the real extensions answer with, so a `500` here is the host's. */
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
  createAgent: () => ({ agent: { id: AGENT } }),
  listTools: () => [],
  noteAgentDeleted: () => Promise.resolve(),
};

function gatewayApi() {
  const record = (name) => (...args) => (SHAPES[name] != null ? SHAPES[name](record) : undefined);
  const domain = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const analytics = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const logs = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const telemetry = new Proxy({ analytics, logs }, {
    get: (target, name) =>
      typeof name === "symbol" ? Reflect.get(target, name) : name in target ? target[name] : record(String(name)),
  });
  const mcp = Object.assign(Object.create(null), {
    mcp: new Proxy({}, { get: (_target, name) => record(String(name)) }),
    management: new Proxy({}, { get: (_target, name) => record(String(name)) }),
    skillPublish: new Proxy({}, { get: (_target, name) => record(String(name)) }),
    syncPluginSkills: record("syncPluginSkills"),
    pluginSyncStatus: record("pluginSyncStatus"),
    listBoxServers: async () => [{ serverIdentifier: "s", status: "ready", toolCount: 0 }],
  });
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => (id === "telemetry" ? telemetry : id === "mcp" ? mcp : domain),
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
  assert.notEqual(typeof api.listAgents, "undefined",
    "the gateway returned no commands at all, so this sweep would be measuring nothing");
  return api;
}

/**
 * Bodies a caller can plausibly send by mistake. `null` is the one the pre-fix
 * host could not survive: it is valid JSON, so the parse gate waved it through.
 */
const BODIES = {
  "{}": {},
  "null": null,
  "[]": [],
  '"text"': "text",
  "42": 42,
  '{"id":42}': { id: 42 },
  '{"id":""}': { id: "" },
  '{"id":[]}': { id: [] },
  '{"id":{}}': { id: {} },
  '{"spec":[]}': { spec: [] },
  '{"spec":{}}': { spec: {} },
  '{"ids":"all"}': { ids: "all" },
  '{"name":{}}': { name: {} },
  '{"targets":42}': { targets: 42 },
  '{"markdown":42}': { markdown: 42 },
  '{"url":42}': { url: 42 },
  '{"pngBase64":42}': { pngBase64: 42 },
};

/**
 * Sentences that name an engine, a module, a filesystem path or a syscall
 * instead of the command and the field the caller has to fix.
 */
const INTERNAL_DETAIL =
  /node:|Cannot read propert|Cannot destructure|must be of type|Received undefined|is not a function|\.ts:\d+|\.js:\d+|at Object\.|at Array\.|SQLITE|EPERM|ENOENT|EACCES|Buffer\._|URI malformed|JSON at position|Unexpected end of JSON|Unterminated string|host extension method is unavailable/;

async function sweep() {
  const server = await startGatewayServer({
    api: gatewayApi(),
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
  });
  const findings = [];
  let refused = 0;
  try {
    for (const command of Object.keys(SAND_GATEWAY_COMMANDS)) {
      for (const [label, body] of Object.entries(BODIES)) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/${command}`, {
          method: "POST",
          headers: { authorization: "Bearer test-token", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        if (response.status === 400 || response.status === 404) refused += 1;
        const why =
          response.status >= 500
            ? `answered ${response.status}`
            : INTERNAL_DETAIL.test(text)
              ? "leaked an internal detail"
              : null;
        if (why != null) findings.push(`${command} sent ${label} ${why}: ${text.slice(0, 160)}`);
      }
    }
  } finally {
    await server.close();
  }
  return { findings, refused, probes: Object.keys(SAND_GATEWAY_COMMANDS).length * Object.keys(BODIES).length };
}

test("the sweep still covers the whole table and still finds refusals to make", async () => {
  const commands = Object.keys(SAND_GATEWAY_COMMANDS);
  assert.ok(commands.length >= 100,
    `the table was expected to carry the whole shipped surface, found ${commands.length} commands`);
  assert.ok(Object.keys(BODIES).length >= 16,
    `the sweep was expected to send the whole malformed-body set, found ${Object.keys(BODIES).length}`);
  assert.ok(commands.includes("deleteAgent") && commands.includes("setBoxSecrets"),
    "the sweep lost two commands it was written against, so it is no longer the same sweep");

  const { refused } = await sweep();
  assert.ok(refused >= 100,
    `the sweep produced only ${refused} refusals across every command and body; a sweep that stops finding anything proves nothing`);
});

test("no command answers a malformed body with a server fault or an internal sentence", async () => {
  const { findings, probes } = await sweep();
  assert.deepEqual(findings, [],
    `these ${probes} probes each sent a caller-caused body to every command:\n  ${findings.join("\n  ")}`);
});