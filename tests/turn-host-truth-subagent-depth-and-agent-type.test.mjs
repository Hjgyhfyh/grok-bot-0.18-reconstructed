/**
 * Three host facts that were quietly false, each of which cost an investigation:
 *
 *  1. `turn-run-shell.ts` declared `discoverMcpTools`, called it from the middle
 *     of `run()`, and no host has ever assigned it. The block never ran, the
 *     tool list it was supposed to publish stayed undefined, and the three hooks
 *     it fed were unreachable. It is the block that sent the "why do local MCP
 *     servers disappear" hunt into this file instead of into the one place MCP
 *     is actually discovered. There is exactly one live discovery path —
 *     `TurnAgentMcpTurnProvider.getTools()` inside
 *     `createTurnAgentRunInputProjection` — and it now has to carry the whole
 *     obligation, account refresh included, or the guard below fails.
 *
 *  2. `SubagentAdapterArgs` had no depth, so nothing at the place that actually
 *     mints a subagent could say how deep it was minting one. The nesting cap
 *     was carried entirely by a `scope.isSubagentRunner` flag in another file.
 *     The depth is now a field the adapter fills in, enforces against
 *     `SAND_MAX_SUBAGENT_DEPTH` and hands to `createSubagentRunner`. The limits
 *     themselves are unchanged: depth 1, four live subagents.
 *
 *  3. The host set `agentType: "IDE"` for every runner, subagents included.
 *     `"IDE"` is not a member of the `AgentType` enum (`"ide"`, `"cli"`,
 *     `"background"`, `"bugbot"`), so `parseAgentType` answered `undefined` for
 *     every turn this build ever ran and every reader keyed on the real value
 *     was reading a field that could only be empty. The worst consequence is
 *     `isBackgroundAgent` in `create-shell-tool.ts:391`: a Task subagent ran the
 *     same interactive Auto-review classifier as a turn with the user watching,
 *     and it would have stopped to ask for an approval nobody can give it.
 *
 * The classifier proof is measured, not asserted from the source: the test drives
 * the real `createTurnAgentToolsHandoff` -> `buildTurnTools` -> `createShellTool`
 * chain, runs the Shell tool, and watches whether the resource accessor was ever
 * asked for the classifier executor.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-turn-host-truth-"));
  const source = relative =>
    JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { createSandAgentStaticConfig, createTurnAgentToolsHandoff, createTurnAgentRunInputProjection, resolveSandAgentType, SAND_MAX_ACTIVE_SUBAGENTS, SAND_MAX_SUBAGENT_DEPTH } from ${source(["host", "runner", "turn-agent-composition.ts"])};`,
    `export { SandSubagentDispatchError, SandSubagentHostAdapter } from ${source(["host", "runner", "agent-adapters.ts"])};`,
    `export { AgentType } from ${source(["packages", "agent", "utils", "agent-config.js"])};`,
    `export { parseAgentType } from ${source(["packages", "agent", "state-agent-type.js"])};`,
    `export { shellStreamExecutorResource, smartModeClassifierExecutorResource } from ${source(["packages", "agent-exec", "index.js"])};`,
    `export { SAND_BOX_SHELL_TOOL_NAME, SAND_EXTERNAL_SHELL_TOOL_NAME } from ${source(["shared", "agents", "agent-tool-names.js"])};`,
    `export { createContext } from ${source(["packages", "context", "core.js"])};`,
    `export { SmartModeClassifierArgs, SmartModeClassifierResult, SmartModeClassifierSuccess, SmartModeClassifierDecision } from ${source(["packages", "proto", "generated", "agent", "v1", "smart_mode_classifier_exec_pb.js"])};`,
    `export { SubagentType } from ${source(["packages", "proto", "generated", "agent", "v1", "subagents_pb.js"])};`,
    `export { ShellStream, ShellStreamExit } from ${source(["packages", "proto", "generated", "agent", "v1", "shell_exec_pb.js"])};`,
  ].join("\n"), "utf8");
  const outfile = path.join(directory, "entry.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    banner: {
      js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const {
  createSandAgentStaticConfig,
  createTurnAgentToolsHandoff,
  createTurnAgentRunInputProjection,
  resolveSandAgentType,
  SAND_MAX_ACTIVE_SUBAGENTS,
  SAND_MAX_SUBAGENT_DEPTH,
  SandSubagentDispatchError,
  SandSubagentHostAdapter,
  AgentType,
  parseAgentType,
  shellStreamExecutorResource,
  smartModeClassifierExecutorResource,
  createContext,
  SmartModeClassifierResult,
  SmartModeClassifierSuccess,
  SmartModeClassifierDecision,
  SAND_BOX_SHELL_TOOL_NAME,
  SAND_EXTERNAL_SHELL_TOOL_NAME,
  SubagentType,
  ShellStream,
  ShellStreamExit,
} = loaded;

test.after(() => dispose());

const readSource = (...parts) =>
  readFileSync(path.join(repoRoot, "source", ...parts), "utf8");

/**
 * Drops the leading-comment forms only. The guard has to be able to say "this
 * module still talks about the dead hook" without failing on the comment that
 * explains why it was deleted.
 */
const stripLeadingComments = (source) =>
  source.replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* 1. MCP has exactly one discovery path, and it is the live one.      */
/* ------------------------------------------------------------------ */

function mcpProjectionFixture() {
  const calls = { getTools: 0, refreshed: 0, failures: [] };
  const mcp = {
    async getTools() {
      calls.getTools += 1;
      return [
        { providerIdentifier: "server-a", toolName: "Search" },
        { providerIdentifier: "server-b", toolName: "Fetch" },
      ];
    },
    refreshAccountConfig() {
      calls.refreshed += 1;
    },
  };
  return { calls, mcp };
}

test("the live MCP provider still discovers the turn's tools and refreshes the account", async () => {
  const { calls, mcp } = mcpProjectionFixture();
  const projection = await createTurnAgentRunInputProjection({
    runCtx: createContext(),
    async createAction() {
      return { action: { case: "userMessageAction" } };
    },
    mcp,
    onMcpDiscoveryFailed: (error) => calls.failures.push(error),
    getConversationState: () => ({ toBinary: () => new Uint8Array() }),
  });
  assert.deepEqual(
    projection.mcpTools.map((tool) => tool.providerIdentifier),
    ["server-a", "server-b"],
    "provider order is part of the contract: it is the order the model was offered",
  );
  assert.equal(calls.getTools, 1, "discovery runs once per turn, not once per retry");
  assert.equal(
    calls.refreshed,
    1,
    "the account refresh the deleted block performed still happens on this path, or reconnecting MCP silently stops",
  );
  assert.deepEqual(
    calls.failures,
    [],
    "nothing failed, so the failure callback must stay untouched",
  );
});

test("a discovery failure still yields a tool list and still refreshes the account", async () => {
  const calls = { failures: [], refreshed: 0 };
  const failure = new Error("mcp discovery unavailable");
  const projection = await createTurnAgentRunInputProjection({
    runCtx: createContext(),
    async createAction() {
      return { action: { case: "userMessageAction" } };
    },
    mcp: {
      async getTools() {
        throw failure;
      },
      refreshAccountConfig() {
        calls.refreshed += 1;
      },
    },
    onMcpDiscoveryFailed: (error) => calls.failures.push(error),
    getConversationState: () => ({ toBinary: () => new Uint8Array() }),
  });
  assert.deepEqual(
    projection.mcpTools,
    [],
    "a failed discovery must offer no tools rather than a stale or invented list",
  );
  assert.deepEqual(
    calls.failures,
    [failure],
    "the failure has to reach the host by identity, or the turn reports a healthy MCP surface",
  );
  assert.equal(
    calls.refreshed,
    1,
    "the account config is refreshed even when discovery failed; that is what reconnects a server",
  );
});

test("turn-run-shell keeps no second MCP discovery path", () => {
  const shellSource = stripLeadingComments(readSource("host", "runner", "turn-run-shell.ts"));
  const compositionSource = readSource("host", "runner", "turn-agent-composition.ts");
  assert.equal(
    (shellSource.match(/discoverMcpTools/g) ?? []).length,
    0,
    "the shell must not even name the dead hook outside a comment: a name is an invitation to wire a second source of truth",
  );
  assert.equal(
    (shellSource.match(/noteMcpToolDiscoveryFailed|refreshMcpAccountConfig|setMcpConnectedServerNamesForTurn/g) ?? []).length,
    0,
    "the hooks only the dead block called must be gone with it",
  );
  assert.equal(
    (shellSource.match(/readonly mcpTools\?/g) ?? []).length,
    0,
    "the context field the dead block filled had no reader; keeping it would hide the next dead path",
  );
  assert.equal(
    (compositionSource.match(/input\.mcp\.getTools\(/g) ?? []).length,
    1,
    "there has to be exactly ONE discovery call in the whole turn path, or the guard below is measuring nothing",
  );
});

/* ------------------------------------------------------------------ */
/* 2. A subagent knows how deep it is, and the cap is unchanged.       */
/* ------------------------------------------------------------------ */

function createDispatcherStub() {
  const dispatched = [];
  const released = [];
  return {
    dispatched,
    released,
    isRunning: () => false,
    allocateComputerUseWindow: () => ({}),
    freeComputerUseWindow: (id) => released.push(id),
    dispatch: (args) => dispatched.push(args),
  };
}

test("the adapter mints a subagent at depth 1 and hands that depth to the runner factory", async () => {
  const created = [];
  const adapter = new SandSubagentHostAdapter(
    new Map(),
    (id, args) => {
      created.push({ id, args });
      return { run: async () => ({ text: "" }), interrupt() {} };
    },
    createDispatcherStub(),
    { depth: 0, maxDepth: SAND_MAX_SUBAGENT_DEPTH },
  );
  const agentId = await adapter.createOrResumeSession(createContext(), {
    subagentType: "generalPurpose",
    toolCallId: "call-1",
    prompt: "go",
  });
  assert.equal(
    created.length,
    1,
    "a Task dispatch from the user-facing agent must still mint its subagent",
  );
  assert.equal(
    created[0].args.subagentDepth,
    1,
    "the depth is the value the factory is asked to enforce against, so it has to arrive with the dispatch",
  );
  assert.equal(
    adapter.subagentDepthOf(agentId),
    1,
    "a resumed session must report the depth it was minted at, not one recomputed from the caller",
  );
});

test("a subagent that reaches Task anyway is refused with the depth limit in the sentence", async () => {
  let created = 0;
  const adapter = new SandSubagentHostAdapter(
    new Map(),
    () => {
      created += 1;
      return { run: async () => ({ text: "" }), interrupt() {} };
    },
    createDispatcherStub(),
    { depth: 1, maxDepth: SAND_MAX_SUBAGENT_DEPTH },
  );
  await assert.rejects(
    adapter.createOrResumeSession(createContext(), {
      subagentType: "generalPurpose",
      toolCallId: "call-2",
      prompt: "go deeper",
    }),
    (error) =>
      error instanceof SandSubagentDispatchError
      && error.message.includes(`nesting depth is limited to ${SAND_MAX_SUBAGENT_DEPTH}`),
    "nesting must be refused by the adapter that owns the depth, with the limit named",
  );
  assert.equal(
    created,
    0,
    "no runner may be built for a refused dispatch, or the guard only moved the failure",
  );
});

test("the depth and concurrency caps are the ones this build already shipped", () => {
  assert.equal(
    SAND_MAX_SUBAGENT_DEPTH,
    1,
    "adding a depth field must not widen the cap; one level of Task is the product decision",
  );
  assert.equal(
    SAND_MAX_ACTIVE_SUBAGENTS,
    4,
    "the live-subagent cap is unchanged too",
  );
});

/* ------------------------------------------------------------------ */
/* 3. A subagent is a background agent, and really skips the classifier */
/* ------------------------------------------------------------------ */

function staticConfigFixture(isSubagentRunner) {
  return createSandAgentStaticConfig({
    modelId: "test-model",
    agentTokenLimit: 200_000,
    conversationId: "aaaaaaaa-0000-4000-8000-000000000001",
    isBoxScopedSubagent: false,
    isSubagentRunner,
    isSharedRoomRunner: false,
    sandSendMessageDeliveryOwed: true,
    systemPromptGenerator: () => "",
    toolsGenerator: () => [],
  });
}

test("the Agent config carries an agent type every reader can parse", () => {
  const parent = staticConfigFixture(false);
  const subagent = staticConfigFixture(true);
  assert.equal(
    parseAgentType(parent.agentType),
    AgentType.IDE,
    "`\"IDE\"` was never an AgentType, so parseAgentType answered undefined for every turn this host ran",
  );
  assert.equal(
    parseAgentType(subagent.agentType),
    AgentType.BACKGROUND,
    "a Task subagent runs unattended, which is exactly what AgentType.BACKGROUND means",
  );
  assert.equal(
    parent.agentType,
    resolveSandAgentType(false),
    "the config and the resolver must not drift; two sources of truth is the defect this file is about",
  );
  assert.equal(
    subagent.agentType,
    resolveSandAgentType(true),
    "the config and the resolver must not drift for a subagent either",
  );
});

/**
 * Runs one Shell tool call through the real per-turn tool host and reports
 * whether the interactive classifier was consulted. The observable is the
 * resource accessor: `runShellSmartModeClassifier` is the only reader of
 * `smartModeClassifierExecutorResource` on this path.
 */
async function runShellAndReportClassifierUse(isSubagentRunner) {
  const asked = [];
  const classifier = {
    async execute() {
      return new SmartModeClassifierResult({
        result: {
          case: "success",
          value: new SmartModeClassifierSuccess({
            decision: SmartModeClassifierDecision.ALLOW,
          }),
        },
      });
    },
  };
  // A shell that finishes immediately, so the call resolves instead of leaving a
  // rejection floating past the test that owns the measurement.
  const shellExecutor = {
    async *execute() {
      yield new ShellStream({
        event: {
          case: "exit",
          value: new ShellStreamExit({ code: 0, localExecutionTimeMs: 1 }),
        },
      });
    },
  };
  const resourceAccessor = {
    get(key) {
      if (key === shellStreamExecutorResource) return shellExecutor;
      if (key === smartModeClassifierExecutorResource) {
        asked.push("smartModeClassifierExecutorResource");
        return classifier;
      }
      return undefined;
    },
  };
  // The box surface stays unbound on purpose: this test is about the host
  // Shell tool, and a second accessor would give the fixture two ways to pass.
  const remoteBoxResourceAccessor = { get: () => undefined };
  const toolHost = {
    isSubagentRunner,
    isSharedRoomRunner: false,
    isBoxScopedSubagent: false,
    isComputerUseSubagent: false,
    isBrowserUseSubagent: false,
    isSystemPromptOverridden: false,
    remoteBoxHasDesktop: false,
    getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true,
    isDynamicToolsEnabled: () => false,
    spotlightEnabled: () => false,
    getConversationId: () => "aaaaaaaa-0000-4000-8000-000000000001",
    factories: {},
    factoryProvider: {},
  };
  const handoff = createTurnAgentToolsHandoff({
    toolHost,
    turn: {
      autoReviewModes: { hostShell: "enforce", boxShell: "enforce" },
      // A subagent is fenced to an empty toolset when the catalogue is absent,
      // which is the composition's other depth guard. One entry keeps the Shell
      // surface real for both cases.
      subagentConfigs: [
        {
          subagent_type: new SubagentType(),
          description: "the one entry that keeps the Task catalogue real",
          preserveTaskTool: false,
        },
      ],
      remoteBoxResourceAccessor,
      mcpTools: [],
    },
  });
  const handle = handoff.toolsGenerator({
    resourceAccessor,
    parentModelInfo: { isComposer1: false, isComposer15: false },
    hostDependencies: {
      autoReview: {
        getModes: () => ({
          hostShell: "enforce",
          boxShell: "enforce",
          mcp: "enforce",
          computer: "off",
          automationWrite: "off",
          cloudAgent: "off",
          subagentLaunch: "off",
        }),
        getInstructions: () => undefined,
        agentId: "aaaaaaaa-0000-4000-8000-000000000001",
        requestContext: { env: { smartModeClassifierAutoModeEnabled: true } },
        getApprovalExpiryPolicy: () => ({}),
      },
    },
  });
  const hostShellTool = handle
    .getAllTools()
    .find((tool) => tool.name === SAND_EXTERNAL_SHELL_TOOL_NAME);
  assert.equal(
    handle.getAllTools().some((tool) => tool.name === SAND_BOX_SHELL_TOOL_NAME),
    false,
    "the fixture must not offer a box Shell surface, or it is proving the wrong one",
  );
  assert.equal(
    hostShellTool !== undefined,
    true,
    "the host Shell surface has to be offered, or this test measures nothing",
  );
  const context = createContext();
  // The Agent calls tools with a stream of JSON argument chunks, not an object
  // (`common.ts:210` drains the stream before parsing).
  async function* argumentChunks() {
    yield JSON.stringify({ command: "git status" });
  }
  // Execution is allowed to fail here — the stubbed shell stream cannot produce
  // a result. The parent assertion below is the control that proves the call got
  // far enough to be a measurement at all: if the tool died before the
  // classifier, the parent would also report no classifier use.
  await hostShellTool
    .execute(
      context,
      {
        getAbortSignal: () => ({ aborted: false }),
        emitPartialToolCall: async () => {},
        executeToolCall: async (_ctx, _call, _id, run) => {
          try {
            return await run(context);
          } catch {
            // The stubbed shell stream cannot produce a result. Contain the
            // failure inside the stub: an escaping rejection would surface as
            // async activity after the test ended, which hides the real result.
            return {};
          }
        },
      },
      argumentChunks(),
      { toolCallId: "call-1", workspacePaths: [] },
    )
    .then(
      () => undefined,
      () => undefined,
    );
  return { classifierConsulted: asked.length > 0, asked };
}

test("a subagent's Shell call never reaches the interactive Auto-review classifier", async () => {
  const parent = await runShellAndReportClassifierUse(false);
  const subagent = await runShellAndReportClassifierUse(true);
  assert.equal(
    parent.classifierConsulted,
    true,
    "an interactive turn with Auto-review in enforce mode must still consult the classifier, or this fix silently disabled review for the user",
  );
  assert.equal(
    subagent.classifierConsulted,
    false,
    "a Task subagent has nobody to answer an approval card, so it must not enter the interactive classifier",
  );
});
