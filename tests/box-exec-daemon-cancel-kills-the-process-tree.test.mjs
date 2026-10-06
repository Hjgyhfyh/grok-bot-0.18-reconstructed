import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * A cancelled or timed-out command on the box left every program it started
 * running, and then held the shell tool's answer open for as long as they lived.
 *
 * `packages/local-exec/shell-core.ts` already carries the answer for this. Its
 * comment names the exact failure: "It answers an abort with `child.kill()`,
 * which on Windows is a TerminateProcess on the shell alone: `cmd.exe` dies and
 * the `python` it started keeps running until something walks the tree." The guard
 * it builds on top — `createShellProcessGuard` plus `killProcessTree`, which runs
 * `taskkill /T /F` — exists only because a cancelled shell used to leak.
 *
 * `box-exec-daemon/server.ts` has the same `kill(child)` and never got the guard.
 * On Windows that method is `child.kill("SIGTERM")`, which terminates exactly one
 * pid: the `cmd.exe` this daemon spawned. Everything below it — the `python`, the
 * dev server, the `node build.js` — is untouched, and so is the pair of pipes it
 * inherited from that `cmd.exe`.
 *
 * The leak is not the half of it that hurts. Node emits `close` on a child only
 * after `exit` AND after all three of its stdio streams have reached EOF, and the
 * streams do not reach EOF while an orphan still holds the write end. So:
 *
 *   1. the orphan keeps running after the user cancels, and
 *   2. `shellStream`'s `while (!done || events.length > 0)` loop — `done` is set
 *      by the `close` listener — waits for the orphan too, and
 *   3. `run()`, the one-shot path, awaits `child.once("close")` the same way, so
 *      its `timeout` case never gets a chance to be reported.
 *
 * Measured on this machine through the shipped daemon, with the interpreter and
 * the route held fixed and a grandchild whose own lifetime is 20 s:
 *
 *   shellStream, `timeout: 1500`  the stream ended after 19 998 ms — 13x the
 *                                 declared timeout, and exactly when the orphan
 *                                 exited by itself. Overrun 18 498 ms.
 *   shellArgs,   `timeout: 1500`  the call returned after 19 992 ms. Same overrun.
 *   shellStream, client abort     the orphan was still running 1.5 s later.
 *
 * With the shell tool's own 30 000 ms default, one command that leaves a server
 * running makes the tool wait for that server. It is not a slow tool; it is a
 * tool with no answer.
 *
 * The two tests below drive the real daemon over the real Connect route with a
 * real `cmd.exe` and a real `node` grandchild. Nothing is stubbed. A grandchild
 * that outlives a failing assertion is force-killed in `test.after`, so a red run
 * still leaves the machine clean.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

// CommonJS on purpose, like `tests/box-exec-daemon-command-line-fidelity.test.mjs`:
// Connect and the protobuf runtime reach for Node built-ins through `require`.
const SHIM_SOURCE = `
export { startBoxExecDaemon } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { ShellArgs } from "./packages/proto/generated/agent/v1/shell_exec_pb.js";
`;

const AUTH_TOKEN = "k".repeat(43);

/**
 * The grandchild's own lifetime, and therefore the number this file measures
 * against. It has to be comfortably longer than the daemon timeout and than every
 * ceiling below, so an overrun cannot be mistaken for the daemon being slow.
 */
const ORPHAN_LIFETIME_SECONDS = 20;
const DAEMON_TIMEOUT_MS = 1_500;
/** A cancel that has not taken the tree down by now has leaked it. */
const CANCEL_CEILING_MS = 8_000;
/** A `timeout: 1500` call that needs longer than this ignored the timeout. */
const TIMEOUT_CEILING_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const strays = new Set();

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Last-resort cleanup. A test that leaves a grandchild behind is worse than a failing test. */
function forceKill(pid) {
  if (!isAlive(pid)) return;
  strays.add(pid);
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Nothing more to try; the suite reports the failure that led here.
  }
}

/** Polls instead of sleeping blind, and cannot hang: the ceiling is the safety limit. */
async function waitFor(predicate, what, ceilingMs) {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() > deadline) assert.fail(`${what} never happened within ${ceilingMs}ms`);
    await sleep(25);
  }
}

test.after(() => {
  for (const pid of strays) forceKill(pid);
  strays.clear();
});

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-cancel-"));
  const outfile = path.join(directory, "box-cancel-shim.cjs");
  await build({
    stdin: { contents: SHIM_SOURCE, resolveDir: path.join(repoRoot, "source"), sourcefile: "box-cancel-shim.ts", loader: "ts" },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return {
    shim: createRequire(import.meta.url)(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

let shim;
let disposeShim;
let handle;
let exec;
let workspaceRoot;
let terminalsDirectory;
let nextId = 1;

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-box-cancel-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-box-cancel-terminals-"));
  handle = await shim.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: AUTH_TOKEN, port: 0 });
  const transport = shim.createConnectTransport({
    baseUrl: handle.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  exec = shim.createClient(shim.ExecService, transport, { transport });
});

test.after(async () => {
  await handle?.stop();
  for (const directory of [workspaceRoot, terminalsDirectory]) {
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  disposeShim?.();
});

/**
 * A launcher inside the daemon's own workspace root that starts a process far
 * outliving its parent, plus the command that runs it.
 *
 * The directory has to be inside `workspaceRoot`: the daemon's `resolvePath`
 * refuses a working directory outside it, so a tree in a separate temp directory
 * never runs, and a test that measures a command which never started proves
 * nothing. The command is a bare program name with no quoted path for the reason
 * `tests/shell-timeout-kills-the-whole-process-tree.test.mjs` gives — `PATH`
 * lookup never consults the working directory.
 */
function makeOrphan(label) {
  const dir = mkdtempSync(path.join(workspaceRoot, `orphan-${label}-`));
  const pidFile = path.join(dir, "grandchild.pid");
  const sleeper = path.join(dir, "sleeper.mjs");
  writeFileSync(
    sleeper,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setTimeout(() => {}, ${ORPHAN_LIFETIME_SECONDS * 1000});`,
      "",
    ].join("\n"),
  );
  return { dir, pidFile, command: "node sleeper.mjs" };
}

/**
 * Starts one command and hands back the pump plus the promise of its frames.
 * The pump is returned, not awaited, so a test can cancel while it runs.
 */
function startShellStream(args, signal) {
  const id = nextId++;
  const frames = [];
  const done = (async () => {
    try {
      const stream = exec.exec(new shim.ExecServerMessage({ id, execId: `exec-${id}`, message: { case: "shellStreamArgs", value: args } }), { signal });
      for await (const element of stream) {
        if (element.element.case === "execClientMessage") frames.push(element.element.value.message.case);
      }
    } catch (error) {
      frames.push(`throw:${error instanceof Error ? error.message : String(error)}`);
    }
    return frames;
  })();
  return { frames, done };
}

async function startShell(args) {
  const id = nextId++;
  const frames = [];
  const stream = exec.exec(new shim.ExecServerMessage({ id, execId: `exec-${id}`, message: { case: "shellArgs", value: args } }), { signal: new AbortController().signal });
  for await (const element of stream) {
    if (element.element.case === "execClientMessage") frames.push(element.element.value.message.case);
  }
  return frames;
}

async function grandchildPidOf(orphan, what) {
  return await waitFor(
    () => (existsSync(orphan.pidFile) ? Number(readFileSync(orphan.pidFile, "utf8").trim()) : false),
    `${what} (the command has to be running before a cancel can be measured against it)`,
    20_000,
  );
}

// ---------------------------------------------------------------------------

test("a cancelled command takes the process it started with it", { skip: !isWindows && "the tree walk this asserts on is Windows `taskkill /T`; a POSIX host already signals the process group" }, async () => {
  const orphan = makeOrphan("cancel");
  const controller = new AbortController();
  const run = startShellStream(
    new shim.ShellArgs({ command: orphan.command, workingDirectory: orphan.dir, timeout: 600_000 }),
    controller.signal,
  );
  let pid;
  try {
    pid = await grandchildPidOf(orphan, "the grandchild under the box shell to start");
    assert.equal(isAlive(pid), true, "the grandchild has to be running before the cancel, or this proves nothing");

    controller.abort();
    await run.done;

    await waitFor(() => (isAlive(pid) ? false : true), `the grandchild of a cancelled command to be gone (pid ${pid} is still running)`, CANCEL_CEILING_MS);
  } finally {
    forceKill(pid);
    rmSync(orphan.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a command that hits its timeout answers at the timeout instead of waiting for what it left behind", { skip: !isWindows && "the tree walk this asserts on is Windows `taskkill /T`; a POSIX host already signals the process group" }, async () => {
  const orphan = makeOrphan("timeout");
  let pid;
  try {
    const started = Date.now();
    const running = startShellStream(
      new shim.ShellArgs({ command: orphan.command, workingDirectory: orphan.dir, timeout: DAEMON_TIMEOUT_MS }),
      new AbortController().signal,
    );
    pid = await grandchildPidOf(orphan, "the grandchild under the box shell to start");
    assert.equal(isAlive(pid), true, "the grandchild has to be running before the timeout can be measured against it");

    const frames = await Promise.race([
      running.done,
      sleep(TIMEOUT_CEILING_MS).then(() => assert.fail(
        `a command with timeout ${DAEMON_TIMEOUT_MS}ms was still streaming ${TIMEOUT_CEILING_MS}ms later; it is waiting for the orphan, whose own lifetime is ${ORPHAN_LIFETIME_SECONDS}s`,
      )),
    ]);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < TIMEOUT_CEILING_MS, `the answer took ${elapsed}ms, which is the orphan's lifetime and not the declared timeout`);
    assert.ok(frames.includes("shellStream"), `the daemon must still answer a timed-out command; it produced ${JSON.stringify(frames)}`);
    await waitFor(() => (isAlive(pid) ? false : true), `the orphan of a timed-out command to be gone (pid ${pid} is still running)`, CANCEL_CEILING_MS);
  } finally {
    forceKill(pid);
    rmSync(orphan.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the one-shot shell path answers its timeout at the timeout too", { skip: !isWindows && "the tree walk this asserts on is Windows `taskkill /T`; a POSIX host already signals the process group" }, async () => {
  const orphan = makeOrphan("oneshot");
  let pid;
  try {
    const running = startShell(new shim.ShellArgs({ command: orphan.command, workingDirectory: orphan.dir, timeout: DAEMON_TIMEOUT_MS }));
    pid = await grandchildPidOf(orphan, "the grandchild under the box shell to start");
    assert.equal(isAlive(pid), true, "the grandchild has to be running before the timeout can be measured against it");

    const started = Date.now();
    const frames = await Promise.race([
      running,
      sleep(TIMEOUT_CEILING_MS).then(() => assert.fail(
        `shellArgs with timeout ${DAEMON_TIMEOUT_MS}ms had not answered ${TIMEOUT_CEILING_MS}ms later; run() awaits close, and close waits for the orphan's pipes`,
      )),
    ]);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < TIMEOUT_CEILING_MS, `the one-shot answer took ${elapsed}ms, which is the orphan's lifetime and not the declared timeout`);
    assert.deepEqual(frames, ["shellResult"], `a one-shot shell call must answer with exactly one result frame, and it produced ${JSON.stringify(frames)}`);
    await waitFor(() => (isAlive(pid) ? false : true), `the orphan of a timed-out one-shot command to be gone (pid ${pid} is still running)`, CANCEL_CEILING_MS);
  } finally {
    forceKill(pid);
    rmSync(orphan.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});