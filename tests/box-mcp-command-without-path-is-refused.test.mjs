import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * `{"command":"cmd"}` started. Every absolute path in a pushed stdio MCP entry
 * went through `assertRealPathAllowed`, so a script outside the box roots was
 * refused — and `checkMcpLaunchAllowed` in `source/box-exec-daemon/server.ts` then
 * skipped `command` itself, because `"cmd"` is not a path. It resolved through
 * PATH and the daemon started it. `{"command":"node","args":["-e","…"]}` was the
 * same hole one layer down: an inline program is an argument, not a path either.
 * And a token carrying a `..` segment answered `false` to "is this a path?", so
 * `{"command":"node","args":["..\\..\\..\\..\\Users\\me\\.ssh\\id_rsa"]}` skipped
 * the roots check entirely.
 *
 * The daemon answered all three with a normal MCP handshake attempt, so nothing
 * reported a problem. The refusal list the file carried said so honestly, but a
 * comment is not a control: the whole defence rested on one property checked
 * somewhere else — the model cannot write `mcp-servers.json` — and that property
 * is true only while that writer path stays shut.
 *
 * The daemon now requires that a program named by PATH has its script named by
 * path, and refuses a command processor by name. Bare names as such are still
 * allowed, because the user's own file runs `{"command":"node","args":["<box
 * workspace>\\mcp-servers\\…"]}` and breaking that would trade a real hole for a
 * fake one. The tests below drive the real daemon over the real Connect routes:
 * the escape shapes must be refused with a reason that says which rule stopped
 * them, and the two legitimate shapes must still connect.
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
export { McpStateExecArgs } from "./packages/proto/generated/agent/v1/mcp_exec_pb.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-command-refusal-"));
  const outfile = path.join(directory, "box-mcp-command-shim.cjs");
  await build({
    stdin: { contents: SHIM_SOURCE, resolveDir: path.join(repoRoot, "source"), sourcefile: "box-mcp-command-shim.ts", loader: "ts" },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return { shim: createRequire(import.meta.url)(outfile), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const AUTH_TOKEN = "c".repeat(43);
// The server imports `../mcp-stdio-core.mjs`, so the tree is laid out the way the
// real deployment is: the core at the workspace root, the server one folder below.
// Copying the server alone produces ERR_MODULE_NOT_FOUND, which measures the copy
// and not the daemon.
const CORE_RELATIVE = path.join("local-mcp", "mcp-stdio-core.mjs");
const SERVER_RELATIVE = path.join("local-mcp", "servers", "echo-mcp-server.mjs");

let shim;
let disposeShim;
let handle;
let control;
let exec;
let workspaceRoot;
let terminalsDirectory;
let nextId = 1;

/** The echo server, copied in verbatim, at the path the daemon is allowed to run. */
function scriptInside() {
  return path.join(workspaceRoot, "mcp-servers", "echo-mcp-server.mjs");
}

/** `node` under a path inside the roots, so "a program named by path" is testable. */
let nodeInside;
function placeNodeInside() {
  const target = path.join(workspaceRoot, "tools", path.basename(process.execPath));
  mkdirSync(path.dirname(target), { recursive: true });
  // A hard link keeps the path inside the roots without copying 100 MB. `realpath`
  // does not follow a hard link back to its other name, which is the point.
  try {
    linkSync(process.execPath, target);
    return target;
  } catch {
    copyFileSync(process.execPath, target);
    return target;
  }
}

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-command-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-command-terminals-"));
  mkdirSync(path.dirname(scriptInside()), { recursive: true });
  copyFileSync(path.join(repoRoot, SERVER_RELATIVE), scriptInside());
  copyFileSync(path.join(repoRoot, CORE_RELATIVE), path.join(workspaceRoot, "mcp-stdio-core.mjs"));
  nodeInside = placeNodeInside();
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
  for (const directory of [workspaceRoot, terminalsDirectory]) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  disposeShim?.();
});

async function pushServers(servers, removeMissing = true) {
  return await control.loadMcpServers(
    new shim.LoadMcpServersRequest({ mcpConfigJson: JSON.stringify({ mcpServers: servers }), removeMissing }),
  );
}

/** Every server the daemon is currently reporting, by the name the user wrote. */
async function stateOf() {
  const stream = exec.exec(new shim.ExecServerMessage({
    id: nextId++, execId: `exec-${nextId}`,
    message: { case: "mcpStateExecArgs", value: new shim.McpStateExecArgs({ serverIdentifiers: [] }) },
  }));
  const frames = [];
  for await (const element of stream) {
    if (element.element.case === "execClientMessage" && element.element.value.message.case === "mcpStateExecResult") {
      frames.push(element.element.value.message.value.result);
    }
  }
  assert.equal(frames.length, 1, `the daemon answered a listing with ${frames.length} frames instead of one`);
  assert.equal(frames[0].case, "success", `the daemon answered a listing with "${frames[0].case}"`);
  return new Map(frames[0].value.servers.map(server => [server.serverIdentifier, server]));
}

async function pushAndRead(name, entry) {
  const response = await pushServers({ [name]: entry });
  const state = await stateOf();
  return { announced: [...response.loadedServerNames], server: state.get(name) };
}

test("a command that is only a name on PATH is refused, and the reason names the rule", async () => {
  // The shape the debt item names, exactly: a bare name and nothing else.
  const { announced, server } = await pushAndRead("shell", { command: "cmd" });
  assert.deepEqual(announced, [],
    "the daemon announced a command processor as loaded, so the host would show the user's computer as running it");
  assert.equal(server.status, "error", "a refused entry must read as an error, because the host has no other way to show why");
  assert.match(String(server.errorMessage), /command processor/i,
    `the refusal does not say what is wrong with "cmd", so the user cannot fix the file: ${server.errorMessage}`);
});

test("a command processor with a switch on the command line is refused as what it is", async () => {
  const { server } = await pushAndRead("shell-args", { command: "cmd", args: ["/c", "echo owned"] });
  assert.equal(server.status, "error", `cmd with /c was started: ${server.errorMessage}`);
  assert.match(String(server.errorMessage), /command processor/i,
    `the entry was refused, but for the wrong reason, so the user goes and moves their script instead of dropping "cmd": ${server.errorMessage}`);
});

test("a command processor named by full path is refused by name too", async () => {
  const { server } = await pushAndRead("shell-abs", {
    command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    args: ["/c", "echo owned"],
  });
  assert.equal(server.status, "error",
    "naming the command processor by its full path bypassed the refusal, so the rule only covered bare names");
  assert.match(String(server.errorMessage), /command processor/i,
    `the refusal for an absolute command processor is missing: ${server.errorMessage}`);
});

test("an interpreter given an inline program instead of a script is refused", async () => {
  for (const [name, entry] of [
    ["node-inline", { command: "node", args: ["-e", "process.stdout.write('{}')"] }],
    ["python-inline", { command: "python", args: ["-c", "print(1)"] }],
    ["no-args", { command: "node" }],
  ]) {
    const { server } = await pushAndRead(name, entry);
    assert.equal(server.status, "error",
      `"${entry.command}" with no script path was started, so an inline program is still a way out of the roots`);
    assert.match(String(server.errorMessage), /not a path|script/i,
      `the refusal for ${name} does not say the script path is missing: ${server.errorMessage}`);
  }
});

test("an argument that walks out of the roots is caught instead of skipped", async () => {
  const outside = path.join(workspaceRoot, "..", "..", "outside.mjs");
  writeFileSync(outside, "// sits above every root the daemon was given");
  try {
    const relative = path.relative(workspaceRoot, outside);
    const { server } = await pushAndRead("walk-out", { command: "node", args: [relative] });
    assert.equal(server.status, "error",
      "an argument carrying a .. segment skipped the roots check, which is how a path outside the roots was reached");
    assert.match(String(server.errorMessage), /workspace root/i,
      `the refusal for a walking path does not name the roots: ${server.errorMessage}`);
  } finally {
    rmSync(outside, { force: true });
  }
});

test("a legitimate server given a script path still connects", async () => {
  const { announced, server } = await pushAndRead("by-name", { command: "node", args: [scriptInside()] });
  assert.deepEqual(announced, ["by-name"],
    "the daemon refused the shape the user's own file actually uses, which would break working configuration");
  assert.equal(server.status, "connected", `the daemon refused to run a server whose script is inside the roots: ${server.errorMessage}`);
  assert.equal(server.tools.length, 2, "the connected server reports a tool count that does not match the echo server's own listing");
});

test("a legitimate server whose program is named by full path still connects", async () => {
  const { announced, server } = await pushAndRead("by-path", { command: nodeInside, args: [scriptInside()] });
  assert.deepEqual(announced, ["by-path"], "a program named by an absolute path inside the roots was announced as not loaded");
  assert.equal(server.status, "connected", `the daemon refused a program named by path inside the roots: ${server.errorMessage}`);
  assert.equal(server.tools.length, 2, "the server started by absolute path does not serve the echo server's tools");
});

test("a refused entry never publishes the value of env", async () => {
  const secret = "mcp-entry-secret-that-must-not-leak";
  const { server } = await pushAndRead("leaking", {
    command: "cmd",
    args: ["/c", "echo owned"],
    env: { SOME_TOKEN: secret },
  });
  const message = String(server.errorMessage);
  assert.match(message, /refused/i, "the refusal text changed shape, so this test is no longer proving anything about it");
  assert.equal(message.includes(secret), false,
    `the value of env was published to the host through errorMessage: ${message}`);
});