/**
 * Semantic reranking for the `SearchPlugins` tool, on top of the lexical pass.
 *
 * `rankPluginsLexically` in `../tools/sand-mcp-management-tools.js` stays the
 * first pass: it is free, synchronous and offline, and it is exactly right for
 * the queries a user types as keywords. What it cannot do is read a request
 * that names a TASK instead of a product. The tool description promises
 * natural-language relevance ("manage linear issues", "write word documents"),
 * and for such a query the literal tokens miss and the tool answers
 * `No plugins match "..."`.
 *
 * --- WHY A TRIGGER AND NOT A CLASSIFIER CALL ON EVERY QUERY --------------------
 *
 * `SearchPlugins` is a TOOL CALL BY THE AGENT, not a search box: `frontend/`
 * contains no `SearchPlugins`, no `rankPluginsLexically` and no search input, so
 * it runs roughly once per agent turn, on the queries the model chose to send.
 * (An earlier version of this header put it in a UI search box. That was wrong,
 * and it was load-bearing for a mitigation that therefore does not exist.)
 *
 * One consequence is a decision NOT to add something: because the frequency is
 * already about one call per turn, there is no debounce here and no cooldown on
 * the success path. Neither would buy anything. The failure-path cooldown below
 * is a different thing and does earn its keep -- it stops a dead endpoint from
 * being dialled again on the next several turns of the same conversation.
 *
 * What the trigger actually buys is LATENCY ON THE COMMON CASE. The classifier is
 * one HTTPS round trip with real latency, and for the common query ("linear",
 * where lexical already put the exact-name match first) that round trip would add
 * latency for no gain. So the classifier is asked only when the lexical pass is
 * WEAK, and the weakness is read off the lexical numbers.
 *
 * The trigger, in one sentence: ask the classifier when the query is a real
 * query and the lexical ranking is not decisive.
 *
 * - `tokens.length === 0` -> never ask. `tokenizePluginQuery` drops tokens under
 *   3 characters, so an empty token list means "browse the catalog", and
 *   `rankPluginsLexically` then returns the whole catalog sorted by name. That is
 *   not a search.
 * - `lexical.length === 0` -> always ask. This is the literal failure above:
 *   lexical says nothing matches, and the tool description says it should.
 * - otherwise ask UNLESS the lexical ranking is decisive, which means BOTH:
 *     - the winner scored at least `PLUGIN_SEARCH_EXACT_NAME_SCORE` (8), and
 *     - it leads the runner-up by at least `PLUGIN_SEARCH_CONFIDENT_SPREAD` (3).
 *
 * Both numbers come from the weight ladder in `scorePluginForToken`
 * (8/5/3/2/1). 8 is the ONLY weight awarded to a whole-name equality; 5 is a
 * substring of a name; 3/2/1 are skill, category and description hits, i.e.
 * evidence that text co-occurs somewhere rather than that the plugin IS what was
 * asked for. The ladder's gaps are 8->5 (3) and then 5->3, 3->2, 2->1 (1). So
 * "top >= 8 and spread >= 3" means the winner stands at least one full rung
 * above every other candidate. Below that the ranking is a coin flip between a
 * name-substring hit and an incidental description word, which is exactly what
 * a semantic classifier is for.
 *
 * `coverage` -- the share of query tokens that score above zero on at least one
 * catalog entry -- is computed and reported for every search, because it is what
 * separates the reported regression from a keyword search: "manage linear
 * issues" covers at most 1 of its 3 tokens there, i.e. two thirds of the query
 * is text the catalog simply does not contain. That is what "natural language
 * rather than a keyword list" looks like in the data.
 *
 * --- WHAT THE CLASSIFIER IS ALLOWED TO DO -------------------------------------
 *
 * At most one promotion. The classifier can move a plugin from the shortlist to
 * the front of the lexical result. It can never remove a plugin, never introduce
 * one from outside the shortlist, and never turn a non-empty lexical result into
 * an empty one. Every degradation path returns the lexical list unchanged:
 *
 * - no API key configured, or a client that refuses to construct;
 * - a shortlist that is empty -- nothing to promote, because the classifier is
 *   never shown the whole catalog and must not invent a plugin id;
 * - a transport failure, a timeout, an HTTP error or a malformed answer;
 * - an abstention (`opts.abstain` is always supplied, so "no plugin fits" is a
 *   first-class answer rather than a forced guess);
 * - `band !== "decide"` on every candidate, which includes every `uncertain`;
 * - a throw anywhere in this module.
 *
 * A failure outcome carries no `value` at all (see `decision-client.ts`), so a
 * transport failure can never be read as "no match" here: `outcome.value` is
 * read only after `outcome.ok` has been checked.
 *
 * --- WHY ONE BINARY JUDGE PER CANDIDATE, IN PARALLEL --------------------------
 *
 * Measured calibration on Jev: a small semantic yes/no has ECE ~0.08, a
 * three-way question is worse, and a four-way or wider question degrades to ECE
 * up to 0.305. So the question asked here is deliberately BINARY -- `judge`
 * with true / false / abstain, so `decisionShapeForOptionCount(2)` is "binary"
 * and the auto-decide threshold is 0.90 -- and it is asked about ONE candidate
 * at a time. "Pick one of these 4 plugins" as a `choice` would have been a
 * single request, but it would be a multiWay question, i.e. exactly the regime
 * the measurements distrust.
 *
 * The fan-out is concurrent, so the wall-clock cost is ONE timeout rather than
 * `n * timeout`. The shortlist is capped at `PLUGIN_SEARCH_JEV_MAX_CANDIDATES`
 * entries, which bounds both the request count and the state size.
 *
 * `PLUGIN_SEARCH_JEV_TIMEOUT_MS` is the per-request budget and
 * `PLUGIN_SEARCH_JEV_DEADLINE_MS` is the wall-clock guard around the whole
 * batch, so awaiting this module can never hold a search open for longer than
 * `PLUGIN_SEARCH_JEV_DEADLINE_MS`. A repeated question is served from the
 * client's content-hash cache and costs 0 ms; failures are NOT cached by the
 * client, so `PLUGIN_SEARCH_JEV_COOLDOWN_MS` keeps a dead endpoint from being
 * re-dialed on every turn that follows.
 *
 * --- LANGUAGE ----------------------------------------------------------------
 *
 * The instructions are English (the hosted model's primary training language)
 * and the user's query is forwarded VERBATIM inside `state`, never translated:
 * the only backend with published Russian coverage is the local multilingual
 * model.
 */

import {
  createHttpDecisionClient,
  JEV_DEFAULT_MODEL,
  type Decision,
  type DecisionClient,
  type DecisionOutcome,
} from "./decision-client.js";

/** The hosted Jev endpoint. A local `laya-serve` speaks the same wire format. */
export const PLUGIN_SEARCH_JEV_BASE_URL = "https://api.typesafe.ai/v1";

/** Environment variable that carries the bearer key. Absent means "no classifier", not "classifier broken". */
export const PLUGIN_SEARCH_JEV_API_KEY_ENV = "TYPESAFE_API_KEY";

/** Per-request budget. A search runs inside an agent turn, so this budget has to leave that turn responsive. */
export const PLUGIN_SEARCH_JEV_TIMEOUT_MS = 1_500;

/** Wall-clock guard around the whole concurrent batch: one timeout plus slack. */
export const PLUGIN_SEARCH_JEV_DEADLINE_MS = PLUGIN_SEARCH_JEV_TIMEOUT_MS + 250;

/** Candidates asked about at once. Bounds the request count and the state size. */
export const PLUGIN_SEARCH_JEV_MAX_CANDIDATES = 4;

/** Skip the classifier for a while after it failed, so a dead endpoint is not re-dialed on the next turns of the same conversation. */
export const PLUGIN_SEARCH_JEV_COOLDOWN_MS = 60_000;

/** The weight `scorePluginForToken` gives to a whole-name equality. See the header. */
export const PLUGIN_SEARCH_EXACT_NAME_SCORE = 8;

/** One full rung of the 8/5/3/2/1 ladder. */
export const PLUGIN_SEARCH_CONFIDENT_SPREAD = 3;

/** How a catalog entry is described to the classifier. `McpPluginSummary` satisfies it structurally. */
export interface PluginSearchCandidate {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

/**
 * Everything the rerank needs, all of it already computed by the caller.
 *
 * The lexical scorer is passed IN rather than imported: it lives with the weight
 * ladder in `../tools/sand-mcp-management-tools.js`, and importing it from here
 * would close an import cycle with the tool module that calls this one.
 */
export interface PluginSearchEvidence<T extends PluginSearchCandidate> {
  /** The raw user query, verbatim. */
  readonly query: string;
  /** `tokenizePluginQuery(query)`. */
  readonly tokens: readonly string[];
  /** The whole catalog, in listing order. */
  readonly all: readonly T[];
  /** `rankPluginsLexically(all, query)`: the hits only, best first. */
  readonly lexical: readonly T[];
  /** `scorePluginForToken(plugin, token)`: the lexical score of ONE token against ONE catalog entry. */
  readonly tokenScoreOf: (plugin: T, token: string) => number;
}

/** Why the classifier was not asked, or was asked and changed nothing. */
export type PluginSearchClassifierSkip =
  /** `tokenizePluginQuery` produced nothing: no usable word, so this is a catalog browse. */
  | "no-query-tokens"
  /** Lexical already had a decisive winner. */
  | "lexical-confident"
  /** `TYPESAFE_API_KEY` is unset. */
  | "no-client"
  /** The client refused to construct, or a previous failure is still inside the cooldown. */
  | "client-unavailable"
  /** No candidate to ask about. The classifier is never shown the whole catalog. */
  | "no-shortlist"
  /** The model took the abstain option on every candidate. */
  | "abstained"
  /** Transport failure, timeout, HTTP error or malformed answer. */
  | "failed"
  /** The batch deadline passed before the answers came back. */
  | "deadline"
  /** No outcome reached `band === "decide"`. Every `uncertain` lands here. */
  | "no-decide"
  /** Every candidate that reached `decide` answered false. */
  | "no-relevant"
  /** One candidate was promoted to the front; the rest of the lexical order is untouched. */
  | "promoted"
  /** Something in this module threw. */
  | "error";

export interface PluginSearchOutcome<T extends PluginSearchCandidate> {
  /** The plugins to show, in order. The lexical list, with at most one entry moved to the front. */
  readonly plugins: readonly T[];
  /** True only when a classifier request was actually sent. */
  readonly classifierUsed: boolean;
  readonly skip: PluginSearchClassifierSkip;
  /** The plugin the classifier promoted, when it promoted one. */
  readonly promotedPluginId?: string | undefined;
  /** How long the rerank took. 0 when the classifier was skipped before any request. */
  readonly decidedInMs: number;
  /** Share of query tokens that scored above zero on at least one catalog entry, in [0, 1]. */
  readonly coverage: number;
  /** Candidate questions sent. */
  readonly attempts: number;
  /** Failure reasons seen, joined and sorted. Empty when nothing failed. */
  readonly failures: string;
}

export interface PluginSearchJevOptions {
  /** Injected client. `null` forces the pure-lexical path, which is what a degradation test wants. */
  readonly client?: DecisionClient | null | undefined;
  /** Overrides `PLUGIN_SEARCH_JEV_MAX_CANDIDATES`. */
  readonly maxCandidates?: number | undefined;
  /** Overrides the per-request timeout. */
  readonly timeoutMs?: number | undefined;
  /** Diagnostics sink. Defaults to a `console.warn` on the failure path. */
  readonly log?: ((message: string) => void) | undefined;
}

/**
 * The instructions sent with every candidate question. This text is part of the
 * contract: it states the one thing the lexical pass gets wrong (the request
 * names a task, not a product), it scopes the answer to the named plugin, and it
 * names the abstain case in the model's own terms.
 */
export const PLUGIN_SEARCH_JEV_INSTRUCTIONS =
  "A user typed a short request into a plugin catalog search box. The request names a task or a workflow, often without naming the product behind it. The state lists the request verbatim and the catalog entries under test. Decide whether the plugin named in the question is the one the user wants. Judge the intent, not the wording: \"manage linear issues\" and \"triage bugs\" both ask for issue tracking even when the words never appear in a plugin's name or description. Answer true when running that plugin would carry out what the user asked for. Answer false when the plugin does something else. Answer with the abstain option when the request is too vague to identify a plugin, or when it asks for something no catalog plugin provides.";

/** `true`: the plugin does what the request asks for. */
export const PLUGIN_SEARCH_JEV_TRUE_DESCRIPTION =
  "Running this plugin would carry out what the user asked for.";

/** `false`: the plugin does something else. */
export const PLUGIN_SEARCH_JEV_FALSE_DESCRIPTION =
  "This plugin does something other than what the user asked for.";

/**
 * The required abstain option. Without it the model must answer on every
 * candidate, including the ones it cannot judge; the client throws when it is
 * missing.
 */
export const PLUGIN_SEARCH_JEV_ABSTAIN = {
  value: "unclear",
  description: "The request is too vague to identify a plugin, or asks for something this catalog does not provide.",
} as const;

const MAX_DESCRIPTION_CHARS = 180;
const MAX_SKILLS_SHOWN = 4;
const RELAXED_PREFIX_MIN_LENGTH = 4;

/** One catalog entry as the model reads it. One line per entry keeps the state inside the token budget. */
function describeCandidate(plugin: PluginSearchCandidate): string {
  const skills = plugin.skills.slice(0, MAX_SKILLS_SHOWN).map((skill) => skill.name).filter((name) => name.length > 0);
  const description = plugin.description.replace(/\s+/g, " ").trim();
  const shortened = description.length <= MAX_DESCRIPTION_CHARS ? description : `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
  return [
    `id=${plugin.pluginId}`,
    `name=${plugin.displayName.length > 0 ? plugin.displayName : plugin.name}`,
    `category=${plugin.category.length > 0 ? plugin.category : "uncategorized"}`,
    skills.length > 0 ? `skills=${skills.join("; ")}` : "skills=none",
    `description=${shortened.length > 0 ? shortened : "none"}`,
  ].join(" | ");
}

/**
 * The `state` for ONE candidate question. The query is verbatim; it is never
 * translated.
 *
 * The candidate goes into the `state` and not only into the `judge()` question
 * text, and that is load-bearing rather than cosmetic. `buildJudgeQuestion`
 * validates its `question` argument but does not put it into the question object
 * it builds, so the client's cache key -- `decisionCacheKey({model, state,
 * question})` -- does not see it. Two `judge()` calls that share a `state` and
 * the same criteria therefore share one cache key, and the second joins the
 * first's in-flight request and is handed the first's answer marked `cached`.
 * Naming the candidate in the `state` gives every request its own key, and it is
 * also the only way the model learns which catalog entry it is judging.
 */
export function buildPluginSearchJevState(
  query: string,
  shortlist: readonly PluginSearchCandidate[],
  candidate: PluginSearchCandidate,
): string {
  const request = query.trim();
  return [
    `User request: ${request.length > 0 ? request : "(empty)"}`,
    `Plugin under test: ${candidate.pluginId} (${candidate.displayName.length > 0 ? candidate.displayName : candidate.name})`,
    "Catalog entries:",
    ...shortlist.map((plugin, index) => `${index + 1}. ${describeCandidate(plugin)}`),
  ].join("\n");
}

/** Total lexical score of one catalog entry: the same sum `rankPluginsLexically` reduces. */
function totalScore<T extends PluginSearchCandidate>(evidence: PluginSearchEvidence<T>, plugin: T): number {
  return evidence.tokens.reduce((sum, token) => sum + evidence.tokenScoreOf(plugin, token), 0);
}

/**
 * Share of query tokens that scored above zero on at least one catalog entry.
 *
 * A token at zero everywhere carries no information about the ordering, which is
 * why a low coverage is the signature of a natural-language query.
 */
export function pluginSearchTokenCoverage<T extends PluginSearchCandidate>(evidence: PluginSearchEvidence<T>): number {
  const { tokens, all, tokenScoreOf } = evidence;
  if (tokens.length === 0) return 0;
  let covered = 0;
  for (const token of tokens) {
    if (all.some((plugin) => tokenScoreOf(plugin, token) > 0)) covered += 1;
  }
  return covered / tokens.length;
}

/**
 * The lexical top score and its gap to the runner-up. A missing runner-up counts
 * as 0, so a unique hit spreads by its whole score.
 */
function lexicalLead<T extends PluginSearchCandidate>(evidence: PluginSearchEvidence<T>): { readonly top: number; readonly spread: number } {
  const first = evidence.lexical[0];
  if (first === undefined) return { top: 0, spread: 0 };
  const top = totalScore(evidence, first);
  const second = evidence.lexical[1];
  const runnerUp = second === undefined ? 0 : totalScore(evidence, second);
  return { top, spread: top - runnerUp };
}

/** True when the lexical pass alone already produced a defensible ordering. */
export function isLexicalPluginRankingConfident<T extends PluginSearchCandidate>(evidence: PluginSearchEvidence<T>): boolean {
  const { top, spread } = lexicalLead(evidence);
  return top >= PLUGIN_SEARCH_EXACT_NAME_SCORE && spread >= PLUGIN_SEARCH_CONFIDENT_SPREAD;
}

/**
 * The candidates to ask about.
 *
 * With lexical hits the shortlist IS the head of the lexical list: the
 * classifier reorders what lexical found and never widens the net behind a
 * confident lexical answer. With no lexical hit at all there is nothing to
 * reorder, so a RELAXED pass over the whole catalog supplies candidates. That
 * pass matches the first 4 characters of a token as a prefix, which is what lets
 * "issues" reach a plugin named "Issue Tracker" and "manage" reach one in the
 * "Management" category, without dragging in a stemmer.
 */
export function pluginSearchShortlist<T extends PluginSearchCandidate>(
  evidence: PluginSearchEvidence<T>,
  maxCandidates: number = PLUGIN_SEARCH_JEV_MAX_CANDIDATES,
): T[] {
  if (evidence.lexical.length > 0) return evidence.lexical.slice(0, maxCandidates);
  const ranked = evidence.all
    .map((plugin) => ({ plugin, relaxed: relaxedScore(plugin, evidence.tokens) }))
    .filter((entry) => entry.relaxed > 0)
    .sort((left, right) => right.relaxed - left.relaxed || left.plugin.displayName.localeCompare(right.plugin.displayName));
  return ranked.slice(0, maxCandidates).map((entry) => entry.plugin);
}

function relaxedScore(plugin: PluginSearchCandidate, tokens: readonly string[]): number {
  let best = 0;
  for (const token of tokens) {
    const prefix = token.slice(0, RELAXED_PREFIX_MIN_LENGTH);
    if (prefix.length < RELAXED_PREFIX_MIN_LENGTH) continue;
    const names = [plugin.name, plugin.displayName].map((text) => text.toLowerCase());
    const inName = names.some((text) => text.includes(prefix) || (text.length >= RELAXED_PREFIX_MIN_LENGTH && prefix.includes(text)));
    const inMetadata = plugin.skills.some((skill) => skill.name.toLowerCase().includes(prefix))
      || plugin.category.toLowerCase().includes(prefix)
      || plugin.description.toLowerCase().includes(prefix);
    if (inName) best = Math.max(best, 2);
    else if (inMetadata) best = Math.max(best, 1);
  }
  return best;
}

let cachedClient: DecisionClient | null = null;
let clientResolved = false;
let cooldownUntilMs = 0;

/**
 * The production client, built once per process.
 *
 * An unset `TYPESAFE_API_KEY` is a normal configuration, not an error: search
 * then stays purely lexical. A `DecisionClientConfigError` (bad base URL,
 * floating alias) is swallowed for the same reason -- it must not turn a working
 * search into an error.
 */
export function resolvePluginSearchDecisionClient(): DecisionClient | null {
  if (clientResolved) return cachedClient;
  clientResolved = true;
  const apiKey = typeof process === "undefined" ? undefined : process.env[PLUGIN_SEARCH_JEV_API_KEY_ENV]?.trim();
  if (apiKey === undefined || apiKey.length === 0) return null;
  try {
    cachedClient = createHttpDecisionClient({
      baseUrl: PLUGIN_SEARCH_JEV_BASE_URL,
      apiKey,
      model: JEV_DEFAULT_MODEL,
      timeoutMs: PLUGIN_SEARCH_JEV_TIMEOUT_MS,
    });
  } catch {
    cachedClient = null;
  }
  return cachedClient;
}

/** Drops the memoized client and the cooldown so a settings change can pick up a new key. */
export function resetPluginSearchDecisionClientCache(): void {
  cachedClient = null;
  clientResolved = false;
  cooldownUntilMs = 0;
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function warn(message: string): void {
  console.warn(`[plugin-search] ${message}`);
}

/** The most characters of any one interpolated value that reaches a log line. */
const PLUGIN_SEARCH_LOG_VALUE_MAX = 120;

/**
 * One bounded, single-line value for a log line: runs of whitespace collapse to a
 * single space, and anything longer is cut.
 *
 * This is `truncateOneLine` from `../tools/sand-mcp-management-tools.js`, repeated
 * here ON PURPOSE. It is not imported: this module is imported by the tool module,
 * so importing back from it would close an import cycle -- the same cycle the
 * header of this file already refuses to close for `scorePluginForToken`. Three
 * characters of duplication is the cheaper mistake. If you are about to delete this
 * and import the other one instead, do not.
 */
function logValue(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > PLUGIN_SEARCH_LOG_VALUE_MAX ? `${oneLine.slice(0, PLUGIN_SEARCH_LOG_VALUE_MAX - 1)}…` : oneLine;
}

/**
 * The user's request, DESCRIBED and not reproduced.
 *
 * `logValue` is not enough for this value, and having a separate helper is the
 * whole point. The query is whatever the user typed, and `SearchPlugins` takes free
 * text by design -- its own description invites "natural language", and a pasted
 * API key is natural language. A credential is SHORT: an `sk-...` key runs to a few
 * dozen characters, so cutting the query to any sane bound copies the whole secret
 * into the log. Truncation is not redaction for this input, and a redactor that
 * only truncates looks like one while leaking.
 *
 * So the text does not go to the log at all. What goes is its length and how many
 * usable words survived tokenization, which is what an operator debugging "the
 * classifier did not contribute" actually needs. The query itself is already in the
 * agent transcript beside the tool call that carried it, so echoing it here would
 * only add a second, less protected copy of possibly sensitive user text to a sink
 * that has no redaction of its own.
 *
 * Keep it that way: `outcome.reason` is logged and `DecisionFailure.detail` is
 * NOT, so the response-body redaction in `decision-client.ts` cannot reach this
 * file by a second route.
 */
function describeQueryForLog(query: string, tokenCount: number): string {
  return `a ${query.trim().length}-character request (${tokenCount} usable word(s))`;
}

/** A one-shot timer that resolves to `null`, so a stalled batch cannot hold a search open. */
function deadlineAfter(ms: number): Promise<null> {
  return new Promise<null>((resolve) => {
    const timer: { unref?: () => void } = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}

/**
 * Rerank the lexical result with one binary classifier question per candidate,
 * asked concurrently.
 *
 * Never throws: every failure path returns the lexical list untouched.
 */
export async function searchPluginsWithJev<T extends PluginSearchCandidate>(
  evidence: PluginSearchEvidence<T>,
  options: PluginSearchJevOptions = {},
): Promise<PluginSearchOutcome<T>> {
  const startedAtMs = nowMs();
  const lexical = evidence.lexical;
  const log = options.log ?? warn;
  let coverage = 0;
  const outcome = (skip: PluginSearchClassifierSkip, extra?: { readonly classifierUsed?: boolean; readonly promotedPluginId?: string; readonly attempts?: number; readonly failures?: string; readonly decidedInMs?: number }): PluginSearchOutcome<T> => ({
    plugins: lexical,
    classifierUsed: extra?.classifierUsed ?? false,
    skip,
    ...(extra?.promotedPluginId === undefined ? {} : { promotedPluginId: extra.promotedPluginId }),
    decidedInMs: extra?.decidedInMs ?? nowMs() - startedAtMs,
    coverage,
    attempts: extra?.attempts ?? 0,
    failures: extra?.failures ?? "",
  });

  try {
    if (evidence.tokens.length === 0) return outcome("no-query-tokens");
    coverage = pluginSearchTokenCoverage(evidence);
    if (isLexicalPluginRankingConfident(evidence)) return outcome("lexical-confident");

    const client = options.client === undefined ? resolvePluginSearchDecisionClient() : options.client;
    if (client == null) return outcome("no-client");
    if (nowMs() < cooldownUntilMs) return outcome("client-unavailable");

    const shortlist = pluginSearchShortlist(evidence, options.maxCandidates ?? PLUGIN_SEARCH_JEV_MAX_CANDIDATES);
    if (shortlist.length === 0) return outcome("no-shortlist");

    const timeoutMs = options.timeoutMs ?? PLUGIN_SEARCH_JEV_TIMEOUT_MS;
    const answered = await Promise.race([
      Promise.all(shortlist.map((plugin) => judgeCandidate(client, evidence.query, shortlist, plugin, timeoutMs))),
      deadlineAfter(PLUGIN_SEARCH_JEV_DEADLINE_MS),
    ]);
    const decidedInMs = nowMs() - startedAtMs;
    const attempts = answered?.length ?? 0;

    if (answered === null) {
      cooldownUntilMs = nowMs() + PLUGIN_SEARCH_JEV_COOLDOWN_MS;
      log(`classifier batch passed the ${PLUGIN_SEARCH_JEV_DEADLINE_MS}ms deadline; kept the lexical result for ${describeQueryForLog(evidence.query, evidence.tokens.length)}.`);
      return outcome("deadline", { classifierUsed: true, attempts, failures: "timeout", decidedInMs });
    }

    const failures = [...new Set(answered.flatMap((attempt) => attempt.failure === undefined ? [] : [attempt.failure]))].sort();
    if (failures.length > 0) {
      cooldownUntilMs = nowMs() + PLUGIN_SEARCH_JEV_COOLDOWN_MS;
      log(`classifier unavailable (${logValue(failures.join(", "))}); kept the lexical result for ${describeQueryForLog(evidence.query, evidence.tokens.length)}.`);
    }

    // Only `ok` outcomes carry a value, so this is the one place a value can be read.
    const answeredOk = answered.filter((attempt) => attempt.outcome !== undefined);
    const autoDecided = answered.filter(isAutoDecided);
    const relevant = autoDecided.filter(isDecidedTrue);
    const promoted = relevant.length === 0 ? undefined : bestByProbability(relevant);
    const asked = { classifierUsed: true, attempts, failures: failures.join(", "), decidedInMs };

    if (promoted !== undefined) {
      return {
        ...outcome("promoted", { ...asked, promotedPluginId: promoted.pluginId }),
        plugins: [promoted, ...lexical.filter((plugin) => plugin.pluginId !== promoted.pluginId)],
      };
    }
    if (autoDecided.length > 0) return outcome("no-relevant", asked);
    // A real answer that landed in the `uncertain` band is not a failure: it is an
    // answer the caller may not act on, and the lexical order stands.
    if (answeredOk.length > 0) return outcome("no-decide", asked);
    if (failures.length > 0 && failures.every((reason) => reason === "abstained")) return outcome("abstained", asked);
    return outcome("failed", asked);
  } catch (error) {
    // Nothing here may escape: the lexical result is always a valid answer.
    log(`classifier rerank threw (${logValue(error instanceof Error ? error.message : String(error))}); kept the lexical result.`);
    return outcome("error");
  }
}

interface CandidateAttempt<T extends PluginSearchCandidate = PluginSearchCandidate> {
  readonly plugin: T;
  /** Present only when the client returned an `ok` outcome. */
  readonly outcome: DecisionOutcome<boolean> | undefined;
  /** `"abstained"`, a `DecisionFailureReason`, or `"timeout"` from the batch guard. */
  readonly failure: string | undefined;
}

/** An attempt that came back decided, so its `value` may be read. */
type AutoDecidedAttempt<T extends PluginSearchCandidate> = CandidateAttempt<T> & { readonly outcome: Decision<boolean> };

function isAutoDecided<T extends PluginSearchCandidate>(attempt: CandidateAttempt<T>): attempt is AutoDecidedAttempt<T> {
  return attempt.outcome !== undefined && attempt.outcome.ok === true && attempt.outcome.band === "decide";
}

function isDecidedTrue<T extends PluginSearchCandidate>(attempt: AutoDecidedAttempt<T>): boolean {
  return attempt.outcome.value === true;
}

/** One binary question: "is this the plugin the user means?" Never throws. */
async function judgeCandidate<T extends PluginSearchCandidate>(
  client: DecisionClient,
  query: string,
  shortlist: readonly T[],
  plugin: T,
  timeoutMs: number,
): Promise<CandidateAttempt<T>> {
  try {
    // One `state` per candidate, so every request gets its own cache key.
    const state = buildPluginSearchJevState(query, shortlist, plugin);
    const outcome = await client.judge(state, `Is plugin "${plugin.pluginId}" (${plugin.displayName}) the one the user wants?`, {
      abstain: { value: PLUGIN_SEARCH_JEV_ABSTAIN.value, description: PLUGIN_SEARCH_JEV_ABSTAIN.description },
      instructions: PLUGIN_SEARCH_JEV_INSTRUCTIONS,
      trueDescription: PLUGIN_SEARCH_JEV_TRUE_DESCRIPTION,
      falseDescription: PLUGIN_SEARCH_JEV_FALSE_DESCRIPTION,
      timeoutMs,
      id: `plugin-search-${plugin.pluginId}`,
    });
    return outcome.ok ? { plugin, outcome, failure: undefined } : { plugin, outcome: undefined, failure: outcome.reason };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { plugin, outcome: undefined, failure: name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

/**
 * Among the candidates the classifier auto-decided relevant, the one it is most
 * confident about: the raw `true` probability. Ties keep the shortlist order,
 * which is lexical order, so the result is deterministic.
 */
function bestByProbability<T extends PluginSearchCandidate>(attempts: readonly CandidateAttempt<T>[]): T | undefined {
  let bestIndex = -1;
  let bestScore = -1;
  for (const [index, attempt] of attempts.entries()) {
    const raw = attempt.outcome?.ok === true ? attempt.outcome.probabilities["true"] : undefined;
    const score = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  const winner = bestIndex < 0 ? undefined : attempts[bestIndex];
  return winner?.plugin;
}
