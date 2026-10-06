import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * `listRoutedMcpTools` published a tool and `executeRoutedMcpTool` could not run
 * it. The two commands are a pair: the listing is the only thing a caller has,
 * and the natural call is to hand a row back to the execution command. Every row
 * the listing produces carries `name` and `toolName`, and `executeRoutedMcpTool`
 * swapped them on the way in:
 *
 *     name: args.toolName, toolName: args.name
 *
 * The swap is not a typo in a dead field. It is load-bearing for HTTP servers —
 * `tools-discovery.ts:401-408` sends `toolName: args.name` to the backend — and
 * it is wrong for stdio servers, because the box resolves a tool by the bare
 * name the MCP server advertises (`server.ts:958`,
 * `live.tools.find(entry => entry.name === toolName)`) and `live.tools` holds
 * bare names while `listRoutedMcpTools` publishes the prefixed ones
 * (`server.ts:926`, `name: \`${live.name}-${tool.name}\``). So the listing hands
 * out `<server>-<tool>` and the daemon is asked for `<server>-<tool>`.
 *
 * Nothing reported it. Discovery succeeds, the listing is non-empty, and the
 * failure only appears at call time as `toolNotFound` naming tools the caller
 * was just shown.
 *
 * These tests run the whole chain — `createHostGatewayApi`, `createHostMcp`,
 * `createMcpToolsDiscovery`, `SandMcpExecutor` — against a real
 * `BoxExecRuntime` started from `source/box-exec-daemon/server.ts`, which spawns
 * a real stdio MCP server copied verbatim out of `local-mcp/servers/`. Nothing
 * on the path is faked except the Connect transport, which is the product's own
 * `BoxMcpExecPort` seam.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHIM_SOURCE = `
export { startBoxExecDaemon } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { Value } from "@bufbuild/protobuf";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ControlService } from "./packages/proto/generated/agent/v1/control_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { LoadMcpServersRequest } from "./packages/proto/generated/agent/v1/control_service_pb.js";
export { McpArgs, McpStateExecArgs } from "./packages/proto/generated/agent/v1/mcp_exec_pb.js";
export { createHostMcp } from "./host/extensions/mcp/mcp-service.js";
export { createHostGatewayApi } from "./host/host-gateway-api.js";
export { createBoxSandMcpExec } from "./host/extensions/mcp/box-mcp-exec.js";
export { RemoteResourceAccessor } from "./packages/agent-exec/resource-provider.js";
export { localMcpServerIdForName } from "./shared/node/mcp/local-mcp-config-provider.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-routed-mcp-"));
  const outfile = path.join(directory, "routed-mcp-shim.cjs");
  await build({
    stdin: { contents: SHIM_SOURCE, resolveDir: path.join(repoRoot, "source"), sourcefile: "routed-mcp-shim.ts", loader: "ts" },
    outfile,
    bundle: true,
    format: "cjs",
    mainFields: ["module", "main"],
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return { shim: createRequire(import.meta.url)(outfile), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const SERVER_SOURCES = [
  path.join("local-mcp", "mcp-stdio-core.mjs"),
  path.join("local-mcp", "servers", "echo-mcp-server.mjs"),
];

/**
 * A stdio MCP server whose tool names are hostile.
 *
 * These are names an MCP server is allowed to advertise and that no schema in the
 * product constrains: a path, an HTML tag, a prototype key, an empty string, a
 * name made only of whitespace, and a 300-character name. Written here rather
 * than added to the repository because the repository ships no such server, and a
 * server that ships would be a permanent invitation to the next sweep.
 */
const HOSTILE_SERVER_SOURCE = `
import { serveStdio } from "../mcp-stdio-core.mjs";
serveStdio({
  name: "hostile",
  version: "1.0.0",
  tools: [
    { name: "../../etc/passwd", description: "A tool named like a path.", inputSchema: { type: "object", properties: {} } },
    { name: "<script>alert(1)</script>", description: "A tool named like markup.", inputSchema: { type: "object", properties: {} } },
    { name: "__proto__", description: "A tool named like a prototype key.", inputSchema: { type: "object", properties: {} } },
    { name: "", description: "A tool with an empty name.", inputSchema: { type: "object", properties: {} } },
    { name: "   ", description: "A tool whose name is only whitespace.", inputSchema: { type: "object", properties: {} } },
    { name: "x".repeat(300), description: "A tool with a very long name.", inputSchema: { type: "object", properties: {} } },
    { name: "boom", description: "A tool that always fails.", inputSchema: { type: "object", properties: {} } },
  ],
  onCall(toolName) {
    if (toolName.endsWith("boom")) throw new Error("this tool is broken on purpose");
    return "ok";
  },
});
`;

const AUTH_TOKEN = "r".repeat(43);
const SANDBOX_PREFIX = path.join("sandbox", "local-mcp");

let shim;
let disposeShim;
let handle;
let control;
let exec;
let workspaceRoot;
let terminalsDirectory;
let configDir;
let configFile;
let configHashBefore;
let configStatBefore;
let nextId = 1;

const insideSandbox = relative => path.join(workspaceRoot, SANDBOX_PREFIX, relative.slice("local-mcp".length + 1));

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-routed-mcp-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-routed-mcp-terminals-"));
  configDir = mkdtempSync(path.join(os.tmpdir(), "grok-routed-mcp-config-"));
  for (const relative of SERVER_SOURCES) {
    const target = insideSandbox(relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, relative), target);
  }
  const hostilePath = insideSandbox(path.join("local-mcp", "servers", "hostile-mcp-server.mjs"));
  mkdirSync(path.dirname(hostilePath), { recursive: true });
  writeFileSync(hostilePath, HOSTILE_SERVER_SOURCE, "utf8");

  configFile = path.join(configDir, "mcp-servers.json");
  const servers = {
    echo: { command: "node", args: [insideSandbox(path.join("local-mcp", "servers", "echo-mcp-server.mjs"))] },
    hostile: { command: "node", args: [hostilePath] },
    // Configured but unreachable: a program name that resolves through PATH and
    // is not an MCP server at all, so the daemon connects, fails, and reports.
    broken: { command: "node", args: [insideSandbox(path.join("local-mcp", "servers", "does-not-exist.mjs"))] },
  };
  writeFileSync(configFile, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
  configHashBefore = createHash("sha256").update(readFileSync(configFile)).digest("hex");
  configStatBefore = statSync(configFile);

  process.env.GROKBOT_LOCAL_MCP_CONFIG = configFile;

  handle = await shim.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: AUTH_TOKEN, port: 0 });
  const transport = shim.createConnectTransport({
    baseUrl: handle.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  control = shim.createClient(shim.ControlService, transport, { transport });
  exec = shim.createClient(shim.ExecService, transport, { transport });
});

test.after(async () => {
  delete process.env.GROKBOT_LOCAL_MCP_CONFIG;
  await handle?.stop();
  for (const directory of [workspaceRoot, terminalsDirectory, configDir]) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  disposeShim?.();
});

/**
 * The product's own box port, built over the same Connect transport the daemon
 * serves. `createBoxSandMcpExec` is the shipped implementation, not a double, so
 * everything between `tools-discovery.ts` and the box process — the argument
 * encoding, the serializer, the error wrapping — is the code under test.
 */
function boxMcpExecPort() {
  const accessor = new shim.RemoteResourceAccessor({
    createExecInstance: async function* (_ctx, createMessage) {
      const stream = exec.exec(createMessage(nextId++));
      for await (const element of stream) {
        if (element.element.case === "execClientMessage") yield element.element.value;
      }
    },
  });
  return shim.createBoxSandMcpExec({
    loadMcpServers: async (_ctx, configJson) =>
      await control.loadMcpServers(new shim.LoadMcpServersRequest({ mcpConfigJson: configJson, removeMissing: true })),
    mcpResourceAccessor: async () => accessor,
  });
}

/** The whole host-side chain, built the way `production-provider.ts` builds it. */
function buildGateway(settingsStore, makeBoxPort) {
  const hostMcp = shim.createHostMcp({
    backendMcpExec: { listTools: async () => [], executeTool: async () => { throw new Error("no backend in this test"); } },
    boxMcpExec: makeBoxPort == null ? boxMcpExecPort() : makeBoxPort(),
    ...(settingsStore === undefined ? {} : { settingsStore }),
    getMachineId: async () => "machine-1",
    getAccessToken: async () => null,
    log: () => {},
  });
  const api = shim.createHostGatewayApi({
    extensions: { api: (id) => (id === "mcp" ? { mcp: hostMcp.mcp } : {}) },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
  return { api, hostMcp };
}

const contentText = result => {
  const root = result?.result;
  if (root?.case !== "success") return "";
  return (root.value.content ?? []).map(item => item?.content?.value?.text ?? "").join("");
};

test("a tool the listing published can be executed by handing that row back", async () => {
  const { api } = buildGateway();
  const tools = await api.listRoutedMcpTools();
  const row = tools.find(tool => tool.toolName === "add" && tool.providerIdentifier === "echo");
  assert.ok(row, `the listing published no add tool for the echo server: ${JSON.stringify(tools)}`);
  const result = await api.executeRoutedMcpTool({ ...row, args: { a: 19, b: 23 } });
  assert.equal(result?.result?.case, "success",
    `the listing published a tool that execution refused: ${JSON.stringify(result?.result?.value ?? result)}`);
  assert.equal(contentText(result), "42", "the arithmetic did not survive the round trip");
});

test("a tool the user disabled is refused by the routed command, not only by the listing", async () => {
  const disabledFor = {};
  const { api } = buildGateway({
    migrateMcpCustomInstructionToServerId: () => {},
    setMcpCustomInstructionByServerId: () => {},
    getMcpDisabledToolsByServerId: () => disabledFor,
    setMcpDisabledToolsByServerId: () => {},
    getMcpCustomInstructions: () => ({}),
    getMcpCustomInstructionsByServerId: () => ({}),
    getRawMcpCustomInstructionByServerId: () => undefined,
    getRawMcpCustomInstruction: () => undefined,
  });
  const tools = await api.listRoutedMcpTools();
  const row = tools.find(tool => tool.toolName === "add" && tool.providerIdentifier === "echo");
  const kept = tools.find(tool => tool.toolName === "echo" && tool.providerIdentifier === "echo");
  assert.ok(row && kept, "the listing published neither echo tool");
  // The listing is filtered by `tool.toolName` (`tools-discovery.ts:132`), so the
  // disabled name must be the bare one for the two to agree.
  disabledFor[echoServerId()] = ["add"];
  const after = await api.listRoutedMcpTools();
  assert.equal(after.some(tool => tool.toolName === "add" && tool.providerIdentifier === "echo"), false,
    "the listing still publishes a disabled tool, so this test would prove nothing about the execution path");
  const result = await api.executeRoutedMcpTool({ ...row, args: { a: 1, b: 2 } });
  assert.equal(result?.result?.case, "error",
    "a tool the user turned off is still executable through the routed command, so the toggle only hides the tool instead of refusing it");
  const allowed = await api.executeRoutedMcpTool({ ...kept, args: { message: "still here" } });
  assert.equal(allowed?.result?.case, "success",
    `disabling one tool refused a different tool: ${JSON.stringify(allowed?.result?.value ?? allowed)}`);
});

/** The display-row id the settings store keys per-server preferences on. */
function echoServerId() {
  // `getMcpDisabledToolsByServerId` is keyed by the display row id, which for a
  // local stdio server is the hashed identifier from `localMcpServerIdForName`.
  return shim.localMcpServerIdForName("echo");
}

test("a tool call carrying no arguments at all still reaches the tool", async () => {
  const { api } = buildGateway();
  const tools = await api.listRoutedMcpTools();
  const row = tools.find(tool => tool.toolName === "add" && tool.providerIdentifier === "echo");
  assert.ok(row, "the listing published no add tool for the echo server");
  // No `args` key at all — not `args: {}`. The daemon still has to build the tool
  // arguments, the server still has to see a call, and the server's own complaint
  // is the only evidence that it got one.
  const result = await api.executeRoutedMcpTool({ name: row.name, toolName: row.toolName, providerIdentifier: row.providerIdentifier });
  const detail = JSON.stringify(result?.result?.value ?? result);
  assert.match(detail, /finite numbers/,
    `a call with no arguments never reached the tool, so the tool's own refusal is missing: ${detail}`);
});

test("a tool whose own implementation fails reports that failure, not a routing one", async () => {
  const { api } = buildGateway();
  const tools = await api.listRoutedMcpTools();
  const row = tools.find(tool => tool.toolName === "boom" && tool.providerIdentifier === "hostile");
  assert.ok(row, `the listing published no boom tool: ${JSON.stringify(tools.map(t => [t.providerIdentifier, t.toolName]))}`);
  const result = await api.executeRoutedMcpTool({ ...row, args: {} });
  const detail = JSON.stringify(result?.result?.value ?? result);
  assert.match(detail, /broken on purpose/,
    `a tool that threw on purpose did not report its own error, so a broken tool is indistinguishable from a broken route: ${detail}`);
  assert.doesNotMatch(detail, /toolNotFound/,
    "a failing tool was reported as a missing one, which sends the caller looking for a tool that exists");
});

test("a server that is configured but cannot start is published honestly", async () => {
  const { api } = buildGateway();
  const tools = await api.listRoutedMcpTools();
  const broken = tools.filter(tool => tool.providerIdentifier === "broken");
  assert.deepEqual(broken, [], "a server that never started advertised tools");
});

test("hostile tool names survive the listing and the execution path", async () => {
  const { api } = buildGateway();
  const tools = await api.listRoutedMcpTools();
  const hostile = tools.filter(tool => tool.providerIdentifier === "hostile");
  assert.equal(hostile.length, 7, `the listing published ${hostile.length} of the 7 tools the server advertises`);
  for (const row of hostile) {
    if (row.toolName.length === 0) continue; // Its own test, below.
    const result = await api.executeRoutedMcpTool({ ...row, args: {} });
    assert.equal(result?.result?.case, "success",
      `the tool named ${JSON.stringify(row.name)} could not be executed: ${JSON.stringify(result?.result?.value ?? result)}`);
  }
});

test("a server advertising a zero-length tool name produces a row the pair cannot execute", async () => {
  const { api } = buildGateway();
  const tools = await api.listRoutedMcpTools();
  const row = tools.find(tool => tool.providerIdentifier === "hostile" && tool.toolName === "");
  assert.ok(row,
    "the listing dropped the zero-length tool name instead of publishing it, which would leave this asymmetry unmeasured");
  await assert.rejects(
    () => api.executeRoutedMcpTool({ ...row, args: {} }),
    (error) => {
      assert.equal(error?.name, "SandGatewayRequestError",
        `a malformed request came back as ${error?.name}, so the caller cannot tell a refusal from a broken server`);
      assert.match(String(error?.message), /"toolName"/,
        `the refusal names no field, so a caller holding seven fields cannot tell which one to fix: ${error?.message}`);
      return true;
    },
  );
});

test("a box that fails the call answers with that failure, even with no toolCallId", async () => {
  const tools = await (async () => {
    const { api } = buildGateway();
    return await api.listRoutedMcpTools();
  })();
  const row = tools.find(tool => tool.toolName === "add" && tool.providerIdentifier === "echo");
  assert.ok(row, "the listing published no add tool for the echo server");

  // The box accepts the configuration push and then goes away, which is the one
  // shape that reaches `createBoxSandMcpExec.executeTool`'s own catch block.
  const { api } = buildGateway(undefined, () => shim.createBoxSandMcpExec({
    loadMcpServers: async () => [],
    mcpResourceAccessor: async () => { throw new Error("the box is not reachable"); },
  }));
  const result = await api.executeRoutedMcpTool({ ...row, args: { a: 1, b: 2 } });
  assert.equal(result?.result?.case, "error",
    "a box that cannot take the call produced no error result, so the failure escaped as an exception instead of an answer");
  assert.match(JSON.stringify(result?.result?.value), /not reachable/,
    `the failure the box reported was replaced, so the user is told nothing about why: ${JSON.stringify(result?.result?.value)}`);
});

test("the user's own MCP configuration file is never written", () => {
  const after = statSync(configFile);
  const hashAfter = createHash("sha256").update(readFileSync(configFile)).digest("hex");
  assert.equal(hashAfter, configHashBefore,
    "listing and executing routed MCP tools rewrote %LOCALAPPDATA%\\GrokBotLocalBox\\mcp-servers.json, which is the only thing keeping a local MCP entry out of the model's reach");
  assert.equal(after.mtimeMs, configStatBefore.mtimeMs,
    "the configuration file was rewritten with identical content, which still proves a writer exists");
  assert.equal(existsSync(path.join(configDir, "mcp-servers.json.tmp")), false, "a writer left a temporary file beside the configuration");
});