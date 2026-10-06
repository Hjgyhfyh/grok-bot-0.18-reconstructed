import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Killing the box left the app unable to start again, ever, and nothing in the
// product ever said why. The cause is an orphan, not a refusal policy: an
// abruptly killed host (`taskkill /F`, a power cut, a Task Manager "End task")
// does not run `installShutdownHandlers`, and Windows does not kill the
// `box-exec-daemon` child when its parent dies. That daemon keeps
// 127.0.0.1:1337 bound forever, because its only owner is gone. The next start
// reads the stale `host.lock`, decides `reclaimed-dead`, resolves a zero
// millisecond release budget on the grounds that "only a takeover can leave the
// port behind", probes once, finds the port held, and throws
//
//   refusing contaminated box exec-daemon startup: 127.0.0.1:1337 is already
//   bound by pid <N>, after this host evicted its predecessor pid <dead>;
//   the holder is NOT the host this start evicted, so it is a foreign listener
//   and this host will not stop it
//
// Three live runs of that refusal were measured against a real orphaned daemon
// on a spare port: 40 ms, 35 ms, 34 ms, three identical refusals, port still
// bound afterwards. The message is wrong twice over. Nothing was evicted -
// `reclaimed-dead` means the predecessor was already dead - and the holder is
// not foreign: its command line is this host's own resolved
// `box-exec-daemon/main.cjs` entry.
//
// The fix is narrow on purpose. A listener is stopped only when BOTH halves are
// provable: its command line carries the exact entry path this start resolved,
// AND its parent process is gone. A daemon whose host is still alive (another
// box, or the host this start just evicted) is left strictly alone, and a
// listener that cannot be named is still refused by pid and still left running.
// The tests below drive the real port lookup and the real termination against
// real child processes, so the reclaim is exercised rather than described.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-orphan-reclaim-"));
  const outfile = path.join(directory, "exec-daemon-process.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "box", entry)],
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

const { loaded, dispose } = await bundle("exec-daemon-process.ts");
const { ensureBoxExecDaemonPortAvailable, readPortHolderPids } = loaded;

test.after(() => dispose());

const workDir = mkdtempSync(path.join(os.tmpdir(), "grok-orphan-reclaim-work-"));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const holderScript = path.join(workDir, "port-holder.cjs");
writeFileSync(holderScript, `
const net = require("node:net");
const fs = require("node:fs");
const [portFile] = process.argv.slice(2);
const server = net.createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
setInterval(() => {}, 1 << 30);
`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let holderCounter = 0;

/** Binds an ephemeral port in a real child process and never lets go of it. */
async function startPortHolder() {
  holderCounter += 1;
  const portFile = path.join(workDir, `holder-${holderCounter}.port`);
  const child = spawn(process.execPath, [holderScript, portFile], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const deadline = Date.now() + 15_000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("the port holder never reported a port");
    await sleep(20);
  }
  return {
    port: Number.parseInt(readFileSync(portFile, "utf8").trim(), 10),
    pid: child.pid,
    exited,
    isAlive: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}

const ENTRY = "D:\\apps\\Grok Bot\\resources\\app.asar.unpacked\\dist\\box-exec-daemon\\main.cjs";
// Node quotes an argument that contains a space when it composes a command
// line, and the packaged install path always does. The fixture has to be what
// CIM answers for, or the tokeniser is tested against a line that never exists.
const COMMAND = `"C:\\Program Files\\nodejs\\node.exe" "${ENTRY}"`;

/** The readers the product uses on this host, minus the two CIM queries. */
function readers(overrides = {}) {
  return {
    readCommand: overrides.readCommand ?? (() => COMMAND),
    readParentPid: overrides.readParentPid ?? (() => 424_242),
    isProcessAlive: overrides.isProcessAlive ?? (() => false),
    terminate: overrides.terminate ?? (() => {}),
  };
}

test("the port lookup this reclaim relies on really names the holder", async () => {
  const holder = await startPortHolder();
  try {
    const pids = readPortHolderPids(holder.port);
    assert.ok(
      pids.includes(holder.pid),
      `the holder of ${holder.port} is pid ${holder.pid} but the product read ${JSON.stringify(pids)}, so a reclaim built on this lookup could never fire`,
    );
  } finally {
    await holder.stop();
  }
});

test("a box exec daemon left behind by a killed host is reclaimed instead of refused", async () => {
  const holder = await startPortHolder();
  const terminated = [];
  try {
    const result = await ensureBoxExecDaemonPortAvailable({
      port: holder.port,
      entryPath: ENTRY,
      previousHost: { outcome: "reclaimed-dead", previousPid: 999_001 },
      ...readers({
        // The real thing would be the host that has already died.
        isProcessAlive: pid => pid === process.pid || holder.isAlive() && pid === holder.pid,
        terminate: pid => {
          terminated.push(pid);
          holder.stop();
        },
      }),
      delay: () => sleep(20),
    });

    assert.equal(result.available, true, `the start refused the port instead of reclaiming its own orphan: ${JSON.stringify(result)}`);
    assert.deepEqual(terminated, [holder.pid], "the orphaned exec daemon was never stopped, so the next start refused again for the same reason");
    assert.equal(holder.isAlive(), false, "the reclaim reported success while the orphan was still holding the port");
    assert.equal(result.reclaimedPids.length, 1, "the reclaim did not report which daemon it stopped, so the refusal message can never name it");
  } finally {
    await holder.stop();
  }
});

test("an exec daemon whose host is still alive is never stopped", async () => {
  // The control for the test above: same port, same entry in the command line,
  // same real lookup. The only difference is that the parent answers as alive -
  // a second box, or the very host this start evicted. Stopping it would break a
  // running app to save a dead one.
  const holder = await startPortHolder();
  const terminated = [];
  try {
    const result = await ensureBoxExecDaemonPortAvailable({
      port: holder.port,
      entryPath: ENTRY,
      previousHost: { outcome: "took-over", previousPid: 999_001 },
      timeoutMs: 200,
      ...readers({
        isProcessAlive: () => true,
        terminate: pid => terminated.push(pid),
      }),
      delay: () => sleep(20),
    });

    assert.equal(result.available, false, "a live host's exec daemon was taken away from it");
    assert.deepEqual(terminated, [], "a daemon with a living parent was signalled, which is the one thing this reclaim must never do");
    assert.equal(result.holderPid, holder.pid, "the refusal no longer names the pid, so the operator cannot see who to look at");
  } finally {
    await holder.stop();
  }
});

test("a listener that is not our own entry is refused by pid and left running", async () => {
  // A random program on 1337 - a dev server, another app - is not this app's
  // orphan and must never be signalled, however dead its parent looks.
  const holder = await startPortHolder();
  const terminated = [];
  try {
    const result = await ensureBoxExecDaemonPortAvailable({
      port: holder.port,
      entryPath: ENTRY,
      previousHost: { outcome: "reclaimed-dead", previousPid: 999_001 },
      ...readers({
        readCommand: () => '"C:\\Program Files\\nodejs\\node.exe" C:\\somebody-else\\server.js"',
        terminate: pid => terminated.push(pid),
      }),
      delay: () => sleep(20),
    });

    assert.equal(result.available, false, "a foreign listener was reclaimed on the strength of a dead parent alone");
    assert.deepEqual(terminated, [], "a foreign listener was signalled by the box exec-daemon startup");
    assert.equal(holder.isAlive(), true, "the foreign listener was stopped");
  } finally {
    await holder.stop();
  }
});

test("the refusal no longer claims a predecessor it never evicted", async () => {
  const holder = await startPortHolder();
  try {
    const result = await ensureBoxExecDaemonPortAvailable({
      port: holder.port,
      entryPath: ENTRY,
      previousHost: { outcome: "reclaimed-dead", previousPid: 999_001 },
      ...readers({ readCommand: () => null, readParentPid: () => null }),
      delay: () => sleep(20),
    });

    assert.equal(result.available, false, "an unnamed holder was allowed through, which is the foreign-listener case");
    assert.equal(result.evicted, false, "`reclaimed-dead` was reported as an eviction, so the message blames a predecessor that was already dead");
    assert.equal(result.previousHostPid, 999_001, "the dead predecessor was dropped from the report entirely, so the operator lost the pid that wrote host.lock");
  } finally {
    await holder.stop();
  }
});

test("a free port is probed once, reclaims nothing and waits for nothing", async () => {
  const holder = await startPortHolder();
  await holder.stop();
  await holder.exited;
  await sleep(150);

  let delays = 0;
  const result = await ensureBoxExecDaemonPortAvailable({
    port: holder.port,
    entryPath: ENTRY,
    previousHost: { outcome: "created" },
    ...readers(),
    delay: () => { delays += 1; return sleep(1); },
  });

  assert.equal(result.available, true, "a free port was refused, so every ordinary first start would print a contamination warning");
  assert.deepEqual(result.reclaimedPids, [], "a free port reported a reclaim, which would mean the reclaim reads a holder that does not exist");
  assert.equal(delays, 0, `a free port slept ${delays} time(s), so the reclaim path added startup latency to the common case`);
  assert.equal(result.waitedMs, 0, "a free port reported a wait, so the reclaim path spends time where there is nothing to wait for");
});