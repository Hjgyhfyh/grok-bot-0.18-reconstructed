import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The agent used to tell the user it could do nothing but generate text, and it was telling the
 * truth about the request it had actually received.
 *
 * Two separate defects produced that answer, and only one of them was upstream of every prompt in
 * the repository.
 *
 * The first was interception. For any provider except `cursor`,
 * `createCoordinatorInferenceRouter` claimed `sendPrompt` for itself, flattened the transcript
 * into bare role/content messages, and called `runRoutedProviderText` with the routed MCP tool
 * list as its only tool source. With no connectors connected that list is empty, `toToolSet` turns
 * an empty array into `undefined`, and the request goes out with no `tools` key at all and
 * `GROK_ROUTER_SYSTEM_PROMPT` -- four lines that describe no capability -- as the only system
 * text. A raw chat completion, reached through the Grok Bot UI, is exactly a bot with no hands.
 * That route now declines the turn: it runs no model completion over the conversation, offers no
 * tool list, and asks for one thing only, a conversation title. The turn itself is the agent on
 * the box, with its own prompt and its own toolset.
 *
 * The second was dishonesty in the prompt itself. A request captured off
 * `https://opencode.ai/zen/go/v1` carried 28 tools and a 74853-character system prompt, and that
 * prompt named nine tools the request did not carry -- CopyToBox, CopyFromBox, GetMcpTools,
 * CallMcpTool, Screenshot, GenerateImage, CheckSubagent, MessageSubagent and StopSubagent. Asked
 * in Russian what it could do, the model then listed them as its own tools, which is the symptom
 * that was reported. The prompt is now conditioned on the turn's own toolset: a fully wired agent
 * is told about every tool it carries, and a turn with no toolset to consult is told about no
 * optional family rather than about all of them.
 *
 * Nothing noticed because every half of the product was individually healthy: the agent runner
 * sent a correct prompt with a correct toolset, and the routed provider was a working text
 * completion. Only the composition was broken. These tests prove both halves, so a future trim
 * to the agent prompt cannot be mistaken for this bug again, and so the routed path cannot
 * silently lose its last remaining capability text.
 *
 * A third defect sat alongside both of these and was not covered by either test, because both
 * only ever checked the presence of a name: `buildSandBaseSystemPrompt` was given capability
 * flags for `mcpTools`, `screenshot`, `fileTransfer` and `subagentManagement` and used them, but
 * `mcpManagement`, `cloudAgent` and `boxDesktop` existed and went unread. So a turn with no
 * Cursor account was taught SearchPlugins, AuthenticateMcpServer, Computer, request_box_help and
 * the whole cloud-agent handoff — and the fallback text blamed the user's team for a tool that
 * needs an account they never signed into. The `ALWAYS_ON_TOOLS` comment below used to cite that
 * unconditional teaching as the reason to list two MCP management tools as always present, so
 * this file enforced the defect as if it were the contract. Both directions are now asserted
 * instead: present when the turn carries them, absent when it does not.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-selfdesc-"));
  // The Claude Code SDK is only reachable from the claude-code executor, and it ships
  // native bindings this repository does not install. A stub keeps the bundle buildable
  // without touching the code path under test; if anything ever did call it, the stub
  // throws instead of silently succeeding.
  const claudeSdkStub = path.join(directory, "claude-agent-sdk-stub.mjs");
  writeFileSync(
    claudeSdkStub,
    "export const query = () => { throw new Error('the Claude Code SDK is not under test'); };\n",
    "utf8",
  );
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
      alias: { "@anthropic-ai/claude-agent-sdk": claudeSdkStub },
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "runner", "system-prompt.ts"],
  ["host", "runner", "system-prompt-assembly.ts"],
  ["host", "extensions", "inference", "provider-session.ts"],
]);
const { DEFAULT_SAND_SYSTEM_PROMPT, SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED } = loaded["system-prompt.mjs"];
const { createSystemPromptAssembly } = loaded["system-prompt-assembly.mjs"];
const { runRoutedProviderText } = loaded["provider-session.mjs"];

test.after(() => dispose());

/**
 * The tools a fully wired agent turn actually carries. The 28 tools the live capture off
 * `https://opencode.ai/zen/go/v1` recorded are a subset of this and a strictly poorer one: none
 * of the optional families below were among them. This set is what a turn looks like when the
 * box really does project its MCP and file-transfer tools, and every name in it has to be
 * described, because a prompt that describes less makes an agent deny its own hands.
 */
const WIRED_AGENT_TOOLS = new Set([
  "SendMessage",
  "CreateAgent",
  "UpdateAgent",
  "SendToAgent",
  "ReactToMessage",
  "Task",
  "Shell",
  "Read",
  "ExternalShell",
  "ExternalRead",
  "WebSearch",
  "WebFetch",
  "SearchPlugins",
  "AuthenticateMcpServer",
  "GetMcpTools",
  "CallMcpTool",
  "CopyToBox",
  "CopyFromBox",
  "Screenshot",
  "GenerateImage",
  "CheckSubagent",
  "MessageSubagent",
  "StopSubagent",
]);

/**
 * Tools no turn is ever without, so conditioning on the toolset must never silence them.
 *
 * SearchPlugins and AuthenticateMcpServer used to sit in this list, and the comment beside them
 * gave the reason: "it was among the 28 tools the live capture carried, and the 'no connector'
 * section of the base prompt teaches it unconditionally." Both are MCP *management* tools —
 * `UNAVAILABLE_TOOL_NAMES` in system-prompt-assembly.ts puts them in the `mcpManagement` family
 * and declares their names must never reach a prompt whose turn lacks that family — and the base
 * prompt taught them unconditionally anyway. So the reason was the defect, restated as a
 * justification, and this list enforced it. They moved to `ACCOUNT_GATED_TOOLS` below, where both
 * directions are asserted: a wired turn must still be told about them, and a turn with no toolset
 * to consult must not be.
 */
const ALWAYS_ON_TOOLS = [
  "CreateAgent",
  "UpdateAgent",
  "SendToAgent",
  "ReactToMessage",
  "Task",
  "Shell",
  "Read",
  "ExternalShell",
  "ExternalRead",
  "WebSearch",
  "WebFetch",
];

/**
 * Tools that need a signed-in Cursor account: registered by `mcp.management` only, so absent from
 * every turn on a host that has none. They are named by the base prompt exactly when the turn's
 * own toolset carries them.
 */
const ACCOUNT_GATED_TOOLS = ["SearchPlugins", "AuthenticateMcpServer"];

/**
 * The optional families, named by hand rather than read out of the product's own list. A test
 * that imported `unavailableToolNames` would stop checking a name the day the product dropped it
 * from that list -- which is exactly the change it exists to catch. These nine are exactly the
 * names the live capture's prompt promised and its 28-tool request did not carry.
 */
const OPTIONAL_FAMILY_TOOLS = [
  "GetMcpTools",
  "CallMcpTool",
  "CopyToBox",
  "CopyFromBox",
  "Screenshot",
  "GenerateImage",
  "CheckSubagent",
  "MessageSubagent",
  "StopSubagent",
];

/**
 * Assembles the prompt exactly the way `host-runner-composition.ts` does for a main
 * agent turn: the shipped base prompt, an agent store, and the agent-management pair
 * that unlocks the agent-directory section. Every optional store is null exactly as
 * the production composition passes them, so the result is the prompt the model
 * actually receives rather than a hand-picked excerpt.
 *
 * `toolset` is the turn's own tool list, handed to the assembly the way the runner hands it, so
 * the prompt is rendered for the tools this turn really carries. `null` is the case that
 * matters most: no toolset to consult at all.
 */
function assembleMainAgentPrompt({ basePrompt = DEFAULT_SAND_SYSTEM_PROMPT, toolset = WIRED_AGENT_TOOLS } = {}) {
  const assembly = createSystemPromptAssembly({
    basePrompt,
    isSubagentRunner: false,
    isSharedRoomRunner: false,
    isSystemPromptOverridden: false,
    agentProfileProvider: () => ({ name: "Grok", description: "", filePath: "", settingsFilePath: "" }),
    agentStore: () => ({ getMetadata: (key) => (key === "name" ? "Grok" : "") }),
    compactionEpoch: () => 0,
    memoryStore: () => null,
    memorySnapshots: () => null,
    userMemory: () => null,
    projectMemory: () => null,
    isBoxScopedSubagent: () => false,
    requestContext: { resolve: () => ({ timeZone: "UTC" }) },
    automationStore: () => null,
    workflowStore: () => null,
    channelStore: () => null,
    connectorManifests: [],
    sendToAgentImpl: () => undefined,
    agentManagement: () => undefined,
    agentDirectory: () => [],
    agentGroups: () => [],
    agentsRootDir: () => null,
    isToolAvailable: toolset == null ? undefined : (name) => toolset.has(name),
    mcpManagement: () => null,
    mcpCustomInstructionsSection: () => null,
    mcpDiscoveryStatusSection: () => null,
    remoteBoxSection: () => "",
    computerSection: () => null,
  });
  return assembly.getSystemPrompt();
}

/**
 * Stands in for the OpenAI-compatible endpoint the custom provider posts to. It records
 * the exact request body so the tests can assert on what the model would have received,
 * and answers with a minimal, well-formed SSE stream so `streamText` settles.
 */
async function withCapturingEndpoint(run) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "capture",
          object: "chat.completion.chunk",
          created: 0,
          model: "capture",
          choices: [{ index: 0, delta: { role: "assistant", content: "ack" } }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "capture",
          object: "chat.completion.chunk",
          created: 0,
          model: "capture",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "grok-selfdesc-root-"));
  writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({
      version: 1,
      inferenceProvider: "custom",
      inferenceCustomEndpoint: { baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "capture-model" },
    }),
    "utf8",
  );

  const savedSandRoot = process.env.SAND_DATA_ROOT;
  const savedKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  try {
    // Without a bound a hanging endpoint fails the suite by hanging, not by asserting.
    await withSafetyCeiling(() => run({ port, dataRoot }));
    return requests;
  } finally {
    if (savedSandRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = savedSandRoot;
    if (savedKey === undefined) delete process.env.OPENAI_COMPATIBLE_API_KEY;
    else process.env.OPENAI_COMPATIBLE_API_KEY = savedKey;
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

/**
 * Retries `body` until it reports the captured endpoint saw a request. Without a bound
 * a provider that never reaches the wire fails the suite by hanging, not by asserting.
 */
async function withSafetyCeiling(body, ceiling = 200) {
  for (let attempt = 0; attempt < ceiling; attempt += 1) {
    if (await body()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the captured endpoint produced no request within ${ceiling} polls`);
}

test("a fully wired agent is told about every tool its turn actually carries", () => {
  const prompt = assembleMainAgentPrompt();
  const named = [...ALWAYS_ON_TOOLS, ...ACCOUNT_GATED_TOOLS, "GetMcpTools", "CallMcpTool"];
  for (const tool of named) {
    assert.ok(
      prompt.includes(tool),
      `the assembled agent prompt never mentions ${tool}, so an agent that had it would still claim it cannot`,
    );
  }
  assert.ok(
    WIRED_AGENT_TOOLS.size >= 20,
    `the wired toolset shrank to ${WIRED_AGENT_TOOLS.size} names, so this is no longer a turn every optional family is offered in`,
  );
  assert.ok(
    prompt.length > 50_000,
    `the assembled prompt is ${prompt.length} characters, far shorter than the shipped 74 kB one, so this is not the prompt that was measured on the running box`,
  );
});

test("a turn with no toolset to consult is told about no optional family at all", () => {
  // The complement of the test above, and the reason the toolset is passed in at all. With no
  // resolver the old prompt named every optional tool, which is how the capture was taken: 28
  // tools on the wire, nine names in the prompt that were not among them.
  const prompt = assembleMainAgentPrompt({ toolset: null });

  for (const tool of OPTIONAL_FAMILY_TOOLS) {
    assert.equal(
      prompt.includes(tool),
      false,
      `the prompt named ${tool} for a turn that carries no optional tool, so the model either invents it or denies having tools`,
    );
  }
  // The account-gated pair, same rule, different reason: these are not "optional families" the
  // user turned off, they are tools that do not exist without a signed-in account. The old prompt
  // taught the whole plugin section to a turn that had neither, which made the agent apologise
  // for a feature the user never bought.
  for (const tool of ACCOUNT_GATED_TOOLS) {
    assert.equal(
      prompt.includes(tool),
      false,
      `${tool} needs a signed-in account this turn does not have, so naming it teaches the agent to call a tool it cannot call`,
    );
  }
  for (const tool of ALWAYS_ON_TOOLS) {
    assert.equal(
      prompt.includes(tool),
      true,
      `${tool} belongs to every turn, so conditioning the prompt on the toolset silenced a capability that is always there`,
    );
  }
});

test("the cloud-agents-disabled variant still describes the same hands", () => {
  const disabled = SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED;
  assert.ok(
    disabled.includes("SendMessage") && disabled.includes("Task") && disabled.includes("WebSearch"),
    "disabling cloud agents must not take the core capability description with it",
  );
  assert.notEqual(
    disabled,
    DEFAULT_SAND_SYSTEM_PROMPT,
    "the cloud-disabled prompt is identical to the default, so the variant is not being exercised",
  );
});

test("the custom provider sends no capability text at all when the routed tool list is empty", async () => {
  const requests = await withCapturingEndpoint(async () => {
    await runRoutedProviderText("custom", [{ role: "user", content: "hi" }], { tools: [], sessionId: "s" });
    return true;
  });

  assert.equal(requests.length, 1, "the custom provider made a different number of requests than the one under test");
  const [request] = requests;
  assert.equal(
    request.tools,
    undefined,
    "an empty routed tool list must collapse to no tools key, which is why the agent answered as a bare chat model",
  );
  const systems = (request.messages ?? []).filter((message) => message.role === "system");
  assert.equal(systems.length, 1, "the routed request should carry exactly one system message");
  assert.equal(
    systems[0].content,
    [
      "You are Grok Bot, a warm, concise desktop assistant.",
      "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
      "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
      "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
    ].join("\n"),
    "the routed system prompt has changed; re-measure what the agent is actually told before concluding anything about its capabilities",
  );
});

test("the routed provider does send tools once the caller has any, so the empty list is the whole defect", async () => {
  const requests = await withCapturingEndpoint(async () => {
    await runRoutedProviderText("custom", [{ role: "user", content: "hi" }], {
      tools: [{ name: "CreateAgent", description: "Create an agent", inputSchema: { type: "object", properties: {} } }],
      sessionId: "s",
    });
    return true;
  });

  assert.equal(requests.length, 1, "the custom provider made a different number of requests than the one under test");
  const names = (requests[0].tools ?? []).map((entry) => entry.function?.name ?? entry.name);
  assert.deepEqual(names, ["CreateAgent"], "a non-empty tool list must reach the model by registered name");
});