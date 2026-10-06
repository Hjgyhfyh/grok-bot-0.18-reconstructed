import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A `store.db` that lost its tail was thrown away whole, even though the
 * surviving pages still held almost the entire conversation.
 *
 * What broke. `openSqliteForSalvage` opened the quarantined file and probed it
 * with `PRAGMA schema_version`. A short file still has a readable first page,
 * but the header's page-count field describes the file as it was *before* the
 * loss, so SQLite rejects the database as soon as it looks at a page that is
 * no longer there. The probe raised, the two open attempts both failed, and the
 * function fell through to a bare `new DatabaseSync(...)` handle that accepts
 * every statement and completes none of them. `copySalvageableSqliteRows` then
 * broke out of its loop on the first row, `salvageStoreDb` reported
 * `transcript: 0`, and `recoverCorruptStoreDb` published `outcome: "reset"` for
 * a conversation whose bytes were still on disk.
 *
 * Measured on one 2000-entry store, truncated to each ratio and then opened
 * through `SandAgentDb`: 99% → 0 salvaged with all 2000 entries still physically
 * present, 95% → 0, 90% → 0, 80% → 0, 70% → 0, 60% → 0, 50% → 0, 25% → 0. Every
 * one of those outcomes was `reset` with `salvaged: {kv: 0, blobs: 0,
 * transcript: 0}`. The same file with 4 KiB flipped in the middle instead of a
 * shortened tail salvaged 993, which is what proved the loss was about the file
 * length and not about the data.
 *
 * Why nothing noticed. The carve fires between two open attempts that both
 * "succeeded" from the caller's point of view, and the salvage is explicitly
 * best-effort, so a zero looked like a legitimate answer. The one caller that
 * guards on an unreadable quarantine,
 * `conversation-blob-db.ts:378` (`if (source == null && existsSync(quarantinePath))`),
 * could not fire either: the function returns a handle, never `undefined`, for a
 * file that no statement can read.
 *
 * What these tests prove. `openTruncatedSqliteForSalvage` lowers the header's
 * page count to the pages that are physically present, on a copy beside the
 * evidence, and `copySalvageableSqliteRows` then reads the tables up to the
 * truncation point. Every truncated store below comes back with most of its
 * transcript, in sequence order, with the entry ids it went in with.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-store-carve-"));
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
  ["host", "storage", "sqlite-recovery.ts"],
]);
const { SandAgentDb, ensureAgentDbDirectory } = loaded["agent-db.mjs"];
const { openSqliteForSalvage, openTruncatedSqliteForSalvage } =
  loaded["sqlite-recovery.mjs"];
test.after(() => dispose());

const AGENT_ID = "1a2b3c4d-5555-4666-8777-888899990000";
const ENTRY_COUNT = 2000;
/** Nothing in this file may loop without a ceiling; a runaway reader fails the suite by hanging. */
const PAGE_WALK_LIMIT = 64;

function discard(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

function userMessage(id, timestampMs) {
  return { kind: "message", id, role: "user", content: `m ${id}`, timestampMs };
}

/**
 * The highest-numbered entry whose id still appears in the raw bytes. This is
 * the number of rows a reader *could* have got back, independent of whether
 * SQLite is willing to serve them.
 */
function physicallyPresentEntries(dbPath) {
  const text = readFileSync(dbPath).toString("latin1");
  let last = 0;
  for (let index = 1; index <= ENTRY_COUNT; index += 1) {
    if (text.indexOf(`"id":"s${index}",`) >= 0) last = index;
  }
  return last;
}

/** A healthy store, checkpointed and closed, with `ENTRY_COUNT` entries. */
function buildSourceStore() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-store-carve-src-"));
  const agentDir = path.join(base, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  ensureAgentDbDirectory(dbPath);
  const db = new SandAgentDb(dbPath);
  const batch = [];
  for (let index = 1; index <= ENTRY_COUNT; index += 1)
    batch.push(userMessage(`s${index}`, index));
  for (let index = 0; index < ENTRY_COUNT; index += 500)
    db.appendTranscriptEntries(batch.slice(index, index + 500));
  db.close({ checkpoint: true });
  return { base, dbPath };
}

/**
 * A copy of the source store with `mutate` applied, in a temp directory of its
 * own. No real agent directory is ever named here, and the source store is only
 * ever read.
 */
function cloneSourceStore(sourceDbPath, mutate) {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-store-carve-clone-"));
  const agentDir = path.join(base, "agents", AGENT_ID);
  mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "store.db");
  copyFileSync(sourceDbPath, dbPath);
  mutate?.(dbPath);
  return { base, dbPath, agentDir };
}

function openAndSalvage(clone) {
  const events = [];
  const db = new SandAgentDb(clone.dbPath, {
    onCorruptionRecovered: (event) => events.push(event),
  });
  try {
    return {
      events,
      entries: db.getTranscriptEntries(),
      tail: db.getTranscriptTail({ limit: 5 }).entries,
      page: db.getTranscriptPage({ limit: 5 }).entries,
    };
  } finally {
    db.close();
  }
}

let source = null;
test.before(() => {
  source = buildSourceStore();
});
test.after(() => {
  if (source != null) discard(source.base);
});

test("the source store really holds every entry these tests claim to lose", () => {
  assert.ok(source != null, "the fixture was never built, so every assertion below would be about nothing");
  const clone = cloneSourceStore(source.dbPath);
  try {
    const entries = openAndSalvage(clone);
    assert.equal(entries.entries.length, ENTRY_COUNT,
      "the fixture wrote fewer entries than the test claims to lose, so a passing recovery proves nothing");
    assert.equal(entries.events.length, 0,
      "an untouched copy of the fixture needed recovery, so the fixture itself is corrupt and every truncation result is meaningless");
  } finally {
    discard(clone.base);
  }
});

test("a store truncated by a single page keeps its transcript instead of resetting to nothing", () => {
  const clone = cloneSourceStore(source.dbPath, (dbPath) =>
    truncateSync(dbPath, Math.floor(statSync(dbPath).size * 0.99)),
  );
  try {
    assert.equal(physicallyPresentEntries(clone.dbPath), ENTRY_COUNT,
      "the truncation removed entry bytes, so this case is not the one that proves the header page count is the obstacle");
    const { events, entries } = openAndSalvage(clone);
    assert.equal(events.length, 1, "a truncated store.db did not go through recovery at all");
    assert.equal(events[0].outcome, "recovered",
      `a store.db that lost its last 1% was reported as "${events[0].outcome}" with nothing salvaged, while all ${ENTRY_COUNT} entries were still on disk`);
    assert.ok(entries.length >= ENTRY_COUNT - 50,
      `a store.db truncated by one page salvaged ${entries.length} of the ${ENTRY_COUNT} entries that were physically present`);
    assert.deepEqual(entries.map((entry) => entry.id), Array.from({ length: entries.length }, (_, index) => `s${index + 1}`),
      "the salvaged entries are not the first ones in the file in sequence order, so the recovered transcript is not the conversation that was there");
  } finally {
    discard(clone.base);
  }
});

test("a store truncated to half its size keeps the half that survived", () => {
  const clone = cloneSourceStore(source.dbPath, (dbPath) =>
    truncateSync(dbPath, Math.floor(statSync(dbPath).size * 0.5)),
  );
  try {
    const present = physicallyPresentEntries(clone.dbPath);
    assert.ok(present > 100,
      `only ${present} entries were physically present after the truncation, so there is too little left to prove a recovery`);
    const { events, entries } = openAndSalvage(clone);
    assert.equal(events[0].outcome, "recovered",
      `a half-truncated store.db was reported as "${events[0].outcome}"; it keeps none of the ${present} entries that survived`);
    assert.ok(entries.length >= 500,
      `a store.db truncated to half its size salvaged ${entries.length} entries while ${present} were physically present`);
    assert.deepEqual(entries.at(-1).id, `s${entries.length}`,
      "the recovered transcript does not end at the last entry that survived the truncation, so rows are missing from the middle");
  } finally {
    discard(clone.base);
  }
});

test("recovery from a truncated store leaves the store usable and its sequence intact", () => {
  const clone = cloneSourceStore(source.dbPath, (dbPath) =>
    truncateSync(dbPath, Math.floor(statSync(dbPath).size * 0.9)),
  );
  try {
    const { entries, tail, page } = openAndSalvage(clone);
    assert.ok(entries.length > 1000, "the fixture did not survive enough of the truncation to judge usability");

    // Read the recovered store the way a renderer pages it: backwards from the
    // newest entry, one `nextBeforeSeq` cursor at a time. Each page must read
    // oldest-first, every page must sit strictly below the one before it, and
    // no entry may appear on two pages.
    const db = new SandAgentDb(clone.dbPath);
    const pages = [];
    let beforeSeq = undefined;
    let reachedTheStart = false;
    try {
      for (let guard = 0; guard < PAGE_WALK_LIMIT; guard += 1) {
        const walkedPage = db.getTranscriptPage({ beforeSeq, limit: 500 });
        pages.push(walkedPage.entries.map((entry) => entry.id));
        if (walkedPage.nextBeforeSeq == null) {
          reachedTheStart = true;
          break;
        }
        beforeSeq = walkedPage.nextBeforeSeq;
      }
    } finally {
      db.close();
    }
    assert.ok(reachedTheStart,
      `paging the recovered store never reported the end of the transcript within ${PAGE_WALK_LIMIT} pages`);
    const order = (ids) => Number(ids.at(-1).slice(1));
    for (const [index, ids] of pages.entries()) {
      assert.equal(new Set(ids).size, ids.length,
        `page ${index} of the recovered store returned an entry twice`);
      for (let at = 1; at < ids.length; at += 1) {
        assert.ok(Number(ids[at].slice(1)) > Number(ids[at - 1].slice(1)),
          `page ${index} of the recovered store read ${ids[at]} after ${ids[at - 1]}, so nextBeforeSeq walked the wrong way or the sequence is not monotonic`);
      }
      if (index > 0) {
        assert.ok(order(pages[index - 1]) > order(ids),
          `page ${index} of the recovered store ended at ${order(ids)} while the previous page ended at ${order(pages[index - 1])}, so paging skipped or repeated a range`);
      }
    }
    const walked = pages.flat();
    assert.equal(walked.length, entries.length,
      `paging the recovered store produced ${walked.length} entries while a full read produced ${entries.length}, so nextBeforeSeq and getTranscriptEntries disagree about the same store`);
    assert.deepEqual(new Set(walked), new Set(entries.map((entry) => entry.id)),
      "paging the recovered store returned a different set of entries than a full read, so a paged client and a full reader disagree about the same store");
    assert.ok(tail.length > 0, "the tail reader cannot read a recovered store, so the recovery produced an unreadable file");
    assert.ok(page.length > 0, "the page reader cannot read a recovered store, so the recovery produced an unreadable file");
    assert.deepEqual(tail.map((entry) => entry.id), entries.map((entry) => entry.id).slice(-5),
      "the tail of a recovered store does not match the tail of the transcript, so the readers disagree about what survived");
  } finally {
    discard(clone.base);
  }
});

test("the salvage count the recovery reports is the number of entries the store really has", () => {
  const clone = cloneSourceStore(source.dbPath, (dbPath) =>
    truncateSync(dbPath, Math.floor(statSync(dbPath).size * 0.75)),
  );
  try {
    const { events, entries } = openAndSalvage(clone);
    assert.ok(entries.length > 0,
      "the truncated store salvaged nothing at all, so comparing the reported count with the real one proves nothing");
    assert.equal(events[0].salvaged.transcript, entries.length,
      `recovery reported ${events[0].salvaged.transcript} salvaged transcript rows and the recovered store holds ${entries.length}, so the diagnostic a user would read overstates or understates the loss`);
  } finally {
    discard(clone.base);
  }
});

test("a store whose bytes are damaged but whose length is intact still salvages what it always did", () => {
  const clone = cloneSourceStore(source.dbPath, (dbPath) => {
    const bytes = readFileSync(dbPath);
    const start = Math.floor(bytes.length / 2);
    for (let index = start; index < Math.min(bytes.length, start + 4096); index += 1)
      bytes[index] ^= 0xff;
    writeFileSync(dbPath, bytes);
  });
  try {
    const { events, entries } = openAndSalvage(clone);
    assert.equal(events[0].outcome, "recovered", "a mid-file corruption stopped being recovered");
    assert.ok(entries.length > 500,
      `a store with 4 KiB flipped in the middle salvaged only ${entries.length} entries; the carve changed the behaviour of the case that already worked`);
  } finally {
    discard(clone.base);
  }
});

test("the carve refuses a database whose header does not over-declare its pages", () => {
  const clone = cloneSourceStore(source.dbPath);
  try {
    assert.equal(openTruncatedSqliteForSalvage({ dbPath: clone.dbPath }), undefined,
      "the carve opened an intact database, so it rewrites the header of a healthy file and every carve result is suspect");
    const opened = openSqliteForSalvage({ dbPath: clone.dbPath });
    assert.ok(opened != null, "an intact database could not be opened for salvage at all");
    assert.equal(
      opened.prepare("SELECT count(*) AS c FROM transcript_entries").get().c,
      ENTRY_COUNT,
      "the plain salvage path no longer reads a healthy database",
    );
    opened.close();
  } finally {
    discard(clone.base);
  }
});

test("the carve refuses a file that is not a SQLite database", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-store-carve-junk-"));
  try {
    const dbPath = path.join(base, "store.db");
    writeFileSync(dbPath, Buffer.alloc(200 * 1024, 0x41));
    assert.equal(openTruncatedSqliteForSalvage({ dbPath }), undefined,
      "the carve opened a file with no SQLite header in it");
  } finally {
    discard(base);
  }
});

test("the carve leaves the quarantined evidence byte-identical and removes its own scratch file", () => {
  const clone = cloneSourceStore(source.dbPath, (dbPath) =>
    truncateSync(dbPath, Math.floor(statSync(dbPath).size * 0.6)),
  );
  try {
    const before = readFileSync(clone.dbPath);
    const carved = openTruncatedSqliteForSalvage({ dbPath: clone.dbPath });
    assert.ok(carved != null, "the carve refused a truncated database, so the salvaged transcripts above came from somewhere else");
    carved.close();
    assert.deepEqual(readFileSync(clone.dbPath), before,
      "the carve modified the quarantined file, which is the only copy of a conversation the user can still recover by hand");
    const leftovers = readdirSync(clone.agentDir).filter((name) => name.includes("salvage-carve"));
    assert.deepEqual(leftovers, [],
      `closing the carved handle left ${leftovers.join(", ")} beside the store, so a crash during recovery would pile up copies of the user's transcript`);
  } finally {
    discard(clone.base);
  }
});
