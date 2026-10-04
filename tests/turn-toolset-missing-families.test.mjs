/**
 * Nine tool families were wired in `buildTurnTools` but no factory ever reached
 * the model, so a turn carried 28 tools while the system prompt described
 * thirty-seven. Nothing threw and nothing looked broken: `createTurnToolsetFactories`
 * copies each provider slot verbatim, `buildTurnTools` skips a family whose
 * factory is absent, and the live request simply shipped without it. The
 * measured request to `https://opencode.ai/zen/go/v1` carried SendMessage,
 * ReactToMessage, update_state, the shell trio, Task, TodoWrite, agent
 * management, the web pair, AwaitShell and the MCP management surface — and no
 * CopyToBox, no GetMcpTools, no CheckSubagent. Asked «Что ты умеешь?» the model
 * named tools it had never been given, because the prompt promised them.
 *
 * Three causes, all silent:
 *
 * 1. The MCP pair was gated on `props.mcp`, a field `createTurnToolProjections`
 *    never projected, so `createMcpMetaToolInputs` was defined only under a
 *    condition that could never hold in production.
 * 2. CopyToBox/CopyFromBox, CheckSubagent/MessageSubagent/StopSubagent had no
 *    `create*ToolInputs` callback at all, so their factories did not exist.
 * 3. Attaching the MCP pair unconditionally would have been a second defect:
 *    a `GetMcpTools` that can only answer "no servers" burns a turn and reads
 *    to the model as a broken capability. The pair must appear only when this
 *    turn can actually reach a server.
 *
 * These tests drive the real `buildTurnTools` — not a reimplementation — and
 * assert the tool names it produces for a production-shaped host. They prove
 * the families are built, that the MCP pair stays absent on a box with no
 * servers and appears the moment a live per-turn snapshot names one, and that
 * the turn reports its own toolset so the prompt can describe exactly that.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-turntools-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.cjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      // The toolset pulls in CommonJS dependencies (`mime-types` and its
      // internal relative requires), which esbuild can only wire up inside a
      // CommonJS output — the same shape `scripts/lib/clean-build.mjs` builds.
      format: "cjs",
      platform: "node",
      target: "node22",
      // `jsonc-parser` ships a UMD `main` whose factory hides its relative
      // requires behind `define`, so esbuild cannot see them and leaves a
      // runtime `require("./impl/format")` that resolves against the temp
      // directory. Its `module` entry is the same package without that
      // indirection.
      mainFields: ["module", "main"],
      logLevel: "silent",
    });
  }
  const require = createRequire(import.meta.url);
  const loaded = {};
  for (const [name, file] of names) loaded[name] = require(file);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "runner", "tools", "turn-toolset.ts"],
]);

const {
  buildTurnTools,
  createTurnFileTransferToolFactory,
  createTurnMcpMetaToolFactory,
  createTurnSubagentManagementToolFactory,
  createTurnToolsetFactoriesForTurn,
  liveMcpToolsForTurn,
} = loaded["turn-toolset.cjs"];

test.after(() => dispose());

const AUTO_REVIEW_MODES_OFF = {
  hostShell: "off",
  boxShell: "off",
  mcp: "off",
  computer: "off",
  automationWrite: "off",
  cloudAgent: "off",
  subagentLaunch: "off",
};

/** The per-turn resource accessor: only the identity lookups are exercised here. */
const RESOURCE_ACCESSOR = { get: () => ({}) };

function makeProps(overrides = {}) {
  return {
    resourceAccessor: RESOURCE_ACCESSOR,
    stateHandler: {},
    toolSession: {},
    config: {},
    summarizationHandler: {},
    parentModelInfo: {},
    subagentModels: [],
    subagentConfigs: [],
    fencedToolSet: {},
    staticTools: [],
    dynamicTools: [],
    ...overrides,
  };
}

function makeHost(factories, overrides = {}) {
  return {
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    isComputerUseSubagent: false,
    isBrowserUseSubagent: false,
    isSystemPromptOverridden: false,
    remoteBoxHasDesktop: true,
    getConversationId: () => "agent-under-test",
    getRemoteBoxAvailable: () => true,
    cloudAgentsDisabledByTeam: () => false,
    spotlightEnabled: () => false,
    isDynamicToolsEnabled: () => false,
    isMultitaskEnabled: () => false,
    factories,
    ...overrides,
  };
}

function toolNames(host, turn, props) {
  return buildTurnTools(host, turn, props).getAllTools().map((tool) => tool.name);
}

const BASE_TURN = { autoReviewModes: AUTO_REVIEW_MODES_OFF, subagentConfigs: [] };

test("a production provider now builds the file transfer and subagent management families", () => {
  // The exact factory inputs the host supplies: both endpoints of a file
  // transfer are live ports (the box and the local-exec computer bridge), and
  // the subagent controller is the session runner's own.
  const transferred = [];
  const agentBox = {
    downloadFile: async (_ctx, _agentId, filePath) => {
      transferred.push(`download:${filePath}`);
      return new Uint8Array([1, 2, 3]);
    },
    uploadFile: async (_ctx, _agentId, filePath) => {
      transferred.push(`upload:${filePath}`);
    },
  };
  const provider = {
    createFileTransferToolInputs: () => ({
      controller: {
        agentBox,
        userComputers: {
          resolve: () => ({
            id: "computer-1",
            label: "this computer",
            connected: true,
            box: agentBox,
          }),
          list: () => [
            { id: "computer-1", label: "this computer", connected: true, box: agentBox },
          ],
        },
        getComputerAgentId: () => "agent-under-test",
        getBoxId: () => "agent-under-test",
        isBoxPreparing: () => false,
      },
    }),
    createSubagentManagementToolInputs: () => ({
      controller: {
        listRunningSubagents: () => [],
        getRunningSubagent: () => undefined,
        steerSubagent: () => "not-running",
        abortSubagent: () => "not-running",
      },
    }),
  };

  const factories = createTurnToolsetFactoriesForTurn(provider, BASE_TURN, undefined);
  assert.equal(typeof factories.fileTransfer, "function", "the file transfer factory was never created from the provider slot");
  assert.equal(typeof factories.subagentManagement, "function", "the subagent management factory was never created from the provider slot");

  const names = toolNames(
    makeHost(factories, { getRemoteBoxAvailable: () => true }),
    BASE_TURN,
    makeProps(),
  );
  for (const expected of ["CopyToBox", "CopyFromBox", "CheckSubagent", "MessageSubagent", "StopSubagent"]) {
    assert.ok(names.includes(expected), `the turn was built without ${expected}; it carried ${JSON.stringify(names)}`);
  }
  assert.deepEqual(transferred, [], "building the toolset must not copy any bytes");
});

test("the MCP pair stays absent on a box whose turn has no live MCP server", () => {
  // `props.mcp` is never projected in production, so the pair used to have no
  // way to switch itself on at all. It must now be driven by the Agent's own
  // per-turn snapshot — and an empty one means no servers, so no tool.
  const factories = {
    mcpMeta: createTurnMcpMetaToolFactory({
      resourceAccessor: RESOURCE_ACCESSOR,
      getMcpTools: () => [],
      callOptions: {},
    }),
  };

  const names = toolNames(makeHost(factories), BASE_TURN, makeProps({ mcpTools: [] }));
  assert.ok(!names.includes("GetMcpTools"), `an always-empty GetMcpTools was offered on a box with no MCP server: ${JSON.stringify(names)}`);
  assert.ok(!names.includes("CallMcpTool"), `CallMcpTool was offered with nothing to call: ${JSON.stringify(names)}`);
});

test("the MCP pair appears as soon as the turn's own snapshot names a live server tool", () => {
  const liveTool = {
    providerIdentifier: "linear",
    toolName: "create_issue",
    description: "Create an issue",
    inputSchema: { type: "object", properties: {} },
  };
  const factories = {
    mcpMeta: createTurnMcpMetaToolFactory({
      resourceAccessor: RESOURCE_ACCESSOR,
      getMcpTools: () => liveMcpToolsForTurn(BASE_TURN, makeProps({ mcpTools: [liveTool] })),
      callOptions: {},
    }),
  };

  const names = toolNames(makeHost(factories), BASE_TURN, makeProps({ mcpTools: [liveTool] }));
  assert.ok(names.includes("GetMcpTools"), `the discovery tool stayed absent with one live MCP server tool: ${JSON.stringify(names)}`);
  assert.ok(names.includes("CallMcpTool"), `the call tool stayed absent with one live MCP server tool: ${JSON.stringify(names)}`);
});

test("request-context rows without a provider are not mistaken for MCP servers", () => {
  // The Agent hands the generator one merged list: MCP tools plus rows from the
  // request context. Treating the latter as servers would put an empty
  // GetMcpTools back on a box that has none.
  const merged = [
    { name: "some_request_context_tool", description: "not an MCP server tool" },
    null,
    "not an object",
    { providerIdentifier: "linear" },
  ];
  assert.deepEqual(
    liveMcpToolsForTurn(BASE_TURN, makeProps({ mcpTools: merged })),
    [],
    "a merged request-context row was counted as a live MCP server tool",
  );
  assert.deepEqual(
    liveMcpToolsForTurn(BASE_TURN, undefined),
    [],
    "a turn with no props at all reported live MCP servers",
  );
});

test("the turn reports its own toolset so the system prompt can describe exactly it", () => {
  // `systemPromptGenerator(args, toolSetHandle)` is called with the handle the
  // Agent just built, so the report has to come from `buildTurnTools` itself.
  const reported = [];
  const factories = {
    fileTransfer: createTurnFileTransferToolFactory({
      controller: {
        agentBox: { downloadFile: async () => new Uint8Array(), uploadFile: async () => {} },
        userComputers: {
          resolve: () => undefined,
          list: () => [
            {
              id: "computer-1",
              label: "this computer",
              connected: true,
              box: { downloadFile: async () => new Uint8Array(), uploadFile: async () => {} },
            },
          ],
        },
        getComputerAgentId: () => "agent-under-test",
        getBoxId: () => "agent-under-test",
        isBoxPreparing: () => false,
      },
    }),
  };

  const names = toolNames(
    makeHost(factories),
    { ...BASE_TURN, onToolsetBuilt: toolNames_ => reported.push([...toolNames_]) },
    makeProps(),
  );

  assert.equal(reported.length, 1, "the turn never told the prompt what it carries");
  assert.deepEqual(
    reported[0],
    names,
    "the reported toolset differs from the toolset the handle actually carries, so the prompt would describe a different turn",
  );
  assert.ok(reported[0].includes("CopyToBox"), "the representative of the file transfer family was not reported, so the prompt could never enable its section");
});

test("Screenshot and GenerateImage are still absent, and the file transfer gate still holds", () => {
  // Both stay absent on purpose. The reconstructed box has no monitor at all —
  // `createProductionBoxInner` wraps every accessor in `withNoMonitorComputerUse`
  // — so a Screenshot would fail on every call, and there is no image provider
  // behind GenerateImage. The file transfer family, by contrast, is real and
  // must survive a box that is merely unavailable.
  const factories = {
    fileTransfer: createTurnFileTransferToolFactory({
      controller: {
        agentBox: { downloadFile: async () => new Uint8Array(), uploadFile: async () => {} },
        userComputers: {
          resolve: () => undefined,
          list: () => [
            {
              id: "computer-1",
              label: "this computer",
              connected: true,
              box: { downloadFile: async () => new Uint8Array(), uploadFile: async () => {} },
            },
          ],
        },
        getComputerAgentId: () => "agent-under-test",
        getBoxId: () => "agent-under-test",
        isBoxPreparing: () => false,
      },
    }),
    screenshot: () => ({ id: "SCREENSHOT", name: "Screenshot", execute: async () => "" }),
    generateImage: () => ({ id: "GENERATE_IMAGE", name: "GenerateImage", execute: async () => "" }),
  };

  const available = toolNames(makeHost(factories), BASE_TURN, makeProps());
  assert.ok(available.includes("Screenshot"), "the Screenshot placement gate changed without a monitor to satisfy it");
  assert.ok(available.includes("GenerateImage"), "the GenerateImage placement gate changed without an image provider behind it");

  const unavailable = toolNames(
    makeHost(factories, { getRemoteBoxAvailable: () => false }),
    BASE_TURN,
    makeProps(),
  );
  assert.ok(!unavailable.includes("CopyToBox"), "CopyToBox was offered while the box was unavailable");
  assert.ok(!unavailable.includes("Screenshot"), "Screenshot was offered while the box was unavailable");
});

test("the file transfer family stays absent while no computer is connected", () => {
  // Measured on this box: ExternalRead answers "your computer isn't connected
  // right now (the Grok Bot desktop app needs to be open and online)". Every
  // CopyToBox/CopyFromBox call would hit that same missing endpoint, so the
  // family must be gated on a live computer rather than offered as two tools
  // that can only fail.
  const agentBox = { downloadFile: async () => new Uint8Array(), uploadFile: async () => {} };
  const controller = (computers) => ({
    agentBox,
    userComputers: { resolve: () => undefined, list: () => computers },
    getComputerAgentId: () => "agent-under-test",
    getBoxId: () => "agent-under-test",
    isBoxPreparing: () => false,
  });

  const disconnected = toolNames(
    makeHost({ fileTransfer: createTurnFileTransferToolFactory({ controller: controller([]) }) }),
    BASE_TURN,
    makeProps(),
  );
  assert.ok(!disconnected.includes("CopyToBox"), `CopyToBox was offered with no connected computer: ${JSON.stringify(disconnected)}`);
  assert.ok(!disconnected.includes("CopyFromBox"), `CopyFromBox was offered with no connected computer: ${JSON.stringify(disconnected)}`);

  const offline = toolNames(
    makeHost({
      fileTransfer: createTurnFileTransferToolFactory({
        controller: controller([
          { id: "computer-1", label: "this computer", connected: false, box: agentBox },
        ]),
      }),
    }),
    BASE_TURN,
    makeProps(),
  );
  assert.ok(!offline.includes("CopyToBox"), "CopyToBox was offered while the only connected computer had gone offline");

  const reconnected = toolNames(
    makeHost({
      fileTransfer: createTurnFileTransferToolFactory({
        controller: controller([
          { id: "computer-1", label: "this computer", connected: true, box: agentBox },
        ]),
      }),
    }),
    BASE_TURN,
    makeProps(),
  );
  assert.ok(reconnected.includes("CopyToBox"), `the family did not come back when a computer connected: ${JSON.stringify(reconnected)}`);
});

test("the host actually supplies the factories the toolset was missing", () => {
  // Everything above proves the builder honours a factory. The defect lived one
  // level up: the live provider — the only one production ever builds, created
  // by `createTurnToolsetFactoryProvider` with no per-turn inputs — had no slot
  // for these families at all. This guard reads the composition source and
  // fails when a slot disappears, and the counter proves it found something
  // rather than matching nothing and passing.
  const source = readFileSync(
    path.join(repoRoot, "source", "host", "host-runner-composition.ts"),
    "utf8",
  );
  const required = [
    "createFileTransferToolInputs",
    "createSubagentManagementToolInputs",
    "createMcpMetaToolInputs",
    "isToolAvailable:",
    "onToolsetBuilt:",
    "createHostFileTransferController",
    "mcpExecutorResource",
    "liveMcpToolsForTurn",
  ];
  let found = 0;
  const missing = [];
  for (const needle of required) {
    if (source.includes(needle)) found += 1;
    else missing.push(needle);
  }
  assert.equal(found, required.length, `the host composition lost these provider slots: ${JSON.stringify(missing)}`);
  assert.ok(found > 0, "the static guard matched nothing, so it proves nothing");
});