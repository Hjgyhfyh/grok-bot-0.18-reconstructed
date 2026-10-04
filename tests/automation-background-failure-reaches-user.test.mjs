import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A routine that failed in the background never told anybody.
 * `AutomationRunPath.notifyAutomationFailure` opened with
 * `if (isBackgroundAutomationTrigger(trigger)) return;`, and both background
 * triggers — `schedule` and `event` — are exactly the ones a user is not
 * watching. The failure was still written to the run history, so the routine
 * looked healthy: seven nightly failures showed up only if the user opened the
 * routine and read the history themselves.
 *
 * Three neighbours were silent in the same way. A host that cannot execute
 * returned `undefined` with nothing recorded; a `resolveBackgroundSession`
 * throw returned a bare `undefined` with no telemetry at all; a duplicate fire
 * reported a drop but shared none of that code. This test proves that a
 * scheduled failure reaches the user through the same tray error a manual one
 * does, and that every path which refuses to start a run leaves a record.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-routine-failure-"));
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
  ["host", "extensions", "transcript", "automation-run-path.ts"],
]);
const { AutomationRunPath } = loaded["automation-run-path.mjs"];

test.after(() => dispose());

const AGENT_ID = "agent-1";
const AUTOMATION = {
  id: "routine-1",
  name: "Morning digest",
  prompt: "Summarise overnight alerts.",
  trigger: { type: "cron", schedule: "15 8 * * 1-5" },
  schedule: "15 8 * * 1-5",
  triggerDescription: "Every Monday to Friday at 8:15am",
  isEnabled: true,
  createdAt: 1_800_000_000_000,
  lastRunAt: null,
  raisedNotices: [],
  nextRunAt: null,
  runs: [],
  filePath: path.join(os.tmpdir(), "grok-routine", "automation.json"),
};

function createSession() {
  return {
    id: AGENT_ID,
    dbPath: path.join(os.tmpdir(), "grok-routine-agent", "store.db"),
    automations: {
      get: () => AUTOMATION,
      listDefinitions: () => [AUTOMATION],
      recordRunDefinition: () => {},
      beginRun: () => ({ id: "run-1" }),
      finishRunDefinition: (args) => { finishedRunsRef.push(args); },
      markNoticeRaised: () => {},
    },
  };
}

let finishedRunsRef = [];

/**
 * A transcript manager that is only as complete as `fireAutomation` actually
 * touches, with three recorders standing in for the surfaces a refused or
 * failed run has to reach: the error tray, the drop telemetry and the agent
 * error log.
 */
function createHarness({
  canExecute = true,
  resolveSession = async () => createSession(),
  runFailure = new Error("provider refused the request"),
} = {}) {
  const trayErrors = [];
  const droppedFires = [];
  const agentErrors = [];
  const finishedRuns = [];
  const telemetryRuns = [];
  finishedRunsRef = finishedRuns;

  const tm = {
    execution: { canExecute },
    sessions: {
      activeSession: undefined,
      resolveBackgroundSession: async () => await resolveSession(),
    },
    groupChat: { isGroupSession: () => false },
    runnerRegistry: {
      getRunner: () => ({
        run: async () => {
          throw runFailure;
        },
      }),
    },
    spendGuardMarker: undefined,
    automationRuntime: {
      enqueueAutomationLifecycleMutation: async (args) => { await args.mutation(); },
      recordAutomationChangeEvents: () => {},
      recordInactiveAutomationChanges: () => {},
      emitAutomations: () => {},
    },
    runLifecycle: {
      lastRequestIdBySession: new Map(),
      beginSessionRun: () => {},
      endSessionRun: () => {},
      enqueueExclusiveRun: async (_sessionId, run) => await run(),
    },
    turnRuntime: { activeRequestSources: new Map() },
    telemetry: {
      reportAgentError: (report) => { agentErrors.push(report); },
      reportAutomationRun: (report) => { telemetryRuns.push(report); },
    },
    roster: { emitAgentUpdate: async () => {} },
    sessionStore: { getUserTimeZone: () => "Europe/Moscow", markSessionActivity: () => {} },
    upgradeResume: { markAgentResumePending: () => {} },
    trayErrors: {
      pushError: (options) => {
        trayErrors.push(options);
        return { id: `tray-${trayErrors.length}` };
      },
    },
  };
  const spendGuard = { apply: async () => ({ paused: false }) };
  const eventFires = {
    reportFireDropped: (args) => { droppedFires.push(args); },
  };
  const runPath = new AutomationRunPath(tm, spendGuard, eventFires);
  return { runPath, trayErrors, droppedFires, agentErrors, finishedRuns, telemetryRuns };
}

function fireArgs(overrides = {}) {
  return {
    agentId: AGENT_ID,
    automation: AUTOMATION,
    trigger: "schedule",
    ...overrides,
  };
}

test("a routine that fails on its own schedule reports it the way a manual run does", async () => {
  const { runPath, trayErrors, finishedRuns } = createHarness();

  const outcome = await runPath.fireAutomation(fireArgs());

  assert.equal(outcome, "error", "the run itself failed, so it must not report success");
  assert.equal(
    finishedRuns.at(-1)?.status,
    "error",
    "the failure was recorded in the run history, which is the only place it used to be recorded",
  );
  assert.equal(
    trayErrors.length,
    1,
    "a scheduled routine that failed produced no error for the user at all — the run history was the only trace",
  );
  assert.equal(trayErrors[0].title, 'Automation "Morning digest" failed');
  assert.equal(trayErrors[0].agentId, AGENT_ID, "the error must name the agent it belongs to");
  assert.equal(
    typeof trayErrors[0].detail,
    "string",
    "the tray error carries the failure detail the user needs to act on",
  );
});

test("an event-driven failure is not quieter than a scheduled one", () => {
  const { runPath, trayErrors } = createHarness();

  runPath.notifyAutomationFailure(
    { id: AGENT_ID },
    AUTOMATION,
    "provider refused the request",
    "event",
    { detail: "provider refused the request" },
  );

  assert.equal(
    trayErrors.length,
    1,
    "a listener-driven failure skipped notification while a manual one did not",
  );
  assert.equal(trayErrors[0].title, 'Automation "Morning digest" failed');
});

test("a repeat failure still collapses into one entry carrying a count", () => {
  const { runPath, trayErrors } = createHarness();
  const description = { detail: "provider refused the request" };

  for (let attempt = 0; attempt < 3; attempt += 1)
    runPath.notifyAutomationFailure({ id: AGENT_ID }, AUTOMATION, "provider refused the request", "schedule", description);

  assert.equal(
    trayErrors.length,
    2,
    "repeated background failures must not stack one tray error per night, and must not all be swallowed either",
  );
  assert.equal(trayErrors[0].count, 1);
  assert.equal(trayErrors[1].count, 2, "the second notification carries how many failures it stands for");
});

test("a host that cannot execute records the skipped fire instead of skipping quietly", async () => {
  const { runPath, droppedFires, trayErrors } = createHarness({ canExecute: false });

  const outcome = await runPath.fireAutomation(fireArgs({ runUuid: "run-9" }));

  assert.equal(outcome, undefined, "nothing ran, so there is no run outcome to report");
  assert.equal(
    droppedFires.length,
    1,
    "a routine the host refused to run left no record anywhere: it looked like a routine with nothing to do",
  );
  assert.equal(droppedFires[0].reason, "execution_unavailable");
  assert.equal(droppedFires[0].runUuid, "run-9", "the drop keeps the run identity so repeats cannot spam the log");
  assert.deepEqual(trayErrors, [], "a host that is paused is not a broken routine and must not raise an error tray");
});

test("a session that cannot be opened is reported instead of vanishing", async () => {
  const { runPath, droppedFires, agentErrors, trayErrors } = createHarness({
    resolveSession: async () => { throw new Error("agent store is locked"); },
  });

  const outcome = await runPath.fireAutomation(fireArgs());

  assert.equal(outcome, undefined, "the run never started, so it has no outcome");
  assert.equal(
    droppedFires.length,
    1,
    "a routine that could not open a session left no telemetry at all",
  );
  assert.equal(droppedFires[0].reason, "session_unavailable");
  assert.equal(agentErrors.length, 1, "the underlying error was never classified or logged anywhere");
  assert.equal(agentErrors[0].source, "automation");
  assert.equal(
    trayErrors.length,
    1,
    "the user has no way to learn that a routine did not run when its agent could not be opened",
  );
  assert.match(trayErrors[0].detail, /agent store is locked/, "the tray error names what actually failed");
});

test("a second fire while one is in flight is recorded as a drop", async () => {
  const { runPath, droppedFires } = createHarness();
  runPath.inFlightAutomationKeys.add(`${AGENT_ID}:${AUTOMATION.id}`);

  const outcome = await runPath.fireAutomation(fireArgs());

  assert.equal(outcome, undefined, "the second fire did not run");
  assert.equal(droppedFires.length, 1, "a skipped duplicate must leave the same record as every other skip");
  assert.equal(droppedFires[0].reason, "duplicate_in_flight");
});