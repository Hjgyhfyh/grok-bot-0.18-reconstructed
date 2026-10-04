import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `createRetryPolicy().schedule()` computes a delay and nothing else: it never
// reads `maxAttempts`. Only `runWithRetry` consults the bound, and the
// coordinator relaunch loop called `schedule()` directly, so the configured
// `maxAttempts` was inert on the one code path that used it. A coordinator that
// crashed on every launch therefore relaunched forever at the 10 s ceiling.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-relaunch-"));
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
  ["electron-main", "coordinator", "coordinator-runtime.ts"],
  ["electron-main", "coordinator", "coordinator-telemetry.ts"],
]);
const { createCoordinatorRuntime } = loaded["coordinator-runtime.mjs"];
const {
  COORDINATOR_RELAUNCH_MAX_ATTEMPTS,
  coordinatorLifecycleTelemetry,
  createCoordinatorRelaunchBackoff,
} = loaded["coordinator-telemetry.mjs"];

test.after(() => dispose());

/**
 * Drives a coordinator runtime whose every child exits instantly. `now` never
 * advances, so each exit is classified as a fast exit and the counter climbs.
 *
 * `safetyCeiling` stops handing out new children well past the expected bound.
 * Without it a runtime with no enforced bound relaunches through an endless
 * microtask chain, which drains without ever yielding and exhausts the heap
 * rather than failing an assertion.
 */
function createCrashLoopingRuntime({ relaunchMaxAttempts, exitCode = 1, safetyCeiling = 40 } = {}) {
  const lifecycle = [];
  const problems = [];
  let launchCount = 0;

  const runtime = createCoordinatorRuntime({
    fork: () => { throw new Error("not used"); },
    createChannel: () => { throw new Error("not used"); },
    executors: {},
    onEvent: () => {},
    onProblem: (problem) => { problems.push(problem); },
    monotonicNow: () => 0,
    onMainDataPort: () => {},
    onLifecycle: (event) => { lifecycle.push(event); },
    relaunchBackoff: {
      schedule(attempt) {
        return { elapsed: Promise.resolve(), dispose() {}, attempt };
      },
    },
    ...(relaunchMaxAttempts === undefined ? {} : { relaunchMaxAttempts }),
    launch() {
      launchCount += 1;
      const { promise, resolve } = Promise.withResolvers();
      // Queue the exit as a microtask so the runtime finishes wiring before the
      // exit handler runs, exactly as a real child exit would.
      if (launchCount < safetyCeiling) queueMicrotask(() => resolve({ code: exitCode }));
      return {
        rendererDataPort: {},
        mainDataPort: {},
        controlSettled: Promise.resolve(),
        processExited: promise,
        dispose() {},
      };
    },
  });

  return { runtime, lifecycle, problems, launchCount: () => launchCount };
}

async function settle(turns = 40) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("the relaunch loop stops at its bound instead of spinning forever", async () => {
  const { lifecycle, launchCount } = createCrashLoopingRuntime();
  await settle();

  // One initial launch plus exactly `maxAttempts` relaunches, then it stops.
  assert.equal(COORDINATOR_RELAUNCH_MAX_ATTEMPTS, 10);
  assert.equal(launchCount(), COORDINATOR_RELAUNCH_MAX_ATTEMPTS + 1);

  // Before the fix this counter never stopped climbing.
  await settle();
  assert.equal(launchCount(), COORDINATOR_RELAUNCH_MAX_ATTEMPTS + 1, "relaunching resumed after the bound");

  const abandoned = lifecycle.filter((event) => event.outcome === "relaunch_abandoned");
  assert.equal(abandoned.length, 1, "a terminal stop must be reported exactly once");
  assert.equal(abandoned[0].attempts, COORDINATOR_RELAUNCH_MAX_ATTEMPTS);
});

test("giving up is a distinct terminal outcome, not a silent end of events", async () => {
  const { lifecycle } = createCrashLoopingRuntime();
  await settle();

  // Every cycle still emits "exited"; the loop then emits one terminal event.
  const exited = lifecycle.filter((event) => event.outcome === "exited");
  assert.equal(exited.length, COORDINATOR_RELAUNCH_MAX_ATTEMPTS + 1);
  assert.equal(exited.every((event) => event.exitCodeClass === "breach"), true);

  const last = lifecycle.at(-1);
  assert.equal(last.outcome, "relaunch_abandoned");

  const telemetry = coordinatorLifecycleTelemetry(last);
  assert.equal(telemetry.level, "error");
  assert.equal(telemetry.metadata.outcome, "relaunch_abandoned");
  assert.equal(telemetry.metadata.attempts, String(COORDINATOR_RELAUNCH_MAX_ATTEMPTS));
  assert.equal(telemetry.metadata.exit_code_class, "breach");
});

test("the configured bound is finite and the policy agrees with the runtime", () => {
  assert.ok(Number.isInteger(COORDINATOR_RELAUNCH_MAX_ATTEMPTS));
  assert.ok(COORDINATOR_RELAUNCH_MAX_ATTEMPTS > 0 && COORDINATOR_RELAUNCH_MAX_ATTEMPTS <= 100);
  // `maxAttempts` must satisfy the retry-policy constructor, which rejects 0.
  assert.doesNotThrow(() => createCoordinatorRelaunchBackoff());
  assert.equal(createCoordinatorRelaunchBackoff().name, "sand-coordinator-relaunch");
});

test("a long-lived coordinator resets the counter and is never abandoned", async () => {
  const lifecycle = [];
  const maxLaunches = COORDINATOR_RELAUNCH_MAX_ATTEMPTS + 5;
  let now = 0;
  let launchCount = 0;
  createCoordinatorRuntime({
    fork: () => { throw new Error("not used"); },
    createChannel: () => { throw new Error("not used"); },
    executors: {},
    onEvent: () => {},
    onProblem: () => {},
    // Each child runs for well past the healthy window before exiting, so the
    // fast-exit counter resets every time and the bound is never reached.
    monotonicNow: () => { const value = now; now += 60_000; return value; },
    onMainDataPort: () => {},
    onLifecycle: (event) => { lifecycle.push(event); },
    relaunchBackoff: { schedule: () => ({ elapsed: Promise.resolve(), dispose() {} }) },
    launch() {
      launchCount += 1;
      const { promise, resolve } = Promise.withResolvers();
      // Stop handing out new children once the bound is comfortably exceeded, so
      // the test terminates instead of relaunching forever.
      if (launchCount < maxLaunches) queueMicrotask(() => resolve({ code: 0 }));
      return { rendererDataPort: {}, mainDataPort: {}, controlSettled: Promise.resolve(), processExited: promise, dispose() {} };
    },
  });
  await settle();

  assert.equal(launchCount, maxLaunches);
  assert.deepEqual(lifecycle.filter((event) => event.outcome === "relaunch_abandoned"), []);
  assert.equal(lifecycle.filter((event) => event.outcome === "relaunched").length, maxLaunches - 1);
});

test("an explicit bound overrides the default", async () => {
  const { launchCount, problems } = createCrashLoopingRuntime({ relaunchMaxAttempts: 2 });
  await settle();
  assert.equal(launchCount(), 3);
  assert.ok(
    problems.some((problem) => problem.includes("giving up after 2 consecutive fast relaunches")),
    problems.join(" | "),
  );
});