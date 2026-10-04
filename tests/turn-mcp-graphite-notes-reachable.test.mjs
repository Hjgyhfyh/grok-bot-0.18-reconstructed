import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * An agent configured with its own Graphite notes server could not call it, and
 * nothing in the product said so.
 *
 * The whole MCP stack around the server was already working and had been proved
 * live: the box spawned the stdio process, `POST /api/listRoutedMcpTools`
 * answered with six `graphite-*` descriptors and their schemas, and
 * `GetMcpServerStatus` reported `connected`. The turn path read a different
 * projection, `getToolsForTurnStart`
 * (`source/shared/node/mcp/tools-discovery.ts:435`), and that one only ever
 * *sampled* a cache instead of resolving it:
 *
 *   - with a cold cache it called `startToolsResolution(key, true)` and then
 *     immediately read that same call's own empty result, so it answered `[]` on
 *     the first turn — and no turn ever warmed the cache, because only the
 *     settings surface and the routed listing awaited a resolution;
 *   - with no account configuration it returned `[]` before even looking, and
 *     `undefined` there means "the account's servers are unknown", not "there are
 *     no servers" — a stdio server from the user's own file is known without any
 *     account read.
 *
 * An empty list is not a degraded capability, it is the absence of the feature:
 * `createTurnMcpMetaToolFactory` (`turn-toolset.ts:908`) builds the
 * discovery/call pair only from a non-empty descriptor list, so the turn carried
 * neither `GetMcpTools` nor `CallMcpTool`; `resolveSandToolCapabilities`
 * (`system-prompt.ts:158`) then read `mcpTools: false` and the prompt stopped
 * naming them, so the model never went looking. The agent reported exactly that
 * to the user while the server it could not see was running.
 *
 * The tests below close the loop with nothing mocked. The box daemon is started
 * from source, the `graphite` server it runs is a byte-for-byte copy of
 * `local-mcp/servers/graphite-notes-mcp-server.mjs`, the host MCP service is the
 * real `createHostMcp` reading the real local-configuration file, the toolset is
 * built by the real turn factory, and the last test proves the claim the user
 * actually made — that an agent has a personal notes store it reaches over MCP —
 * by executing the real `CallMcpTool` and reading the resulting markdown file off
 * disk.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NOTE_TITLE = "Заметка агента";
const NOTE_FOLDER = "Входящие";
const NOTE_BODY = "Агент обязан иметь свою личную graphite, чтобы не забывать важные вещи.";
const AGENT_ID = "agent-graphite-proof";

/**
 * One bundle carrying the daemon, the generated Connect client and messages, the
 * host MCP service, the turn toolset factory and the prompt resolver.
 *
 * CommonJS on purpose, like `tests/box-mcp-stdio-executor.test.mjs`: Connect and
 * the protobuf runtime reach for Node built-ins through `require`, which an ESM
 * bundle cannot serve. A single bundle also keeps `mcpExecutorResource.symbol`
 * identical to the one the turn factory resolves against.
 */
const SHIM_SOURCE = `
export { startBoxExecDaemon } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { ControlService } from "./packages/proto/generated/agent/v1/control_service_connect.js";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { LoadMcpServersRequest } from "./packages/proto/generated/agent/v1/control_service_pb.js";
export { createHostMcp } from "./host/extensions/mcp/mcp-service.js";
export { createBoxSandMcpExec } from "./host/extensions/mcp/box-mcp-exec.js";
export { createTurnMcpMetaToolFactory, liveMcpToolsForTurn } from "./host/runner/tools/turn-toolset.js";
export { resolveSandToolCapabilities, buildSandBaseSystemPrompt } from "./host/runner/system-prompt.js";
export { unavailableToolNames } from "./host/runner/system-prompt-assembly.js";
export { createContext } from "./packages/context/core.js";
export { loggerKey } from "./packages/context/logger.js";
export { mcpExecutorResource, mcpStateExecutorResource } from "./packages/agent-exec/mcp.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-turn-mcp-graphite-"));
  const outfile = path.join(directory, "turn-mcp-graphite-shim.cjs");
  await build({
    stdin: {
      contents: SHIM_SOURCE,
      resolveDir: path.join(repoRoot, "source"),
      sourcefile: "turn-mcp-graphite-shim.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    // `jsonc-parser`'s UMD entry calls `require("./impl/format")` from inside a
    // factory, which esbuild cannot follow, so the bundle would carry a runtime
    // require that resolves against a temp directory. Point it at the ESM build
    // instead: same package, statically analysable.
    alias: {
      "jsonc-parser": path.join(repoRoot, "node_modules", "jsonc-parser", "lib", "esm", "main.js"),
    },
  });
  return {
    shim: createRequire(import.meta.url)(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * `local-mcp/` is mirrored, not flattened: the servers import
 * `../mcp-stdio-core.mjs` relative to themselves. The daemon also refuses a
 * script outside the roots it was given, so the copies have to sit inside the
 * workspace.
 */
const SANDBOX_PREFIX = path.join("sandbox", "local-mcp");
const insideSandbox = (workspaceRoot, relative) =>
  path.join(workspaceRoot, SANDBOX_PREFIX, relative.slice("local-mcp".length + 1));

const SERVER_SOURCES = [
  path.join("local-mcp", "mcp-stdio-core.mjs"),
  path.join("local-mcp", "servers", "graphite-notes-mcp-server.mjs"),
];

const AUTH_TOKEN = "g".repeat(43);
const LOCAL_MCP_CONFIG_ENV = "GROKBOT_LOCAL_MCP_CONFIG";
/** Point the vault at a directory you want to inspect after a run. */
const KEEP_VAULT_ENV = "GROK_GRAPHITE_VAULT";

let shim;
let disposeShim;
let handle;
let workspaceRoot;
let terminalsDirectory;
let vault;
let vaultIsTemporary = true;
let localConfigPath;
let inheritedLocalConfig;
let inheritedKeepVault;
let nextId = 1;

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-turn-mcp-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-turn-mcp-terminals-"));
  inheritedLocalConfig = process.env[LOCAL_MCP_CONFIG_ENV];
  inheritedKeepVault = process.env[KEEP_VAULT_ENV];
  vaultIsTemporary = inheritedKeepVault === undefined || inheritedKeepVault.trim().length === 0;
  vault = vaultIsTemporary
    ? mkdtempSync(path.join(os.tmpdir(), "grok-turn-mcp-vault-"))
    : path.resolve(inheritedKeepVault.trim());
  mkdirSync(vault, { recursive: true });
  for (const relative of SERVER_SOURCES) {
    const target = insideSandbox(workspaceRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, relative), target);
  }

  // The one file a user writes by hand: a stdio server and the vault it keeps.
  // `node` rather than an absolute interpreter path, because the daemon refuses
  // to start a program that resolves outside the roots it was given — exactly
  // what the documented configuration uses.
  localConfigPath = path.join(workspaceRoot, "mcp-servers.json");
  writeFileSync(
    localConfigPath,
    JSON.stringify({
      mcpServers: {
        graphite: {
          command: "node",
          args: [insideSandbox(workspaceRoot, path.join("local-mcp", "servers", "graphite-notes-mcp-server.mjs"))],
          env: { GRAPHITE_VAULT: vault },
        },
      },
    }),
    "utf8",
  );
  process.env[LOCAL_MCP_CONFIG_ENV] = localConfigPath;

  handle = await shim.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: AUTH_TOKEN, port: 0 });
});

test.after(async () => {
  await handle?.stop();
  if (inheritedLocalConfig === undefined) delete process.env[LOCAL_MCP_CONFIG_ENV];
  else process.env[LOCAL_MCP_CONFIG_ENV] = inheritedLocalConfig;
  if (inheritedKeepVault === undefined) delete process.env[KEEP_VAULT_ENV];
  else process.env[KEEP_VAULT_ENV] = inheritedKeepVault;
  for (const directory of [workspaceRoot, terminalsDirectory]) {
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  if (vaultIsTemporary) rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  disposeShim?.();
});

/** One `ExecServerMessage` in, the single result frame the daemon streamed back. */
async function send(exec, message) {
  const stream = exec.exec(new shim.ExecServerMessage({ id: nextId++, execId: `exec-${nextId}`, message }));
  const frames = [];
  for await (const element of stream) {
    if (element.element.case === "execClientMessage") {
      frames.push(element.element.value.message);
    } else if (element.element.case === "execClientControlMessage" && element.element.value.message.case === "throw") {
      frames.push({ case: "throw", value: element.element.value.message.value });
    }
  }
  const failure = frames.find(frame => frame.case === "throw");
  assert.equal(failure, undefined, `the daemon refused the request instead of answering it: ${failure?.value?.error}`);
  assert.equal(frames.length, 1, "the daemon streamed more than one answer to a single request");
  return frames[0];
}

/**
 * The `CapableBox` surface `createBoxSandMcpExec` is written against, backed by
 * the daemon this test started. This is the same adaptation production gets from
 * `foreverBox.box`; the protocol under it is the daemon's own Connect service.
 */
function capableBox(exec, control) {
  return {
    loadMcpServers: async (_ctx, configJson) =>
      await control.loadMcpServers(new shim.LoadMcpServersRequest({ mcpConfigJson: configJson, removeMissing: true })),
    mcpResourceAccessor: async () => ({
      get(resource) {
        if (resource.symbol === shim.mcpStateExecutorResource.symbol) {
          return { execute: async (_ctx, args) => (await send(exec, { case: "mcpStateExecArgs", value: args })).value };
        }
        if (resource.symbol === shim.mcpExecutorResource.symbol) {
          return { execute: async (_ctx, args) => (await send(exec, { case: "mcpArgs", value: args })).value };
        }
        throw new Error(`the test box has no resource for symbol ${String(resource.symbol)}`);
      },
    }),
  };
}

/**
 * The real host MCP service, signed out.
 *
 * `accountServersProvider` answering `null` is what `fetchAccountMcpServers`
 * returns with no access token, and it is the whole point of the product.
 * `backendMcpExec` throws if it is ever called: a local stdio server must never
 * be routed to the account backend.
 */
function signedOutHostMcp(exec, control) {
  return shim.createHostMcp({
    accountServersProvider: async () => null,
    backendMcpExec: {
      listTools: async () => {
        throw new Error("the account backend must not be consulted for a local stdio server");
      },
      executeTool: async () => {
        throw new Error("the account backend must not execute a local stdio server");
      },
    },
    boxMcpExec: shim.createBoxSandMcpExec(capableBox(exec, control)),
    getMachineId: async () => "machine-local-only",
    getAccessToken: async () => null,
  });
}

/**
 * Where `CallMcpTool` reaches the box: `turn-agent-composition.ts:1656` registers
 * `mcp.mcp.createExecutor()` under `mcpExecutorResource` in the turn's resource
 * accessor, so the tool and the executor are wired exactly as production wires
 * them, without the Smart Mode guard that only adds approval gating.
 */
function turnResourceAccessor(hostMcp) {
  const executor = hostMcp.mcp.createExecutor(undefined, undefined, { agentId: AGENT_ID });
  return {
    get(resource) {
      assert.equal(resource.symbol, shim.mcpExecutorResource.symbol,
        "the turn factory asked for a resource the MCP turn never registers");
      return executor;
    },
  };
}

/** The toolset the turn really carries, built by the factory the host calls. */
function turnTools(hostMcp, turnMcpTools) {
  const turn = {};
  const props = { mcpTools: turnMcpTools };
  return shim.createTurnMcpMetaToolFactory({
    resourceAccessor: turnResourceAccessor(hostMcp),
    getMcpTools: () => shim.liveMcpToolsForTurn(turn, props),
    callOptions: {},
  })();
}

/** Runs one real turn tool with real arguments and returns its `McpToolResult`. */
async function callTurnTool(tools, name, args, toolCallId) {
  const tool = tools.find(entry => entry.name === name);
  assert.notEqual(tool, undefined,
    `the turn carries no ${name}, so this call would prove nothing about the product`);
  const serialized = JSON.stringify(args);
  const call = await tool.execute(
    // The logger backend is the product's own seam; a test run prints nothing of
    // its own, so the turn must not print on stdout either.
    shim.createContext().with(shim.loggerKey, { log: () => {} }),
    {
      executeToolCall: async (callCtx, _toolCall, _callId, run, project) => project(await run(callCtx)),
    },
    (async function* () { yield serialized; })(),
    { toolCallId },
  );
  return call.tool.value.result;
}

function resultText(result) {
  return result.result.value.content.map(item => item.content.value.text).join("\n");
}

function connectClients() {
  const transport = shim.createConnectTransport({
    baseUrl: handle.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  return {
    control: shim.createClient(shim.ControlService, transport, { transport }),
    exec: shim.createClient(shim.ExecService, transport, { transport }),
  };
}

test("the server the daemon runs is the repository file, not a stand-in", () => {
  for (const relative of SERVER_SOURCES) {
    assert.deepEqual(
      readFileSync(insideSandbox(workspaceRoot, relative)),
      readFileSync(path.join(repoRoot, relative)),
      `the sandboxed copy of ${relative} differs from the repository file, so this file would be proving a different program than the one a user runs`,
    );
  }
});

test("the turn is given the notes server the user configured, on the very first turn", async () => {
  const { control, exec } = connectClients();
  const hostMcp = signedOutHostMcp(exec, control);

  const turnToolsList = await hostMcp.mcp.getTools({});
  assert.deepEqual(
    turnToolsList.map(tool => `${tool.providerIdentifier}-${tool.toolName}`).sort(),
    [
      "graphite-append_note",
      "graphite-create_note",
      "graphite-list_folders",
      "graphite-list_notes",
      "graphite-read_note",
      "graphite-search_notes",
    ],
    "the first turn found no notes server, which is what kept GetMcpTools and CallMcpTool out of the toolset",
  );
  assert.ok(turnToolsList.every(tool => tool.inputSchema != null),
    "a descriptor without its schema lets the model invent arguments the server will reject");
});

test("a live notes server puts the discovery and call pair in the turn's toolset", async () => {
  const { control, exec } = connectClients();
  const hostMcp = signedOutHostMcp(exec, control);

  const names = turnTools(hostMcp, await hostMcp.mcp.getTools({})).map(tool => tool.name);
  assert.ok(names.includes("GetMcpTools"),
    `the turn carries no discovery tool, so the model cannot learn what it may call: ${names.join(", ")}`);
  assert.ok(names.includes("CallMcpTool"),
    `the turn carries no MCP call tool, which is exactly what the agent reported back to the user: ${names.join(", ")}`);
});

test("the prompt names the MCP pair only for a turn that carries it", async () => {
  const { control, exec } = connectClients();
  const hostMcp = signedOutHostMcp(exec, control);
  const withServer = turnTools(hostMcp, await hostMcp.mcp.getTools({})).map(tool => tool.name);

  const capabilities = shim.resolveSandToolCapabilities(name => withServer.includes(name));
  assert.equal(capabilities.mcpTools, true,
    "the prompt resolver reads the turn's own toolset, so a live server it cannot see is a prompt that never names MCP");
  const prompt = shim.buildSandBaseSystemPrompt({ cloudAgentsEnabled: false, tools: capabilities });
  assert.match(prompt, /CallMcpTool/,
    "the prompt must tell the model the tool exists, or the model never searches for it");
  assert.deepEqual(
    shim.unavailableToolNames(capabilities).filter(name => name === "CallMcpTool" || name === "GetMcpTools"),
    [],
    "a turn that carries the pair must not have its names stripped from the prompt");

  // The other direction matters too. The twelve MCP administration tools all
  // write to the user's Cursor account and still answer 401 without one; they
  // are a separate family from the discovery/call pair and must stay out of the
  // prompt on a machine that only has a local file.
  const withoutServer = shim.resolveSandToolCapabilities(() => false);
  assert.equal(withoutServer.mcpTools, false, "a turn with no MCP pair must not claim the MCP family");
  assert.equal(withoutServer.mcpManagement, false,
    "the account administration family stays off without an account, whatever the local file says");
  const hidden = shim.unavailableToolNames(withoutServer);
  assert.deepEqual(
    hidden.filter(name => name === "CallMcpTool" || name === "GetMcpTools"),
    ["GetMcpTools", "CallMcpTool"],
    "a turn without the pair must have both names removed from the prompt");
  assert.ok(hidden.includes("SearchPlugins") && hidden.includes("AuthenticateMcpServer"),
    "the account administration tools must stay hidden on a machine with no account");
  assert.doesNotMatch(
    shim.buildSandBaseSystemPrompt({ cloudAgentsEnabled: false, tools: withoutServer }),
    /CallMcpTool/,
    "the prompt promises an MCP call tool to a turn that has none, which is how a model burns a turn on a tool that is not there",
  );
});

test("the agent writes a note into its own vault, and the file is on disk", async () => {
  const { control, exec } = connectClients();
  const hostMcp = signedOutHostMcp(exec, control);
  const tools = turnTools(hostMcp, await hostMcp.mcp.getTools({}));

  const created = await callTurnTool(tools, "CallMcpTool", {
    server: "graphite",
    toolName: "create_note",
    arguments: { title: NOTE_TITLE, body: NOTE_BODY, folder: NOTE_FOLDER },
  }, "call-create-note");
  assert.equal(created.result.case, "success",
    `the notes server refused a call the tool advertises: ${created.result.case} ${JSON.stringify(created.result.value ?? created.result.error)}`);
  assert.equal(created.result.value.isError, false,
    `the daemon reported the note as an error: ${resultText(created)}`);

  const notePath = path.join(vault, NOTE_FOLDER, `${NOTE_TITLE}.md`);
  assert.ok(existsSync(notePath),
    `the call reported success but ${notePath} is not on disk, so the agent has no personal notes store`);
  const note = readFileSync(notePath, "utf8");
  assert.match(note, /type: note/, "the note was written in the shape Graphite itself reads");
  assert.match(note, /# Заметка агента/u, "the note carries its title as the heading Graphite shows");
  assert.ok(note.includes(NOTE_BODY), "the body the agent passed is in the file it can read back next turn");

  // Reading it back through a second, independent call proves the file is served
  // by the running process rather than echoed from one cached answer.
  const read = await callTurnTool(tools, "CallMcpTool", {
    server: "graphite",
    toolName: "read_note",
    arguments: { path: `${NOTE_FOLDER}/${NOTE_TITLE}.md` },
  }, "call-read-note");
  assert.equal(read.result.case, "success", `reading the note back failed: ${read.result.case}`);
  assert.ok(resultText(read).includes(NOTE_BODY),
    `the note on disk did not come back through the server, so the two calls did not share one vault: ${resultText(read)}`);
});

test("a turn after RestartMcpServers still sees the server, because the cache it reads was just dropped", async () => {
  const { control, exec } = connectClients();
  const hostMcp = signedOutHostMcp(exec, control);
  const first = await hostMcp.mcp.getTools({});
  assert.equal(first.length, 6, "the first turn must have found the server for this test to mean anything");

  // `RestartMcpServers` is the user's own answer to "I edited my file and
  // nothing happened", and it empties the tool cache. The account configuration
  // survives it, so the server set IS known here while the cache is cold — the
  // one combination in which the turn used to read its own just-started
  // resolution and answer "no servers".
  await hostMcp.management.restart();

  const second = await hostMcp.mcp.getTools({});
  assert.deepEqual(
    second.map(tool => `${tool.providerIdentifier}-${tool.toolName}`).sort(),
    first.map(tool => `${tool.providerIdentifier}-${tool.toolName}`).sort(),
    "restarting the servers dropped the notes server out of the very next turn",
  );
});

test("a machine with no local server still gets no MCP pair", async () => {
  const emptyConfig = path.join(workspaceRoot, "mcp-servers.empty.json");
  writeFileSync(emptyConfig, JSON.stringify({ mcpServers: {} }), "utf8");
  const { control, exec } = connectClients();
  const previous = process.env[LOCAL_MCP_CONFIG_ENV];
  process.env[LOCAL_MCP_CONFIG_ENV] = emptyConfig;
  let turnToolsList;
  let hostMcp;
  try {
    hostMcp = signedOutHostMcp(exec, control);
    turnToolsList = await hostMcp.mcp.getTools({});
  } finally {
    process.env[LOCAL_MCP_CONFIG_ENV] = previous;
  }
  assert.deepEqual([...turnToolsList], [],
    "an empty local file must produce an empty list, or this fix would offer GetMcpTools to a machine that has nothing to call");
  assert.deepEqual(turnTools(hostMcp, turnToolsList).map(tool => tool.name), [],
    "with no descriptors the pair stays absent, which is the honest answer and must not change");
});