import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A page query with a time window answered with entries that have no time at
 * all, however old, so a caller asking "what happened in the last two seconds"
 * was handed the whole recovered history on every call.
 *
 * What broke. `listTranscriptPage` (`agent-db-schema.ts`) spelled both bounds as
 * `(... IS NULL OR (? IS NULL OR ... >= ?))` and `(... IS NULL OR ... <= ?)`.
 * The leading `IS NULL` test is on the *row*: a row with no `timestampMs` passes
 * the predicate whatever window the caller named. So the escape hatch that was
 * meant for "this row cannot be compared, do not lose it" also fired for "the
 * caller asked for a window", and the second clause had no `? IS NULL` guard at
 * all — `untilMs` was normalised to `MAX_SAFE_INTEGER` when absent, but a
 * present `untilMs` still let every timestamp-less row through.
 *
 * The store holds such rows in normal operation. `rebuildTranscriptEntriesFromState`
 * (`conversation-recovery.ts:7`) spreads
 * `...(item.timestampMs == null ? {} : { timestampMs: item.timestampMs })`, and
 * `backfillTranscript` writes the result, so every entry recovered from a
 * conversation whose outline item carries no timestamp lands without one.
 *
 * Measured on a store of 500 recovered entries followed by 3 fresh ones, before
 * the fix: `getTranscriptPage({ sinceMs: now - 2000, untilMs: now, limit: 10 })`
 * answered `["recovered-493" … "recovered-499", "fresh-1", "fresh-2", "fresh-3"]`
 * — 7 of its 10 rows outside the window — and walking that page to its end took
 * 11 pages and returned all 503 rows, 500 of them with no timestamp at all.
 * After the fix the same call answers the 3 fresh entries in 1 page.
 *
 * What these tests prove. A bound that the caller supplied is a bound for every
 * row, and an absent bound is not a window: the unbounded query the gateway
 * sends still returns the timestamp-less rows, so nothing is lost by closing the
 * hatch.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-page-window-"));
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
    });
  }
  const loaded = {};
  for (const [name, file] of names)
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "session", "agent-db.ts"],
]);
const { SandAgentDb, ensureAgentDbDirectory } = loaded["agent-db.mjs"];
test.after(() => dispose());

const AGENT_ID = "c0ffee00-1111-4222-8333-444444444444";
const RECOVERED = 500;
const NOW = 1_700_000_000_000;
/** A walk that never ends would hang instead of failing, so every walk here has a ceiling. */
const PAGE_WALK_LIMIT = 64;

function discard(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

/**
 * Shaped exactly like `rebuildTranscriptEntriesFromState` builds an entry whose
 * outline item carries no timestamp: the spread emits no `timestampMs` key.
 */
function recoveredEntry(index) {
  return {
    kind: "message",
    id: `recovered-${index}`,
    role: "user",
    content: `recovered ${index}`,
    isStreaming: false,
  };
}

function freshEntry(id, timestampMs) {
  return { kind: "message", id, role: "user", content: id, timestampMs };
}

function storeWithRecoveredHistory() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-page-window-root-"));
  const agentDir = path.join(base, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  ensureAgentDbDirectory(dbPath);
  const db = new SandAgentDb(dbPath);
  const batch = [];
  for (let index = 0; index < RECOVERED; index += 1) batch.push(recoveredEntry(index));
  for (let index = 0; index < RECOVERED; index += 500)
    db.appendTranscriptEntries(batch.slice(index, index + 500));
  db.appendTranscriptEntries([
    freshEntry("fresh-1", NOW - 1_000),
    freshEntry("fresh-2", NOW - 500),
    freshEntry("fresh-3", NOW),
  ]);
  return { base, db };
}

test("the fixture really holds the rows the bounds are supposed to exclude", () => {
  const store = storeWithRecoveredHistory();
  try {
    const all = store.db.getTranscriptEntries();
    assert.equal(all.length, RECOVERED + 3, "the fixture is not the store the defect was measured on");
    const undated = all.filter((entry) => typeof entry.timestampMs !== "number");
    assert.equal(undated.length, RECOVERED,
      `the fixture holds ${undated.length} entries with no timestampMs, so the page reader is never asked to bound one and the test proves nothing`);
    assert.equal(store.db.getTranscriptPage({ limit: 5 }).entries.length, 5,
      "the unbounded page reader cannot see the fixture at all");
  } finally {
    store.db.close();
    discard(store.base);
  }
});

test("a page query that names a time window does not answer with entries outside it", () => {
  const store = storeWithRecoveredHistory();
  try {
    const page = store.db.getTranscriptPage({
      sinceMs: NOW - 2_000,
      untilMs: NOW,
      limit: 10,
    });
    assert.deepEqual(page.entries.map((entry) => entry.id), ["fresh-1", "fresh-2", "fresh-3"],
      `a window of [${NOW - 2000}, ${NOW}] returned ${page.entries.length} entries, and every recovered entry in it sits outside the window it was asked for`);
  } finally {
    store.db.close();
    discard(store.base);
  }
});

test("walking a catch-up page does not walk the recovered history behind it", () => {
  const store = storeWithRecoveredHistory();
  try {
    const rows = [];
    let beforeSeq = undefined;
    let reachedTheEnd = false;
    for (let guard = 0; guard < PAGE_WALK_LIMIT; guard += 1) {
      const page = store.db.getTranscriptPage({
        sinceMs: NOW - 2_000,
        ...(beforeSeq == null ? {} : { beforeSeq }),
        limit: 50,
      });
      for (const entry of page.entries) rows.push(entry);
      if (page.nextBeforeSeq == null) {
        reachedTheEnd = true;
        break;
      }
      beforeSeq = page.nextBeforeSeq;
    }
    assert.ok(reachedTheEnd,
      `a catch-up page never reported the end of its range within ${PAGE_WALK_LIMIT} pages`);
    assert.equal(rows.length, 3,
      `a catch-up query for the last two seconds walked ${rows.length} rows; nextBeforeSeq is taking the client backwards through ${RECOVERED} entries that carry no timestamp at all`);
    assert.ok(rows.every((entry) => typeof entry.timestampMs === "number"),
      "a catch-up query returned an entry with no timestamp, which is exactly the row the window was supposed to exclude");
  } finally {
    store.db.close();
    discard(store.base);
  }
});

test("a query that names only a lower bound still bounds from below", () => {
  const store = storeWithRecoveredHistory();
  try {
    const page = store.db.getTranscriptPage({ sinceMs: NOW - 2_000, limit: 50 });
    assert.deepEqual(page.entries.map((entry) => entry.id), ["fresh-1", "fresh-2", "fresh-3"],
      `sinceMs: ${NOW - 2000} returned ${page.entries.length} entries; a lower bound on its own must not admit rows outside it`);
  } finally {
    store.db.close();
    discard(store.base);
  }
});

test("a query that names only an upper bound still bounds from above", () => {
  const store = storeWithRecoveredHistory();
  try {
    const page = store.db.getTranscriptPage({ untilMs: NOW - 750, limit: 50 });
    assert.deepEqual(page.entries.map((entry) => entry.id), ["fresh-1"],
      `untilMs: ${NOW - 750} returned ${page.entries.map((entry) => entry.id).join(", ")}; an upper bound on its own must not admit rows outside it`);
  } finally {
    store.db.close();
    discard(store.base);
  }
});

test("closing the hatch for a bounded query does not close it for an unbounded one", () => {
  const store = storeWithRecoveredHistory();
  try {
    const unbounded = store.db.getTranscriptPage({ limit: 5 });
    assert.deepEqual(unbounded.entries.map((entry) => entry.id),
      ["recovered-498", "recovered-499", "fresh-1", "fresh-2", "fresh-3"],
      `an unbounded page returned ${JSON.stringify(unbounded.entries.map((entry) => entry.id))}; the timestamp-less rows must still come back when the caller named no window, or a recovery would hide them from the chat`);
    const stillAll = store.db.getTranscriptEntries();
    assert.equal(stillAll.length, RECOVERED + 3,
      "the timestamp-less rows stopped coming back from the store at all, so the hatch was closed at the wrong level");
  } finally {
    store.db.close();
    discard(store.base);
  }
});

test("the window reader and the page reader still agree when no window is named", () => {
  const store = storeWithRecoveredHistory();
  try {
    const tail = store.db.getTranscriptTail({ limit: 4 }).entries.map((entry) => entry.id);
    const window = store.db.getTranscriptWindow({ limit: 4 }).entries.map((entry) => entry.id);
    assert.deepEqual(window, tail,
      `the window reader and the tail reader disagree about the same store: window=${JSON.stringify(window)} tail=${JSON.stringify(tail)}`);
  } finally {
    store.db.close();
    discard(store.base);
  }
});
