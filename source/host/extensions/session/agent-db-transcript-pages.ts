import { parseTranscriptEntry } from "./agent-db-serde.js";

interface Row { seq?: number; entry?: string }
interface Statement { all(...parameters: unknown[]): Row[] }
export interface TranscriptPageStatements { listTranscriptPage: Statement; listTranscriptWindow: Statement; listTranscriptTail: Statement }
export interface TranscriptPageQuery { beforeSeq?: number; sinceMs?: number; untilMs?: number; limit?: number }
type TranscriptEntry = Record<string, unknown>;

/** The window and tail readers clamp to this; the page reader has to as well. */
const TRANSCRIPT_PAGE_DEFAULT_LIMIT = 500;
const TRANSCRIPT_PAGE_MAX_LIMIT = 5_000;

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pageLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, TRANSCRIPT_PAGE_MAX_LIMIT)
    : TRANSCRIPT_PAGE_DEFAULT_LIMIT;
}

function page(rows: Row[], limit: number): { entries: TranscriptEntry[]; nextBeforeSeq?: number } {
  const hasMore = rows.length > limit, selected = rows.slice(0, limit), entries: TranscriptEntry[] = [];
  for (const row of selected.toReversed()) if (typeof row.entry === "string") { const entry = parseTranscriptEntry(row.entry); if (entry != null) entries.push(entry); }
  const oldestSeq = selected.at(-1)?.seq; return { entries, ...(hasMore && typeof oldestSeq === "number" ? { nextBeforeSeq: oldestSeq } : {}) };
}
/**
 * Normalises the query before it reaches SQL.
 *
 * This reader used to hand `query.untilMs` and `query.limit + 1` straight to
 * `node:sqlite`. No caller supplies `untilMs`: `host-gateway-api.ts` forwards the
 * parsed request verbatim, so the query that arrives is `{ id, beforeSeq,
 * limit }`. `node:sqlite` refuses to bind `undefined`, so every page read
 * without an upper bound raised `Provided value cannot be bound to SQLite
 * parameter 5`; the gateway's fallback for a non-open agent turned that into
 * `{"entries": []}` and the caller saw an empty conversation for an agent that
 * had one. Its two siblings already normalise here, which is why the window and
 * tail readers kept working while the page reader did not.
 *
 * An absent bound now means "no bound": `untilMs` becomes the largest finite
 * timestamp rather than NULL, `sinceMs` and `beforeSeq` become NULL when they are
 * absent or not a number, and `limit` falls back to the same default the window
 * reader uses.
 *
 * The bounds are enforced against a row that has no `timestampMs` by asking
 * whether the *bound* is absent, not by exempting the row. The old predicate
 * read `(json_extract(entry, '$.timestampMs') IS NULL OR (? IS NULL OR ...))`,
 * which let a timestamp-less row through no matter what window the caller asked
 * for. `rebuildTranscriptEntriesFromState` builds exactly such rows — it spreads
 * `...(item.timestampMs == null ? {} : { timestampMs: item.timestampMs })` — and
 * `backfillTranscript` writes them, so a store under recovery really does hold
 * them. Measured on a store of 500 recovered entries and 3 fresh ones,
 * `getTranscriptPage({ sinceMs: now - 2000, untilMs: now, limit: 10 })` answered
 * with 7 of the recovered entries, and walking that page to its end returned all
 * 503 rows: a caller asking what happened in the last two seconds was handed the
 * whole recovered history, on every call. An absent bound still carries the
 * timestamp-less rows, because an absent bound is not a window.
 *
 * Each bound is therefore bound twice: once as the flag that says whether the
 * caller asked for a window at all, and once as the value to compare against,
 * which is `MIN_SAFE_INTEGER` or `MAX_SAFE_INTEGER` when the bound is absent.
 * Comparing against NULL instead would make `ts >= NULL` evaluate to NULL and
 * drop every row of a query that asked for no lower bound, which is exactly the
 * reader the gateway sends.
 */
export function readTranscriptPage(statements: TranscriptPageStatements, query: TranscriptPageQuery): { entries: TranscriptEntry[]; nextBeforeSeq?: number } { const before = finiteOrNull(query?.beforeSeq), sinceBound = finiteOrNull(query?.sinceMs), untilBound = finiteOrNull(query?.untilMs), since = sinceBound ?? Number.MIN_SAFE_INTEGER, until = untilBound ?? Number.MAX_SAFE_INTEGER, limit = pageLimit(query?.limit); return page(statements.listTranscriptPage.all(before, before, sinceBound, since, untilBound, until, limit + 1), limit); }
export function readTranscriptWindow(statements: TranscriptPageStatements, query: Pick<TranscriptPageQuery, "beforeSeq" | "limit">, threadCountsFor: (entries: readonly TranscriptEntry[]) => unknown): { entries: TranscriptEntry[]; nextBeforeSeq?: number; threadCounts: unknown } { const before = finiteOrNull(query?.beforeSeq); const limit = pageLimit(query?.limit); const result = page(statements.listTranscriptWindow.all(before, before, limit + 1), limit); return { ...result, threadCounts: threadCountsFor(result.entries) }; }
export function readTranscriptTail(statements: TranscriptPageStatements, query: Pick<TranscriptPageQuery, "beforeSeq" | "limit">): { entries: TranscriptEntry[]; nextBeforeSeq?: number } { const before = finiteOrNull(query?.beforeSeq), limit = pageLimit(query?.limit); return page(statements.listTranscriptTail.all(before, before, limit + 1), limit); }
