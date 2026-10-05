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
 */
export function readTranscriptPage(statements: TranscriptPageStatements, query: TranscriptPageQuery): { entries: TranscriptEntry[]; nextBeforeSeq?: number } { const before = finiteOrNull(query?.beforeSeq), since = finiteOrNull(query?.sinceMs), until = finiteOrNull(query?.untilMs) ?? Number.MAX_SAFE_INTEGER, limit = pageLimit(query?.limit); return page(statements.listTranscriptPage.all(before, before, since, since, until, limit + 1), limit); }
export function readTranscriptWindow(statements: TranscriptPageStatements, query: Pick<TranscriptPageQuery, "beforeSeq" | "limit">, threadCountsFor: (entries: readonly TranscriptEntry[]) => unknown): { entries: TranscriptEntry[]; nextBeforeSeq?: number; threadCounts: unknown } { const before = finiteOrNull(query?.beforeSeq); const limit = pageLimit(query?.limit); const result = page(statements.listTranscriptWindow.all(before, before, limit + 1), limit); return { ...result, threadCounts: threadCountsFor(result.entries) }; }
export function readTranscriptTail(statements: TranscriptPageStatements, query: Pick<TranscriptPageQuery, "beforeSeq" | "limit">): { entries: TranscriptEntry[]; nextBeforeSeq?: number } { const before = finiteOrNull(query?.beforeSeq), limit = pageLimit(query?.limit); return page(statements.listTranscriptTail.all(before, before, limit + 1), limit); }
