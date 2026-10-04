import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The agent had no command line at all. `BoxExecRuntime.spawnShell` in
 * `source/box-exec-daemon/server.ts` was `spawn("/bin/sh", ["-lc", command])`,
 * and `/bin/sh` does not exist on Windows, so every one of the three callers —
 * `shellStream` at line 598, `spawnBackground` at 649 and `run` at 992 — failed to
 * create a process. The three attempts the agent reported came back as
 * `Error: Command failed to spawn: Service temporarily unavailable. This may be
 * temporary; try again.` and `Error: Command failed to spawn: Aborted`: the client
 * turned a stream that had nothing behind it into a promise to try later, and
 * nothing anywhere said that no interpreter had been found. `shellStream` and
 * `spawnBackground` never listened for the child's `error` event either, so a
 * spawn failure could not be reported at all — it could only end the stream.
 *
 * The tests below start the daemon from source, drive it through the same
 * Connect routes and the same protobuf messages the host uses, and run real
 * commands. No transport is mocked and no child is stubbed: the stdout that is
 * asserted on comes from a `cmd.exe` (or `/bin/sh`) that this machine started, and
 * the missing-interpreter case is produced by pointing `ComSpec` at a file that
 * does not exist, which is the same failure the shipped code hit on every call.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const MARKER = "GROK_SHELL_OK";
const BACKGROUND_MARKER = "GROK_SHELL_BG_OK";
const MISSING_INTERPRETER = "C:\\grok-no-such-shell\\cmd.exe";

/**
 * One bundle carrying the daemon plus the generated Connect client and messages.
 *
 * CommonJS on purpose, like `tests/box-mcp-stdio-executor.test.mjs`: Connect and
 * the protobuf runtime reach for Node built-ins through `require`, which an ESM
 * bundle cannot serve. The `stdin` entry point is how a test reaches the
 * generated modules with no shared loader.
 */
const SHIM_SOURCE = `
export { startBoxExecDaemon, resolveShellInvocation, describeShellInterpreterFailure } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { ShellArgs } from "./packages/proto/generated/agent/v1/shell_exec_pb.js";
export { BackgroundShellSpawnArgs } from "./packages/proto/generated/agent/v1/background_shell_exec_pb.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-shell-"));
  const outfile = path.join(directory, "box-shell-shim.cjs");
  await build({
    stdin: {
      contents: SHIM_SOURCE,
      resolveDir: path.join(repoRoot, "source"),
      sourcefile: "box-shell-shim.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return {
    shim: createRequire(import.meta.url)(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const AUTH_TOKEN = "s".repeat(43);

let shim;
let disposeShim;
let handle;
let exec;
let workspaceRoot;
let terminalsDirectory;
let nextId = 1;

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-box-shell-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-box-shell-terminals-"));
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
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  disposeShim?.();
});

/**
 * Sends one `ExecServerMessage` and collects the frames the daemon streams back.
 *
 * The deadline is the safety ceiling. A daemon that cannot start a process used
 * to leave this stream open forever, which would hang the whole file instead of
 * failing one assertion, so the wait is bounded and the timeout is reported as
 * the failure it is.
 */
async function drive(message, deadlineMs = 30_000, client = exec) {
  const id = nextId++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const frames = [];
  try {
    const stream = client.exec(new shim.ExecServerMessage({ id, execId: `exec-${id}`, message }), { signal: controller.signal });
    for await (const element of stream) {
      if (element.element.case === "execClientMessage") {
        frames.push({ kind: "result", case: element.element.value.message.case, value: element.element.value.message.value });
      } else if (element.element.case === "execClientControlMessage" && element.element.value.message.case === "throw") {
        frames.push({ kind: "throw", value: element.element.value.message.value });
      }
    }
  } catch (error) {
    frames.push({ kind: "throw", value: { error: `the daemon never finished the request (${deadlineMs} ms): ${errorText(error)}` } });
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The client-side normalizer, bundled on its own.
 *
 * `maybeNormalizeExecBoundaryError` is the boundary the user's wording came out
 * of. Loading it separately keeps the daemon bundle small and proves the claim
 * about that boundary against the shipped code rather than against a paraphrase
 * of it.
 */
let connectErrorPromise;
function loadConnectError() {
  connectErrorPromise ??= (async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-shell-connect-error-"));
    const outfile = path.join(directory, "connect-error.cjs");
    await build({
      entryPoints: [path.join(repoRoot, "source", "packages", "agent", "tools", "core", "connect-error.ts")],
      outfile,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    return createRequire(import.meta.url)(outfile);
  })();
  return connectErrorPromise;
}

/** Every string the daemon streamed, in order, so one assertion sees the whole run. */
function collectStream(frames) {
  const text = { stdout: "", stderr: "", exit: undefined, throw: undefined };
  for (const frame of frames) {
    if (frame.kind === "throw") {
      text.throw = frame.value.error;
      continue;
    }
    if (frame.value.result.case === "success" || frame.value.result.case === "failure") {
      text.stdout = frame.value.result.value.stdout;
      text.stderr = frame.value.result.value.stderr;
    }
    if (frame.value.result.case === "spawnError") text.throw = frame.value.result.value.error;
  }
  return text;
}

/** The stream arm: `start`, then any `stdout`/`stderr`, then exactly one `exit`. */
function collectShellStream(frames) {
  const text = { stdout: "", stderr: "", exit: undefined, throw: undefined };
  for (const frame of frames) {
    if (frame.kind === "throw") {
      text.throw = frame.value.error;
      continue;
    }
    const event = frame.value.event;
    if (event.case === "stdout") text.stdout += event.value.data;
    else if (event.case === "stderr") text.stderr += event.value.data;
    else if (event.case === "exit") text.exit = event.value;
  }
  return text;
}

const shellStreamArgs = (command, timeout = 0) => ({
  case: "shellStreamArgs",
  value: new shim.ShellArgs({ command, workingDirectory: workspaceRoot, timeout }),
});

const shellArgs = (command, timeout = 0) => ({
  case: "shellArgs",
  value: new shim.ShellArgs({ command, workingDirectory: workspaceRoot, timeout }),
});

const backgroundSpawnArgs = command => ({
  case: "backgroundShellSpawnArgs",
  value: new shim.BackgroundShellSpawnArgs({ command, workingDirectory: workspaceRoot }),
});

/** Reads the terminal transcript a background shell writes until `predicate` holds. */
async function readTerminalUntil(shellId, predicate, deadlineMs = 15_000) {
  const terminalPath = path.join(terminalsDirectory, `${shellId}.txt`);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = readFileSync(terminalPath, "utf8");
    } catch {}
    if (predicate(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return readFileSync(terminalPath, "utf8");
}

/**
 * What the background shell actually wrote, with the frontmatter removed.
 *
 * The frontmatter records the command text verbatim, so a marker appears in a
 * transcript even when no process ever ran. Asserting on the whole file is a
 * test that passes without executing anything — which is exactly what the first
 * run of this file did.
 */
function terminalOutput(transcript) {
  const frontmatterEnd = transcript.indexOf("\n---\n");
  return frontmatterEnd === -1 ? "" : transcript.slice(frontmatterEnd + "\n---\n".length);
}

// ---------------------------------------------------------------------------
// The interpreter the daemon picks, one platform at a time.
// ---------------------------------------------------------------------------

test("the daemon never names a POSIX program on Windows and never names cmd.exe elsewhere", () => {
  const windows = shim.resolveShellInvocation("win32", "echo hi");
  assert.doesNotMatch(windows.file, /bin[\\/]sh/,
    "the Windows branch spawns a POSIX program that does not exist on this platform, which is the defect these tests close");
  assert.match(windows.file, /cmd(\.exe)?$/i,
    `Windows must run the command interpreter Windows itself defines in ComSpec, not ${windows.file}`);
  assert.deepEqual(windows.args, ["/c", "echo hi"],
    "cmd.exe takes /c; -c is a POSIX flag it does not understand");

  const linux = shim.resolveShellInvocation("linux", "echo hi");
  assert.equal(linux.file, "/bin/sh", "POSIX keeps the interpreter the box has always used");
  assert.deepEqual(linux.args, ["-lc", "echo hi"],
    "POSIX keeps the login-shell argv the box has always used, so no existing box behaviour changes");
});

test("an interpreter that cannot be started is named, not described as a temporary outage", () => {
  const enoent = Object.assign(new Error(`spawn ${MISSING_INTERPRETER} ENOENT`), { code: "ENOENT" });
  const described = shim.describeShellInterpreterFailure(enoent, MISSING_INTERPRETER);
  assert.match(described, /cmd\.exe/,
    `the failure does not say which program was missing, so the user is left guessing: ${described}`);
  assert.doesNotMatch(described, /temporar|try again/i,
    `the failure is told to the user as a retryable outage, which is a lie: ${described}`);
  assert.match(described, /did not run/i,
    `the failure does not say that nothing was executed: ${described}`);

  const denied = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  assert.match(shim.describeShellInterpreterFailure(denied, "cmd.exe"), /cmd\.exe/,
    "a permission refusal on the interpreter is just as unrunnable as a missing one");

  const other = shim.describeShellInterpreterFailure(new Error("EAGAIN"), "cmd.exe");
  assert.match(other, /cmd\.exe/, "an unnamed failure still has to name the program that failed to start");
});

// ---------------------------------------------------------------------------
// A real command, run three ways, on this machine.
// ---------------------------------------------------------------------------

test("a streamed command runs in a real interpreter and returns its stdout with exit code 0", async () => {
  const run = collectShellStream(await drive(shellStreamArgs(`echo ${MARKER}`, 20_000)));
  assert.equal(run.throw, undefined, `the daemon refused to run the command: ${run.throw}`);
  assert.match(run.stdout, new RegExp(MARKER),
    `no command was executed on this machine; the daemon streamed: ${JSON.stringify(run)}`);
  assert.ok(run.exit !== undefined, "the stream ended without an exit event, so the caller is left waiting for a result");
  assert.equal(run.exit.code, 0,
    `the command ran but reported a failure, which the model would read as the command itself failing: ${JSON.stringify(run)}`);
});

test("a one-shot command runs in a real interpreter and returns its stdout with exit code 0", async () => {
  const frames = await drive(shellArgs(`echo ${MARKER}`, 20_000));
  const run = collectStream(frames);
  assert.equal(run.throw, undefined, `the daemon refused to run the command: ${run.throw}`);
  assert.equal(frames[0].case, "shellResult", `the daemon answered the wrong message arm: ${frames[0].case}`);
  assert.match(run.stdout, new RegExp(MARKER),
    `no command was executed on this machine; the daemon answered: ${JSON.stringify(run)}`);
  assert.equal(frames[0].value.result.case, "success",
    `a command that ran and exited 0 was reported as "${frames[0].value.result.case}"`);
});

test("a background command runs in a real interpreter and writes its output to its terminal file", async () => {
  const frames = await drive(backgroundSpawnArgs(`echo ${BACKGROUND_MARKER}`));
  const result = frames[0];
  assert.equal(frames[0].case, "backgroundShellSpawnResult", `the daemon answered the wrong message arm: ${frames[0].case}`);
  assert.equal(result.value.result.case, "success",
    `a background command could not be started at all: ${result.value.result.case} ${result.value.result.value?.error ?? ""}`);
  const transcript = await readTerminalUntil(
    result.value.result.value.shellId,
    text => /exit_code: \d+/.test(text),
  );
  const output = terminalOutput(transcript);
  assert.match(output, new RegExp(BACKGROUND_MARKER),
    `the background command wrote nothing to its terminal file, so nothing was executed on this machine: ${JSON.stringify(transcript)}`);
  assert.match(transcript, /exit_code: 0/,
    `the background command never reported a clean exit, so its result is unknown: ${JSON.stringify(transcript)}`);
});

// ---------------------------------------------------------------------------
// A working interpreter must not become a wider sandbox.
// ---------------------------------------------------------------------------

test("a working directory outside the box roots is still refused now that commands run", async () => {
  // Finding a real interpreter is exactly the change that could have been used to
  // run commands anywhere: the daemon now creates processes on this machine for
  // the first time, so the boundary that rejected those paths has to be proven
  // still in front of them.
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-box-outside-"));
  try {
    const frames = await drive({
      case: "shellArgs",
      value: new shim.ShellArgs({ command: `echo ${MARKER}`, workingDirectory: outside, timeout: 20_000 }),
    });
    assert.equal(frames[0].case, "shellResult", `the daemon answered the wrong message arm: ${frames[0].case}`);
    assert.equal(frames[0].value.result.case, "spawnError",
      `a command was accepted outside the roots the daemon was given: ${JSON.stringify(collectStream(frames))}`);
    assert.match(String(frames[0].value.result.value.error), /escapes configured workspace root/i,
      `the refusal does not say which boundary stopped it: ${frames[0].value.result.value.error}`);
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// The interpreter is genuinely missing, the case the agent hit every time.
// ---------------------------------------------------------------------------

/**
 * A second daemon whose environment has no command interpreter.
 *
 * The daemon copies its environment when it starts, and the host can rewrite
 * that copy later, so `ComSpec` is doctored through `startBoxExecDaemon` rather
 * than through `process.env`. That is how a real Windows box reaches this state,
 * and it is the only way to fail the interpreter resolution in `spawnShell`
 * without patching the product.
 */
async function startDaemonWithoutInterpreter() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-box-nointerp-workspace-"));
  const terminals = mkdtempSync(path.join(os.tmpdir(), "grok-box-nointerp-terminals-"));
  const environment = { ...process.env };
  delete environment.SHELL;
  environment.ComSpec = MISSING_INTERPRETER;
  const started = await shim.startBoxExecDaemon({
    workspaceRoot: root,
    terminalsDirectory: terminals,
    authToken: AUTH_TOKEN,
    port: 0,
    environment,
  });
  const transport = shim.createConnectTransport({
    baseUrl: started.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  return {
    exec: shim.createClient(shim.ExecService, transport, { transport }),
    root,
    stop: async () => {
      await started.stop();
      for (const directory of [root, terminals]) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test("a missing interpreter is reported as a missing interpreter, not as a temporary outage", { skip: !isWindows }, async (t) => {
  const broken = await startDaemonWithoutInterpreter();
  t.after(broken.stop);

  const frames = await drive(
    { case: "shellArgs", value: new shim.ShellArgs({ command: `echo ${MARKER}`, workingDirectory: broken.root, timeout: 20_000 }) },
    30_000,
    broken.exec,
  );
  const failure = frames.find(frame => frame.kind === "throw");
  assert.ok(failure !== undefined,
    `the daemon reported no failure at all for an interpreter that does not exist: ${JSON.stringify(collectStream(frames))}`);
  assert.match(failure.value.error, /cmd\.exe/i,
    `the failure does not name the program that could not be started: ${failure.value.error}`);
  assert.doesNotMatch(failure.value.error, /temporar|try again/i,
    `the user is told to retry a failure that cannot be retried away: ${failure.value.error}`);
});

test("a missing interpreter ends a streamed command with a diagnosis instead of an unexplained exit", { skip: !isWindows }, async (t) => {
  const broken = await startDaemonWithoutInterpreter();
  t.after(broken.stop);

  const run = collectShellStream(await drive(
    { case: "shellStreamArgs", value: new shim.ShellArgs({ command: `echo ${MARKER}`, workingDirectory: broken.root, timeout: 20_000 }) },
    30_000,
    broken.exec,
  ));
  assert.ok(run.throw !== undefined || run.exit !== undefined,
    `the stream never finished, so the caller waits forever for a result: ${JSON.stringify(run)}`);
  assert.ok(run.throw !== undefined,
    `a command that never started ended with a bare exit code and no reason: ${JSON.stringify(run)}`);
  assert.match(run.throw, /cmd\.exe/i,
    `the failure does not name the program that could not be started: ${run.throw}`);
  assert.doesNotMatch(run.throw, /temporar|try again/i,
    `the user is told to retry a failure that cannot be retried away: ${run.throw}`);
});

test("the daemon's own diagnosis is not rewritten into a retryable outage on the way out", async () => {
  // `maybeNormalizeExecBoundaryError` is what produced "Service temporarily
  // unavailable. This may be temporary; try again." in front of the user. It
  // rewrites a Connect error that carries a code; the daemon's throw travels as
  // a plain Error, so the named interpreter has to survive this boundary intact.
  const reported = shim.describeShellInterpreterFailure(
    Object.assign(new Error("spawn cmd.exe ENOENT"), { code: "ENOENT" }),
    "C:\\Windows\\System32\\cmd.exe",
  );
  const { maybeNormalizeExecBoundaryError } = await loadConnectError();
  const normalized = maybeNormalizeExecBoundaryError(new Error(reported));
  assert.equal(normalized.message, reported,
    `the diagnosis the box produced was replaced before the user saw it: ${normalized.message}`);
  assert.doesNotMatch(normalized.message, /temporar|try again/i,
    `the user is told to retry a failure that cannot be retried away: ${normalized.message}`);
});