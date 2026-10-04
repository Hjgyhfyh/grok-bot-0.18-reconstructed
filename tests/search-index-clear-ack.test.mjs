import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The search index and the agent delete only ever talked in one direction.
// `deleteSession` published `agent-removed`, the content-search extension turned
// that into a `clear-agent` job, and `agentRemoved` returned before the worker
// had done anything. Nothing told the delete when the index was done, so the
// unlink raced the worker and correctness rested on a retry window: publish
// first, then `rm` with `maxRetries`, and rely on the worker catching up inside
// the budget. It did catch up вЂ” measured, a handle released 100 ms into an `rm`
// finished the unlink at 153 ms вЂ” but an unlink that has to win a race is not an
// ordered delete. The service now answers: `whenAgentCleared` resolves when the
// `clear-agent` job for one agent has settled, which is the wait the delete was
// missing. The ack is deliberately scoped to this one job on this one queue:
// making `publishTranscriptMutation` awaitable would make every delete wait on
// every subscriber of every mutation kind. The tests below drive a job port the
// test owns, so the ordering is decided by the test and nothing sleeps.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-index-ack-"));
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
  ["host", "extensions", "content-search", "search-index-service.ts"],
]);
const { SandSearchIndexService } = loaded["search-index-service.mjs"];

test.after(() => dispose());

const AGENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** A job port the test answers by hand, so ordering is never a timing question. */
function makeControllablePort() {
  const pending = [];
  return {
    pending,
    port: {
      post(job) {
        return new Promise((resolve) => { pending.push({ job, resolve }); });
      },
      async terminate() {},
    },
    /** Waits for the queue to hand the port its next job, then answers it. */
    async answerNext(result = { ok: true }) {
      for (let turn = 0; turn < 50 && pending.length === 0; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      const entry = pending.shift();
      assert.notEqual(entry, undefined, "the test expected a queued job and there was none");
      entry.resolve(result);
      return entry.job;
    },
    depth() { return pending.length; },
    /**
     * Answers whatever is still queued. `dispose()` waits on the job tail, so a
     * test that fails half way must not leave an unanswered job behind or the
     * whole run hangs instead of reporting its assertion.
     */
    async answerAll() {
      for (let guard = 0; guard < 50 && pending.length > 0; guard += 1) {
        pending.shift().resolve({ ok: true });
        await flushQueue();
      }
    },
  };
}

/** Lets every already-queued microtask and job hop run. No clock, no sleeping. */
async function flushQueue() {
  for (let turn = 0; turn < 10; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

async function makeService(port) {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-index-ack-root-"));
  const indexDbPath = path.join(base, "search-index.db");
  mkdirSync(path.join(base, "agents"), { recursive: true });
  const health = [];
  const service = new SandSearchIndexService({
    indexDbPath,
    agentsRootDir: path.join(base, "agents"),
    createJobPort: () => port,
    disposeDeadline: { run: (operation) => operation() },
    report: (value) => health.push(value),
  });
  service.start();
  return { service, base, health };
}

test("a delete can wait for the index to let go of its agent", async () => {
  const control = makeControllablePort();
  const { service, base } = await makeService(control.port);
  try {
    const reconcile = await control.answerNext();
    assert.equal(reconcile.kind, "reconcile", "the service did not open with a reconcile");

    let settled = false;
    service.applyMutation({ kind: "agent-removed", agentId: AGENT });
    const ack = service.whenAgentCleared(AGENT).then(() => { settled = true; });

    // Give the queue every chance to run the job it was handed.
    await flushQueue();
    assert.equal(settled, false,
      "the ack resolved while the clear-agent job was still queued, so the delete would race the worker exactly as before");
    assert.equal(service.isAgentReleased(AGENT), false,
      "the service reports the agent as released before it has cleared anything");

    const cleared = await control.answerNext();
    assert.deepEqual(
      { kind: cleared.kind, agentId: cleared.agentId },
      { kind: "clear-agent", agentId: AGENT },
      "agent-removed did not reach the index as a clear-agent job for that agent");

    await ack;
    assert.equal(settled, true, "the ack never resolved after the job answered");
    assert.equal(service.isAgentReleased(AGENT), true,
      "the agent is still reported as held after its clear finished");
  } finally {
    await control.answerAll();    await service.dispose();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("the ack answers even when the job failed, so a delete cannot hang on it", async () => {
  const control = makeControllablePort();
  const { service, base } = await makeService(control.port);
  try {
    await control.answerNext();
    service.applyMutation({ kind: "agent-removed", agentId: AGENT });
    const ack = service.whenAgentCleared(AGENT);
    await control.answerNext({ ok: false, message: "index is locked", isIndexCorrupt: false, isWorkerUnavailable: false });

    await ack;
    assert.equal(service.isAgentReleased(AGENT), true,
      "a failed clear keeps the agent marked as held, so nothing ever waits on it again");
  } finally {
    await control.answerAll();    await service.dispose();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("an agent the index was never told about is already released", async () => {
  const control = makeControllablePort();
  const { service, base } = await makeService(control.port);
  try {
    await control.answerNext();
    assert.equal(service.isAgentReleased(AGENT), true,
      "an agent nobody deleted is reported as held by the index");
    await service.whenAgentCleared(AGENT);
  } finally {
    await control.answerAll();    await service.dispose();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("the ack for one agent does not wait for another agent's job", async () => {
  const control = makeControllablePort();
  const { service, base } = await makeService(control.port);
  try {
    await control.answerNext();
    service.applyMutation({ kind: "agent-removed", agentId: AGENT });
    const firstAck = service.whenAgentCleared(AGENT);
    await control.answerNext();

    service.applyMutation({ kind: "agent-removed", agentId: OTHER });
    const secondAck = service.whenAgentCleared(OTHER);
    await flushQueue();
    assert.equal(control.depth(), 1, "the second agent's job was not queued");
    await control.answerNext();

    await firstAck;
    await secondAck;
    assert.equal(service.isAgentReleased(AGENT), true,
      "an agent whose clear finished is still reported as pending, so a caller would keep waiting on it");
    assert.equal(service.isAgentReleased(OTHER), true,
      "the second agent is still reported as pending although its clear answered");
  } finally {
    await control.answerAll();    await service.dispose();
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test("an ack for a dropped job answers instead of hanging", async () => {
  const control = makeControllablePort();
  const { service, base } = await makeService(control.port);
  try {
    await control.answerNext();
    await control.answerAll();    await service.dispose();

    service.applyMutation({ kind: "agent-removed", agentId: AGENT });
    await service.whenAgentCleared(AGENT);
    assert.equal(control.depth(), 0,
      "a disposed service still handed a clear-agent job to a worker");
  } finally {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

