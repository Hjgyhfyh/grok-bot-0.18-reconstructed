/**
 * The Router settings test used to pin nine lines of an `execute()` that no longer exists.
 *
 * Those nine lines -- `executeTool: async (definition, toolArgs, toolCallId)`,
 * `setTimeout(resolve, 1_200)`, `currentActivity: { kind: "thinking" }`, `onTextDelta`,
 * `streaming`, `postEvent("agents"`, `createRoutedMcpBridge`, `listRoutedMcpTools` and
 * `executeRoutedMcpTool` -- were the interceptor. The coordinator's inference route claimed
 * `sendPrompt` for every provider except `cursor`, ran the user's message as a bare chat
 * completion with no agent system prompt and no tools, and streamed the reply into the chat as
 * if the agent had sent it. The pins kept that code alive: the only way to satisfy them was to
 * restore the defect, so the file that was supposed to describe the shipped product described
 * the bug instead.
 *
 * The pins are now the contract the fixed route actually carries: it declines the turn, it owns
 * no tool executor and no MCP bridge, and the one thing it still asks a model for is a
 * conversation title with no tool list. The absence of the interceptor's machinery is pinned as
 * firmly as its presence was, because a route that starts answering again has to bring all of it
 * back. `send-prompt-reaches-the-agent.test.mjs` proves the same thing behaviourally.
 *
 * The rest of this file is the packaging contract it always was: the packaged `.app` bundle is
 * the verification authority, the renderer stays checksum-pinned, and the Router settings screen
 * reads the trusted backend and the recorded usage.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import createIgnore from "ignore";

import { resolvePackagedAppArtifacts } from "../scripts/lib/packaged-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packaged verification authority is the selected app bundle", () => {
  const appPath = path.join(repoRoot, "dist", "Example.app");
  const artifacts = resolvePackagedAppArtifacts(appPath);
  assert.equal(artifacts.appPath, appPath);
  assert.equal(artifacts.shape, "app-bundle");
  assert.equal(artifacts.asarPath, path.join(appPath, "Contents", "Resources", "app.asar"));
  assert.equal(artifacts.unpackedPath, `${artifacts.asarPath}.unpacked`);
  assert.notEqual(artifacts.asarPath, path.join(repoRoot, ".build", "app.asar"));
  assert.throws(() => resolvePackagedAppArtifacts(path.join(repoRoot, ".build", "app.asar")), /\.app bundle/);
});

// A `.app` bundle keeps its layout on every host, but only a Windows runtime
// host resolves the flat payload directory that Electron loads directly, so this
// assertion describes the Windows contract and is skipped elsewhere.
test("packaged verification resolves the flat Windows payload beside its executable", { skip: process.platform !== "win32" }, () => {
  const appPath = mkdtempSync(path.join(os.tmpdir(), "grok-bot-payload-"));
  try {
    const artifacts = resolvePackagedAppArtifacts(appPath);
    assert.equal(artifacts.appPath, appPath);
    assert.equal(artifacts.shape, "app-directory");
    assert.equal(artifacts.asarPath, path.join(appPath, "resources", "app.asar"));
    assert.equal(artifacts.unpackedPath, `${artifacts.asarPath}.unpacked`);
    // A packed archive or installer is never a payload root, even by name.
    assert.throws(() => resolvePackagedAppArtifacts(path.join(appPath, "app.asar")), /\.app bundle/);
    assert.throws(() => resolvePackagedAppArtifacts(path.join(appPath, "Grok Bot 0.18 Reconstructed.exe")), /\.app bundle/);
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

test("publication ignore rules retain reconstructed frontend source", async () => {
  const ignoreRules = await readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignoreRules, /^\/recovered\/$/m);
  // An empty `.gitignore` satisfies `doesNotMatch` for free; the `ignores`
  // assertions below are the ones that would notice.
  assert.ok(ignoreRules.trim().length > 0, ".gitignore is empty, so the negative assertion below proves nothing");
  assert.doesNotMatch(ignoreRules, /^recovered\/$/m);
  const retained = "frontend/src/recovered/ui/sand-form-primitives.css";
  const matcher = createIgnore().add(ignoreRules);
  assert.equal(matcher.ignores(retained), false, `${retained} must remain addable in a fresh repository`);
  assert.equal(matcher.ignores("recovered/generated-output.txt"), true, "root recovery output must remain ignored");
});

test("default packaging keeps the polished checksum-pinned renderer", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "package-macos.mjs"), "utf8");
  assert.match(source, /import \{ buildFidelityReconstructedAsar \} from "\.\/clean-build\.mjs"/);
  assert.match(source, /await buildFidelityReconstructedAsar\(\)/);
});

test("Router settings use the trusted backend and display recorded inference usage", async () => {
  const rendererPatch = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  const preload = await readFile(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8");
  const mainEdge = await readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8");
  const inference = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "inference-service.ts"), "utf8");
  const cursorSession = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "cursor-session.ts"), "utf8");
  const cursorBackend = await readFile(path.join(repoRoot, "source", "shared", "node", "cursor-backend", "cursor-inference.ts"), "utf8");
  const providers = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"), "utf8");
  const codexDirect = await readFile(path.join(repoRoot, "source", "host", "extensions", "inference", "codex-direct-responses.ts"), "utf8");
  const turnShell = await readFile(path.join(repoRoot, "source", "host", "runner", "turn-run-shell.ts"), "utf8");
  const coordinator = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "inference-router.ts"), "utf8");
  const coordinatorMain = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "main.ts"), "utf8");
  const mcpBridge = await readFile(path.join(repoRoot, "source", "node-agent-coordinator", "routed-mcp-bridge.ts"), "utf8");
  const localDocker = await readFile(path.join(repoRoot, "source", "electron-main", "box", "local-docker-host-connector.ts"), "utf8");
  // Every assertion below is a regex against one of these files. `assert.match` on
  // an empty string fails, but `assert.doesNotMatch` on an empty string passes
  // trivially, so a truncated or unread-but-present file would turn the five
  // negative assertions below into no-ops. Every source has to carry content.
  for (const [name, text] of Object.entries({
    rendererPatch, preload, mainEdge, inference, cursorSession, cursorBackend,
    providers, codexDirect, turnShell, coordinator, coordinatorMain, mcpBridge, localDocker,
  })) {
    assert.ok(text.trim().length > 0, `${name} is empty, so its regex assertions below prove nothing`);
  }
  assert.match(rendererPatch, /desktop\.agent\.getInferenceRouter\(\)/);
  assert.match(rendererPatch, /desktop\.agent\.setInferenceRouter\(n\)/);
  assert.match(rendererPatch, /desktop\.agent\.getBoxRuntime\(\)/);
  assert.match(rendererPatch, /desktop\.agent\.setBoxRuntime\(r\)/);
  assert.match(rendererPatch, /role:"switch"/);
  assert.match(rendererPatch, /Use local Docker VM/);
  assert.match(rendererPatch, /onValueChange:l=>\{if\(l!==null\)void e\(l\)\}/);
  assert.match(rendererPatch, /desktop\.secrets\.upsert/);
  assert.doesNotMatch(rendererPatch, /settings\.router-provider\.v1/);
  assert.match(rendererPatch, /Usage for /);
  assert.match(rendererPatch, /Requests/);
  assert.match(rendererPatch, /Input tokens/);
  assert.match(rendererPatch, /Last used/);
  assert.match(rendererPatch, /Tracked activity/);
  assert.match(rendererPatch, /RRouterProviders\.filter/);
  assert.match(rendererPatch, /\{value:"custom",label:"Custom",description:"Route through your own OpenAI-compatible endpoint\.",kind:"custom",secret:"OPENAI_COMPATIBLE_API_KEY"/);
  assert.match(rendererPatch, /kind:"custom"/);
  assert.match(rendererPatch, /s\.kind==="custom"/);
  assert.match(rendererPatch, /"aria-label":"Endpoint base URL"/);
  assert.match(rendererPatch, /"aria-label":"Endpoint model id"/);
  assert.match(rendererPatch, /const E=\{baseUrl:g\.trim\(\),modelId:v\.trim\(\)\}/);
  assert.match(rendererPatch, /desktop\.agent\.setInferenceRouter\(s\.value,E\)/);
  assert.match(rendererPatch, /typeof window\.desktop\?\.agent\?\.setInferenceRouter!=="function"/);
  assert.match(rendererPatch, /desktop\.secrets\.upsert\(\{\[s\.secret\]:r\.trim\(\)\}\)/);
  assert.doesNotMatch(rendererPatch, /title:r\.kind==="key"\?"OpenRouter account":"Account"/);
  assert.match(rendererPatch, /title:RRouterCredentialTitle\(r\)/);
  assert.match(rendererPatch, /label:RRouterCredentialLabel\(r\)/);
  assert.match(rendererPatch, /RRouterCredentialDescription\(r\)/);
  assert.match(preload, /getInferenceRouter: \(\) => edge\("getInferenceRouter"\)/);
  assert.match(preload, /getBoxRuntime: \(\) => edge\("getBoxRuntime"\)/);
  assert.match(preload, /setBoxRuntime: \(mode: string\) => edge\("setBoxRuntime", \{ mode \}\)/);
  assert.match(mainEdge, /syncHostSettingsToBox\(\{ inferenceProvider: provider \}\)/);
  assert.match(mainEdge, /invoke\(deps\.settingsStore, "setInferenceProvider", provider\)/);
  assert.match(mainEdge, /return \{ provider, usage:/);
  assert.match(mainEdge, /invoke\(deps\.boxRecovery, "restartCoordinator"\)/);
  assert.match(mainEdge, /mode === "local-docker"\) await startLocalDockerBox\(settingsPath\); else await stopLocalDockerBox\(\)/);
  assert.match(mainEdge, /setBoxRuntime", mode === "local-docker" \? "remote" : "local-docker"/);
  assert.match(localDocker, /public\.ecr\.aws\/k0i0n2g5\/cursorenvironments\/universal:sand-box-latest/);
  assert.match(localDocker, /"127\.0\.0\.1:1340:1340"/);
  assert.match(localDocker, /SAND_BOX_AUTO_UPDATE=0/);
  assert.match(localDocker, /dst=\/home\/box\/sand-host\/host-main\.cjs,readonly/);
  assert.match(localDocker, /\.getBoxRuntime\(\) === "local-docker" \? await localConnect\(\) : await remote\.connect\(\)/);
  assert.match(inference, /recordInferenceUsage\(provider/);
  assert.match(inference, /routerSettings\.getInferenceProvider\(\)/);
  assert.match(inference, /typeof extendedUsage\.then === "function"/);
  assert.match(inference, /createProviderPromptSession\(provider\)/);
  assert.match(providers, /https:\/\/chatgpt\.com\/backend-api\/codex/);
  assert.match(providers, /headers\.set\("ChatGPT-Account-Id", credentials\.accountId\)/);
  assert.match(providers, /streamCodexDirectResponses/);
  assert.doesNotMatch(providers, /provider\.responses\(configuredCodexModel\(\)\)/);
  assert.match(codexDirect, /store: false/);
  assert.match(codexDirect, /response\.output_text\.delta/);
  assert.match(codexDirect, /type: "function_call_output"/);
  assert.match(providers, /parameters: jsonSchema\(parameters\)/);
  assert.match(providers, /You are Grok Bot, a warm, concise desktop assistant/);
  assert.match(providers, /mcpServers: \{ grok_bot_plugins:/);
  assert.match(providers, /recordRoutedUsage\(provider, usage\)/);
  assert.match(providers, /queryClaude/);
  assert.match(providers, /tools: mcpServerUrl == null \? \[\] : \["mcp__grok_bot_plugins__\*"\]/);
  assert.match(providers, /https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(providers, /OpenRouter needs OPENROUTER_API_KEY/);
  assert.match(cursorSession, /routedProvider !== "cursor"/);
  assert.match(cursorSession, /createProviderPromptSession\(routedProvider\)/);
  assert.match(cursorBackend, /routedProvider !== "cursor"/);
  assert.match(cursorBackend, /createProviderPromptSession\(routedProvider\)/);
  assert.doesNotMatch(rendererPatch, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  assert.match(turnShell, /inferenceProvider === "cursor"/);
  assert.match(turnShell, /createProviderPromptSession\(inferenceProvider\)/);
  // The coordinator's inference route used to claim `sendPrompt` for every provider except
  // `cursor` and answer the user itself: a bare chat completion with no agent system prompt and
  // no tools, written into the chat as if the agent had sent it. It now declines the turn and
  // asks a model for exactly one thing -- a conversation title, with no tool list -- so these are
  // the pins that hold that in place. Every one of them is a real symbol or a real call site in
  // the shipped file, never a line that exists only to satisfy a regex.
  assert.match(coordinator, /method !== "sendPrompt" \|\| provider === "cursor"/);
  assert.match(coordinator, /return \{ handled: false \}/);
  // The old `execute()` brought a tool executor, a streaming callback, an activity indicator and
  // the whole routed MCP bridge with it. A route that answers the user again needs every one of
  // those back, so their absence is the guard -- a route that quietly grew an answer path would
  // have to grow them with it. These come first on purpose: they are the defect itself.
  assert.doesNotMatch(coordinator, /onTextDelta/);
  assert.doesNotMatch(coordinator, /executeTool|createRoutedMcpBridge|listRoutedMcpTools|executeRoutedMcpTool/);
  assert.doesNotMatch(coordinator, /currentActivity|postEvent\("agents"/);
  assert.doesNotMatch(coordinator, /routed-mcp-bridge/);
  assert.doesNotMatch(coordinator, /setTimeout\(resolve, 1_200\)/);
  // What is left is the one concern that is genuinely agent-free: a conversation title, asked for
  // with no tool list, so no tool call can be answered with no agent behind it.
  assert.match(coordinator, /runRoutedProviderText\(/);
  assert.match(coordinator, /\{ sessionId: agentId \}/);
  assert.match(coordinator, /parseRoutedControlEnvelope\(reply\)/);
  assert.match(coordinator, /applyRoutedControlEnvelope\(agentId, envelope\)/);
  // The transcript file survives as a read-only archive of the turns this route used to own, so
  // the conversations the user can still open keep merging them. It is written by nothing here.
  assert.match(coordinator, /inference-router-transcript\.json/);
  assert.match(mcpBridge, /openWorldHint: !readOnly/);
  assert.match(coordinator, /schemaVersion: 2/);
  assert.match(coordinator, /\["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"\]/);
  assert.match(coordinator, /\.map\(projectInferenceRouterTranscriptEntry\)/);
  assert.match(coordinator, /readonly richText\?: string/);
  assert.match(coordinator, /richText: entry\.richText/);
  // A reaction the user makes on one of those archived entries is still this route's business.
  assert.match(coordinator, /method === "reactToMessage"/);
  assert.match(coordinator, /reaction\.by === "me"/);
  assert.match(mcpBridge, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.match(mcpBridge, /readOnlyHint: readOnly/);
  assert.match(mcpBridge, /request\.url !== `\/mcp\/\$\{secret\}`/);
  assert.match(coordinator, /kind: "send-message"/);
  assert.match(coordinatorMain, /createCoordinatorInferenceRouter/);
  assert.match(coordinatorMain, /command\(commands, "listRoutedMcpTools", args\)/);
  assert.match(coordinatorMain, /routed\.handled/);
});
