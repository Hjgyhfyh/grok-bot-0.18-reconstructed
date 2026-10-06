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

/**
 * A user-owned OpenAI-compatible inference endpoint. Never carries credentials; the API key lives
 * in the OS secret store.
 *
 * `fallbackModelId` is the spare model the same base URL also serves. It is optional on purpose:
 * an endpoint without it is routed exactly as it was before this field existed, and a settings
 * file written by an older build still parses against the same schema. The id is validated as the
 * same kind of token as `modelId`, never as a name that this build has confirmed — confirming it
 * needs a network call, and nothing on the turn path may make one.
 *
 * A spare this build cannot use is NOT a broken endpoint. The field is optional, so a value that is
 * absent, empty, `null` or the wrong type all mean the same thing: this endpoint has no spare. The
 * primary route must survive any of them, because the alternative was measured — with `""`, `"   "`,
 * `null`, `"deepseek v4.1 flash"` or `42` in this one field, `isSandInferenceCustomEndpoint` said
 * `false`, `getInferenceCustomEndpoint()` answered `undefined`, and `createProviderPromptSession(
 * "custom")` threw "The custom endpoint is not configured. Set its base URL and model in
 * Settings → Router." while the base URL and the primary model were both perfectly good. The app
 * stopped answering entirely and blamed the two fields that were fine.
 */
export interface SandInferenceCustomEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly fallbackModelId?: string;
}

/**
 * Why a turn was moved off the endpoint's primary model, and which model it moved to.
 *
 * `reason` is a closed set of machine words rather than the provider's sentence. A provider
 * answers a refusal by repeating the request back, and a refusal body can carry the whole prompt
 * or the key it was sent; the classifier already refuses to repeat provider prose for that reason
 * (`provider-refusal-reason.ts`), so this record names the class instead of quoting anything.
 *
 * The two reasons are the two signals that can move a route, and they are kept apart because they
 * are not equally strong evidence:
 *
 *  - `model_absent_from_catalogue` — the endpoint's own `GET <baseUrl>/models` answered and the
 *    primary model id was not in it. This is the primary signal: it needs no sentence from a
 *    failure body to survive, so it holds even when the provider's 400 arrives with an empty body.
 *  - `model_not_found` — the provider's refusal sentence itself named this model as unsupported.
 *    This is the secondary signal, used when the catalogue could not be read.
 */
export type SandInferenceCustomModelDemotionReason =
  | "model_absent_from_catalogue"
  | "model_not_found";

export interface SandInferenceCustomModelDemotion {
  readonly fromModelId: string;
  readonly toModelId: string;
  readonly reason: SandInferenceCustomModelDemotionReason;
  /**
   * The HTTP status the provider answered, or `0` when no reply was classified at all — the
   * catalogue decided, and the failed request's own status may never have existed. `0` is stated
   * rather than a plausible-looking `400`, because a fabricated status would tell the user the
   * provider rejected a request that may have failed for any reason.
   */
  readonly httpStatus: number;
  readonly at: string;
}

/**
 * An id this build will store and put on the wire: no whitespace, no control characters, bounded
 * length. Deliberately NOT the more generous shape `provider-refusal-reason.ts` uses to quote a
 * provider token back — this value becomes a model name in a request body.
 */
const ENDPOINT_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;

/** True for a model id a user could have typed into the endpoint settings. */
export function isSandEndpointModelId(value: unknown): value is string {
  return typeof value === "string" && ENDPOINT_MODEL_ID.test(value.trim());
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

/**
 * The spare this endpoint can actually route to, or `undefined` for "no spare".
 *
 * This is the one reader of the raw field, and it is total: absent, `null`, empty, whitespace,
 * the wrong type and a token outside the wire charset all answer `undefined`. Refusing the whole
 * endpoint over a junk spare was measured to kill the primary route, which is the more expensive
 * of the two mistakes: `""` and `null` are exactly what a cleared form field produces.
 *
 * An explicit `null` is the only value that means "clear the stored spare" on a write; a junk
 * value is not the same instruction and is not honoured as one. See
 * `normalizeSandInferenceWriteEndpoint`.
 */
export function sandInferenceFallbackModelId(value: unknown): string | undefined {
  return isSandEndpointModelId(value) ? value.trim() : undefined;
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
  const record = value as { readonly baseUrl: string; readonly modelId: string; readonly fallbackModelId?: unknown };
  const fallback = sandInferenceFallbackModelId(record.fallbackModelId);
  return {
    baseUrl: record.baseUrl.trim(),
    modelId: record.modelId.trim(),
    ...(fallback === undefined ? {} : { fallbackModelId: fallback })
  };
}

/**
 * An endpoint as a caller offers it for storage. `fallbackModelId: null` is an instruction to clear
 * the stored spare, and the key being absent is an instruction to leave it alone. These are two
 * different requests and the store must not collapse them.
 *
 * Why that matters: the Router panel sends exactly `{ baseUrl, modelId }` — no spare field at all
 * (`scripts/lib/router-renderer-patch.mjs`, the `RRouterCredential` save handler). An ordinary Save
 * used to write that object through `normalizeSandInferenceCustomEndpoint`, which simply has no
 * spare, so the stored spare was replaced by nothing, the demotion on disk stopped matching the
 * endpoint, and the next turn went back to the model the demotion had retired. Measured:
 * `effective_model_next_turn = space-bunny` after a plain re-save of an endpoint the user had just
 * seen demoted to the spare.
 *
 * A junk spare is neither instruction: it names no model this build can put on the wire, so it is
 * read as absent rather than as "clear", and it cannot be used to erase a working spare either.
 */
export interface SandInferenceWriteEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly fallbackModelId?: string | null;
}

export interface NormalizedSandInferenceWriteEndpoint {
  readonly baseUrl: string;
  readonly modelId: string;
  /** `undefined` = the caller said nothing about the spare. `null` = the caller cleared it. */
  readonly fallbackModelId: string | null | undefined;
}

/**
 * Validates an endpoint offered for storage, keeping the three states of the spare apart.
 *
 * `undefined` is refused for the whole endpoint, exactly as before: a base URL that is not an https
 * URL (or http on loopback), or a primary model id that is empty, was never storable. The spare
 * cannot refuse the endpoint — a bad one becomes "no spare" and the primary route is untouched.
 */
export function normalizeSandInferenceWriteEndpoint(value: unknown): NormalizedSandInferenceWriteEndpoint | undefined {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return undefined;
  const record = value as { baseUrl?: unknown; modelId?: unknown; fallbackModelId?: unknown };
  if (typeof record.baseUrl !== "string" || typeof record.modelId !== "string") return undefined;
  if (record.modelId.trim().length === 0) return undefined;
  let url: URL;
  try { url = new URL(record.baseUrl.trim()); } catch { return undefined; }
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && SAND_INFERENCE_LOOPBACK_HOSTS.has(url.hostname))) return undefined;
  return {
    baseUrl: record.baseUrl.trim(),
    modelId: record.modelId.trim(),
    fallbackModelId: record.fallbackModelId === null ? null : sandInferenceFallbackModelId(record.fallbackModelId)
  };
}

/**
 * The stored demotion, or `undefined` for anything this build cannot vouch for.
 *
 * `httpStatus` is bounded to a real status because it is printed to the user; `at` is only kept
 * when it is a string this repository wrote, so a hand-edited file cannot put arbitrary text in a
 * sentence the app renders. `0` is admitted as the one non-4xx value, because the catalogue signal
 * decides on a document rather than on the failed request's own reply and has no status to report.
 */
export function isSandInferenceCustomModelDemotion(value: unknown): value is SandInferenceCustomModelDemotion {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as { fromModelId?: unknown; toModelId?: unknown; reason?: unknown; httpStatus?: unknown; at?: unknown };
  if (!isSandEndpointModelId(record.fromModelId) || !isSandEndpointModelId(record.toModelId)) return false;
  if (record.reason !== "model_not_found" && record.reason !== "model_absent_from_catalogue") return false;
  if (typeof record.httpStatus !== "number" || !Number.isInteger(record.httpStatus)) return false;
  if (record.httpStatus !== 0 && (record.httpStatus < 400 || record.httpStatus > 499)) return false;
  // A refused failure body can be hundreds of kilobytes of echoed prompt, and this record is written
  // to the user's settings file. Nothing reads the timestamp, so an over-long one is only a way to
  // grow that file without bound.
  return typeof record.at === "string" && record.at.length > 0 && record.at.length <= 64;
}

export function normalizeSandInferenceCustomModelDemotion(value: unknown): SandInferenceCustomModelDemotion | undefined {
  if (!isSandInferenceCustomModelDemotion(value)) return undefined;
  const record = value as SandInferenceCustomModelDemotion;
  return { fromModelId: record.fromModelId.trim(), toModelId: record.toModelId.trim(), reason: record.reason, httpStatus: record.httpStatus, at: record.at };
}

/**
 * The one demotion that is still in force, or `undefined`.
 *
 * A demotion names the model it moved off. A user who fixes the model id in Settings → Router has
 * changed the primary, so the stale record describes a pairing that no longer exists and must not
 * decide anything: it is dropped here rather than at every reader. It is also dropped when the
 * endpoint's spare no longer matches what the record demoted to, so a record can never route to a
 * model the endpoint no longer names.
 *
 * A spare this build cannot put on the wire is no spare, which is why the guard below is
 * `sandInferenceFallbackModelId` and not a truthiness test: `"   "` is truthy, and it is not a model.
 */
export function activeCustomModelDemotion(
  endpoint: Pick<SandInferenceCustomEndpoint, "modelId" | "fallbackModelId">,
  demotion: unknown,
): SandInferenceCustomModelDemotion | undefined {
  const record = normalizeSandInferenceCustomModelDemotion(demotion);
  if (record === undefined) return undefined;
  const fallback = sandInferenceFallbackModelId(endpoint.fallbackModelId);
  if (fallback === undefined) return undefined;
  if (record.fromModelId !== endpoint.modelId.trim()) return undefined;
  if (record.toModelId !== fallback) return undefined;
  return record;
}

/**
 * Which model one turn must use. The single answer to that question: the prompt session's
 * `getModelId()` and the `.chat(...)` call both read it, so they cannot disagree.
 *
 * With no demotion in force this returns the endpoint's own `modelId`, which is exactly what the
 * route used before the field existed. The spare is only ever returned against a record that
 * survived `activeCustomModelDemotion`, so a demotion to a model this endpoint does not serve is
 * impossible by construction.
 */
export function resolveEffectiveCustomModelId(
  endpoint: Pick<SandInferenceCustomEndpoint, "modelId" | "fallbackModelId">,
  demotion: unknown,
): string {
  const demoted = activeCustomModelDemotion(endpoint, demotion)?.toModelId;
  return demoted !== undefined && isSandEndpointModelId(demoted) ? demoted.trim() : endpoint.modelId.trim();
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty(), custom: empty() } };
}
