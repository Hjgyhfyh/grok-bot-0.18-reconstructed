import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * `getAgentTranscriptPage` answered `{"entries":[]}` for every agent on a live
 * box that had transcripts. Eight agents in a row reported three, three, two,
 * two, six, two, one and three entries through `getAgentTranscript`,
 * `getAgentTranscriptTail` and `getAgentTranscriptWindow`, and zero through
 * `getAgentTranscriptPage` — for all of them.
 *
 * Why. `readTranscriptPage` binds `query.untilMs` straight into
 * `json_extract(entry, '$.timestampMs') <= ?`. Its two siblings normalise their
 * inputs first: `readTranscriptWindow` and `readTranscriptTail` both clamp
 * `limit` and treat a missing `beforeSeq` as null. The page reader did neither,
 * and nothing upstream supplies the missing piece — `host-gateway-api.ts` hands
 * it the request verbatim, so the query that arrives is `{ id, beforeSeq,
 * limit }` with no `untilMs` at all. `node:sqlite` binds `undefined` as NULL,
 * `ts <= NULL` evaluates to NULL, and every row that carries a `timestampMs`
 * drops out of the result. `query.limit + 1` was `NaN` in the same breath.
 *
 * Nothing threw. The page came back shaped like a page, carrying nothing, which
 * is exactly what an empty conversation looks like — so the caller had no way to
 * tell "this agent has no transcript" from "this reader cannot read one".
 *
 * The tests below drive the real store through the exact query the gateway
 * sends and through the deliberate ones, and they fail against the old reader.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-transcript-page-"));
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
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([["host", "extensions", "session", "agent-db.ts"]]);
const { SandAgentDb, ensureAgentDbDirectory } = loaded["agent-db.mjs"];
test.after(() => dispose());

const AGENT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/**
 * A store holding four timestamped user messages. They are all `role: "user"`
 * on purpose: `MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL` keeps only `send-message`,
 * `user-attachment`, and `message` rows that name an agent, so a plain
 * assistant message is not part of the main transcript and would make a page
 * test pass for the wrong reason.
 */
function storeWithEntries() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-transcript-page-root-"));
  const agentDir = path.join(base, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  ensureAgentDbDirectory(dbPath);
  const db = new SandAgentDb(dbPath);
  for (const [index, timestampMs] of [1_000, 2_000, 3_000, 4_000].entries()) {
    db.appendTranscriptEntry({ kind: "message", id: `e${index + 1}`, role: "user", content: `message ${index + 1}`, timestampMs });
  }
  return { base, agentDir, dbPath, db };
}

function closeStore(store) {
  try {
    store.db.close();
  } catch {}
  try {
    rmSync(store.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

test("the fixture really holds the entries the page is supposed to return", () => {
  const store = storeWithEntries();
  try {
    const all = store.db.getTranscriptEntries();
    assert.equal(all.length, 4, "the fixture wrote fewer entries than it was supposed to, so a passing page proves nothing");
    assert.equal(store.db.getTranscriptTail({ limit: 500 }).entries.length, 4,
      "the tail reader cannot see the fixture, so the store under test is not the store that failed");
    assert.ok(
      all.every((entry) => typeof entry.timestampMs === "number"),
      "the fixture has an entry with no timestamp, and the defect is specifically about rows that carry one"
    );
  } finally {
    closeStore(store);
  }
});

test("a page query with no untilMs, exactly as the gateway sends it, returns the entries", () => {
  const store = storeWithEntries();
  try {
    // This is `host-gateway-api.ts` handing `getAgentTranscriptPage` the parsed
    // request body verbatim: `{ id, limit }`, with no `untilMs` anywhere.
    const page = store.db.getTranscriptPage({ limit: 500 });
    assert.ok(Array.isArray(page.entries), "the page reader did not answer with a page");
    assert.equal(page.entries.length, 4,
      `a page query with no untilMs returned ${page.entries.length} of the 4 timestamped entries: the reader refused to bind an absent upper bound`);
    assert.deepEqual(page.entries.map((entry) => entry.id), ["e1", "e2", "e3", "e4"],
      "the page came back in the wrong order or with the wrong rows, so it is not simply an upper bound that never arrived");
  } finally {
    closeStore(store);
  }
});

test("a page query with no limit at all still returns the entries", () => {
  const store = storeWithEntries();
  try {
    const page = store.db.getTranscriptPage({});
    assert.equal(page.entries.length, 4,
      `a page query carrying no limit returned ${page.entries.length} entries: an absent limit must fall back to the default, not become NaN`);
  } finally {
    closeStore(store);
  }
});

test("a page query that names untilMs still bounds the page from above", () => {
  const store = storeWithEntries();
  try {
    const bounded = store.db.getTranscriptPage({ untilMs: 2_000, limit: 500 });
    assert.deepEqual(bounded.entries.map((entry) => entry.id), ["e1", "e2"],
      `untilMs: 2000 should have stopped the page before the third message, got ${JSON.stringify(bounded.entries.map((e) => e.id))}`);

    const empty = store.db.getTranscriptPage({ untilMs: 500, limit: 500 });
    assert.deepEqual(empty.entries, [],
      "a page whose upper bound sits before every entry must be empty, not full: the bound was ignored");
  } finally {
    closeStore(store);
  }
});

test("sinceMs and beforeSeq still bound the page the other two ways", () => {
  const store = storeWithEntries();
  try {
    const since = store.db.getTranscriptPage({ sinceMs: 3_000, limit: 500 });
    assert.deepEqual(since.entries.map((entry) => entry.id), ["e3", "e4"],
      `sinceMs: 3000 should have dropped the first two messages, got ${JSON.stringify(since.entries.map((e) => e.id))}`);

    const tail = store.db.getTranscriptPage({ limit: 2 });
    assert.equal(tail.entries.length, 2, "a page with limit 2 returned a different number of entries");
    assert.equal(typeof tail.nextBeforeSeq, "number",
      "a page with a limit smaller than the transcript must hand back the seq to continue from, or the caller cannot page at all");
    const next = store.db.getTranscriptPage({ beforeSeq: tail.nextBeforeSeq, limit: 2 });
    assert.deepEqual(next.entries.map((entry) => entry.id), ["e1", "e2"],
      `paging backwards with the seq the previous page handed back lost a row: got ${JSON.stringify(next.entries.map((e) => e.id))}`);
  } finally {
    closeStore(store);
  }
});

test("a limit past the ceiling is clamped instead of trusted", () => {
  const store = storeWithEntries();
  try {
    const page = store.db.getTranscriptPage({ limit: 10_000_000 });
    assert.equal(page.entries.length, 4,
      "a limit of ten million was taken literally; the reader has to clamp it the way its siblings do");
    const nonsense = store.db.getTranscriptPage({ limit: -5 });
    assert.equal(nonsense.entries.length, 4,
      `a negative limit produced ${nonsense.entries.length} entries; the reader has to fall back to the default the way readTranscriptWindow does`);
  } finally {
    closeStore(store);
  }
});

test("the three transcript readers agree about a store with entries", () => {
  const store = storeWithEntries();
  try {
    const ids = (reader) => reader.entries.map((entry) => entry.id);
    const tail = ids(store.db.getTranscriptTail({ limit: 500 }));
    const window = ids(store.db.getTranscriptWindow({ limit: 500 }));
    const page = ids(store.db.getTranscriptPage({ limit: 500 }));
    assert.deepEqual(page, tail,
      `the page reader and the tail reader disagree about the same store: page=${JSON.stringify(page)} tail=${JSON.stringify(tail)}`);
    assert.deepEqual(window, tail,
      `the window reader and the tail reader disagree about the same store: window=${JSON.stringify(window)} tail=${JSON.stringify(tail)}`);
  } finally {
    closeStore(store);
  }
});