/**
 * Swappable decision client for a Jev-compatible classifier.
 *
 * The backend is one HTTP call in, one answer out. `https://api.typesafe.ai/v1`
 * (model `jev-1.13.0`, bearer key) and a local `laya-serve` speak the identical
 * wire format, so the same client covers the hosted model and the local
 * multilingual model, which is the only backend with real Russian coverage.
 *
 * --- WHAT A CALL SITE MUST DO -------------------------------------------------
 *
 * The client returns `DecisionOutcome<T>`: a `Decision<T>` when the model named
 * a real option, a `DecisionAbstained` when the model took the abstain option,
 * or a `DecisionFailure` when no usable answer exists.
 *
 * Two of the three carry NO `value` field at all. That is deliberate: a
 * classifier outage or an unanswerable item must never be readable as `false`,
 * `0`, or "allow". A call site that only reads `.value` gets a type error, and
 * one that casts gets `undefined`, not a safe-looking boolean.
 *
 * Minimum correct call site:
 *
 * ```ts
 * const outcome = await client.judge(state, "Does the user ask to delete files?", {
 *   abstain: { value: "unclear", description: "The state does not settle the question." },
 * });
 * if (!outcome.ok) {
 *   // failure OR abstention: escalate, do not guess
 *   return escalate(outcome.reason);
 * }
 * if (outcome.band === "uncertain") return escalate("low_confidence");
 * return outcome.value ? allow() : deny();
 * ```
 *
 * `requireDecision()` exists for the rare call site that genuinely cannot
 * proceed: it throws instead of returning a value.
 *
 * `fallback` is an opt-in escape hatch for non-safety paths. It returns a
 * `Decision<T>` with `fallback: true` and `band: "uncertain"`, so the caller
 * choice stays visible and loggable. Never pass a `fallback` that encodes "no",
 * "allow" or "safe" on a safety-adjacent path.
 */

import {
  buildChoiceQuestion,
  buildJudgeQuestion,
  buildScoreQuestion,
  classifyDecisionBand,
  decisionShapeForOptionCount,
  DecisionClientInputError,
  JUDGE_FALSE_VALUE,
  JUDGE_TRUE_VALUE,
  type DecisionBand,
  type DecisionBandPolicy,
  type DecisionOption,
  type DecisionQuestion,
  type DecisionWireRequest,
} from "./decision-prompt.js";
import {
  canonicalDecisionJson,
  DecisionCache,
  decisionCacheKey,
  decisionQuestionId,
  DEFAULT_DECISION_CACHE_MAX_ENTRIES,
  DEFAULT_DECISION_CACHE_TTL_MS,
  type DecisionCacheOptions,
} from "./decision-cache.js";

export { DecisionClientInputError } from "./decision-prompt.js";
export {
  DecisionCache,
  decisionCacheKey,
  decisionQuestionId,
  canonicalDecisionJson,
  DEFAULT_DECISION_CACHE_MAX_ENTRIES,
  DEFAULT_DECISION_CACHE_TTL_MS,
  type DecisionCacheOptions,
} from "./decision-cache.js";
export {
  buildChoiceQuestion,
  buildJudgeQuestion,
  buildScoreQuestion,
  classifyDecisionBand,
  decisionShapeForOptionCount,
  DEFAULT_DECISION_BAND_THRESHOLDS,
  JUDGE_FALSE_VALUE,
  JUDGE_TRUE_VALUE,
  MAX_CHOICE_OPTIONS,
  type DecisionBand,
  type DecisionBandPolicy,
  type DecisionChoiceQuestion,
  type DecisionOption,
  type DecisionQuestion,
  type DecisionScoreQuestion,
  type DecisionShape,
  type DecisionBandThresholds,
  type DecisionWireRequest,
} from "./decision-prompt.js";

/** Pinned on purpose. A floating alias such as `jev-latest` would change the model under the caller without any code change. */
export const JEV_DEFAULT_MODEL = "jev-1.13.0";

/** The single route that both backends expose. */
export const JEV_DEFAULT_PATH = "/systemone";

/**
 * Last-resort ceiling for a call that sets no `timeoutMs`.
 *
 * It used to be 15s, which is not a timeout a person can feel: a UI action that
 * forgets to pass one freezes for a quarter of a minute. The classifier backs
 * interactive paths (see `plugin-search-jev.ts`, which asks for 1.5s), so the
 * default is now a ceiling rather than a budget. A safety path that genuinely
 * needs longer passes its own `timeoutMs` and this never applies to it.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 5_000;

/** How much of an error body is kept in a failure detail. */
const FAILURE_DETAIL_LIMIT = 240;

/**
 * A decided answer.
 *
 * `probabilities` are RAW and UNROUNDED, keyed by option value, and valid only
 * for the option set of this call. Adding an option moves every number, so
 * never compare these with numbers from a call that had a different option set.
 *
 * `decidedInMs` is `0` when the answer came from the cache: no endpoint call
 * was made for it.
 *
 * `abstain` is `false` on every `Decision`: when the model takes the abstain
 * option the client returns a `DecisionAbstained` instead, which has no `value`.
 */
export interface Decision<T> {
  readonly ok: true;
  readonly value: T;
  readonly probabilities: Record<string, number>;
  /** The model's own confidence, or `null` when the primitive reports none (the ordinal `score`). */
  readonly confidence: number | null;
  readonly abstain: false;
  /** Advisory: `decide` is the only band a call site may act on without a human. */
  readonly band: DecisionBand;
  /** The `model` string the SERVICE returned, so alias drift is observable on every decision. */
  readonly model: string;
  readonly cached: boolean;
  readonly decidedInMs: number;
  /** True only when a caller-supplied `fallback` produced this value. */
  readonly fallback: boolean;
  /** Why a `fallback` value was used. Absent on a real answer. */
  readonly fallbackReason?: DecisionFailureReason | undefined;
}

/**
 * The model took the abstain option: the item is unanswerable. No `value` is
 * returned on purpose. Escalate or ask a human.
 */
export interface DecisionAbstained {
  readonly ok: false;
  readonly reason: "abstained";
  readonly abstain: true;
  /** The option value the model picked. */
  readonly abstainValue: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number | null;
  readonly band: "uncertain";
  readonly model: string;
  readonly cached: boolean;
  readonly decidedInMs: number;
  readonly fallback: false;
}

/** Why no classifier answer exists. Every transport and protocol failure lands here. */
export type DecisionFailureReason =
  | "timeout"
  | "aborted"
  | "rate_limited"
  | "unauthorized"
  | "server_error"
  | "http_error"
  | "network_error"
  | "malformed_json"
  | "missing_answers"
  | "invalid_answer";

export interface DecisionFailure {
  readonly ok: false;
  readonly reason: DecisionFailureReason;
  /** Short, already truncated. Never contains the API key. */
  readonly detail: string;
  readonly httpStatus?: number | undefined;
  /** The REQUESTED model. A response that got far enough to report drift carries the returned one in the `response` event instead. */
  readonly model: string;
  readonly cached: false;
  readonly decidedInMs: number;
  readonly fallback: false;
}

export type DecisionOutcome<T> = Decision<T> | DecisionAbstained | DecisionFailure;

export type DecisionKind = "choose" | "judge" | "score";

/** An explicit caller decision, not a default value. It must be a function so the choice is visible at the call site. */
export type DecisionFallback<T> = () => T;

export interface DecisionCallOptions {
  /** Cosmetic question id for logs. It is NOT part of the cache key, so two calls that differ only by id share one cache entry and one endpoint hit. */
  readonly id?: string | undefined;
  /** Caller cancellation. Distinct from a client timeout: `reason` becomes `aborted`. */
  readonly signal?: AbortSignal | undefined;
  /** Per-call cache tuning. `false` disables the cache for this call. */
  readonly cache?: DecisionCacheOptions | false | undefined;
  readonly band?: DecisionBandPolicy | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ChooseDecisionOptions extends DecisionCallOptions {
  /**
   * REQUIRED. The option the model takes when the item is unanswerable. Without
   * an explicit abstain option the model must pick a real answer, which measured
   * 0.000 accuracy on unanswerable items and a 0.79 stereotype rate. The client
   * throws when it is missing, at build time, before any request is sent.
   */
  readonly abstain: DecisionOption;
  readonly instructions?: string | undefined;
  readonly fallback?: DecisionFallback<string> | undefined;
}

export interface JudgeDecisionOptions extends DecisionCallOptions {
  /** REQUIRED, for the same reason as in `choose`. */
  readonly abstain: DecisionOption;
  readonly instructions?: string | undefined;
  readonly trueDescription?: string | undefined;
  readonly falseDescription?: string | undefined;
  readonly fallback?: DecisionFallback<boolean> | undefined;
}

export interface ScoreDecisionOptions extends DecisionCallOptions {
  readonly instructions?: string | undefined;
  readonly fallback?: DecisionFallback<number> | undefined;
}

export interface DecisionClient {
  readonly baseUrl: string;
  /** The pinned model this client requests. Compare it with `decision.model` to see drift. */
  readonly model: string;
  choose(state: string, options: readonly DecisionOption[], opts: ChooseDecisionOptions): Promise<DecisionOutcome<string>>;
  judge(state: string, question: string, opts: JudgeDecisionOptions): Promise<DecisionOutcome<boolean>>;
  /** Returns the RAW fractional zero-based rubric index. The ordinal `score` primitive measured no better than guessing, so its band is `uncertain` unless a caller passes an explicit threshold. */
  score(state: string, rubric: readonly string[], opts?: ScoreDecisionOptions): Promise<DecisionOutcome<number>>;
  clearCache(): void;
  readonly cacheSize: number;
}

export type DecisionClientEvent =
  | { readonly type: "request"; readonly kind: DecisionKind; readonly questionId: string; readonly model: string }
  | {
    readonly type: "response";
    readonly kind: DecisionKind;
    readonly questionId: string;
    readonly requestedModel: string;
    readonly returnedModel: string;
    /** True when the service answered with a different model string than the one requested. */
    readonly drift: boolean;
    readonly cached: boolean;
    readonly decidedInMs: number;
  }
  | { readonly type: "failure"; readonly kind: DecisionKind; readonly questionId: string; readonly reason: DecisionFailureReason; readonly detail: string; readonly httpStatus?: number | undefined; readonly decidedInMs: number };

export interface DecisionClientOptions {
  /** `https://api.typesafe.ai/v1` or a local `http://127.0.0.1:PORT`. */
  readonly baseUrl: string;
  /** Optional for a loopback base URL. Required for anything else: the client throws at construction instead of sending an anonymous request. */
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Defaults to `/systemone`. */
  readonly path?: string | undefined;
  /** Injection point. When omitted the client resolves `globalThis.fetch` at call time. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly cache?: DecisionCacheOptions | false | undefined;
  /** Never throws: a broken listener cannot change a decision. */
  readonly onEvent?: ((event: DecisionClientEvent) => void) | undefined;
}

/** Thrown by `createHttpDecisionClient` for a bad base URL, a missing key on a remote base URL, or a floating model alias. */
export class DecisionClientConfigError extends Error {
  override readonly name = "DecisionClientConfigError";
}

/** Thrown by `requireDecision` when the caller demanded a value and none exists. */
export class DecisionUnavailableError extends Error {
  override readonly name = "DecisionUnavailableError";
  readonly reason: DecisionFailureReason | "abstained";
  constructor(reason: DecisionFailureReason | "abstained", detail: string) {
    super(`No classifier decision available: ${reason}. ${detail}`);
    this.reason = reason;
  }
}

export function isDecision<T>(outcome: DecisionOutcome<T>): outcome is Decision<T> {
  return outcome.ok === true;
}

export function isDecisionFailure<T>(outcome: DecisionOutcome<T>): outcome is DecisionFailure {
  return outcome.ok === false && outcome.reason !== "abstained";
}

export function isDecisionAbstained<T>(outcome: DecisionOutcome<T>): outcome is DecisionAbstained {
  return outcome.ok === false && outcome.reason === "abstained";
}

/** Narrow or throw. Use only where a missing decision must stop the caller. */
export function requireDecision<T>(outcome: DecisionOutcome<T>): Decision<T> {
  if (isDecision(outcome)) return outcome;
  if (isDecisionFailure(outcome)) throw new DecisionUnavailableError(outcome.reason, outcome.detail);
  throw new DecisionUnavailableError("abstained", `The model chose the abstain option "${outcome.abstainValue}".`);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** One request in flight, plus the cancellation scope it belongs to. */
interface InFlightRequest {
  /**
   * The caller's own signal, or `undefined`. Two callers may only share a
   * request when this matches: the request runs under the starter's
   * `AbortSignal.any([signal, timeout])`, so sharing across signals means the
   * starter's cancel kills the other caller's answer, and the other caller's
   * cancel does nothing to the request it was waiting for.
   */
  readonly signal: AbortSignal | undefined;
  readonly promise: Promise<DecisionOutcome<unknown>>;
}

/** A floating alias changes the model under the caller without any code change, so it is refused outright. */
function assertPinnedModel(model: string): void {
  if (model.trim().length === 0) throw new DecisionClientConfigError("A decision client needs a pinned model id.");
  const normalized = model.trim().toLowerCase();
  if (normalized === "latest" || normalized.endsWith("-latest") || normalized.endsWith(":latest")) {
    throw new DecisionClientConfigError(`Model "${model}" is a floating alias. Pin an exact version such as "${JEV_DEFAULT_MODEL}".`);
  }
}

// A remote service is not obliged to keep our secrets out of its own error text. A 401
// body of `{"error":"invalid api key: sk-live-..."}` was copied verbatim into `detail` and
// into the `failure` event, so the key reached logs that the Decision object never touched.
// Redact first, collapse second, truncate last.
function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret == null || secret.length < 8) continue;
    out = out.replaceAll(secret, "[redacted]");
  }
  // Catch the common shapes even when the exact key is not known to us.
  return out
    .replace(/(sk|pk|oc|key|api|token|bearer)[-_][A-Za-z0-9_-]{16,}/gi, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}

function truncateDetail(text: string, secrets: readonly (string | undefined)[] = []): string {
  const collapsed = redactSecrets(text, secrets).replace(/\s+/g, " ").trim();
  return collapsed.length <= FAILURE_DETAIL_LIMIT ? collapsed : `${collapsed.slice(0, FAILURE_DETAIL_LIMIT)}…`;
}

// `https://user:hunter2@host` in a base URL was echoed into every failure detail, and into
// client.baseUrl itself. The sibling validateRemoteMcpUrl already forbids URL credentials;
// this layer just missed the house rule.
function redactUrlUserinfo(url: string): string {
  try { const parsed = new URL(url); if (parsed.username === "" && parsed.password === "") return url; parsed.username = "[redacted]"; parsed.password = ""; return parsed.toString(); } catch { return url.replace(/\/\/[^/@]*@/, "//[redacted]@"); }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raw probabilities exactly as the service sent them: no rounding, no renorm, no invented keys. */
function extractProbabilities(raw: unknown): Record<string, number> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function extractConfidence(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function extractModel(raw: unknown, fallbackModel: string): string {
  return typeof raw === "string" && raw.length > 0 ? raw : fallbackModel;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function classifyTransportError(error: unknown, callerSignal: AbortSignal | undefined): DecisionFailureReason {
  if (callerSignal?.aborted === true) return "aborted";
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  return "network_error";
}

function failureForStatus(status: number): DecisionFailureReason {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status >= 500) return "server_error";
  return "http_error";
}

export function createHttpDecisionClient(options: DecisionClientOptions): DecisionClient {
  const model = options.model ?? JEV_DEFAULT_MODEL;
  assertPinnedModel(model);
  const rawBaseUrl = options.baseUrl.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(rawBaseUrl);
  } catch (error) {
    throw new DecisionClientConfigError(`Decision client baseUrl "${rawBaseUrl}" is not a URL.`, { cause: error });
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new DecisionClientConfigError("Decision client baseUrl must not embed credentials; pass the key through the apiKey option.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new DecisionClientConfigError(`Decision client baseUrl "${rawBaseUrl}" must use http or https.`);
  }
  const apiKey = options.apiKey?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    if (!isLoopbackHostname(endpoint.hostname)) {
      throw new DecisionClientConfigError(`Decision client baseUrl "${rawBaseUrl}" is not loopback, so an apiKey is required.`);
    }
  }
  const requestUrl = `${rawBaseUrl.replace(/\/+$/, "")}${(options.path ?? JEV_DEFAULT_PATH).startsWith("/") ? (options.path ?? JEV_DEFAULT_PATH) : `/${options.path}`}`;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new DecisionClientConfigError(`Decision client timeoutMs must be positive; got ${defaultTimeoutMs}.`);
  }
  const now = options.now ?? (() => performance.now());
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

  const cacheEnabled = options.cache !== false;
  const sharedCache = cacheEnabled ? new DecisionCache<Decision<unknown>>(options.cache ?? {}) : undefined;
  /**
   * One in-flight request per FLIGHT KEY, so concurrent identical calls do not
   * hammer a non-deterministic endpoint.
   *
   * The flight key is NOT the cache key. Two callers may share one request only
   * when the request AND the shape of what comes back are identical, and several
   * of those things are not in the cache key:
   *
   * - `fallback`: a caller without one must never be handed the first caller's
   *   `fallback: true` and a value the caller never chose;
   * - `band`: the threshold policy is not cached with the answer, so a lax
   *   policy would hand its band to a strict one;
   * - `timeoutMs`: a waiter with a shorter budget must not get the leader's;
   * - `signal`: the request is bound to whoever started it, see below.
   */
  const inFlight = new Map<string, InFlightRequest>();
  const warnedModels = new Set<string>();

  const emit = (event: DecisionClientEvent): void => {
    if (options.onEvent === undefined) return;
    try { options.onEvent(event); } catch { /* a broken listener never changes a decision */ }
  };

  const warnDriftOnce = (returnedModel: string): void => {
    if (options.onEvent !== undefined || warnedModels.has(returnedModel)) return;
    warnedModels.add(returnedModel);
    console.warn(`[decisions] the classifier answered with model "${returnedModel}" although the client requested "${model}".`);
  };

  const emitFailure = (
    kind: DecisionKind,
    questionId: string,
    reason: DecisionFailureReason,
    detail: string,
    httpStatus: number | undefined,
    decidedInMs: number,
  ): void => {
    emit({
      type: "failure",
      kind,
      questionId,
      reason,
      detail,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      decidedInMs,
    });
  };

  interface TransportSuccess {
    readonly ok: true;
    readonly returnedModel: string;
    readonly answers: Record<string, unknown>;
  }

  async function post(
    kind: DecisionKind,
    questionId: string,
    state: string,
    question: DecisionQuestion,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<TransportSuccess | DecisionFailure> {
    const startedAtMs = now();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);
    const body: DecisionWireRequest = { model, state, questions: { [questionId]: question } };
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    const fail = (reason: DecisionFailureReason, detail: string, httpStatus?: number): DecisionFailure => {
      const decidedInMs = now() - startedAtMs;
      emitFailure(kind, questionId, reason, detail, httpStatus, decidedInMs);
      return {
        ok: false,
        reason,
        detail,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        model,
        cached: false,
        decidedInMs,
        fallback: false,
      };
    };
    let response: Response;
    try {
      response = await doFetch(requestUrl, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      const reason = classifyTransportError(error, callerSignal);
      return fail(reason, `request to ${requestUrl} failed: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      const reason = failureForStatus(response.status);
      return fail(reason, `HTTP ${response.status} from ${redactUrlUserinfo(requestUrl)}: ${truncateDetail(detail || response.statusText, [options.apiKey])}`, response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return fail("malformed_json", `the response from ${requestUrl} was not JSON: ${errorMessage(error)}`);
    }
    if (!isPlainObject(payload)) return fail("malformed_json", `the response from ${requestUrl} was not a JSON object.`);
    const returnedModel = extractModel(payload.model, model);
    const answers = payload.answers;
    if (!isPlainObject(answers)) {
      const failure = fail("missing_answers", `the response from ${requestUrl} has no answers object.`);
      return failure;
    }
    return { ok: true, returnedModel, answers };
  }

  /**
   * Run one question end to end: cache, single flight, transport, band, cache write.
   * `mapValue` turns the raw answer into the caller's type; it throws
   * `invalid_answer` when the service answered something unusable.
   */
  async function run<T>(
    kind: DecisionKind,
    state: string,
    question: DecisionQuestion,
    options_: {
      readonly id?: string | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly cache?: DecisionCacheOptions | false | undefined;
      readonly band?: DecisionBandPolicy | undefined;
      readonly timeoutMs?: number | undefined;
      readonly fallback?: DecisionFallback<T> | undefined;
      readonly abstainValue: string | undefined;
      readonly shape: Parameters<typeof classifyDecisionBand>[0]["shape"];
    },
    mapValue: (raw: unknown) => T | undefined,
  ): Promise<DecisionOutcome<T>> {
    if (typeof state !== "string") throw new DecisionClientInputError(`${kind}() needs a string state.`);
    // TODO(band-in-cache-key): `band` is deliberately NOT part of the key yet. Passing
    // `options_.band` here was tried and made the multi-way test fail in both directions:
    // the strict follow-up call still replayed a "decide" verdict. The honest fix is to cache
    // the RAW probabilities plus confidence and recompute the band on replay, so
    // `Decision.band` stops being a stored value and becomes a derived one. Until that lands,
    // a caller that tightens the policy must pass `cache: false`. decisionCacheKey already
    // accepts an optional `band` and folds it in when supplied.
    const cacheKey = decisionCacheKey({ model, state, question });
    const questionId = options_.id ?? decisionQuestionId(cacheKey);
    const cache = options_.cache === false ? undefined : options_.cache === undefined ? sharedCache : new DecisionCache<Decision<unknown>>(options_.cache);

    const replay = (stored: Decision<unknown>): Decision<T> =>
      ({ ...(stored as Decision<T>), probabilities: { ...stored.probabilities }, cached: true, decidedInMs: 0 } as Decision<T>);

    const cachedValue = cache?.get(cacheKey);
    if (cachedValue !== undefined) {
      emit({ type: "response", kind, questionId, requestedModel: model, returnedModel: cachedValue.model, drift: cachedValue.model !== model, cached: true, decidedInMs: 0 });
      return replay(cachedValue);
    }

    // A concurrent identical call is already in flight: wait for it instead of sending a second
    // request. Merging is only safe when nothing about the answer can differ, which is what the
    // flight key carries; `cache: false` is excluded from merging entirely, because reusing
    // somebody else's in-flight answer is exactly what "do not reuse an answer" forbids.
    const flightKey = options_.cache === false
      ? undefined
      : canonicalDecisionJson({
        cacheKey,
        band: options_.band ?? null,
        timeoutMs: options_.timeoutMs ?? defaultTimeoutMs,
        fallback: options_.fallback !== undefined,
      });
    const pending = flightKey === undefined ? undefined : inFlight.get(flightKey);
    if (flightKey !== undefined && pending !== undefined && pending.signal === options_.signal) {
      const outcome = await (pending.promise as Promise<DecisionOutcome<T>>);
      return isDecision(outcome) ? { ...outcome, cached: true, decidedInMs: 0 } : outcome;
    }

    const execute = async (): Promise<DecisionOutcome<T>> => {
      emit({ type: "request", kind, questionId, model });
      const startedAtMs = now();
      const timeoutMs = options_.timeoutMs ?? defaultTimeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new DecisionClientInputError(`${kind}() timeoutMs must be positive; got ${timeoutMs}.`);
      const transport = await post(kind, questionId, state, question, options_.signal, timeoutMs);
      const decidedInMs = now() - startedAtMs;
      if (!transport.ok) return options_.fallback === undefined ? transport : fallbackOutcome<T>(options_.fallback, transport, decidedInMs);
      if (transport.returnedModel !== model) warnDriftOnce(transport.returnedModel);
      emit({ type: "response", kind, questionId, requestedModel: model, returnedModel: transport.returnedModel, drift: transport.returnedModel !== model, cached: false, decidedInMs });

      const raw = transport.answers[questionId];
      if (raw === undefined || raw === null || typeof raw !== "object") {
        emitFailure(kind, questionId, "missing_answers", `the response has no answer for question "${questionId}".`, undefined, decidedInMs);
        const failure: DecisionFailure = { ok: false, reason: "missing_answers", detail: `the response has no answer for question "${questionId}".`, model, cached: false, decidedInMs, fallback: false };
        return options_.fallback === undefined ? failure : fallbackOutcome<T>(options_.fallback, failure, decidedInMs);
      }
      const answer = raw as Record<string, unknown>;
      const probabilities = Object.freeze(extractProbabilities(answer.probabilities));
      const confidence = extractConfidence(answer.confidence);
      const invalid = (detail: string): DecisionOutcome<T> => {
        emitFailure(kind, questionId, "invalid_answer", detail, undefined, decidedInMs);
        const failure: DecisionFailure = { ok: false, reason: "invalid_answer", detail, model, cached: false, decidedInMs, fallback: false };
        return options_.fallback === undefined ? failure : fallbackOutcome<T>(options_.fallback, failure, decidedInMs);
      };

      if (question.type === "score") {
        const index = answer.score;
        if (typeof index !== "number" || !Number.isFinite(index)) return invalid("the score answer carried no numeric score.");
        const value = mapValue(index);
        if (value === undefined) return invalid(`the score answer ${index} is outside the rubric.`);
        const decision: Decision<T> = {
          ok: true,
          value,
          probabilities,
          confidence,
          abstain: false,
          band: classifyDecisionBand({ shape: options_.shape, probabilities, ...(options_.abstainValue === undefined ? {} : { abstainValue: options_.abstainValue }), confidence, ...(options_.band === undefined ? {} : { policy: options_.band }) }),
          model: transport.returnedModel,
          cached: false,
          decidedInMs,
          fallback: false,
        };
        cache?.set(cacheKey, decision as Decision<unknown>);
        return decision;
      }

      const choice = answer.choice;
      if (typeof choice !== "string" || choice.length === 0) return invalid("the choice answer carried no choice string.");
      const criteria = question.criteria;
      if (!Object.hasOwn(criteria, choice)) return invalid(`the model answered "${choice}", which is not one of the offered options.`);
      const band = classifyDecisionBand({ shape: options_.shape, probabilities, ...(options_.abstainValue === undefined ? {} : { abstainValue: options_.abstainValue }), confidence, ...(options_.band === undefined ? {} : { policy: options_.band }) });
      if (options_.abstainValue !== undefined && choice === options_.abstainValue) {
        return { ok: false, reason: "abstained", abstain: true, abstainValue: choice, probabilities, confidence, band: "uncertain", model: transport.returnedModel, cached: false, decidedInMs, fallback: false } satisfies DecisionAbstained;
      }
      const value = mapValue(choice);
      if (value === undefined) return invalid(`the model answered "${choice}", which the caller cannot map to a value.`);
      const decision: Decision<T> = {
        ok: true,
        value,
        probabilities,
        confidence,
        abstain: false,
        band,
        model: transport.returnedModel,
        cached: false,
        decidedInMs,
        fallback: false,
      };
      cache?.set(cacheKey, decision as Decision<unknown>);
      return decision;
    };

    const promise = execute();
    if (flightKey !== undefined) {
      inFlight.set(flightKey, { signal: options_.signal, promise: promise as Promise<DecisionOutcome<unknown>> });
    }
    try {
      return await promise;
    } finally {
      // Only the entry this call actually owns may be removed: a second caller with a different
      // signal writes its own entry under the same key, and deleting it here would strand it.
      if (flightKey !== undefined && inFlight.get(flightKey)?.promise === promise) inFlight.delete(flightKey);
    }
  }

  function fallbackOutcome<T>(fallback: DecisionFallback<T>, failure: DecisionFailure, decidedInMs: number): Decision<T> {
    return {
      ok: true,
      value: fallback(),
      probabilities: {},
      confidence: null,
      abstain: false,
      // A fallback is a caller default, not a classifier answer: it must never be auto-accepted.
      band: "uncertain",
      model: failure.model,
      cached: false,
      decidedInMs,
      fallback: true,
      fallbackReason: failure.reason,
    };
  }

  return {
    baseUrl: requestUrl,
    model,
    clearCache(): void {
      sharedCache?.clear();
      inFlight.clear();
    },
    get cacheSize(): number {
      return sharedCache?.size ?? 0;
    },
    // These three are deliberately NOT `async`: an input contract violation (a missing
// abstain option, an empty option list) is a caller bug, so it throws synchronously
// instead of turning into a rejected promise that a safety path could swallow.
choose(state: string, options: readonly DecisionOption[], opts: ChooseDecisionOptions): Promise<DecisionOutcome<string>> {
      const abstain = requireAbstain(opts, "choose");
      const question = buildChoiceQuestion({ ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }), options, abstain });
      return run<string>("choose", state, question, {
        ...callOptions(opts),
        abstainValue: abstain.value,
        shape: decisionShapeForOptionCount(options.length),
        ...(opts.fallback === undefined ? {} : { fallback: opts.fallback }),
      }, (raw) => (typeof raw === "string" ? raw : undefined));
    },
    judge(state: string, question: string, opts: JudgeDecisionOptions): Promise<DecisionOutcome<boolean>> {
      const abstain = requireAbstain(opts, "judge");
      const built = buildJudgeQuestion({
        question,
        abstain,
        ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
        ...(opts.trueDescription === undefined ? {} : { trueDescription: opts.trueDescription }),
        ...(opts.falseDescription === undefined ? {} : { falseDescription: opts.falseDescription }),
      });
      return run<boolean>("judge", state, built, {
        ...callOptions(opts),
        abstainValue: abstain.value,
        shape: "binary",
        ...(opts.fallback === undefined ? {} : { fallback: opts.fallback }),
      }, (raw) => (raw === JUDGE_TRUE_VALUE ? true : raw === JUDGE_FALSE_VALUE ? false : undefined));
    },
    score(state: string, rubric: readonly string[], opts?: ScoreDecisionOptions): Promise<DecisionOutcome<number>> {
      const question = buildScoreQuestion({ rubric, ...(opts === undefined || opts.instructions === undefined ? {} : { instructions: opts.instructions }) });
      const rungs = question.criteria.length;
      return run<number>("score", state, question, {
        ...callOptions(opts),
        abstainValue: undefined,
        shape: "ordinalScore",
        ...(opts?.fallback === undefined ? {} : { fallback: opts.fallback }),
      }, (raw) => (typeof raw === "number" && raw >= 0 && raw < rungs ? raw : undefined));
    },
  };
}

function requireAbstain(opts: ChooseDecisionOptions | JudgeDecisionOptions, kind: string): DecisionOption {
  if (opts === undefined || opts === null || opts.abstain === undefined || opts.abstain === null) {
    throw new DecisionClientInputError(`${kind}() needs an explicit abstain option; without one the model must answer on every item, including the unanswerable ones.`);
  }
  return opts.abstain;
}

function callOptions(opts: DecisionCallOptions | undefined): {
  readonly id?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly cache?: DecisionCacheOptions | false | undefined;
  readonly band?: DecisionBandPolicy | undefined;
  readonly timeoutMs?: number | undefined;
} {
  return {
    ...(opts === undefined || opts.id === undefined ? {} : { id: opts.id }),
    ...(opts === undefined || opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts === undefined || opts.cache === undefined ? {} : { cache: opts.cache }),
    ...(opts === undefined || opts.band === undefined ? {} : { band: opts.band }),
    ...(opts === undefined || opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
}