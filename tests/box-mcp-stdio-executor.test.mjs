import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The box could describe an MCP server and never run one. `loadMcpServers` in
 * `source/box-exec-daemon/server.ts` was `async () => new LoadMcpServersResponse()`:
 * it dropped the configuration it was handed on the floor and answered with an
 * empty `loadedServerNames`, so the host pushed a stdio config, was told the push
 * worked, and then discovered nothing.
 *
 * The second defect is in `BoxExecRuntime.execute`. Its `switch` had exactly seven
 * arms — `readArgs`, `redactedReadArgs`, `shellArgs`, `miniSweAgentBashArgs`,
 * `shellStreamArgs`, `backgroundShellSpawnArgs`, `writeShellStdinArgs` — and none
 * of the four MCP arms. Every MCP request fell through to `default:` →
 * `Unsupported ExecServerMessage case`. A live probe of the running box answered
 * `POST /api/listBoxMcpServers {"serverIdentifiers":[]}` with HTTP 500
 * `{"error":"Unsupported ExecServerMessage case: mcpStateExecArgs"}`, and
 * `POST /api/listRoutedMcpTools` with `[]`. Nothing else reported a problem,
 * because the stub returned a success and the throw was swallowed into a control
 * frame the caller turns into a 500.
 *
 * The tests below start the daemon from source, push a configuration that names
 * real stdio servers out of `local-mcp/servers/`, and drive them through the same
 * Connect routes and the same protobuf messages the host uses. No transport is
 * mocked and no stub is injected: the daemon spawns the server, the server is a
 * byte-for-byte copy of the repository file, and the answer comes back from a
 * process this machine started.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One bundle carrying the daemon plus the generated Connect client and messages.
 *
 * CommonJS on purpose, like `tests/box-exec-daemon-token-not-published.test.mjs`:
 * Connect and the protobuf runtime reach for Node built-ins through `require`,
 * which an ESM bundle cannot serve. The `stdin` entry point is how a test reaches
 * the generated modules with no shared loader — the daemon module itself exports
 * only the daemon.
 */
const SHIM_SOURCE = `
export { startBoxExecDaemon } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { Value } from "@bufbuild/protobuf";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ControlService } from "./packages/proto/generated/agent/v1/control_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { LoadMcpServersRequest } from "./packages/proto/generated/agent/v1/control_service_pb.js";
export { McpArgs, McpStateExecArgs, ListMcpResourcesExecArgs, ReadMcpResourceExecArgs } from "./packages/proto/generated/agent/v1/mcp_exec_pb.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-mcp-executor-"));
  const outfile = path.join(directory, "box-mcp-shim.cjs");
  await build({
    stdin: {
      contents: SHIM_SOURCE,
      resolveDir: path.join(repoRoot, "source"),
      sourcefile: "box-mcp-shim.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return {
    shim: createRequire(import.meta.url)(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Repository-relative files that are copied into the sandbox before any server runs. */
const SERVER_SOURCES = [
  path.join("local-mcp", "mcp-stdio-core.mjs"),
  path.join("local-mcp", "servers", "echo-mcp-server.mjs"),
  path.join("local-mcp", "servers", "graphite-notes-mcp-server.mjs"),
];

/**
 * The `local-mcp/` tree is mirrored, not flattened.
 *
 * The servers import `../mcp-stdio-core.mjs` relative to themselves, so a flattened
 * copy fails with `ERR_MODULE_NOT_FOUND` and the file would be measuring the wrong
 * failure. Mirroring is what makes the copy the same program the user runs.
 */
const SANDBOX_PREFIX = path.join("sandbox", "local-mcp");
const insideSandbox = relative => path.join(workspaceRoot, SANDBOX_PREFIX, relative.slice("local-mcp".length + 1));

const AUTH_TOKEN = "m".repeat(43);

let shim;
let disposeShim;
let handle;
let control;
let exec;
let workspaceRoot;
let terminalsDirectory;
let vault;
let nextId = 1;

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-box-mcp-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-box-mcp-terminals-"));
  vault = mkdtempSync(path.join(os.tmpdir(), "grok-box-mcp-vault-"));
  // The daemon refuses a script that sits outside the roots it was given, so the
  // servers are copied in verbatim. The first test asserts byte equality, which is
  // what stops this from quietly becoming a different program.
  for (const relative of SERVER_SOURCES) {
    const target = insideSandbox(relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, relative), target);
  }
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
  await handle?.stop();
  for (const directory of [workspaceRoot, terminalsDirectory, vault]) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  disposeShim?.();
});

/** Pushes a configuration the way `tools-discovery.ts` does. */
async function pushServers(servers, removeMissing = true) {
  return await control.loadMcpServers(
    new shim.LoadMcpServersRequest({ mcpConfigJson: JSON.stringify({ mcpServers: servers }), removeMissing }),
  );
}

/** Sends one `ExecServerMessage` and collects the frames the daemon streams back. */
async function drive(message) {
  const frames = [];
  const stream = exec.exec(new shim.ExecServerMessage({ id: nextId++, execId: `exec-${nextId}`, message }));
  for await (const element of stream) {
    if (element.element.case === "execClientMessage") {
      frames.push({ kind: "result", case: element.element.value.message.case, value: element.element.value.message.value });
    } else if (element.element.case === "execClientControlMessage" && element.element.value.message.case === "throw") {
      frames.push({ kind: "throw", value: element.element.value.message.value });
    }
  }
  return frames;
}

/** The one result frame, or a failure naming what the daemon said instead. */
async function resultOf(message) {
  const frames = await drive(message);
  const failure = frames.find(frame => frame.kind === "throw");
  assert.equal(failure, undefined, `the daemon refused the request instead of answering it: ${failure?.value?.error}`);
  assert.equal(frames.length, 1, "the daemon streamed more than one answer to a single request");
  return frames[0];
}

const mcpStateArgs = serverIdentifiers => ({ case: "mcpStateExecArgs", value: new shim.McpStateExecArgs({ serverIdentifiers }) });

const echoServer = () => ({ command: "node", args: [insideSandbox(path.join("local-mcp", "servers", "echo-mcp-server.mjs"))] });
const graphiteServer = vaultPath => ({
  command: "node",
  args: [insideSandbox(path.join("local-mcp", "servers", "graphite-notes-mcp-server.mjs"))],
  env: { GRAPHITE_VAULT: vaultPath },
});

test("the servers the daemon copies out of the repository are the servers it runs", () => {
  for (const relative of SERVER_SOURCES) {
    assert.deepEqual(
      readFileSync(insideSandbox(relative)),
      readFileSync(path.join(repoRoot, relative)),
      `the sandboxed copy of ${relative} differs from the repository file, so this file would be testing a different program than the one a user runs`,
    );
  }
});

test("loading a configuration reports the servers it actually connected", async () => {
  const response = await pushServers({ echo: echoServer() });
  assert.deepEqual(
    [...response.loadedServerNames].sort(),
    ["echo"],
    "the daemon answered a push with no server names, which is how the host is told a configured server is fine while nothing is running",
  );
});

test("the daemon answers a tool listing with the status and the tool count the host displays", async () => {
  await pushServers({ echo: echoServer() });
  const frame = await resultOf(mcpStateArgs(["echo"]));
  assert.equal(frame.case, "mcpStateExecResult", "the daemon answered a listing with the wrong message arm");
  const state = frame.value.result;
  assert.equal(state.case, "success", `the daemon answered a listing with "${state.case}" instead of the servers it is running`);
  const [server] = state.value.servers;
  assert.equal(server.errorMessage, undefined, `the daemon could not run the server it was configured with: ${server.errorMessage}`);
  assert.equal(server.serverIdentifier, "echo",
    "the identifier the host filters on is the name the user wrote in the configuration, not a synthesized one");
  assert.equal(server.status, "connected", "the host shows this status verbatim, so anything else reads as a broken connector");
  assert.equal(server.tools.length, 2,
    "the daemon reported a tool count that does not match what the running server advertises over MCP");
});

test("a tool call reaches the running server and comes back with the server's own answer", async () => {
  await pushServers({ graphite: graphiteServer(vault) });
  const created = await resultOf({
    case: "mcpArgs",
    value: new shim.McpArgs({
      name: "graphite-create_note",
      toolName: "create_note",
      serverIdentifier: "graphite",
      providerIdentifier: "graphite",
      toolCallId: "call-1",
      args: { title: shim.Value.fromJson("Shopping"), body: shim.Value.fromJson("buy milk") },
    }),
  });
  assert.equal(created.case, "mcpResult", "the daemon answered a tool call with the wrong message arm");
  assert.equal(created.value.result.case, "success",
    `the daemon reported "${created.value.result.case}" for a tool the running server implements`);
  assert.equal(created.value.result.value.isError, false, "the server accepted the note and the daemon called it an error");

  // Reading it back through a second call proves the daemon is talking to a live
  // process with live state, not replaying a cached answer.
  const listed = await resultOf({
    case: "mcpArgs",
    value: new shim.McpArgs({
      name: "graphite-search_notes",
      toolName: "search_notes",
      serverIdentifier: "graphite",
      providerIdentifier: "graphite",
      toolCallId: "call-2",
      args: { query: shim.Value.fromJson("milk") },
    }),
  });
  const text = listed.value.result.value.content.map(item => item.content.value.text).join("\n");
  assert.match(text, /Shopping/,
    `the note the daemon just created did not come back from the server; the server answered: ${text}`);
});

test("the echo server's arithmetic proves the arguments reached the tool unmangled", async () => {
  await pushServers({ echo: echoServer() });
  const frame = await resultOf({
    case: "mcpArgs",
    value: new shim.McpArgs({
      name: "echo-add",
      toolName: "add",
      serverIdentifier: "echo",
      providerIdentifier: "echo",
      toolCallId: "call-3",
      args: { a: shim.Value.fromJson(19), b: shim.Value.fromJson(23) },
    }),
  });
  const text = frame.value.result.value.content.map(item => item.content.value.text).join("");
  assert.equal(text, "42", "the numeric arguments did not survive the trip through the protobuf Value map into the tool");
});

test("a tool the running server does not implement is named, not thrown", async () => {
  await pushServers({ echo: echoServer() });
  const frame = await resultOf({
    case: "mcpArgs",
    value: new shim.McpArgs({
      name: "echo-nope",
      toolName: "nope",
      serverIdentifier: "echo",
      providerIdentifier: "echo",
      toolCallId: "call-4",
      args: {},
    }),
  });
  assert.equal(frame.value.result.case, "toolNotFound",
    "an unknown tool produced a generic failure instead of naming the tools the server does have");
  assert.deepEqual([...frame.value.result.value.availableTools].sort(), ["add", "echo"],
    "the daemon cannot tell the model which tools do exist, so the model has no way to correct itself");
});

test("a server whose script sits outside the box roots is refused with a status, not a crash", async () => {
  const response = await pushServers({
    outside: { command: "node", args: [path.join(repoRoot, "local-mcp", "servers", "echo-mcp-server.mjs")] },
  });
  assert.deepEqual([...response.loadedServerNames], [],
    "the daemon announced a server it must not run as loaded, so the host would show it as connected");
  const frame = await resultOf(mcpStateArgs(["outside"]));
  assert.equal(frame.value.result.case, "success", "the daemon answered a refused server by failing the whole listing");
  const [server] = frame.value.result.value.servers;
  assert.equal(server.status, "error", "a refused server must read as an error, because the host has no other way to show why");
  assert.equal(server.tools.length, 0, "a refused server advertised tools it cannot possibly serve");
  assert.match(String(server.errorMessage), /workspace root/i,
    `the reason the daemon gave does not tell the user which restriction stopped it: ${server.errorMessage}`);
});

test("one refused server does not take the servers beside it down", async () => {
  await pushServers({
    outside: { command: "node", args: [path.join(repoRoot, "local-mcp", "servers", "echo-mcp-server.mjs")] },
    echo: echoServer(),
  });
  const frame = await resultOf(mcpStateArgs([]));
  assert.equal(frame.value.result.case, "success", "one bad entry took the whole listing down instead of being reported per server");
  const byName = new Map(frame.value.result.value.servers.map(server => [server.serverIdentifier, server]));
  assert.equal(byName.get("outside").status, "error", "the entry outside the roots was not reported as refused");
  assert.equal(byName.get("echo").status, "connected",
    "a valid server next to a refused one was taken down with it, which makes one bad config entry look like a broken install");
});

test("a server removed from the configuration stops being reported", async () => {
  await pushServers({ echo: echoServer() });
  await pushServers({}, true);
  const frame = await resultOf(mcpStateArgs([]));
  assert.deepEqual(
    frame.value.result.value.servers.map(server => server.serverIdentifier),
    [],
    "a server the user deleted from the configuration is still being reported, so the host lists a server that no longer exists",
  );
});

test("the resource routes answer with what the server has, instead of an unsupported-case throw", async () => {
  await pushServers({ echo: echoServer() });
  const listed = await resultOf({ case: "listMcpResourcesExecArgs", value: new shim.ListMcpResourcesExecArgs({ server: "echo" }) });
  assert.equal(listed.case, "listMcpResourcesExecResult", "the daemon answered a resource listing with the wrong message arm");
  assert.equal(listed.value.result.case, "success",
    "a server that simply exposes no resources must still answer with an empty list, or the host cannot tell that apart from a broken route");

  const read = await resultOf({
    case: "readMcpResourceExecArgs",
    value: new shim.ReadMcpResourceExecArgs({ server: "echo", uri: "notes://missing", toolCallId: "call-5" }),
  });
  assert.equal(read.case, "readMcpResourceExecResult", "the daemon answered a resource read with the wrong message arm");
  assert.ok(read.value.result.case === "notFound" || read.value.result.case === "error",
    `a missing resource was reported as "${read.value.result.case}", which tells the model nothing about why the read failed`);
});

test("a value the user put in env never reaches the host through an error message", async () => {
  // A vault that does not exist makes the server print the path to stderr and exit.
  // The token is not a vault, but the mechanism is the one under test: whatever the
  // child writes to stderr is quoted back to the host, and `env` is the only place a
  // secret can come from.
  const secret = "graphite-secret-token-do-not-print";
  const response = await pushServers({ leaking: graphiteServer(path.join(vault, secret)) });
  assert.deepEqual([...response.loadedServerNames], [],
    "a server that cannot start was announced as loaded, so the host would show it as connected");
  const frame = await resultOf(mcpStateArgs(["leaking"]));
  assert.equal(frame.value.result.value.servers[0].status, "error", "the daemon did not report the failed start");
  const message = String(frame.value.result.value.servers[0].errorMessage);
  assert.equal(message.includes(secret), false,
    `the value of env was published to the host through errorMessage: ${message}`);
});