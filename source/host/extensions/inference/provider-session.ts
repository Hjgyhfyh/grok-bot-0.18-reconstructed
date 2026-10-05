import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { query as queryClaude, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import { conversationIdKey } from "../../../packages/chat-inference-proto/client.js";
import type { Context } from "../../../packages/context/core.js";
import { isSandInferenceCustomEndpoint, type SandInferenceCustomEndpoint, type SandInferenceProvider } from "../../../shared/inference-router.js";
import { resolveClaudeCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { getSandRootDir } from "../../host-paths.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = Exclude<SandInferenceProvider, "cursor">;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

const GROK_ROUTER_SYSTEM_PROMPT = [
  "You are Grok Bot, a warm, concise desktop assistant.",
  "You are running inside Grok Bot, not inside Codex CLI or Claude Code.",
  "The tools supplied with this request are Grok Bot's already-connected plugins and accounts. Use them whenever they are relevant instead of claiming that a plugin is unavailable or asking the user to reconnect it.",
  "Never ask for an API key for an already-connected plugin. Respond directly to the user in natural language after completing any necessary tool calls.",
].join("\n");

function recordRoutedUsage(provider: RoutedProvider, usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  return value;
}

function customCredential(): string {
  const value = process.env.OPENAI_COMPATIBLE_API_KEY?.trim() || persistedSecrets().OPENAI_COMPATIBLE_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("The custom endpoint needs OPENAI_COMPATIBLE_API_KEY. Add it in Settings → Router.");
  return value;
}

// The base URL is user supplied and reaches `createOpenAI` inside the host process, so the
// stored value is never trusted as-is: it is re-validated with the shared guard every time a
// custom turn starts, and anything that fails the guard is reported as a missing setting.
function customEndpoint(): SandInferenceCustomEndpoint {
  const stored: unknown = new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceCustomEndpoint();
  if (!isSandInferenceCustomEndpoint(stored)) throw new Error("The custom endpoint is not configured. Set its base URL and model in Settings → Router.");
  return stored;
}

// OpenCode Go refuses every request that arrives without a session identity —
// `Request is missing x-opencode-session and cannot be routed efficiently`. The burden is
// explicitly the client's: "Send a stable session ID in `x-opencode-session` for each
// conversation so we can optimize routing and prompt caching"
// (https://opencode.ai/docs/go/#where-can-i-use-it). The docs prescribe no format, so the
// value is the conversation's own id and nothing else: stability per conversation is the
// whole requirement.
const OPENCODE_SESSION_HEADER = "x-opencode-session";
const OPENCODE_SESSION_HOST = "opencode.ai";

let processScopedSessionId: string | undefined;

// A caller that carries no conversation identity still needs one id for every request it
// makes, so it falls back to an id that lives as long as this host process.
function processSessionId(): string {
  processScopedSessionId ??= crypto.randomUUID();
  return processScopedSessionId;
}

function contextConversationId(ctx: unknown): string | undefined {
  if (ctx == null || typeof (ctx as { get?: unknown }).get !== "function") return undefined;
  try {
    const value = (ctx as Context).get(conversationIdKey);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch { return undefined; }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value != null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function";
}

/**
 * The turn context is the abort authority of a routed turn: `stream-attempt.ts` derives the
 * per-attempt context from `ctx.withCancel()`, so `ctx.signal` is exactly the signal the
 * first-token-stall deadline and the user's cancel abort. Reading it here is what lets
 * `streamText` kill its socket instead of leaving it open until the process exits.
 */
function contextAbortSignal(ctx: unknown): AbortSignal | undefined {
  if (ctx == null || typeof ctx !== "object") return undefined;
  const signal = (ctx as { signal?: unknown }).signal;
  return isAbortSignal(signal) ? signal : undefined;
}

/**
 * The context window of the routed model, reported to the agent as `extendedUsage.maxTokens`.
 *
 * Every consumer treats a non-positive `maxTokens` as "unknown": background summarization
 * returns an undefined trigger threshold, the token-overage block is skipped, and
 * `conversation-state.ts` never records a window for the model, so the conversation is never
 * compacted. A hardcoded `0` therefore disabled all three at once, silently.
 */
const ROUTED_CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude|anthropic|^claude-code/, 200_000],
  [/gemini|^google[/]/, 1_000_000],
  [/gpt-5|^openai[/]gpt-5/, 400_000],
  [/gpt-4/, 128_000],
  [/llama|qwen|mistral|phi-|gemma/, 32_768],
  [/deepseek/, 128_000],
];
export const DEFAULT_ROUTED_CONTEXT_WINDOW = 128_000;
export function resolveRoutedContextWindow(modelId: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env.SAND_ROUTED_CONTEXT_WINDOW?.trim() ?? "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  const id = modelId.toLowerCase();
  for (const [pattern, size] of ROUTED_CONTEXT_WINDOWS) if (pattern.test(id)) return size;
  return DEFAULT_ROUTED_CONTEXT_WINDOW;
}

/**
 * `ai` 4.3.17 silently defaults `temperature` to 0 for every `streamText` call, so a routed
 * request's sampling was decided by an SDK default nobody in this repository had read. The
 * value is now stated at the call site and can be changed without touching the SDK:
 * `SAND_ROUTED_TEMPERATURE=0.7`. Omitting the parameter is not possible — the SDK re-applies
 * its own 0 — so there is no `unset` mode here on purpose.
 */
export function resolveRoutedTemperature(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseFloat(env.SAND_ROUTED_TEMPERATURE?.trim() ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

// The custom endpoint is whatever the user typed into Settings → Router. It can be any
// OpenAI-compatible host, so an OpenCode-specific header must not ride along to an
// unrelated one: only `opencode.ai` and its subdomains get it.
function customEndpointHeaders(baseUrl: string, sessionId: string): Record<string, string> {
  let hostname: string;
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch { return {}; }
  if (hostname !== OPENCODE_SESSION_HOST && !hostname.endsWith(`.${OPENCODE_SESSION_HOST}`)) return {};
  return { [OPENCODE_SESSION_HEADER]: sessionId };
}

function providerPrompt(messages: readonly ProviderMessage[]): string {
  const rendered = messages.map(message => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
  return `${GROK_ROUTER_SYSTEM_PROMPT}\n\nContinue this Grok Bot conversation.\n\n${rendered}`;
}

function deferred<T>() { return Promise.withResolvers<T>(); }

function response(text: string, id: string, modelId: string) {
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentials(credentials);
    result = await perform();
    return result;
  };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const value = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim();
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
  } catch { return undefined; }
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const credentials = codexCredentials();
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: codexAuthenticatedFetch(credentials),
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        model,
        ...(configuredCodexReasoningEffort() == null ? {} : { reasoningEffort: configuredCodexReasoningEffort()! }),
        instructions: GROK_ROUTER_SYSTEM_PROMPT,
        input: messages.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) })),
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: resolveRoutedContextWindow(model) };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model));
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function claudeExecutor(messages: readonly ProviderMessage[], invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    try {
      let final: SDKResultMessage | undefined;
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim();
      for await (const message of queryClaude({ prompt: providerPrompt(messages), options: { pathToClaudeCodeExecutable: executable, cwd: getSandRootDir(), tools: mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"], ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }), permissionMode: "default", maxTurns: mcpServerUrl == null ? 1 : 8, persistSession: false, ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }) } })) if (message.type === "result") final = message;
      if (final == null) throw new Error("Claude Code ended without a result.");
      if (final.subtype !== "success") throw new Error(final.errors.join("\n") || `Claude Code failed (${final.subtype}).`);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: resolveRoutedContextWindow("claude-code") });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

/** Per-call controls the runner threads down to `streamText`. */
export interface RoutedStreamCallOptions {
  /**
   * Cancels the provider socket. The runner always supplies the turn context's signal; a
   * caller without a turn context (labeling, routing probes) may omit it.
   */
  readonly abortSignal?: AbortSignal;
}

function resolveAbortSignal(ctx: unknown, options?: RoutedStreamCallOptions): AbortSignal | undefined {
  return options?.abortSignal ?? contextAbortSignal(ctx);
}

/**
 * `maxRetries: 0` is deliberate. The SDK default of 2 sleeps between attempts *inside* one
 * `streamText` call, so a 429 or a 500 turned into a silent seven-second pause and then a
 * single "Failed after 3 attempts". Retries belong to `stream-attempt.ts`, which already
 * has the ladder, the backoff, the server-paced `Retry-After` and the retry counter.
 */
function routedStreamTextParams(ctx: unknown, options?: RoutedStreamCallOptions): { readonly abortSignal?: AbortSignal; readonly maxRetries: number; readonly temperature: number } {
  const abortSignal = resolveAbortSignal(ctx, options);
  return {
    ...(abortSignal === undefined ? {} : { abortSignal }),
    maxRetries: 0,
    temperature: resolveRoutedTemperature(),
  };
}

/**
 * The cache read count the provider actually reported, or 0 when it reported none.
 *
 * `@ai-sdk/openai` 1.3.24 does parse `usage.prompt_tokens_details.cached_tokens` off the
 * stream, but AI SDK v4's `result.usage` has no field to put it in: the usage object
 * carries only `promptTokens`, `completionTokens` and `totalTokens`, and the cached count
 * is parked at `result.providerMetadata.openai.cachedPromptTokens`. The two OpenAI-compatible
 * executors below built their usage record from `result.usage` alone and therefore wrote a
 * hardcoded `cacheReadTokens: 0`, which is what the Router usage panel displayed forever.
 *
 * `cache_write_tokens` has no OpenAI-compatible equivalent at all — automatic prompt caching
 * reports reads only — so `cacheWriteTokens` stays 0 by fact, not by omission.
 */
function cachedPromptTokens(providerMetadata: unknown): number {
  if (typeof providerMetadata !== "object" || providerMetadata == null) return 0;
  const openai: unknown = (providerMetadata as { openai?: unknown }).openai;
  if (typeof openai !== "object" || openai == null) return 0;
  const value: unknown = (openai as { cachedPromptTokens?: unknown }).cachedPromptTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function openRouterExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, ctx?: unknown, options?: RoutedStreamCallOptions) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  const model: LanguageModelV1 = createOpenAI({
    apiKey: openRouterCredential(),
    baseURL: "https://openrouter.ai/api/v1",
    // `strict` is the only mode that puts `stream_options: { include_usage: true }` on the
    // wire (`@ai-sdk/openai` 1.3.24 sends it under a strict guard). Without it the provider
    // returns no usage frame and `result.usage` resolves with nothing to report.
    compatibility: "strict",
    name: "openrouter",
    headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" },
  }).chat(id as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : 8, ...routedStreamTextParams(ctx, options) });
  const extendedUsage = Promise.all([result.usage, result.providerMetadata]).then(([value, providerMetadata]) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: cachedPromptTokens(providerMetadata), cacheWriteTokens: 0, maxTokens: resolveRoutedContextWindow(id) }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

function customExecutor(messages: readonly ProviderMessage[], invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, sessionId?: string, ctx?: unknown, options?: RoutedStreamCallOptions) {
  const endpoint = customEndpoint();
  const model: LanguageModelV1 = createOpenAI({
    apiKey: customCredential(),
    baseURL: endpoint.baseUrl,
    // Same reason as the OpenRouter route: only `strict` puts `stream_options.include_usage`
    // on the wire, and without a usage frame `extendedUsage.maxTokens` had nothing real to
    // report and the token ledger stayed empty.
    compatibility: "strict",
    name: "custom",
    // `headers` on the provider instance is the layer that reaches the wire. `createOpenAI`
    // folds it into `getHeaders()`, which the chat model passes to `postJsonToApi` as
    // `combineHeaders(this.config.headers(), options.headers)` — the object sent on the POST
    // to `/chat/completions`, for both `doGenerate` and the `doStream` this call uses. There
    // is no `defaultHeaders` option in `@ai-sdk/openai` 1.3.24: that name belongs to the
    // unrelated `openai` v4 SDK, and nothing in this repo uses it.
    headers: customEndpointHeaders(endpoint.baseUrl, sessionId ?? processSessionId()),
  }).chat(endpoint.modelId as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: GROK_ROUTER_SYSTEM_PROMPT, messages: messages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : 8, ...routedStreamTextParams(ctx, options) });
  const extendedUsage = Promise.all([result.usage, result.providerMetadata]).then(([value, providerMetadata]) => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: cachedPromptTokens(providerMetadata), cacheWriteTokens: 0, maxTokens: resolveRoutedContextWindow(endpoint.modelId) }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[], options?: RoutedStreamCallOptions) {
    if (this.provider === "codex") return codexExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(this.getMessages(), invocationId, this.onUsage);
    // Only the custom route asks for a session identity, and it takes the real conversation
    // id off the turn context so the header survives every turn of the same conversation.
    if (this.provider === "custom") return customExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, contextConversationId(ctx), ctx, options);
    return openRouterExecutor(this.getMessages(), invocationId, definitions, undefined, this.onUsage, ctx, options);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "codex" ? configuredCodexModel() : provider === "claude-code" ? "claude-code" : provider === "custom" ? customEndpoint().modelId : process.env.SAND_OPENROUTER_MODEL?.trim() || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)) };
}

export async function runRoutedProviderText(provider: RoutedProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  /** The conversation this text belongs to. The custom endpoint reports it to OpenCode Go. */
  readonly sessionId?: string;
  /** Cancels the provider socket; without it the request outlives its caller. */
  readonly abortSignal?: AbortSignal;
}): Promise<string> {
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const callOptions = options?.abortSignal === undefined ? undefined : { abortSignal: options.abortSignal };
  const result = provider === "codex"
    ? codexExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage)
    : provider === "claude-code"
      ? claudeExecutor(messages, invocationId, onUsage, options?.mcpServerUrl)
      : provider === "custom"
        ? customExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, options?.sessionId, undefined, callOptions)
        : openRouterExecutor(messages, invocationId, options?.tools, options?.executeTool, onUsage, undefined, callOptions);
  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta" && typeof event.textDelta === "string") {
      text += event.textDelta;
      options?.onTextDelta?.(event.textDelta, text);
    }
  }
  await result.response;
  return text;
}
