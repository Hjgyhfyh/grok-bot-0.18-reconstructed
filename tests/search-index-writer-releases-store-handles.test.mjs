import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// An agent could not be deleted while the box was running. Measured on a live
// box carrying fifty agents: forty-eight of the fifty `store.db` files were held
// open by the host process, and the set of held ids was exactly the set of rows
// in `search-index.db`. The holder is the content-search writer's
// `storeConnections` cache: `reconcile()` walks every agent directory, opens each
// `store.db` read-only through `store()`, and keeps the connection in a map until
// a `clear-agent` job evicts it or the whole worker is closed. The writer is a
// `worker_thread` of the same process, so the handle keeps the box itself
// holding the file, and Windows refuses to unlink an open file — `rm` left
// exactly `store.db`, `store.db-wal` and `store.db-shm` behind. Renaming the
// directory aside does not help either: `MoveFileEx` on a subtree with such a
// handle fails with the same `EPERM`, measured. The delete only worked because
// `agent-removed` is published before the unlink and `rm` then retries until the
// worker catches up, which is a race with a retry window rather than an
// ordering. The writer no longer holds anything between calls: `store.db` is
// opened and closed inside the one expression that reads it. The tests below
// count open handles the only way a user can — they try to delete the directory.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-search-index-"));
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

const { loaded, dispose } = await bundle([
  ["host", "extensions", "session", "agent-db.ts"],
  ["host", "extensions", "content-search", "search-index-db.ts"],
  ["host", "extensions", "content-search", "search-index-writer.ts"],
]);
const { SandAgentDb, ensureAgentDbDirectory } = loaded["agent-db.mjs"];
const { openSearchIndexDb, ensureSearchIndexSchema } = loaded["search-index-db.mjs"];
const { SandSearchIndexWriter } = loaded["search-index-writer.mjs"];

test.after(() => dispose());

const AGENT_IDS = Array.from(
  { length: 8 },
  (_, index) => `0000000${index}-0000-4000-8000-000000000000`,
);

/** A dozen agents on disk with a real store, each with one indexed message. */
function makeIndexWorld() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-index-agents-"));
  const agentsRootDir = path.join(base, "agents");
  mkdirSync(agentsRootDir, { recursive: true });
  for (const agentId of AGENT_IDS) {
    const dbPath = path.join(agentsRootDir, agentId, "store.db");
    ensureAgentDbDirectory(dbPath);
    const db = new SandAgentDb(dbPath);
    db.appendTranscriptEntry({
      id: `${agentId}-t0u`,
      kind: "message",
      role: "user",
      content: "where is the search index writer",
      timestampMs: 1,
    });
    db.close();
  }
  const indexDb = openSearchIndexDb(path.join(base, "search-index.db"));
  ensureSearchIndexSchema(indexDb);
  return { base, agentsRootDir, indexDb };
}

test("reconcile leaves no store.db open, so every agent directory can be deleted", () => {
  const { base, agentsRootDir, indexDb } = makeIndexWorld();
  const writer = new SandSearchIndexWriter(indexDb, agentsRootDir);
  try {
    writer.runJob({ kind: "reconcile" });
    const indexed = indexDb
      .prepare("SELECT COUNT(*) AS count FROM agents")
      .get().count;
    assert.equal(Number(indexed), AGENT_IDS.length,
      "the test proves nothing unless reconcile really indexed every agent");

    // The measurement the defect was found with: how many of the fifty
    // `store.db` files are still open? An open file cannot be unlinked on
    // Windows, so a successful recursive delete answers it.
    const held = [];
    for (const agentId of AGENT_IDS) {
      const agentDir = path.join(agentsRootDir, agentId);
      try {
        rmSync(agentDir, { recursive: true, force: true });
      } catch {
        held.push(agentId);
      }
    }
    assert.deepEqual(held, [],
      "reconcile left store.db open for these agents, which is exactly what kept a deleted agent on disk with EBUSY");
    assert.equal(existsSync(agentsRootDir), true,
      "the test removed the root it is about to measure against");
  } finally {
    try { writer.close(); } catch {}
    try { indexDb.close(); } catch {}
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("reindexing an agent leaves its store.db closed again", () => {
  const { base, agentsRootDir, indexDb } = makeIndexWorld();
  const writer = new SandSearchIndexWriter(indexDb, agentsRootDir);
  try {
    writer.runJob({ kind: "reconcile" });
    writer.runJob({ kind: "reindex-agents", agentIds: AGENT_IDS });
    const messages = indexDb
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get().count;
    assert.ok(Number(messages) >= AGENT_IDS.length,
      "the test proves nothing unless the reindex really wrote the transcript rows");

    assert.doesNotThrow(
      () => rmSync(agentsRootDir, { recursive: true, force: true }),
      "reindexAgent held a read-only store.db open for every agent it touched",
    );
  } finally {
    try { writer.close(); } catch {}
    try { indexDb.close(); } catch {}
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("a clear-agent job leaves the agent's store.db closed, so the delete can finish", () => {
  const { base, agentsRootDir, indexDb } = makeIndexWorld();
  const writer = new SandSearchIndexWriter(indexDb, agentsRootDir);
  try {
    writer.runJob({ kind: "reconcile" });
    const agentId = AGENT_IDS[0];
    writer.runJob({ kind: "clear-agent", agentId });

    const rows = indexDb
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE agent_id = ?")
      .get(agentId).count;
    assert.equal(Number(rows), 0,
      "the clear-agent job did not clear the index, so the rest of this test would measure nothing");

    assert.doesNotThrow(
      () => rmSync(path.join(agentsRootDir, agentId), { recursive: true, force: true }),
      "the index still holds a handle on the store.db of the agent being deleted",
    );
  } finally {
    try { writer.close(); } catch {}
    try { indexDb.close(); } catch {}
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("a repeated reconcile does not accumulate handles", () => {
  const { base, agentsRootDir, indexDb } = makeIndexWorld();
  const writer = new SandSearchIndexWriter(indexDb, agentsRootDir);
  try {
    for (let round = 0; round < 3; round += 1) writer.runJob({ kind: "reconcile" });
    assert.doesNotThrow(
      () => rmSync(agentsRootDir, { recursive: true, force: true }),
      "handles accumulated across reconciles, so a busy index would pin every agent directory on disk",
    );
  } finally {
    try { writer.close(); } catch {}
    try { indexDb.close(); } catch {}
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});
