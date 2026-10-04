import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { build } from "esbuild";

/**
 * A user could describe an MCP server and Grok Bot would render it, but the only
 * place a server could come from was a signed-in Cursor account, and every
 * account read answers 401 without a token. `listRoutedMcpTools` returned `[]`,
 * `listBoxMcpServers` answered `500 Unsupported ExecServerMessage case:
 * mcpStateExecArgs`, and the user had nowhere on this machine to declare the
 * notes server they wanted every agent to have.
 *
 * The channel was already complete — `mcp-display-runtime.ts` carried the stdio
 * shape, `tools-discovery.ts:162-163` already pushed `{ mcpServers }` to the
 * computer — and nothing supplied it. This change adds the missing source and
 * nothing else: one json file, read, never written.
 *
 * Two failures were possible and both are the kind that looks like success.
 *
 * A first attempt patched only `mcp-manager.ts:69-74`, feeding local servers
 * into the definition source alone. `GetMcpTools` and `CallMcpTool` came alive,
 * and `GetMcpServerStatus` kept answering "No MCP servers are installed" — so
 * `tools-discovery.ts:90-102` found no display row, `getMcpDisabledToolsByServerId`
 * and `getRawMcpCustomInstructionByServerId` had no `row.id` to key on, and every
 * per-server preference silently did nothing. Live tools and a listing that
 * denies they exist is not a partial success; it is an agent that cannot manage
 * what it can call. The local rows therefore have to be display rows, carrying an
 * `id` the settings store can key, and `SandMcpDefinitionSource` gets them through
 * a third constructor argument rather than through the account seam.
 *
 * The second failure is the security one. A local stdio entry is a `command` plus
 * `args`, so writing one is arbitrary code execution as the user. `resolvePath` and
 * `PathRejectedError` constrain the `Shell` and `Read` tools and do not apply to a
 * process started from configuration, so the file must be the user's alone. The
 * tests below prove there is still no writer, and that the four transport-level
 * tools refuse a local server instead of offering to authorise or delete one.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-mcp-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      external: ["electron"],
      format: "esm",
      // `mcp-service.ts` reaches `undici`, which does `require("assert")`. esbuild
      // turns a dynamic require in an esm bundle into a throw, so give it a real one.
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
      },
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
  ["shared", "node", "mcp", "local-mcp-config-provider.ts"],
  ["shared", "node", "mcp", "mcp-manager.ts"],
  ["shared", "node", "mcp", "tools-discovery.ts"],
  ["shared", "node", "mcp", "mcp-stdio-client.ts"],
  ["host", "extensions", "mcp", "mcp-service.ts"],
  ["host", "runner", "tools", "sand-mcp-management-tools.ts"],
  ["packages", "context", "core.ts"],
]);

test.after(() => dispose());

/**
 * `turn-toolset` is bundled on its own, as CommonJS, for the reason
 * `tests/turn-toolset-missing-families.test.mjs` records: it pulls in `mime-types`,
 * whose relative requires esbuild can only wire inside a CommonJS output, and
 * `jsonc-parser`, whose UMD `main` hides those requires behind `define` until the
 * `module` field is preferred.
 */
async function bundleCommonJs(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-mcp-cjs-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.cjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "cjs",
      mainFields: ["module", "main"],
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  const require = createRequire(import.meta.url);
  const modules = {};
  for (const [name, file] of names) modules[name] = require(file);
  return { loaded: modules, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded: commonJs, dispose: disposeCommonJs } = await bundleCommonJs([
  ["host", "runner", "tools", "turn-toolset.ts"],
]);

test.after(() => disposeCommonJs());

const {
  createLocalMcpServerSource,
  isLocalMcpServerId,
  localMcpConfigPath,
  localMcpServerIdForName,
  readLocalMcpConfig,
  LOCAL_MCP_CONFIG_DIRECTORY,
  LOCAL_MCP_CONFIG_ENV,
  LOCAL_MCP_CONFIG_FILE,
  LOCAL_MCP_CONFIG_HINT,
  LOCAL_MCP_SERVER_ID_MAX,
  LOCAL_MCP_SERVER_ID_MIN,
} = loaded["local-mcp-config-provider.mjs"];
const { SandMcpManager } = loaded["mcp-manager.mjs"];
const { createMcpToolsDiscovery } = loaded["tools-discovery.mjs"];
const { connectStdioServer } = loaded["mcp-stdio-client.mjs"];
const { toInstalledServers } = loaded["mcp-service.mjs"];
const { createMcpManagementTools } = loaded["sand-mcp-management-tools.mjs"];
const { liveMcpToolsForTurn } = commonJs["turn-toolset.cjs"];
const { createContext } = loaded["core.mjs"];

const scratch = mkdtempSync(path.join(os.tmpdir(), "grok-local-mcp-fixture-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const GRAPHITE_SERVER = path.join(repoRoot, "local-mcp", "servers", "graphite-notes-mcp-server.mjs");
const ECHO_SERVER = path.join(repoRoot, "local-mcp", "servers", "echo-mcp-server.mjs");

let fixtureCounter = 0;

/** Writes a local MCP file into the scratch directory and returns its path. */
function writeLocalConfig(servers) {
  fixtureCounter += 1;
  const file = path.join(scratch, `mcp-servers-${fixtureCounter}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
  return file;
}

/** A path inside the scratch directory that was never created: no local servers. */
function absentLocalConfigPath() {
  return path.join(scratch, `never-written-${fixtureCounter += 1}.json`);
}

function localSourceFor(file) {
  return createLocalMcpServerSource({ env: { [LOCAL_MCP_CONFIG_ENV]: file } });
}

/** The tools a local `graphite` entry declares, shaped like `listBoxServers` answers. */
function graphiteTools() {
  return ["create_note", "list_notes", "read_note"].map((toolName) => ({
    providerIdentifier: "graphite",
    name: `mcp__graphite__${toolName}`,
    toolName,
    description: `${toolName} on the graphite vault`,
  }));
}

/** Stands in for the box: records the pushed configuration and answers `listTools`. */
function createBoxStub() {
  const state = { pushed: [], listToolsCalls: 0, executed: [] };
  return {
    state,
    invalidateToolsCache() {},
    resetPushState() {},
    isBoxExecWired: () => true,
    async loadServers(configJson) {
      state.pushed.push(JSON.parse(configJson));
    },
    async listTools(serverIdentifiers) {
      state.listToolsCalls += 1;
      return [...serverIdentifiers].map((serverIdentifier) => ({
        serverIdentifier,
        status: "connected",
        toolCount: serverIdentifier === "graphite" ? graphiteTools().length : 0,
        tools: serverIdentifier === "graphite" ? graphiteTools() : [],
      }));
    },
    async executeTool(args) {
      state.executed.push(args);
      return { result: { case: "success", value: { content: [] } } };
    },
  };
}

/** The settings store surface both the manager and the discovery read. */
function createSettings(overrides = {}) {
  const disabled = overrides.disabledByServerId ?? {};
  return {
    scopeToAccount() {},
    migrateMcpCustomInstructionToServerId() {},
    getMcpCustomInstructions: () => ({}),
    getMcpCustomInstructionsByServerId: () => ({}),
    getMcpDisabledToolsByServerId: () => disabled,
    setMcpDisabledToolsByServerId() {},
    getRawMcpCustomInstruction: () => undefined,
    getRawMcpCustomInstructionByServerId: () => undefined,
    setMcpCustomInstructionByServerId() {},
    deleteMcpCustomInstructionByServerId() {},
  };
}

/**
 * The production composition, assembled from the same three pieces
 * `createHostMcp` builds: a manager, a tools discovery, and the box port.
 *
 * `accountServers` is the account read in whichever of its three states matters:
 * a display config, `null` for signed out, or `{ unavailable: true }`.
 */
function createMcpWorld({ localConfigFile, accountServers = null, disabledByServerId = {} } = {}) {
  const box = createBoxStub();
  const manager = new SandMcpManager({
    includeBuiltins: false,
    // Signed out: no writer, so every write path must refuse. `parseServerConfig`
    // is supplied only so `addServer` reaches the writer gate instead of dying on
    // an unrelated missing option.
    accountMcpWriter: undefined,
    parseServerConfig: (value) => value,
    accountServersProvider: async () => (typeof accountServers === "function" ? accountServers() : accountServers),
    accountDisplayConfigProvider: async () => (typeof accountServers === "function" ? accountServers() : accountServers),
    backendMcpExec: box,
    settingsStore: createSettings({ disabledByServerId }),
    getMachineId: async () => "local-mcp-fixture",
    localMcpServers: localSourceFor(localConfigFile),
  });
  const discovery = createMcpToolsDiscovery(
    {
      definitionSource: manager.definitionSourceView(),
      lastAccountDisplayConfig: () => manager.lastAccountDisplayConfigView(),
      settingsStore: () => manager.settingsStoreView(),
      backendMcpExec: box,
    },
    { boxMcpExec: box },
  );
  manager.setBoxRuntime(discovery);
  return { box, manager, discovery };
}

function accountDisplayServer(overrides = {}) {
  return {
    id: "1",
    name: "remote-notes",
    serverIdentifier: "remote-notes",
    config: { url: "https://example.test/mcp" },
    isTeamServer: false,
    disabledByTeamAdminPolicy: false,
    ...overrides,
  };
}

/** Reads the text a `CommunicateUpdateResult` carries, whichever case it arrived in. */
function toolText(result) {
  return result?.result?.case === "error"
    ? result.result.value.error
    : (result?.result?.value?.currentStep ?? "");
}

/** Runs one management tool the way the agent loop does. */
async function callTool(tools, name, args) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool != null, `tool ${name} is not offered at all`);
  const interaction = {
    getAbortSignal: () => new AbortController().signal,
    emitPartialToolCall: async () => {},
    executeToolCall: async (ctx, _call, _id, execute) => await execute(ctx),
  };
  return await tool.execute(
    createContext(),
    interaction,
    (async function* () { yield JSON.stringify(args); })(),
    { toolCallId: `probe-${name}` },
  );
}

test("a local file alone gives the turn real MCP descriptors", async () => {
  const vault = mkdtempSync(path.join(os.tmpdir(), "grok-local-mcp-vault-"));
  const file = writeLocalConfig({
    graphite: {
      command: process.execPath,
      args: [GRAPHITE_SERVER],
      env: { GRAPHITE_VAULT: vault },
    },
  });
  const { box, manager, discovery } = createMcpWorld({ localConfigFile: file });

  try {
    const state = await manager.listServers();
    assert.deepEqual(
      state.servers.map((server) => server.serverIdentifier),
      ["graphite"],
      "the local server is listed, so GetMcpServerStatus no longer says none are installed",
    );

    const stdioConfigs = await manager.definitionSourceView().getStdioServerConfigs();
    assert.deepEqual(
      Object.keys(stdioConfigs),
      ["graphite"],
      "the definition source hands the local entry to the computer as a stdio configuration",
    );
    assert.deepEqual(
      box.state.pushed.at(-1),
      { mcpServers: { graphite: { command: process.execPath, args: [GRAPHITE_SERVER], env: { GRAPHITE_VAULT: vault } } } },
      "the configuration that reached the computer is the one the user wrote, verbatim",
    );

    const tools = await discovery.getTools({});
    const live = liveMcpToolsForTurn({ mcpTools: tools });
    assert.deepEqual(
      live.map((tool) => tool.toolName).sort(),
      ["create_note", "list_notes", "read_note"],
      "GetMcpTools and CallMcpTool exist for this turn because the descriptor list is no longer empty",
    );
    assert.equal(
      live.every((tool) => tool.providerIdentifier === "graphite"),
      true,
      "each descriptor names the local server it came from",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test("with no local file nothing changes at all", async () => {
  const missing = absentLocalConfigPath();
  const { box, manager, discovery } = createMcpWorld({
    localConfigFile: missing,
    accountServers: { servers: [accountDisplayServer()], cacheScope: "account-a" },
  });

  const state = await manager.listServers();
  assert.deepEqual(
    state.servers.map((server) => server.serverIdentifier),
    ["remote-notes"],
    "the account listing is exactly what it was before a local source existed",
  );
  assert.deepEqual(
    await manager.definitionSourceView().getStdioServerConfigs(),
    {},
    "no stdio configuration is pushed for a machine with no local file",
  );
  assert.equal(
    box.state.pushed.length,
    0,
    "the computer is never told to start anything it was not told about",
  );
  assert.deepEqual(await discovery.getTools({}), [], "an account-only box with no tool still exposes no MCP tools");

  // Signed out with no local file, the definition source must stay unloaded, not
  // "loaded and empty": the two are different to `getToolsForTurnStart`.
  const signedOut = createMcpWorld({ localConfigFile: missing, accountServers: null });
  await signedOut.manager.listServers();
  assert.equal(
    signedOut.manager.definitionSourceView().peekStdioServerNames(),
    undefined,
    "without a local file the peek stays undefined exactly as the account-only code left it",
  );
  assert.deepEqual(
    (await signedOut.manager.listServers()).servers,
    [],
    "a signed-out machine with no local file installs nothing",
  );
});

test("local rows carry a usable id and are found by the per-server settings", async () => {
  const file = writeLocalConfig({ graphite: { command: process.execPath, args: [ECHO_SERVER] } });
  const probe = createMcpWorld({ localConfigFile: file });
  const state = await probe.manager.listServers();
  const row = probe.manager.lastAccountDisplayConfigView().servers.find((server) => server.serverIdentifier === "graphite");

  assert.ok(row != null, "the local server is a display row, which is what tools-discovery keys settings by");
  assert.equal(
    /^[1-9]\d*$/.test(row.id),
    true,
    "the local id is a positive decimal string, so every tool that validates a server id accepts it",
  );
  assert.equal(isLocalMcpServerId(row.id), true, "the local id also sits in the band reserved for local servers");
  assert.equal(Number(row.id) <= LOCAL_MCP_SERVER_ID_MAX, true, "the local id stays below the reserved band's end");
  assert.equal(Number(row.id) >= LOCAL_MCP_SERVER_ID_MIN, true, "the local id stays above the reserved band's start");

  // Same name, second machine: the id must not move, or a saved instruction would
  // silently detach from its server on the next restart.
  assert.equal(
    localMcpServerIdForName("graphite", new Set()),
    row.id,
    "the identifier for a name is derived from the name, not from an enumeration order",
  );

  const disabledWorld = createMcpWorld({
    localConfigFile: file,
    disabledByServerId: { [row.id]: ["read_note"] },
  });
  // The listing runs first because `lastAccountDisplayConfig` is populated by it,
  // exactly as a real turn populates it: `tools-discovery` reads that object to
  // find which `row.id` a tool's toggle belongs to.
  await disabledWorld.manager.listServers();
  const visible = (await disabledWorld.discovery.getTools({})).map((tool) => tool.toolName).sort();
  assert.deepEqual(
    visible,
    ["create_note", "list_notes"],
    "a tool disabled for the local server's row.id is really filtered out, which only works because the row is in lastAccountDisplayConfig",
  );
  assert.equal(
    state.servers.length,
    1,
    "the listing still holds exactly the one declared server",
  );
});

test("an account server of the same name wins, and every account state still keeps the locals", async () => {
  const file = writeLocalConfig({
    graphite: { command: process.execPath, args: [ECHO_SERVER] },
  });
  const collision = createMcpWorld({
    localConfigFile: file,
    accountServers: {
      cacheScope: "account-a",
      servers: [{
        id: "1",
        name: "graphite",
        serverIdentifier: "graphite",
        config: { url: "https://example.test/mcp" },
        isTeamServer: false,
        disabledByTeamAdminPolicy: false,
      }],
    },
  });
  const collided = await collision.manager.listServers();
  assert.deepEqual(
    collided.servers.map((server) => [server.id, server.transport]),
    [["1", "http"]],
    "the account row keeps the name; a local file must not shadow an authenticated, manageable server",
  );
  assert.deepEqual(
    await collision.manager.definitionSourceView().getStdioServerConfigs(),
    {},
    "the shadowed local entry is not also pushed as a process to start",
  );

  for (const [label, accountServers] of [
    ["account list present", { cacheScope: "account-a", servers: [] }],
    ["account list null", null],
    ["account list unavailable", { cacheScope: "account-a", servers: [], unavailable: true }],
  ]) {
    const world = createMcpWorld({ localConfigFile: file, accountServers });
    const servers = (await world.manager.listServers()).servers;
    assert.deepEqual(
      servers.map((server) => server.serverIdentifier),
      ["graphite"],
      `the local server survives the "${label}" state, which is the state a signed-out machine is in`,
    );
    assert.deepEqual(
      Object.keys(await world.manager.definitionSourceView().getStdioServerConfigs()),
      ["graphite"],
      `the stdio configuration is pushed in the "${label}" state too`,
    );
  }
});

test("nothing can write the local file", async () => {
  const file = writeLocalConfig({ graphite: { command: process.execPath, args: [ECHO_SERVER] } });
  const before = readFileSync(file, "utf8");
  const { manager } = createMcpWorld({ localConfigFile: file });
  await manager.listServers();
  const localRowId = manager.lastAccountDisplayConfigView().servers.find((server) => server.serverIdentifier === "graphite").id;

  await assert.rejects(
    manager.addServer({ name: "sneaky", configJson: JSON.stringify({ url: "https://example.test/mcp" }) }),
    /requires a signed-in Cursor account/,
    "AddMcpServer still refuses without an account, so no writer has appeared",
  );
  await assert.rejects(
    manager.removeServer(localRowId),
    /requires a signed-in Cursor account/,
    "removing a LOCAL server reaches the writer gate and is refused, instead of pretending to delete a file nobody can write",
  );
  assert.equal(
    readFileSync(file, "utf8"),
    before,
    "the file is byte-identical after every refused mutation attempt",
  );

  const providerSource = readFileSync(
    path.join(repoRoot, "source", "shared", "node", "mcp", "local-mcp-config-provider.ts"),
    "utf8",
  );
  const writeApis = [
    "writeFileSync", "appendFileSync", "createWriteStream", "unlinkSync", "rmSync",
    "renameSync", "mkdirSync", "copyFileSync", "openSync", "truncate",
  ];
  const used = writeApis.filter((api) => providerSource.includes(api));
  assert.deepEqual(
    used,
    [],
    "the local configuration module must not even name a write-capable filesystem API",
  );
  assert.ok(
    providerSource.includes("readFileSync"),
    "the guard above would also pass if the module had stopped reading, so prove it still reads",
  );
});

test("the four transport-level tools refuse a local server instead of touching it", async () => {
  const file = writeLocalConfig({ graphite: { command: process.execPath, args: [ECHO_SERVER] } });
  const { manager } = createMcpWorld({ localConfigFile: file });
  const state = await manager.listServers();
  const installed = toInstalledServers(state);
  const local = installed.find((server) => server.serverIdentifier === "graphite");
  assert.deepEqual(
    installed.filter((server) => server.isLocal === true).map((server) => server.serverIdentifier),
    ["graphite"],
    "the installed listing marks the local row and no account row, which is the fact every refusal below turns on",
  );

  const called = [];
  const management = {
    listPlugins: async () => [],
    getPlugin: async () => null,
    install: async () => { called.push("install"); },
    add: async () => { called.push("add"); return []; },
    listInstalled: async () => installed,
    removeServer: async () => { called.push("removeServer"); return { removed: true, servers: [] }; },
    uninstallPlugin: async () => { called.push("uninstallPlugin"); return { removed: true }; },
    setInstructions: async () => { called.push("setInstructions"); return []; },
    restart: async () => { called.push("restart"); return []; },
    authenticate: async () => { called.push("authenticate"); return { kind: "not-configured", serverName: "graphite" }; },
    removeAccount: async () => { called.push("removeAccount"); return []; },
    renameAccount: async () => { called.push("renameAccount"); return []; },
  };
  const tools = createMcpManagementTools(management, () => undefined, () => false, () => true);
  assert.deepEqual(
    tools.filter((tool) => ["RemoveMcpAccount", "RenameMcpAccount"].includes(tool.name)).map((tool) => tool.name),
    ["RemoveMcpAccount", "RenameMcpAccount"],
    "the multi-account tools exist here, so the refusal below is about locality and not about the tool being absent",
  );

  for (const [name, args, forbidden] of [
    ["AuthenticateMcpServer", { server_id: local.id, account_label: "default" }, "authenticate"],
    ["RemoveMcpAccount", { server_id: local.id, account_label: "default" }, "removeAccount"],
    ["RenameMcpAccount", { server_id: local.id, account_label: "default", new_account_label: "other" }, "renameAccount"],
    ["UninstallMcpServer", { server_id: local.id }, "removeServer"],
  ]) {
    const text = toolText(await callTool(tools, name, args));
    assert.match(text, /local stdio server/, `${name} must say why it refuses`);
    assert.match(text, new RegExp(LOCAL_MCP_CONFIG_HINT.replace(/[\\%]/g, "\\$&")), `${name} must name the file the user edits`);
    assert.equal(
      called.includes(forbidden),
      false,
      `${name} must not reach ${forbidden} for a local server, whatever the listing says`,
    );
  }

  // A remote account server is untouched by the refusals, or the guards would be
  // a blanket disable of the tools rather than a transport distinction.
  const remoteId = "1";
  called.length = 0;
  const remoteManagement = {
    ...management,
    listInstalled: async () => [
      ...installed,
      { id: remoteId, name: "remote-notes", serverIdentifier: "remote-notes", status: "needsAuth", accountKey: "default", transport: "http", toolCount: 3, customInstructions: "", isTeamServer: false },
    ],
  };
  const remoteTools = createMcpManagementTools(remoteManagement, () => undefined, () => false, () => true);
  await callTool(remoteTools, "AuthenticateMcpServer", { server_id: remoteId, account_label: "default" });
  assert.deepEqual(called, ["authenticate"], "an account connector still reaches its authentication flow");
});

test("a broken file is reported by name and never takes the good entries down with it", async () => {
  const file = path.join(scratch, "mixed.json");
  writeFileSync(file, [
    "﻿", // a byte order mark, which three of this repository's json readers strip and the rest do not
    JSON.stringify({
      mcpServers: {
        good: { command: process.execPath, args: [ECHO_SERVER] },
        remote: { url: "https://example.test/mcp" },
        empty: { args: [] },
        "bad/name": { command: process.execPath },
        secretish: { command: process.execPath, args: 7 },
      },
    }),
  ].join(""), "utf8");

  const snapshot = readLocalMcpConfig({ [LOCAL_MCP_CONFIG_ENV]: file });
  assert.deepEqual(
    Object.keys(snapshot.servers),
    ["good"],
    "one valid entry survives alongside four invalid ones",
  );
  assert.equal(
    snapshot.problems.length,
    4,
    "every rejected entry is reported, so a user is not left guessing why their server did not appear",
  );
  for (const problem of snapshot.problems) {
    assert.doesNotMatch(
      problem,
      /7|https:\/\/example\.test/,
      "a problem names the entry and the field, never a value from the file",
    );
  }

  const unparsable = path.join(scratch, "unparsable.json");
  writeFileSync(unparsable, '{"mcpServers":{"notes":{"command":"node","env":{"TOKEN":"s3cr3t-value"', "utf8");
  const broken = readLocalMcpConfig({ [LOCAL_MCP_CONFIG_ENV]: unparsable });
  assert.deepEqual(broken.servers, {}, "a file that cannot be parsed contributes no servers");
  assert.equal(broken.problems.length, 1, "and exactly one explanation");
  assert.doesNotMatch(
    broken.problems[0],
    /s3cr3t-value/,
    "V8 quotes the offending source text in its parse error, so this message must not carry it",
  );

  const absentPath = absentLocalConfigPath();
  assert.deepEqual(
    readLocalMcpConfig({ [LOCAL_MCP_CONFIG_ENV]: absentPath }),
    { path: absentPath, servers: {}, problems: [] },
    "an absent file is indistinguishable from an empty one, which is the normal case",
  );
});

test("the documented path is the one the file is read from", () => {
  assert.equal(
    localMcpConfigPath({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }),
    path.join("C:\\Users\\test\\AppData\\Local", LOCAL_MCP_CONFIG_DIRECTORY, LOCAL_MCP_CONFIG_FILE),
    "the default location is %LOCALAPPDATA%\\GrokBotLocalBox\\mcp-servers.json",
  );
  assert.equal(
    localMcpConfigPath({}),
    path.join(os.homedir(), LOCAL_MCP_CONFIG_DIRECTORY, LOCAL_MCP_CONFIG_FILE),
    "a machine with no LOCALAPPDATA still resolves a path instead of crashing",
  );
});

test("the ported stdio client is in the shipped bundle and really speaks MCP", async () => {
  // The client used to exist only as `local-mcp/mcp-stdio-client.mjs`, outside
  // `source/`, so esbuild never saw it and it never reached `app.asar`. The graph
  // below is the one `scripts/host-production-activation.mjs` builds for the host.
  const graph = await build({
    stdin: {
      contents: 'import { createMcpProductionExtras } from "./source/host/extensions/mcp/production.js";\nconsole.log(createMcpProductionExtras);\n',
      loader: "ts",
      resolveDir: repoRoot,
      sourcefile: "host-production-activation.ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    external: ["electron"],
    metafile: true,
  });
  const inputs = Object.keys(graph.metafile.inputs).map((file) => file.replace(/\\/g, "/"));
  for (const module of [
    "source/shared/node/mcp/local-mcp-config-provider.ts",
    "source/shared/node/mcp/mcp-stdio-client.ts",
    "source/shared/node/mcp/mcp-stdio-core.ts",
  ]) {
    assert.ok(
      inputs.includes(module),
      `${module} is not in the host bundle graph, so it will not be in app.asar and this test is stale`,
    );
  }
  // The file being in the graph is not enough: esbuild drops the body of a module
  // whose exports are unused, so the client's own string is what proves it ships.
  assert.ok(
    graph.outputFiles[0].text.includes("grokbot-local-mcp-client"),
    "the client body is absent from the host bundle; only its module name reached esbuild",
  );

  const client = await connectStdioServer(
    { command: process.execPath, args: [ECHO_SERVER] },
    { clientName: "local-mcp-config-source-test", timeoutMs: 20_000 },
  );
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["add", "echo"],
      "the shipped client completes a real handshake against a real server process",
    );
    const echoed = await client.callTool("echo", { message: "ported" });
    assert.equal(
      echoed.content?.[0]?.text,
      "ported",
      "and a real tools/call round trip, so the port is wire-compatible with the standalone one",
    );
  } finally {
    await client.close();
  }
});