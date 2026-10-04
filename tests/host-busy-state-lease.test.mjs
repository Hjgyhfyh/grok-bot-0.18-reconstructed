import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * `GET /health` reported `isBusy: true` on a freshly started box for a turn
 * submitted minutes earlier, and the turn never completed and never errored.
 * `RunLifecycle.beginSessionRun()` added the session to `inFlightRunCounts`
 * and `endSessionRun()` — which lives in the `finally` of the awaiting task —
 * was the only thing that removed it. A turn that neither settles nor throws
 * therefore kept the box busy forever, in every later process, because
 * `SandRunScheduler.armWatchdog()` returns early unless a user task is queued
 * behind the active run and no other bound existed.
 *
 * These tests prove that a run window is now bounded: it releases itself, it
 * asks the runner to abort first, a late `endSessionRun` from the abandoned
 * turn cannot undo that release, and a turn that finishes in time is left
 * alone. The last test pins the host boundary `SandHost.getHealth()` reads, and
 * records that a fresh process starts idle while still reporting the agent id
 * restored from disk — the restored pointer is a selection, not a busy claim.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-busy-lease-"));
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
  ["host", "extensions", "transcript", "run-lifecycle.ts"],
  ["host", "host-roster-bookkeeping.ts"],
]);
const {
  RUN_LEASE_DEFAULT_MS,
  RUN_LEASE_GRACE_DEFAULT_MS,
  RunLifecycle,
} = loaded["run-lifecycle.mjs"];
const { createHostRosterBookkeeping } = loaded["host-roster-bookkeeping.mjs"];

test.after(() => dispose());

const TOUCHED_ENV = ["SAND_RUN_LEASE_MS", "SAND_RUN_LEASE_GRACE_MS", "SAND_DISABLE_RUN_SCHEDULER"];
const savedEnv = new Map(TOUCHED_ENV.map((name) => [name, process.env[name]]));

test.beforeEach(() => {
  for (const name of TOUCHED_ENV) delete process.env[name];
  process.env.SAND_RUN_LEASE_MS = "40";
  process.env.SAND_RUN_LEASE_GRACE_MS = "15";
});

test.afterEach(() => {
  for (const name of TOUCHED_ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function createFakeTranscriptManager() {
  const interrupts = [];
  const liveSessions = new Map();
  const tm = {
    sessions: {
      liveSessions,
      activeSession: null,
      pendingSessionOpens: new Map(),
      settledOpen: async pending => pending,
    },
    roster: { emitAgentUpdate: async () => {} },
    productAnalytics: { trackEvent: () => {} },
    turnRuntime: { activeRequestPrompts: new Map(), activeRequestSources: new Map() },
    groupChat: { isGroupSession: () => false },
    sendPipeline: { sendAttachmentBatchIds: new Map() },
    ackObligations: { scheduleAckRedriveAfterIdle: () => {} },
    runnerRegistry: {
      runners: new Map(),
      interruptWedgedRunForWatchdog(agentId) {
        interrupts.push({ agentId, at: Date.now() });
        return true;
      },
    },
    telemetry: { reportTurnInterrupt: event => interrupts.push(event) },
  };
  return { tm, interrupts };
}

function createSession(agentId) {
  return {
    id: agentId,
    agentStore: { dispose: async () => {} },
    db: { close: () => {} },
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test("a turn that never settles stops holding the box busy once its lease expires", async () => {
  const { tm } = createFakeTranscriptManager();
  const lifecycle = new RunLifecycle(tm);
  const session = createSession("agent-stuck");

  lifecycle.beginSessionRun(session);
  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    ["agent-stuck"],
    "a started turn must count as running before anything goes wrong",
  );

  // The turn never settles and never throws: no `endSessionRun`, no rejection.
  await wait(200);

  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    [],
    "a turn that never settled must stop counting as running, or the box stays busy forever",
  );
  assert.equal(
    lifecycle.inFlightRunCounts.has(session),
    false,
    "the run window itself must be gone, not merely hidden from the running set",
  );
});

test("the expired lease asks the runner to abort and only then clears the busy state", async () => {
  // A lease longer than the default 40 ms of the other tests, so there is a
  // readable window between the abort and the release.
  process.env.SAND_RUN_LEASE_MS = "150";
  process.env.SAND_RUN_LEASE_GRACE_MS = "400";
  const { tm, interrupts } = createFakeTranscriptManager();
  const lifecycle = new RunLifecycle(tm);
  const session = createSession("agent-wedged");

  lifecycle.beginSessionRun(session);
  await wait(260);

  const interruptsBeforeGrace = interrupts.filter(
    event => event && event.reason === "run_lease_expired",
  );
  assert.equal(
    interruptsBeforeGrace.length,
    1,
    "an expired lease must report the wedged run exactly once",
  );
  assert.equal(
    interruptsBeforeGrace[0].conversationId,
    "agent-wedged",
    "the interrupt must name the agent whose turn is wedged",
  );
  assert.equal(
    interrupts.some(entry => entry.agentId === "agent-wedged"),
    true,
    "the expired lease must ask the runner to abort before releasing the busy state",
  );
  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    ["agent-wedged"],
    "the busy state must survive the grace window, so a slow abort can still settle normally",
  );

  await wait(450);
  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    [],
    "the grace window must end in a release even when the abort produced nothing",
  );
});

test("the abandoned turn's late end call cannot undo the release or corrupt a later turn", async () => {
  const { tm } = createFakeTranscriptManager();
  const lifecycle = new RunLifecycle(tm);
  const stuck = createSession("agent-stuck");

  lifecycle.beginSessionRun(stuck);
  await wait(200);
  assert.deepEqual([...lifecycle.runningAgentIds()], [], "precondition: the lease released the wedged turn");

  // The abandoned turn finally settles, minutes later, and reports its end.
  lifecycle.endSessionRun(stuck);

  const next = createSession("agent-next");
  lifecycle.beginSessionRun(next);
  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    ["agent-next"],
    "a late end from the abandoned turn must not swallow the next turn's run window",
  );

  lifecycle.endSessionRun(next);
  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    [],
    "the next turn must end cleanly after a stale end call was absorbed",
  );
});

test("a nested run window is released as a unit and both late end calls are absorbed", async () => {
  const { tm } = createFakeTranscriptManager();
  const lifecycle = new RunLifecycle(tm);
  const session = createSession("agent-nested");

  lifecycle.beginSessionRun(session);
  lifecycle.beginSessionRun(session);
  assert.equal(
    lifecycle.inFlightRunCounts.get(session),
    2,
    "two overlapping turns on one session must be counted as two windows",
  );

  await wait(200);
  assert.deepEqual(
    [...lifecycle.runningAgentIds()],
    [],
    "one expired lease must clear every window it covers",
  );

  // Both abandoned turns settle afterwards.
  lifecycle.endSessionRun(session);
  lifecycle.endSessionRun(session);
  assert.equal(
    lifecycle.inFlightRunCounts.has(session),
    false,
    "late end calls must be absorbed, not counted as new windows that never end",
  );
});

test("a turn that ends inside its lease is never released early", async () => {
  const { tm, interrupts } = createFakeTranscriptManager();
  const lifecycle = new RunLifecycle(tm);
  const session = createSession("agent-healthy");

  lifecycle.beginSessionRun(session);
  lifecycle.endSessionRun(session);
  await wait(200);

  assert.deepEqual([...lifecycle.runningAgentIds()], [], "a finished turn is not running");
  assert.equal(
    interrupts.length,
    0,
    "a turn that finished inside its lease must not be reported as wedged",
  );
  assert.equal(
    lifecycle.runLeaseTimers.size,
    0,
    "the lease timer must be disposed when the turn ends normally, or it keeps the host alive",
  );
});

test("the lease bound is finite, positive and configurable", () => {
  assert.ok(
    Number.isInteger(RUN_LEASE_DEFAULT_MS) && RUN_LEASE_DEFAULT_MS > 0,
    "a run window needs a finite positive bound or the leak is unbounded",
  );
  assert.ok(RUN_LEASE_DEFAULT_MS <= 24 * 60 * 60 * 1000, "the default bound must stay inside a day");
  assert.ok(RUN_LEASE_GRACE_DEFAULT_MS > 0, "the abort grace must be positive");
  assert.ok(
    RUN_LEASE_GRACE_DEFAULT_MS < RUN_LEASE_DEFAULT_MS,
    "the abort grace must be shorter than the lease, otherwise the release never fires",
  );

  const { tm } = createFakeTranscriptManager();
  process.env.SAND_RUN_LEASE_MS = "1234";
  const lifecycle = new RunLifecycle(tm);
  assert.equal(lifecycle.runLeaseMs, 1234, "an explicit SAND_RUN_LEASE_MS must be honoured");

  process.env.SAND_RUN_LEASE_MS = "not-a-number";
  assert.equal(
    new RunLifecycle(tm).runLeaseMs,
    RUN_LEASE_DEFAULT_MS,
    "an unparseable lease must fall back to the default instead of disabling the bound",
  );
});

test("the host reports an idle box and still names the agent restored from disk", () => {
  const running = new Set();
  let fallbackAgentId = null;
  const bookkeeping = createHostRosterBookkeeping({
    api(id) {
      if (id === "attachments") return { setFallbackAgentId: value => { fallbackAgentId = value; } };
      if (id === "transcript") return { liveRunningAgentIds: () => running };
      if (id === "forever-box")
        return { diskPressureReminder: { enroll: () => {} }, setBusy: () => {} };
      if (id === "state-backstop") return { isEnabled: false, scheduleSnapshot: () => {} };
      if (id === "box-store-sync") return { isEnabled: false, scheduleStoreDbSnapshot: () => {} };
      if (id === "source-map") return { getOrCreate: () => ({}) };
      throw new Error(`unexpected extension ${id}`);
    },
  });

  assert.equal(
    bookkeeping.isBusy,
    false,
    "a fresh process must start idle; a busy flag is never restored from disk",
  );

  // A startup pass names the agent stored in `agents/active-agent.json`.
  bookkeeping.apply("de387e99-cb92-4d81-a52d-f0dd9a02c480");
  assert.equal(
    bookkeeping.isBusy,
    false,
    "an agent id restored from disk is a selection, not a claim that a turn is running",
  );
  assert.equal(
    bookkeeping.activeAgentId ?? bookkeeping.latestActiveAgentId,
    "de387e99-cb92-4d81-a52d-f0dd9a02c480",
    "the restored selection must still be reported for the client",
  );
  assert.equal(
    fallbackAgentId,
    "de387e99-cb92-4d81-a52d-f0dd9a02c480",
    "the restored selection must reach the attachment fallback",
  );

  running.add("de387e99-cb92-4d81-a52d-f0dd9a02c480");
  bookkeeping.apply("de387e99-cb92-4d81-a52d-f0dd9a02c480");
  assert.equal(bookkeeping.isBusy, true, "a live run window must report the box busy");

  // The lease released the wedged window; the durable selection stays.
  running.delete("de387e99-cb92-4d81-a52d-f0dd9a02c480");
  bookkeeping.apply("de387e99-cb92-4d81-a52d-f0dd9a02c480");
  assert.equal(
    bookkeeping.isBusy,
    false,
    "once no live turn backs it, the box must report idle instead of refusing further work",
  );
  assert.equal(
    bookkeeping.latestActiveAgentId,
    "de387e99-cb92-4d81-a52d-f0dd9a02c480",
    "releasing the busy state must not clear the selected agent",
  );
});