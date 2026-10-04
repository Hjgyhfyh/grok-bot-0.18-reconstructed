import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `source/host/host-lock.ts` decides whether the process that currently holds
// `host.lock` is another live `host-main` or a foreign leftover. That decision is
// taken from `readProcessCommand`, which probed `/proc/<pid>/cmdline` and `ps`.
// Neither exists on Windows, so the probe always answered `null`, `isSandHostProcess`
// always answered `false`, and every start classified a LIVE host-main as
// "reclaimed-foreign" and stole its lock. Nothing failed, because no test executed
// these functions against a real process.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let hostLock;
let buildDir;
const spawned = [];

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "grok-host-lock-"));
  const output = path.join(buildDir, "host-lock.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "host-lock.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  hostLock = await import(pathToFileURL(output).href);
});

after(async () => {
  for (const child of spawned.splice(0)) {
    try { child.kill("SIGKILL"); } catch {}
  }
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

// A real child of this Node executable that stays alive for the duration of the test.
async function startLiveChild(extraArgs = []) {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)", ...extraArgs], {
    stdio: "ignore",
    windowsHide: true,
  });
  spawned.push(child);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(child.exitCode, null, `child ${child.pid} exited before it could be inspected`);
  assert.equal(child.signalCode, null, `child ${child.pid} died before it could be inspected`);
  return child;
}

async function withLockFile(body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-host-lock-file-"));
  try {
    const lockPath = path.join(directory, "host.lock");
    return await body(lockPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const OWN_PID = 4242;
const HOLDER_PID = 918273;
const realDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("readProcessCommand reports the command line of a live child process on this host", async () => {
  const child = await startLiveChild();
  const command = hostLock.readProcessCommand(child.pid);
  assert.notEqual(
    command,
    null,
    `readProcessCommand(${child.pid}) returned null on ${process.platform}. The probe reads ` +
      `/proc/${child.pid}/cmdline and falls back to \`ps\`, and neither of them exists on this host, ` +
      `so no live process can ever be identified and every start steals a running host-main's lock.`,
  );
  assert.equal(typeof command, "string");
  assert.ok(
    command.trim().length > 0,
    `readProcessCommand(${child.pid}) returned an empty command line, which classifies every live process the same way`,
  );
  assert.ok(
    command.includes(process.execPath) || command.includes("node"),
    `readProcessCommand(${child.pid}) returned ${JSON.stringify(command)}, which does not describe this Node child`,
  );
});

test("isSandHostProcess says false for a live process that is not a host-main", async () => {
  const child = await startLiveChild();
  assert.equal(
    hostLock.isSandHostProcess(child.pid),
    false,
    "a plain Node child is not a sand host-main and must not be reported as one",
  );
});

test("isSandHostProcess recognises a live host-main command line", async () => {
  // Positive control for the probe above: without it, an implementation that
  // always answers `false` would satisfy every negative assertion.
  const child = await startLiveChild(["host-main"]);
  assert.equal(
    hostLock.isSandHostProcess(child.pid),
    true,
    `isSandHostProcess(${child.pid}) could not recognise a live host-main on ${process.platform}; ` +
      "that is what lets a stale lock be reclaimed while a running host-main keeps its own lock",
  );
});

test("acquireHostLock takes over a live sandbox host instead of silently reclaiming its lock", async () => {
  await withLockFile(async lockPath => {
    await writeFile(lockPath, String(HOLDER_PID), "utf8");
    const terminations = [];
    const result = await hostLock.acquireHostLock({
      path: lockPath,
      pid: OWN_PID,
      isProcessAlive: () => true,
      isSandHostProcess: () => true,
      terminateProcess: (pid, signal) => terminations.push({ pid, signal }),
      delay: realDelay,
      takeoverTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    assert.equal(
      result.outcome,
      "took-over",
      "a live process that is a sandbox host must be taken over, not silently reclaimed",
    );
    assert.equal(result.previousPid, HOLDER_PID);
    assert.ok(
      terminations.length > 0,
      "taking over requires terminating the previous holder; no signal was sent",
    );
    assert.deepEqual(
      terminations.map(entry => entry.pid),
      terminations.map(() => HOLDER_PID),
      "only the recorded previous holder may be terminated",
    );
    assert.equal(terminations[0].signal, "SIGTERM", "the takeover must start with SIGTERM");
    assert.equal(hostLock.readLockPid(lockPath), OWN_PID, "the lock must now belong to the acquiring host");
  });
});

test("acquireHostLock reclaims a dead holder and never terminates it", async () => {
  await withLockFile(async lockPath => {
    await writeFile(lockPath, String(HOLDER_PID), "utf8");
    const terminations = [];
    const result = await hostLock.acquireHostLock({
      path: lockPath,
      pid: OWN_PID,
      isProcessAlive: () => false,
      isSandHostProcess: () => true,
      terminateProcess: (pid, signal) => terminations.push({ pid, signal }),
      delay: realDelay,
      takeoverTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    assert.equal(result.outcome, "reclaimed-dead");
    assert.deepEqual(terminations, [], "a process that is already gone cannot be terminated");
    assert.equal(hostLock.readLockPid(lockPath), OWN_PID);
  });
});

test("acquireHostLock still reclaims a live but foreign holder without terminating it", async () => {
  await withLockFile(async lockPath => {
    await writeFile(lockPath, String(HOLDER_PID), "utf8");
    const terminations = [];
    const result = await hostLock.acquireHostLock({
      path: lockPath,
      pid: OWN_PID,
      isProcessAlive: () => true,
      isSandHostProcess: () => false,
      terminateProcess: (pid, signal) => terminations.push({ pid, signal }),
      delay: realDelay,
      takeoverTimeoutMs: 20,
      pollIntervalMs: 1,
    });
    assert.equal(result.outcome, "reclaimed-foreign");
    assert.deepEqual(
      terminations,
      [],
      "a live process that is not a sandbox host is never terminated; the three outcomes must stay distinguishable",
    );
    assert.equal(hostLock.readLockPid(lockPath), OWN_PID);
  });
});

test("acquireHostLock creates a fresh lock when none exists", async () => {
  await withLockFile(async lockPath => {
    const result = await hostLock.acquireHostLock({ path: lockPath, pid: OWN_PID });
    assert.equal(result.outcome, "created");
    assert.equal(result.previousPid, undefined);
    assert.equal(hostLock.readLockPid(lockPath), OWN_PID);
    result.lock.release();
    assert.equal(hostLock.readLockPid(lockPath), null, "releasing must remove this host's own lock");
  });
});
