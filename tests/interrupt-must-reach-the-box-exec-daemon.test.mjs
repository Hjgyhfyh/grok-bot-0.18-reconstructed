import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Pressing stop did not stop the command the turn was running.
//
// `SandAgentRunner.interruptAll` aborts the turn's `AbortController` and the tests
// in `user-interrupt-run.test.mjs` prove that abort kills a shell's whole process
// tree — but only for a shell that runs INSIDE the host process. A shell the model
// runs on this box does not. It is spawned by a separate daemon, the box exec
// daemon on 127.0.0.1:1337, and the turn's abort signal never reaches it:
//
//   - `box-exec-daemon/server.ts:1379` wires the daemon's exec route as
//     `exec: (request, context) => runtime.execute(request, context.signal)`.
//   - `runtime.shellStream` (`:779-780`) registers
//     `signal.addEventListener("abort", () => this.kill(child))`, and `kill`
//     (`:1300-1313`) is the only thing that walks the tree with `taskkill /T`.
//   - `context.signal` on a connect-node server is the HTTP request's signal, and
//     that only aborts when the CLIENT cancels the request.
//
// The client is built in `host/box/generated-production.ts:204-206`:
//
//     createExecClient(transport) {
//       return bindings.createContextPropagatingClient(bindings.execService, transport);
//     }
//
// `createContextPropagatingClient` forwards the caller's `Context` signal into the
// RPC only when it is asked to — `packages/context-rpc/index.ts:183` reads
// `options.enableAbortSignal === true` — and no options are passed here. So the
// per-turn `Context` is decoded, span-wrapped and given tracing headers, and its
// abort signal is dropped on the floor. Nothing cancels the request; the daemon
// never learns the turn is over; the shell and everything below it keep running.
//
// What the user sees is worse than silence: `interruptAgentRun` answers
// `{"interrupted":true}` and the agent goes idle, and the journal records the
// shell tool's own result as a cancelled command (`aborted: true`,
// `SHELL_ABORT_REASON_USER_ABORT`). The app reports the work as stopped while the
// work is still running.
//
// MEASURED on the live box at 127.0.0.1:8790, three runs out of three, against the
// fidelity build this repository produces:
//
//   shell    cmd.exe /c node <tmp>/sleeper.cjs        pid 28236
//   child    node <tmp>/sleeper.cjs                  pid 31440
//   parent of the shell                             pid 24412  box-exec-daemon/main.cjs
//   POST /api/interruptAgentRun -> 200 {"interrupted":true,"hadRunningSubagents":false}
//   isRunning -> false within 1 s
//   +20 s: shell alive, grandchild alive
//   minutes later: shell gone, grandchild still alive
//
// The same stack run in-process dies in under 500 ms, which is what rules out
// `packages/local-exec` and `process-tree.ts` as the cause: the tree walk is
// fine, the signal simply never arrives.
//
// The tests below drive the real daemon, the real production client, the real
// resource and a real two-level process tree, and they fail on the state before
// the fix. The second test pins the cause: the same call WITHOUT abort
// propagation is the behaviour that leaks, so the flag is the whole difference.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-boxexec-stop-"));
  const source = relative => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(
    entry,
    [
      `export { startBoxExecDaemon } from ${source(["box-exec-daemon", "server.ts"])};`,
      `export { productionBoxGeneratedPorts } from ${source(["host", "box", "generated-production.ts"])};`,
      `export { createBoxTransport, createBoxRemoteResourceAccessorFromTransport, BoxRemoteExecManager } from ${source(["host", "box", "box-remote-accessor.ts"])};`,
      `export { shellStreamExecutorResource } from ${source(["packages", "agent-exec", "shell-stream.ts"])};`,
      `export { createContext } from ${source(["packages", "context", "core.ts"])};`,
      `export { createContextPropagatingClient } from ${source(["packages", "context-rpc", "index.ts"])};`,
      `export { ExecService } from ${source(["packages", "proto", "generated", "agent", "v1", "exec_service_connect.ts"])};`,
    ].join("\n"),
    "utf8",
  );
  const outfile = path.join(directory, "entry.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    banner: {
      js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const {
  startBoxExecDaemon,
  productionBoxGeneratedPorts,
  createBoxTransport,
  createBoxRemoteResourceAccessorFromTransport,
  BoxRemoteExecManager,
  shellStreamExecutorResource,
  createContext,
  createContextPropagatingClient,
  ExecService,
} = loaded;

test.after(() => dispose());

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killTreeSync(pid) {
  spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
}

function parentPidOf(pid) {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).ParentProcessId`],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  const value = Number(String(result.stdout ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function waitFor(predicate, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 50));
  }
}

const AUTH = "test-box-exec-auth-token";

/**
 * A real daemon, the real production client and the real shell resource, wired
 * exactly as `host/box/production.ts` wires them, over loopback.
 *
 * `clientFactory` exists so the second test can supply the same client WITHOUT
 * abort propagation and show that this is the difference and not the daemon.
 */
async function withBoxExecHarness(run, clientFactory) {
  const work = mkdtempSync(path.join(os.tmpdir(), "grok-boxexec-work-"));
  const terminals = mkdtempSync(path.join(os.tmpdir(), "grok-boxexec-term-"));
  const pidFile = path.join(work, "sleeper.pid");
  const sleeperFile = path.join(work, "sleeper.cjs");
  // Two levels, because one cannot show the defect: on Windows `taskkill /PID`
  // kills `cmd.exe` and leaves the `node` it started running, which is exactly
  // what this daemon's `kill` exists to prevent.
  writeFileSync(
    sleeperFile,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `setInterval(() => console.log("tick"), 300);\n`,
  );

  const daemon = await startBoxExecDaemon({
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH,
    workspaceRoot: work,
    terminalsDirectory: terminals,
  });
  const endpoint = { host: daemon.host, port: daemon.port, authToken: AUTH };
  const transport = createBoxTransport(endpoint, productionBoxGeneratedPorts.createTransport);
  const client = clientFactory(transport);
  const accessor = createBoxRemoteResourceAccessorFromTransport(transport, {
    createExecClient: () => client,
    createResourceAccessor: productionBoxGeneratedPorts.createResourceAccessor,
  });
  const shell = accessor.get(shellStreamExecutorResource);
  const [ctx, cancel] = createContext().withCancel();

  const drained = (async () => {
    const seen = [];
    try {
      for await (const event of shell.execute(ctx, {
        command: `node ${sleeperFile}`,
        workingDirectory: work,
        toolCallId: "call-1",
        // The daemon kills the tree on `args.timeout` too, so a non-zero timeout
        // here would let the daemon pass for the wrong reason.
        timeout: 0,
      })) seen.push(event.event.case);
    } catch (error) {
      seen.push(`threw:${error?.name ?? "Error"}`);
    }
    return seen;
  })();

  try {
    return await run({ daemon, shell, ctx, cancel, pidFile, drained, work });
  } finally {
    cancel();
    for (const pid of [parentPidOf(Number(readFileSync(pidFile, "utf8").trim())), Number(readFileSync(pidFile, "utf8").trim())]) {
      if (pid != null && alive(pid)) killTreeSync(pid);
    }
    await daemon.stop();
    rmSync(work, { recursive: true, force: true });
    rmSync(terminals, { recursive: true, force: true });
  }
}

test("the user's stop reaches the box exec daemon, so the command's process tree dies", { timeoutMs: 120_000 }, async () => {
  await withBoxExecHarness(
    async ({ shell, ctx, cancel, pidFile, drained }) => {
      const grandchildPid = await waitFor(
        () => {
          if (!existsSync(pidFile)) return null;
          const pid = Number(readFileSync(pidFile, "utf8").trim());
          return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
        },
        { timeoutMs: 40_000, what: "the daemon to report the command's child pid" },
      );
      const shellPid = parentPidOf(grandchildPid);
      assert.ok(shellPid != null, "the command has no parent process, so the tree this test walks does not exist");
      assert.equal(alive(shellPid), true, "the shell is not running, so the abort below would prove nothing");

      // This is the user's stop: `RunnerRegistry.interruptUserRun` ends at
      // `active.controller.abort(...)`, and this is the Context that abort
      // reaches.
      cancel({ intentional: true, reason: "the user pressed stop" });

      const gone = await waitFor(() => !alive(grandchildPid), {
        timeoutMs: 20_000,
        what: "the process the command started to be gone",
      }).then(() => true, () => false);

      assert.equal(
        gone,
        true,
        `the turn was stopped and the box exec daemon was never told: the child of the shell (pid ${grandchildPid}) is still running after the abort, so the work the user cancelled keeps running with nothing left holding it`,
      );
      await waitFor(() => !alive(shellPid), { timeoutMs: 20_000, what: "the shell itself to be gone" });

      const seen = await Promise.race([
        drained,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("the exec stream never ended after the abort")), 15_000)),
      ]);
      assert.ok(seen.includes("exit") || seen.some(entry => String(entry).startsWith("threw:")), `the exec stream ended without ever reporting an exit: ${JSON.stringify(seen)}`);
    },
    transport => productionBoxGeneratedPorts.createExecClient(transport),
  );
});

test("a client built without abort propagation is what leaks, so the flag is the whole difference", { timeoutMs: 120_000 }, async () => {
  // Same daemon, same resource, same real tree. The only change is that the
  // client is built the way `generated-production.ts` built it: no options, so
  // `packages/context-rpc/index.ts:183` never merges the Context's signal into
  // the call. If this test ever fails because the tree DID die, the diagnosis has
  // moved and the first test is no longer measuring what it claims to.
  await withBoxExecHarness(
    async ({ ctx, cancel, pidFile, drained }) => {
      const grandchildPid = await waitFor(
        () => {
          if (!existsSync(pidFile)) return null;
          const pid = Number(readFileSync(pidFile, "utf8").trim());
          return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
        },
        { timeoutMs: 40_000, what: "the daemon to report the command's child pid" },
      );

      cancel({ intentional: true, reason: "the user pressed stop" });

      // Bounded on purpose, and short: this is the counterexample, not the
      // product path. Ten seconds is far longer than `taskkill /T` needs.
      await new Promise(done => setTimeout(done, 10_000));

      assert.equal(
        alive(grandchildPid),
        true,
        "a client that does not propagate the Context's abort signal reached the daemon anyway, so abort propagation is not what makes the stop work and the diagnosis in the comment above is wrong",
      );

      // Leave the harness able to shut down: the stream is still open.
      void ctx;
      void drained;
    },
    transport => createContextPropagatingClient(ExecService, transport),
  );
});
