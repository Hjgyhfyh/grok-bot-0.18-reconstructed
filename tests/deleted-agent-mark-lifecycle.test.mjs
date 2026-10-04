import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";

// The "this agent is being deleted" mark outlived the delete it belonged to.
// `SessionRuntime.deletedAgentIds` was a plain `Set`: `interruptAgentForDeletion`
// added an id, and only three branches ever removed it — the per-agent success
// branch, the active-agent branch, and the `catch` of `deleteAgents`. So a
// delete that failed for one agent and threw afterwards (which is exactly what
// `deleteAgent` does: `deleteAgents` returns `{ failed: [...] }`, then
// `deleteAgent` throws `SandAgentLifecycleError` from outside the loop) left the
// mark set for the rest of the process. The mark is not a hint: it is the
// `isAgentBeingDeleted` predicate the session store is constructed with, so the
// roster hid an agent that was still on disk, `isAgentGone` refused background
// work for it, and the next cap check deleted the directory of an agent the user
// could still see. Nothing else could clear it, and a restart was the only
// release. The mark is now a claim that has to stay true to count: it is
// re-validated against the directory it is about, and a claim the host cannot
// prove expires instead of sticking. The tests below fail against the plain
// `Set` and pass against this one, with an injected clock so nothing sleeps.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-deleted-mark-"));
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
  ["host", "extensions", "transcript", "session-runtime.ts"],
]);
const { SessionRuntime, DeletedAgentMarks, DELETED_AGENT_MARK_GRACE_MS } = loaded["session-runtime.mjs"];

test.after(() => dispose());

const AGENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function makeHarness({ graceMs = 60_000 } = {}) {
  let now = 1_000_000;
  const onDisk = new Set([AGENT]);
  const marks = new DeletedAgentMarks((agentId) => onDisk.has(agentId), () => now, graceMs);
  return {
    marks,
    onDisk,
    advance: (ms) => { now += ms; },
    /** A delete that never got a `deleteSession` answer, e.g. a thrown lifecycle error. */
    markDeletedWithoutAnswer: () => marks.add(AGENT),
  };
}

test("a mark is dropped as soon as the agent directory is gone", () => {
  const h = makeHarness();
  h.markDeletedWithoutAnswer();
  assert.equal(h.marks.has(AGENT), true,
    "a delete in flight does not hide the agent, so a half-removed agent stays in the roster");

  h.onDisk.delete(AGENT);
  assert.equal(h.marks.has(AGENT), false,
    "the directory is gone and `isAgentGone` already answers from that, but the mark claimed a delete that finished");
});

test("a mark whose delete never answered expires instead of hiding a live agent", () => {
  const h = makeHarness();
  h.markDeletedWithoutAnswer();
  h.advance(DELETED_AGENT_MARK_GRACE_MS - 1);
  assert.equal(h.marks.has(AGENT), true,
    "the mark gave up before the delete could possibly have finished");

  h.advance(2);
  assert.equal(h.marks.has(AGENT), false,
    "a delete that failed left its mark set, so the roster hid an agent that is still on disk and the cap check deleted it");
});

test("a repeated delete re-arms the mark instead of inheriting an expired one", () => {
  const h = makeHarness();
  h.markDeletedWithoutAnswer();
  h.advance(DELETED_AGENT_MARK_GRACE_MS * 2);
  assert.equal(h.marks.has(AGENT), false,
    "the first mark should have expired by now");

  h.markDeletedWithoutAnswer();
  assert.equal(h.marks.has(AGENT), true,
    "deleting the same agent again did not re-arm the mark, so the roster showed an agent that is being removed");
});

test("an explicit delete removes the mark immediately, before any expiry", () => {
  const h = makeHarness();
  h.markDeletedWithoutAnswer();
  assert.equal(h.marks.delete(AGENT), true,
    "the success branch could not clear the mark");
  assert.equal(h.marks.has(AGENT), false,
    "a deleted agent stayed marked for the rest of the process even though the directory is about to go");
});

test("an agent that was never marked is never claimed as deleted", () => {
  const h = makeHarness();
  assert.equal(h.marks.has(AGENT), false,
    "the mark set reports a delete nobody asked for");
  assert.equal(h.marks.size, 0,
    "the mark set is not empty before anything happened");
});

test("a restart starts with no marks, so nothing is hidden by a previous run", () => {
  const first = makeHarness();
  first.markDeletedWithoutAnswer();
  assert.equal(first.marks.has(AGENT), true,
    "the first run should be holding a mark");

  // A restart builds a brand new runtime. The directory the first run failed to
  // remove is still there, so the agent has to be visible again.
  const second = makeHarness();
  assert.equal(second.marks.has(AGENT), false,
    "state from the previous run keeps an agent on disk hidden from the roster");
});

test("SessionRuntime asks the directory, not the mark, whether an agent is gone", async () => {
  const onDisk = new Set([AGENT]);
  const sessionStore = { agentExists: (agentId) => onDisk.has(agentId) };
  const runtime = new SessionRuntime({ sessionStore });

  assert.equal(runtime.isAgentGone(AGENT), false,
    "an agent whose directory is on disk was reported as gone");

  runtime.deletedAgentIds.add(AGENT);
  assert.equal(runtime.isAgentGone(AGENT), true,
    "a delete in flight did not stop new background work for the agent");

  // The failure path: `deleteAgents` returns `failed`, the caller throws, and
  // nothing ever calls `deletedAgentIds.delete`. With a plain `Set` the mark
  // would still be set here and the agent would be gone for the rest of the run.
  onDisk.delete(AGENT);
  assert.equal(runtime.isAgentGone(AGENT), true,
    "an agent whose directory is gone was reported as present");

  const restarted = new SessionRuntime({ sessionStore });
  assert.equal(restarted.isAgentGone(AGENT), true,
    "a fresh runtime reported a deleted agent as present");
});
