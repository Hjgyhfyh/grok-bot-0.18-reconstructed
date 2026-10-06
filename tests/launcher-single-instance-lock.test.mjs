import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Launching the app a second time could leave two box hosts serving the same
// data root, and the launcher was the reason. It deleted `%LOCALAPPDATA%\GrokBotLocalBox\host.lock`
// on every start where nothing was listening on 8790, on the stated theory that
// "a stale lock from an unclean shutdown would make the next start fail".
//
// Measured, that theory is false. `acquireHostLock` reads the pid out of that
// file and already reclaims it when the process is gone, when the file is
// unreadable, and when the pid belongs to some other program; a dead holder is
// reclaimed without being signalled. So the deletion removed the only evidence
// the lock carried for nothing, and it removed it precisely when the evidence
// mattered: a host that has taken the lock and has not yet bound 8790. That is
// a window of seconds, not a corner case - the exec-daemon has to answer its
// first Ping and ~35 extensions start before the gateway listens.
//
// With the lock gone, the next host's `tryCreateLock` succeeds and its outcome
// is "created", not "took-over": nothing is evicted, nothing is reported, and
// two hosts now hold the same `agents/`, `search-index.db` and `gateway.json`.
// The tests below measure the reclaim the launcher was afraid of, and drive the
// launcher's own lock reader against real processes.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(repoRoot, "scripts", "start-grokbot.ps1");
const launcherSource = readFileSync(launcherPath, "utf8");

const HARNESS = `
param([string]$ScriptPath, [string]$LockPath)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { [pscustomobject]@{ ok = $false; parseErrors = @($errors | ForEach-Object { $_.Message }) } | ConvertTo-Json -Compress; exit 0 }
$wanted = @('Get-HostLockOwner')
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($wanted -contains $fn.Name) { Invoke-Expression $fn.Extent.Text }
}
$missing = @($wanted | Where-Object { -not (Get-Command -Name $_ -ErrorAction SilentlyContinue) })
if ($missing.Count -gt 0) { [pscustomobject]@{ ok = $false; missing = $missing } | ConvertTo-Json -Compress; exit 0 }
$owner = Get-HostLockOwner -Path $LockPath
[pscustomobject]@{ ok = $true; owner = $owner } | ConvertTo-Json -Compress
`;

function runLauncherLockReader(lockPath) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-launcher-lock-"));
  const harness = path.join(directory, "harness.ps1");
  writeFileSync(harness, HARNESS, "utf8");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness, "-ScriptPath", launcherPath, "-LockPath", lockPath],
      { encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    return JSON.parse(stdout.trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const roots = [];
function scratch(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `grok-launcher-lock-${label}-`));
  roots.push(root);
  return root;
}
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function bundleHostLock() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-launcher-hostlock-"));
  const outfile = path.join(directory, "host-lock.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "host-lock.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("a lock left behind by an unclean shutdown does not block the next start", async () => {
  // The premise the launcher deleted the file for. `acquireHostLock` is the
  // code that would have to fail, so it is the code under test.
  const { loaded, dispose } = await bundleHostLock();
  try {
    const root = scratch("stale");
    const lockPath = path.join(root, "host.lock");
    // A pid that cannot be alive: far past any Windows pid, with no process
    // behind it. The reclaim decides on `isProcessAlive`, injected below, so
    // nothing here depends on the machine's pid space.
    const deadPid = 4_000_000;
    writeFileSync(lockPath, String(deadPid), "utf8");

    const terminated = [];
    const result = await loaded.acquireHostLock({
      path: lockPath,
      pid: process.pid,
      isProcessAlive: pid => pid === process.pid,
      isSandHostProcess: () => false,
      terminateProcess: pid => terminated.push(pid),
      delay: () => Promise.resolve(),
    });

    assert.equal(result.outcome, "reclaimed-dead", "a lock naming a dead process was not reclaimed, which is the failure the launcher's deletion was guarding against");
    assert.deepEqual(terminated, [], "the reclaim signalled a process that was already gone");
    assert.equal(result.lock.pid, process.pid, "the reclaimed lock does not belong to the new host");
    assert.equal(existsSync(lockPath), true, "the new host left no lock behind, so the NEXT start has nothing to reclaim either");
    assert.equal(String(Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10)), String(process.pid), "the lock file does not name the host that now holds it");
  } finally {
    dispose();
  }
});

test("a lock whose pid is alive and is a box host is what tells the launcher to stop", () => {
  const root = scratch("live");
  const lockPath = path.join(root, "host.lock");
  const script = path.join(root, "host-main.cjs");
  writeFileSync(script, "setInterval(() => {}, 1 << 30);\n");

  const child = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    writeFileSync(lockPath, String(child.pid), "utf8");
    const result = runLauncherLockReader(lockPath);
    assert.equal(result.ok, true, `the launcher's lock reader did not run: ${JSON.stringify(result)}`);
    assert.equal(
      result.owner,
      child.pid,
      `the launcher read the live host-main out of host.lock as ${JSON.stringify(result.owner)}, so a second launch sees "not running" while a host is up and starts a rival on the same data root`,
    );
  } finally {
    child.kill("SIGKILL");
    exited.then(() => rmSync(root, { recursive: true, force: true }));
  }
  return exited;
});

test("a lock naming a dead process reads as no host at all", async () => {
  const root = scratch("dead");
  const lockPath = path.join(root, "host.lock");
  writeFileSync(lockPath, String(4_000_000), "utf8");
  const result = runLauncherLockReader(lockPath);
  assert.equal(result.ok, true, `the launcher's lock reader did not run: ${JSON.stringify(result)}`);
  assert.equal(result.owner, null, "a lock naming a dead process still reads as a running box, so a real restart would be refused");
});

test("a lock naming a live process that is not a box host reads as no host", async () => {
  // A recycled pid is the case a pid-only check gets wrong, and the launcher
  // cannot afford it: believing it would refuse every future start.
  const root = scratch("foreign");
  const lockPath = path.join(root, "host.lock");
  const script = path.join(root, "something-else.js");
  writeFileSync(script, "setInterval(() => {}, 1 << 30);\n");
  const child = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    writeFileSync(lockPath, String(child.pid), "utf8");
    const result = runLauncherLockReader(lockPath);
    assert.equal(result.owner, null, "a live process that is not a host-main was believed to be a running box, so the box would never be started again");
  } finally {
    child.kill("SIGKILL");
    exited.then(() => rmSync(root, { recursive: true, force: true }));
  }
  return exited;
});

test("an unreadable lock reads as no host at all", () => {
  const root = scratch("garbage");
  const lockPath = path.join(root, "host.lock");
  writeFileSync(lockPath, "not-a-pid", "utf8");
  const result = runLauncherLockReader(lockPath);
  assert.equal(result.owner, null, "a lock file that is not a pid was believed to be a running box");
});

test("the launcher no longer deletes the lock of a host it has not proved is gone", () => {
  assert.equal(
    /Remove-Item[^\n]*host\.lock/.test(launcherSource),
    false,
    "the launcher still deletes host.lock unconditionally, so every start in the window between taking the lock and binding 8790 strips a live host's claim to the data root",
  );
  assert.ok(
    /Get-HostLockOwner/.test(launcherSource),
    "the launcher no longer reads host.lock at all, so it cannot tell a starting host from a stopped one",
  );
});