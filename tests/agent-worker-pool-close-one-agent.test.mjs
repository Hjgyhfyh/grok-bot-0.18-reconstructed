import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Deleting an agent failed with `EBUSY: resource busy or locked, unlink
// '...\agents\<id>\store.db'` and, separately, on `conversation-blobs.db`. The
// blob worker that owns `conversation-blobs.db` lives in a pool shared by every
// agent and is swept only after a five-minute idle timeout, so the only way to
// free the handle before the unlink was to reach into the pool's public
// `connections` map, re-derive the key from the agent directory, delete the
// entry and close the connection by hand — through an untyped
// `{ connections?: Map<...> }` cast, because the pool had no method for it.
// Nothing about that would survive a rename of the field: the cast erases the
// check, the call site compiles, and the delete silently stops releasing the
// handle, which is exactly the defect. The pool now answers by agent id and
// owns its own key scheme. The tests below fail against the old pool and pass
// against this one, and they prove the handle is really gone: an open
// `conversation-blobs.db` cannot be unlinked on Windows.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleWorkerPool() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-worker-pool-"));
  // `defaultWorkerEntryPath()` resolves `agent-isolation/agent-store-worker.cjs`
  // relative to the bundle's own directory, which is how the shipped host lays
  // it out: the pool bundle sits in `dist/host` and the worker one level below.
  const hostDir = path.join(directory, "host");
  const isolation = path.join(hostDir, "agent-isolation");
  mkdirSync(isolation, { recursive: true });
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "agent-isolation", "agent-worker-pool.ts")],
    outfile: path.join(hostDir, "agent-worker-pool.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "agent-isolation", "agent-store-worker.ts")],
    outfile: path.join(isolation, "agent-store-worker.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(path.join(hostDir, "agent-worker-pool.mjs")).href);
  return { AgentWorkerPool: loaded.AgentWorkerPool, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { AgentWorkerPool, dispose } = await bundleWorkerPool();

test.after(() => dispose());

const AGENTS = [
  "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
];

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-blob-workers-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function blobDbPath(rootDir, agentId) {
  const agentDir = path.join(rootDir, agentId);
  mkdirSync(agentDir, { recursive: true });
  return path.join(agentDir, "conversation-blobs.db");
}

test("a caller closes one agent's worker without knowing how the pool keys it", async () => {
  const { base, rootDir } = makeRoot();
  const pool = new AgentWorkerPool({ idleTimeoutMs: 60_000, sweepIntervalMs: 60_000 });
  try {
    for (const agentId of AGENTS) await pool.ensure(agentId, blobDbPath(rootDir, agentId));

    assert.equal(pool.activeWorkerCount(), 2,
      "the test proves nothing unless both agents really got a worker");

    assert.equal(pool.blobDbPathForAgent(AGENTS[0]), blobDbPath(rootDir, AGENTS[0]),
      "the pool cannot say which database path belongs to an agent");
    assert.equal(pool.blobDbPathForAgent("not-an-agent"), undefined,
      "the pool answered for an agent it has never seen");

    const closed = await pool.closeAgentWorker(AGENTS[0]);
    assert.equal(closed, true,
      "the pool reported no worker for an agent it had just spawned one for");
    assert.equal(pool.activeWorkerCount(), 1,
      "closing one agent's worker closed somebody else's as well");

    // The handle is gone, not just the bookkeeping: Windows refuses to unlink a
    // file that is still open, so a successful unlink is the proof.
    assert.doesNotThrow(() => rmSync(path.join(rootDir, AGENTS[0]), { recursive: true, force: true }),
      "the deleted agent's directory is still held open by its blob worker");
    assert.equal(existsSync(path.join(rootDir, AGENTS[0])), false,
      "the agent directory survived the unlink");

    assert.throws(() => rmSync(path.join(rootDir, AGENTS[1]), { recursive: true, force: true }),
      "the test is measuring nothing: the surviving agent's directory was removable anyway");
  } finally {
    await pool.closeAll();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("closing an agent that has no worker is a no-op, not a failure", async () => {
  const { base, rootDir } = makeRoot();
  const pool = new AgentWorkerPool({ idleTimeoutMs: 60_000, sweepIntervalMs: 60_000 });
  try {
    const agentId = AGENTS[0];
    await pool.ensure(agentId, blobDbPath(rootDir, agentId));
    assert.equal(await pool.closeAgentWorker(agentId), true, "the first close did nothing");

    assert.equal(await pool.closeAgentWorker(agentId), false,
      "closing the same agent twice claims there was a worker the second time");
    assert.doesNotThrow(() => rmSync(path.join(rootDir, agentId), { recursive: true, force: true }),
      "the agent directory is still held open after the worker was closed");
  } finally {
    await pool.closeAll();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("a worker evicted for capacity stops answering for its agent", async () => {
  const { base, rootDir } = makeRoot();
  const pool = new AgentWorkerPool({ idleTimeoutMs: 60_000, sweepIntervalMs: 60_000, maxWorkers: 1 });
  try {
    await pool.ensure(AGENTS[0], blobDbPath(rootDir, AGENTS[0]));
    await pool.ensure(AGENTS[1], blobDbPath(rootDir, AGENTS[1]));
    await pool.ensure(AGENTS[0], blobDbPath(rootDir, AGENTS[0]));

    assert.equal(pool.activeWorkerCount(), 1, "the pool is over its capacity");
    assert.equal(pool.blobDbPathForAgent(AGENTS[1]), undefined,
      "an evicted worker is still indexed for its agent, so closeAgentWorker would try to close a dead thread");
    assert.equal(pool.blobDbPathForAgent(AGENTS[0]), blobDbPath(rootDir, AGENTS[0]),
      "the live worker lost its index entry");
  } finally {
    await pool.closeAll();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});
