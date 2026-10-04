import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `readProcessState` answered the win32 question "is this pid still there" by
// spawning `powershell.exe` with `execFileSync` — once per probe, on the Electron
// main thread. `waitForProcessExit` probes 40 times and then probes once more, so
// the single user-visible action "terminate a local-exec process" froze the main
// thread for up to 41 PowerShell cold starts. `execFileSync` stops the main event
// loop outright, so every IPC, timer and window event stalled with it. Nothing
// failed: the code returned correct answers, only far too slowly, and no test
// executed it against a live pid.
//
// These tests drive the real bundled module with `node:child_process` replaced by
// a recording stub, so the spawn counter observes the product's own code path and
// no PowerShell is ever launched. The POSIX control test exists because a counter
// of zero is worthless unless the instrument is proven to fire.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A pid that is guaranteed to be gone: a child that has already exited and whose
// handle this process still owns. `process.kill(pid, 0)` raises ESRCH for it.
const EXPIRED_PID = await startExpiredPid();
const LIVE_PID = process.pid;

let native;
let buildDir;
let spawnRecorder;

async function startExpiredPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return child.pid;
}

/**
 * Bundles `local-exec-native.ts` with `node:child_process` resolved to a stub that
 * records every spawn instead of performing it. The stub is marked external so the
 * bundle imports it at run time and shares the recorder with this file — an inlined
 * copy would leave the counter permanently at zero.
 */
async function loadNativeWithStubbedChildProcess() {
  const stubPath = path.join(buildDir, "child-process-recorder.mjs");
  await writeFile(
    stubPath,
    [
      "export const spawns = [];",
      "export function execFileSync(command, args, options) {",
      "  spawns.push({ kind: 'execFileSync', command, args, options });",
      "  if (command === 'powershell.exe') return args.join(' ').includes('Get-CimInstance')",
      "    ? JSON.stringify({ CreationDate: '2026-01-01T00:00:00.0000000Z', CommandLine: 'node daemon.mjs --generation' })",
      "    : 'node daemon.mjs --generation';",
      "  if (command === 'ps') return 'S';",
      "  throw Object.assign(new Error(`stub cannot run ${command}`), { code: 'ENOENT' });",
      "}",
      "export function spawn(command, args, options) {",
      "  spawns.push({ kind: 'spawn', command, args, options });",
      "  return { pid: 4242, once() {}, unref() {} };",
      "}",
    ].join("\n"),
    "utf8",
  );
  const output = path.join(buildDir, "local-exec-native.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "electron-main", "local-exec", "local-exec-native.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-child-process",
        setup(registered) {
          registered.onResolve({ filter: /^node:child_process$/ }, () => ({ path: pathToFileURL(stubPath).href, external: true }));
        },
      },
    ],
  });
  // No cache-busting query here: the stub URL must match the one the bundle imports,
  // or this file would measure a second, unused copy of the recorder.
  spawnRecorder = await import(pathToFileURL(stubPath).href);
  return await import(`${pathToFileURL(output).href}?${Date.now()}`);
}

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "grok-local-exec-win32-"));
  native = await loadNativeWithStubbedChildProcess();
});

after(async () => {
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

function takeSpawns() {
  return spawnRecorder.spawns.splice(0, spawnRecorder.spawns.length);
}

test("the spawn recorder sees a spawn when the product module makes one", () => {
  takeSpawns();
  const state = native.readProcessState(LIVE_PID, "linux");
  const spawns = takeSpawns();

  assert.equal(spawns.length, 1, "the recorder proves itself by counting the ps probe of the posix branch");
  assert.equal(spawns[0].command, "ps", "the posix branch is expected to shell out to ps");
  assert.equal(state, "S", "the stubbed ps output is parsed by the real product code");
});

test("a win32 process-state probe spawns nothing", () => {
  takeSpawns();
  const state = native.readProcessState(LIVE_PID, "win32");
  const spawns = takeSpawns();

  assert.equal(spawns.length, 0, "reading a pid on win32 costs one syscall, not a PowerShell cold start");
  assert.equal(state, "R", "a live win32 process still reports a non-zombie state");
});

test("a win32 probe of a pid that is gone spawns nothing", () => {
  takeSpawns();
  const state = native.readProcessState(EXPIRED_PID, "win32");
  const spawns = takeSpawns();

  assert.equal(spawns.length, 0, "an absent win32 process must not cost a PowerShell cold start either");
  assert.equal(state, null, "a pid that no longer exists has no state");
});

test("liveness on win32 is decided without spawning, for a live and for a dead pid", () => {
  takeSpawns();
  const live = native.isProcessAlive(LIVE_PID);
  const dead = native.isProcessAlive(EXPIRED_PID);
  const spawns = takeSpawns();

  assert.equal(spawns.length, 0, "liveness is a kill(pid, 0) syscall on win32 and needs no helper process");
  assert.equal(live, true, "this test process is running, so its own pid is alive");
  assert.equal(dead, false, "a pid whose process has exited is not alive");
});

test("waiting for a process that refuses to die spawns no PowerShell across all its probes", async () => {
  takeSpawns();
  let probes = 0;
  const safetyCeiling = 400;
  const delay = () => {
    probes += 1;
    if (probes > safetyCeiling) throw new Error("waitForProcessExit polled without honouring its own attempt bound");
    return Promise.resolve();
  };

  await assert.rejects(
    () => native.waitForProcessExit(LIVE_PID, { delay }),
    (error) => error.name === "LocalExecTerminationTimeoutError",
    "a process that never dies must still end in the timeout the callers already handle",
  );
  const spawns = takeSpawns();

  assert.equal(spawns.length, 0, "41 blocking probes of the win32 state must not become 41 PowerShell cold starts");
  assert.equal(probes, 40, "the wait still runs its full 40 attempts, so the fix did not shorten the termination window");
});

test("every process the module spawns is spawned hidden", async () => {
  takeSpawns();
  native.readProcessIdentity(LIVE_PID, "win32");
  native.readProcessCommand(LIVE_PID, "win32");
  await native.spawnLocalExecDaemon({
    logPath: path.join(buildDir, "daemon.log"),
    env: {},
    mainPath: path.join(repoRoot, "source", "host", "local-exec", "main.cjs"),
    realpath: (target) => target,
    open: () => 7,
    close: () => {},
  });
  const spawns = takeSpawns();

  assert.equal(spawns.length, 3, "the identity probe, the command probe and the daemon spawn must all be recorded");
  for (const spawn of spawns) {
    assert.equal(spawn.options.windowsHide, true, `a console window flashes on the main thread for every ${spawn.command} ${spawn.kind}`);
  }
});
