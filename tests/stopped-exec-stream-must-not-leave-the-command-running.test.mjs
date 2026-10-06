import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A command the user had already stopped went on running with nothing left
// holding it.
//
// The shell on this box does not belong to the host process. It belongs to the
// box exec daemon on `127.0.0.1:1337`, so a cancel has to cross an HTTP boundary
// before it can reach a pid:
//
//   `interruptAgentRun` -> `RunnerRegistry.interruptUserRun`
//     -> `SandAgentRunner.interruptAll` -> `TurnRunShell.interrupt`
//     -> `controller.abort()` -> the turn's `Context.signal`
//     -> `remote-box-resources.ts` -> `BoxRemoteExecManager.createExecInstance`
//     -> the Connect request, aborted
//     -> `box-exec-daemon/server.ts:1379` `runtime.execute(request, context.signal)`
//     -> `:780` `signal.addEventListener("abort", () => this.kill(child))`
//     -> `:1306` `killProcessTree(child.pid)` -> `taskkill /T /F`
//
// Every hop of that was already in place when this file was written. What was
// missing is the last way a stop can arrive, and it is the one with no abort in
// it at all.
//
// `BoxRemoteExecManager.createExecInstance` made the RPC with the caller's own
// `Context`, so the only thing that could ever close it was that same `Context`
// being aborted: the user pressing stop, or the controller of the turn. A
// consumer that stopped reading the stream did not abort it. JavaScript does run
// the `finally` of an abandoned `for await` loop, but nothing above that turned
// "no consumer left" into "the work can stop", so the Connect request stayed
// open, the daemon's `context.signal` never fired, and the command kept running.
//
// Nothing threw and nothing logged. The turn had already been reported as
// stopped, the shell tool had already returned, and the process doing the work
// was not a child of anything that could still see it.
//
// MEASURED on this machine before the fix, through the real host accessor, a
// real daemon on an ephemeral port and a real three-level tree (the shell, the
// `node` it started, and the `node` that one started):
//
//   the host stopped reading the exec stream, with no cancel and no abort
//   +1s / +5s / +10s   shell alive, middle alive, grandchild alive
//   the exec stream never ended, so the HTTP response stayed open as well
//
// And with the same harness driving the same chain the other two ways, which is
// what makes this a gap in one place rather than a broken cancel path:
//
//   the user pressed stop             tree gone at +1s, response closed ~0.6s
//   the daemon's own 1500 ms timeout  tree gone, response at ~1.66s
//
// The tests below therefore drive the daemon over the production client and the
// production accessor instead of calling `killProcessTree` directly. A test that
// only exercises the module cannot see a break anywhere above it, which is
// exactly how `tests/user-interrupt-run.test.mjs` passed for a whole session
// while the box leaked. The last test pins that difference: same daemon, same
// client, same transport, same resource accessor, with only the pre-fix
// `createExecInstance` body in place of the current one.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = relative => JSON.stringify(path.join(repoRoot, "source", ...relative));
const REQUIRE_BANNER = {
  js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
};

/**
 * The `BoxRemoteExecManager.createExecInstance` body as it was written before
 * the fix, verbatim. It is here so the counterexample differs from the product
 * in one expression and in nothing else.
 */
const PRE_FIX_MANAGER_BODY = `
import { BoxRemoteExecManager } from ${source(["host", "box", "box-remote-accessor.ts"])};

export class PreFixBoxRemoteExecManager extends BoxRemoteExecManager {
  #nextId = 0;
  constructor(client) { super(client); }

  async *createExecInstance(ctx, serialize) {
    for await (const message of this.client.exec(ctx, serialize(this.#nextId++))) {
      if (message.element.case === "execClientMessage") {
        yield message.element.value;
        continue;
      }
      if (message.element.case !== "execClientControlMessage") continue;
      const control = message.element.value;
      if (control.message.case !== "throw") continue;
      const thrown = control.message.value;
      const error = new Error(thrown.error);
      if (thrown.stackTrace != null && thrown.stackTrace.length > 0) {
        error.stack = thrown.stackTrace;
      }
      throw error;
    }
  }
}
`;

const PRODUCT_ENTRY = [
  `export { startBoxExecDaemon } from ${source(["box-exec-daemon", "server.ts"])};`,
  `export { productionBoxGeneratedPorts } from ${source(["host", "box", "generated-production.ts"])};`,
  `export { createBoxTransport, createBoxRemoteResourceAccessorFromTransport } from ${source(["host", "box", "box-remote-accessor.ts"])};`,
  `export { createRemoteBoxResourceAccessor } from ${source(["host", "runner", "remote-box-resources.ts"])};`,
  `export { shellStreamExecutorResource } from ${source(["packages", "agent-exec", "shell-stream.ts"])};`,
  `export { shellExecutorResource } from ${source(["packages", "agent-exec", "shell.ts"])};`,
  `export { createContext } from ${source(["packages", "context", "core.ts"])};`,
].join("\n");

/**
 * Two bundles on purpose: they carry independent module state, and one cache
 * could hand the falsification the product's own code.
 */
async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-boxexec-stream-"));
  const built = [];
  for (const [name, body] of entries) {
    const entryFile = path.join(directory, `${name}.ts`);
    const outfile = path.join(directory, `${name}.mjs`);
    writeFileSync(entryFile, body, "utf8");
    await build({
      entryPoints: [entryFile],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      mainFields: ["module", "main"],
      banner: REQUIRE_BANNER,
      logLevel: "silent",
    });
    built.push([name, outfile]);
  }
  const loaded = {};
  for (const [name, outfile] of built) loaded[name] = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const product = await bundle([["product", PRODUCT_ENTRY]]);
const preFix = await bundle([["prefix", PRE_FIX_MANAGER_BODY]]);
const {
  startBoxExecDaemon,
  productionBoxGeneratedPorts,
  createBoxTransport,
  createBoxRemoteResourceAccessorFromTransport,
  createRemoteBoxResourceAccessor,
  shellStreamExecutorResource,
  shellExecutorResource,
  createContext,
} = product.loaded.product;
const { PreFixBoxRemoteExecManager } = preFix.loaded.prefix;

test.after(() => {
  product.dispose();
  preFix.dispose();
});

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
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).ParentProcessId`],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  const value = Number(String(result.stdout ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));

async function waitFor(predicate, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const AUTH = "test-box-exec-stream-token";

/**
 * A real daemon, the real production exec client and the real host accessor,
 * wired the way `host/box/production.ts` and `host/runner/remote-box-resources.ts`
 * wire them, over loopback.
 *
 * `abandonStream` is the seam that matters: it makes the consumer walk away
 * mid-command without cancelling the turn, which is the state the defect is
 * about. `managerFor` exists so the last test can supply the pre-fix manager and
 * show this file measures the product and not a fixture of its own.
 */
async function withRunningCommand(run, { abandonStream = false, timeoutMs = 0, managerFor } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), "grok-boxexec-stream-work-"));
  const terminals = mkdtempSync(path.join(os.tmpdir(), "grok-boxexec-stream-term-"));
  const grandchildPidFile = path.join(work, "grandchild.pid");
  const middlePidFile = path.join(work, "middle.pid");
  // Three levels, because two cannot show the defect. `cmd.exe /c node x` replaces
  // its own image on Windows, so the shell and the first descendant share one pid;
  // the level below that is what makes the tree something to walk.
  const grandchildFile = path.join(work, "grandchild.cjs");
  const middleFile = path.join(work, "middle.cjs");
  writeFileSync(
    grandchildFile,
    `require("fs").writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));\nsetInterval(() => console.log("tick"), 200);\n`,
  );
  writeFileSync(
    middleFile,
    `require("fs").writeFileSync(${JSON.stringify(middlePidFile)}, String(process.pid));\n` +
      `require("child_process").spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: "ignore" });\n` +
      // Output matters: a command that says nothing produces no further stream
      // events, so a consumer waiting for one to walk away on would wait for a
      // command that never speaks. A real command streams.
      `setInterval(() => console.log("tick"), 200);\n`,
  );

  const daemon = await startBoxExecDaemon({
    host: "127.0.0.1",
    port: 0,
    authToken: AUTH,
    workspaceRoot: work,
    terminalsDirectory: terminals,
  });
  const transport = createBoxTransport(
    { host: daemon.host, port: daemon.port, authToken: AUTH },
    productionBoxGeneratedPorts.createTransport,
  );
  const remoteAccessor = managerFor === undefined
    ? createBoxRemoteResourceAccessorFromTransport(transport, {
        createExecClient: productionBoxGeneratedPorts.createExecClient,
        createResourceAccessor: productionBoxGeneratedPorts.createResourceAccessor,
      })
    : productionBoxGeneratedPorts.createResourceAccessor(managerFor(productionBoxGeneratedPorts.createExecClient(transport)));
  const connection = { terminalsFolder: terminals, remoteAccessor };
  const accessor = createRemoteBoxResourceAccessor({
    remoteBox: { status: "ready", hasDesktop: false },
    remoteBoxHasDesktop: false,
    preparedRemoteBoxConnection: Promise.resolve(connection),
    ensureReady: async () => connection,
    resolveBoxId: () => "test-box",
    getConversationId: () => "test-agent",
    setRemoteBoxTerminalsFolder: () => {},
    autoReviewGate: { assertNoPendingApproval: () => {}, currentModes: () => ({}) },
    auditShellCommand: () => {},
    computerUse: { getOrCreateNavigationProbe: () => undefined, recordAuditIntent: () => {} },
    probeNavigationAfterComputerUse: () => {},
  });

  const [turnContext, stopTheTurn] = createContext().withCancel();
  const executor = accessor.get(shellStreamExecutorResource);
  const args = { command: `node ${middleFile}`, workingDirectory: work, toolCallId: "call-1", timeout: timeoutMs };

  const seen = [];
  let consumerLeft = false;
  const consumed = (async () => {
    try {
      for await (const event of executor.execute(turnContext, args)) {
        seen.push(event.event.case);
        // The walk-away has to happen once the command is really running. The
        // `start` event arrives before the shell has spawned anything, and
        // abandoning there would prove a different thing: there would be no
        // tree left to leak.
        if (abandonStream && existsSync(grandchildPidFile)) {
          consumerLeft = true;
          break;
        }
      }
    } catch (error) {
      seen.push(`threw:${error?.name ?? "Error"}`);
    }
  })();

  const spawned = { shellPid: null, middlePid: null, grandchildPid: null };
  try {
    const reported = await waitFor(() => {
      if (!existsSync(grandchildPidFile)) return null;
      const pid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null;
      return pid;
    }, { timeoutMs: 40_000, what: "the daemon to report the command's own child pid" });
    spawned.grandchildPid = reported;
    spawned.middlePid = existsSync(middlePidFile) ? Number(readFileSync(middlePidFile, "utf8").trim()) : null;
    spawned.shellPid = parentPidOf(reported);

    return await run({
      ...spawned,
      seen,
      stopTheTurn,
      consumed,
      waitedForConsumerToLeave: () => consumerLeft,
    });
  } finally {
    // The tree is walked from the shell first, for the same reason the daemon
    // does it: a leaked grandchild inherits the pipe this test writes through,
    // and a test that merely waited on a stream would hang instead of failing.
    stopTheTurn();
    for (const pid of [spawned.shellPid, spawned.middlePid, spawned.grandchildPid]) {
      if (pid != null && alive(pid)) killTreeSync(pid);
    }
    await daemon.stop();
    rmSync(work, { recursive: true, force: true });
    rmSync(terminals, { recursive: true, force: true });
  }
}

test("the user pressing stop kills the whole tree the command started and closes the response", { timeoutMs: 120_000 }, async () => {
  await withRunningCommand(async ({ stopTheTurn, consumed, shellPid, middlePid, grandchildPid }) => {
    assert.equal(alive(shellPid), true, "the shell is not running, so the stop below would prove nothing");
    assert.equal(alive(grandchildPid), true, "the command's own child is not running, so nothing below the shell could show that the tree was walked");

    // This is the user's stop, at the end of the chain: `RunnerRegistry
    // .interruptUserRun` finishes at `controller.abort()`.
    stopTheTurn({ intentional: true, reason: "the user pressed stop" });

    await waitFor(() => !alive(grandchildPid), {
      timeoutMs: 20_000,
      what: "the process the command started to be gone",
    });
    assert.equal(
      alive(grandchildPid),
      false,
      `the turn was stopped and the daemon was never told: pid ${grandchildPid}, two levels below the shell, is still running after the abort`,
    );
    assert.equal(alive(middlePid), false, `pid ${middlePid} outlived the abort of the turn that started it`);
    await waitFor(() => !alive(shellPid), { timeoutMs: 20_000, what: "the shell itself to be gone" });

    const settled = await Promise.race([consumed.then(() => "closed"), sleep(15_000).then(() => "held open")]);
    assert.equal(settled, "closed", "the exec stream never ended after the stop, so a response is held open for a command that no longer exists");
  });
});

test("the daemon's own timeout kills the whole tree instead of waiting for the orphan to exit", { timeoutMs: 120_000 }, async () => {
  await withRunningCommand(
    async ({ consumed, shellPid, middlePid, grandchildPid }) => {
      assert.equal(alive(grandchildPid), true, "the command's own child is not running, so the timeout below would prove nothing");

      // No cancel and no abort: only the daemon's own timer. With a single-pid
      // kill the orphan inherited the child's stdout pipe, so node never emitted
      // `close` and the response arrived when the orphan chose to leave rather
      // than when the timeout fired. Measured on this machine: 19 998 ms for a
      // 1500 ms timeout before the tree walk, about 1.66 s after it.
      const settled = await Promise.race([consumed.then(() => "closed"), sleep(25_000).then(() => "held open")]);
      assert.equal(settled, "closed", "a command that left a server running kept its response open past its own timeout");

      assert.equal(alive(grandchildPid), false, `the daemon's timeout fired but pid ${grandchildPid} is still running, so the timeout killed one pid and not the tree`);
      assert.equal(alive(middlePid), false, `pid ${middlePid} survived the timeout that was supposed to end the command`);
      assert.equal(alive(shellPid), false, "the shell outlived its own timeout");
    },
    { timeoutMs: 1500 },
  );
});

test("a stream the host stopped reading takes the command's whole tree down with it", { timeoutMs: 120_000 }, async () => {
  await withRunningCommand(
    async ({ seen, consumed, waitedForConsumerToLeave, shellPid, middlePid, grandchildPid }) => {
      assert.equal(alive(grandchildPid), true, "the command's own child is not running, so nothing below the shell would show what this proves");

      // The consumer walked away in the harness, and the turn context was never
      // cancelled: that is the state under test, and it is the only difference
      // between this and the stop test above.
      await Promise.race([consumed, sleep(15_000)]);
      assert.equal(waitedForConsumerToLeave(), true, `the harness never left the stream, so this ran as a normal command (${JSON.stringify(seen)})`);

      await waitFor(() => !alive(grandchildPid), {
        timeoutMs: 20_000,
        what: "an abandoned exec stream to still take the command's tree down",
      });
      assert.equal(
        alive(grandchildPid),
        false,
        `nothing was cancelled and nobody was reading the stream any more, yet pid ${grandchildPid} is still running: the daemon was never told, and the work has no holder left`,
      );
      assert.equal(alive(middlePid), false, `pid ${middlePid} survived the stream its only consumer walked away from`);
      assert.equal(alive(shellPid), false, "the shell outlived the stream nothing was reading");
    },
    { abandonStream: true },
  );
});

test("the same chain without the per-call cancel is what leaks, so the fix is the whole difference", { timeoutMs: 120_000 }, async () => {
  await withRunningCommand(
    async ({ consumed, waitedForConsumerToLeave, grandchildPid }) => {
      assert.equal(alive(grandchildPid), true, "the command's own child is not running, so this counterexample cannot show a leak");

      await Promise.race([consumed, sleep(15_000)]);
      assert.equal(waitedForConsumerToLeave(), true, "the harness never left the stream, so the counterexample did not reach the state it is about");

      // Bounded on purpose: this is the counterexample, not the product path.
      // Ten seconds is far longer than `taskkill /T` needs.
      await sleep(10_000);

      assert.equal(
        alive(grandchildPid),
        true,
        "the pre-fix manager did not leak: a host that stops reading the exec stream still ended up with no command running, so the diagnosis in the comment above is wrong and the product fix is measuring nothing",
      );
    },
    { abandonStream: true, managerFor: client => new PreFixBoxRemoteExecManager(client) },
  );
});