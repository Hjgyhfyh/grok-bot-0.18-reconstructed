export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter", "custom"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];

/**
 * The one member of `SAND_INFERENCE_PROVIDERS` this build cannot serve. It is kept
 * in the enum rather than deleted so a settings file written by an earlier build
 * still parses against the same schema, but keeping it in the enum is not keeping
 * it selectable: every routing decision goes through `resolveServedInferenceProvider`,
 * which refuses it. Deleting the member instead would quietly turn the two
 * `Exclude<SandInferenceProvider, "cursor">` guards into the full union and lose
 * the compile-time proof, with no compiler signal to say so.
 */
export const SAND_ACCOUNT_BACKED_INFERENCE_PROVIDER = "cursor";

/** Where a refused provider lands: the user's own OpenAI-compatible endpoint. */
export const SAND_FALLBACK_INFERENCE_PROVIDER = "custom";

/** The providers a turn may actually be routed to. */
export type ServedSandInferenceProvider = Exclude<SandInferenceProvider, typeof SAND_ACCOUNT_BACKED_INFERENCE_PROVIDER>;

/** A user-owned OpenAI-compatible inference endpoint. Never carries credentials; the API key lives in the OS secret store. */
export interface SandInferenceCustomEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
}

const SAND_INFERENCE_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

/** True only for a provider this build can actually answer a turn with. */
export function isServedSandInferenceProvider(value: unknown): value is ServedSandInferenceProvider {
  return isSandInferenceProvider(value) && value !== SAND_ACCOUNT_BACKED_INFERENCE_PROVIDER;
}

/**
 * The single place a provider value becomes a routing decision. An unknown value,
 * an absent value and the account-backed provider all land on the user's own
 * endpoint, because every reader of the stored setting shares this function: the
 * host turn shell, the cursor session factory, the inference service, the
 * coordinator's routed router and the desktop panel. A provider that cannot be
 * served must never survive as a value, or the branch that builds an
 * account-backed session stays reachable from a file on disk.
 */
export function resolveServedInferenceProvider(value: unknown): ServedSandInferenceProvider {
  return isServedSandInferenceProvider(value) ? value : SAND_FALLBACK_INFERENCE_PROVIDER;
}

export function isSandInferenceCustomEndpoint(value: unknown): value is SandInferenceCustomEndpoint {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as { baseUrl?: unknown; modelId?: unknown };
  if (typeof record.baseUrl !== "string" || typeof record.modelId !== "string") return false;
  if (record.modelId.trim().length === 0) return false;
  let url: URL;
  try { url = new URL(record.baseUrl.trim()); } catch { return false; }
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && SAND_INFERENCE_LOOPBACK_HOSTS.has(url.hostname);
}

/** Trims an already-valid endpoint, or returns `undefined` so callers can silently drop junk. */
export function normalizeSandInferenceCustomEndpoint(value: unknown): SandInferenceCustomEndpoint | undefined {
  if (!isSandInferenceCustomEndpoint(value)) return undefined;
  const record = value as { readonly baseUrl: string; readonly modelId: string };
  return { baseUrl: record.baseUrl.trim(), modelId: record.modelId.trim() };
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty(), custom: empty() } };
}
