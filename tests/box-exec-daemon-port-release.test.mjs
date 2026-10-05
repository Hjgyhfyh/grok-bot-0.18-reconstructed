import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Launching the app a second time killed the app that was running and started
// nothing in its place, so the user was left with no app at all. The cause was
// a race, not a refusal: `main()` takes the sandbox lock first, and on the
// outcome "took-over" that lock SIGTERMs - then SIGKILLs - the live host. The
// OS releases that host's exec-daemon listening socket only when the process
// has actually exited, which is later than the moment `process.kill` returns.
// The new host then probed the port, read "already bound", and printed
// `refusing contaminated box exec-daemon startup: 127.0.0.1:1337 is already
// bound` - a message that was no longer true by the time it was written, and
// that named no process, so the operator could not tell a dying predecessor
// from a foreign listener. Three live runs agreed: the health probe went to
// `alive=False` 1 s after the second start and never recovered, the daemon died
// with its host rather than lingering, and an external probe already saw 1337
// free while the new host still refused it.
//
// The fix waits a bounded, narrow time for the predecessor's port AFTER the
// eviction and BEFORE the daemon start, and names the pid that holds the port
// when that wait runs out. The tests below drive the real `main()` and the real
// port helpers against a real child process that binds an ephemeral port and
// releases it late, so the race is reproduced rather than described.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `main()` reaches every collaborator through `deps`, which these tests supply.
// The production composition drags in ~1300 modules and several CommonJS
// packages that only `createProductionHostMainDependencies` ever touches, so
// they are stubbed. The stub exports exactly the names `main.ts` imports; a new
// named import there would not link against it. `node:` specifiers are
// deliberately not matched, so the real `path` and `node:fs/promises` still come
// from Node.
const HOST_GRAPH_STUB = `
export const installInvariantReporter = () => {};
export const gatewayScheme = () => "http";
export const resolveGatewayServerConfig = () => ({ host: "127.0.0.1" });
export const startGatewayServer = async () => ({ port: 0, close: async () => {} });
export const clearGatewayDiscovery = async () => {};
export const writeGatewayDiscovery = async () => {};
export const pinHostDiagnosticsReporter = () => {};
export const acquireHostLock = async () => { throw new Error("stubbed: main() must reach the lock only through deps"); };
export const getSandRootDir = () => "";
export const installProcessCrashGuards = () => ({ setReporter() {} });
export const createProductionSandHost = () => { throw new Error("stubbed"); };
export const resolveBoxExecDaemonEntry = () => "";
export const startBoxExecDaemonProcess = async () => { throw new Error("stubbed"); };
export default {};
`;

const stubHostGraph = stubPath => ({
  name: "stub-host-graph",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, args =>
      args.kind === "entry-point" ? null : { path: stubPath });
  },
});

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-port-release-"));
  const stubPath = path.join(directory, "host-graph-stub.js");
  writeFileSync(stubPath, HOST_GRAPH_STUB);
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
      // Only main.ts is stubbed. The box helpers are bundled whole, because the
      // whole point of these tests is that the real probes run.
      ...(entry.includes("main.ts") ? { plugins: [stubHostGraph(stubPath)] } : {}),
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "main.ts"],
  ["host", "box", "exec-daemon-process.ts"],
]);
const { main } = loaded["main.mjs"];
const {
  BoxExecDaemonPortHeldError,
  BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS,
  readPortHolderPids,
  resolveBoxExecDaemonPortReleaseBudget,
  waitForBoxExecDaemonPortRelease,
} = loaded["exec-daemon-process.mjs"];

test.after(() => dispose());

/** A pid above any real one, so nothing here can signal a process that matters. */
const PREVIOUS_HOST_PID = 424_242;

const workDir = mkdtempSync(path.join(os.tmpdir(), "grok-box-port-release-work-"));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

const holderScript = path.join(workDir, "port-holder.cjs");
writeFileSync(holderScript, `
const net = require("node:net");
const fs = require("node:fs");
const [portFile, holdMs] = process.argv.slice(2);
const server = net.createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
setTimeout(() => { server.close(); process.exit(0); }, Number(holdMs));
`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let holderCounter = 0;

/**
 * Binds an ephemeral port in a real child process and holds it for `holdMs`.
 *
 * The port comes from the child rather than from a port this test picked and
 * released, because that gap is itself a race: a port freed and re-picked is
 * exactly the kind of window these tests are about.
 */
async function startPortHolder(holdMs) {
  holderCounter += 1;
  const portFile = path.join(workDir, `holder-${holderCounter}.port`);
  const child = spawn(process.execPath, [holderScript, portFile, String(holdMs)], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  // Ceiling on the poll: a holder that never binds must fail the test, not hang
  // it. Without this the suite waits forever and reports nothing.
  const deadline = Date.now() + 15_000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("the port holder never reported a port");
    await sleep(20);
  }
  return {
    port: Number.parseInt(readFileSync(portFile, "utf8").trim(), 10),
    pid: child.pid,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}

function makeHost() {
  const host = {
    startedAt: 1,
    calls: [],
    async start() { host.calls.push("start"); },
    async dispose() {},
    getApi() { return {}; },
    subscribe() { return () => {}; },
    getHealth() { return { isBusy: false }; },
    noteEventStreamClosed() {},
    noteDesktopContact() {},
    async prepareForUpgrade() { return {}; },
    getLocalExecBridge() { return undefined; },
    getWebAuthnBridge() { return undefined; },
    reportProcessCrash(error) { host.calls.push(`reportProcessCrash:${error?.message ?? error}`); },
    reportInvariantViolation() {},
    reportHostDiagnostic() {},
    reportGatewayCommandError() {},
    reportGatewayCommandSuccess() {},
    async flushTelemetryForFatalExit() {},
    async reportBoxReady() {},
  };
  return host;
}

function makeDeps(overrides) {
  return {
    executeBoxCopyInFromEnv: async () => 0,
    installProcessCrashGuards: () => ({ setReporter() {} }),
    installInvariantReporter() {},
    pinHostDiagnosticsReporter() {},
    getSandRootDir: () => overrides.sandRoot,
    createHost: overrides.createHost ?? (() => makeHost()),
    resolveGatewayServerConfig: () => ({ host: "127.0.0.1" }),
    gatewayScheme: () => "http",
    async startGatewayServer() { overrides.onGatewayStarted(); return { port: 0, close: async () => {} }; },
    async writeGatewayDiscovery() { overrides.onDiscoveryWritten(); },
    async clearGatewayDiscovery() {},
    log: { log() {}, error: (...args) => overrides.onError(args.map(String).join(" ")) },
    ...overrides.deps,
  };
}

function makeProcessControl() {
  const exits = [];
  return {
    exits,
    control: { argv: [], pid: PREVIOUS_HOST_PID, on() {}, exit: code => exits.push(code) },
  };
}

function noop() {}

/**
 * The production wiring of the daemon start, reduced to its two decisions.
 *
 * `resolveBoxExecDaemonPortReleaseBudget` and `waitForBoxExecDaemonPortRelease`
 * are the real functions the real `startBoxExecDaemonProcess` calls, in the
 * same order. Only the spawn and the gRPC handshake are left out, because they
 * need the packaged bundle. Everything between the eviction and the refusal is
 * the code under test.
 */
async function startBoxExecDaemonAsProduction(previousHost, port) {
  const budget = resolveBoxExecDaemonPortReleaseBudget(previousHost);
  const release = await waitForBoxExecDaemonPortRelease({
    port,
    timeoutMs: budget.timeoutMs,
    previousHostPid: budget.previousHostPid,
  });
  if (!release.released) {
    throw new BoxExecDaemonPortHeldError(`127.0.0.1:${port}`, release.holderPid, budget.previousHostPid);
  }
  // Shaped like the real `OwnedBoxExecDaemon`, because `main()` closes it on
  // both the shutdown path and the fatal-startup path. The measured release is
  // hung off it so the test can read what the wait actually spent.
  return { pid: 0, entryPath: "", ready: Promise.resolve(), close: async () => {}, budget, release };
}

async function runMain(deps, processControl) {
  let rejected = null;
  try {
    await main(deps, processControl);
  } catch (error) {
    rejected = error ?? new Error("main() rejected with no error");
  }
  return rejected;
}

test("a host that took over a live host waits for the evicted host's port instead of refusing it", async () => {
  const holder = await startPortHolder(1_200);
  const errors = [];
  let gatewayStarted = false;
  let observedPreviousHost;
  let observedDaemon;
  const processExit = makeProcessControl();

  try {
    const rejected = await runMain(
      makeDeps({
        sandRoot: workDir,
        onGatewayStarted: () => { gatewayStarted = true; },
        onDiscoveryWritten: noop,
        onError: line => errors.push(line),
        deps: {
          acquireHostLock: async () => ({
            outcome: "took-over",
            previousPid: PREVIOUS_HOST_PID,
            lock: { release() {} },
          }),
          startBoxExecDaemon: async previousHost => {
            observedPreviousHost = previousHost;
            observedDaemon = await startBoxExecDaemonAsProduction(previousHost, holder.port);
            return observedDaemon;
          },
        },
      }),
      processExit.control,
    );

    assert.equal(rejected, null, "the takeover start rejected instead of serving, so the double launch still ended with no app");
    assert.deepEqual(processExit.exits, [], "the new host exited, so the app the user just killed was never replaced");
    assert.equal(gatewayStarted, true, "the gateway never started, so the takeover ended before anything was listening");
    assert.equal(observedPreviousHost?.outcome, "took-over", "the daemon start never learned that a live host was evicted, so it could not wait out the release");
    assert.equal(observedPreviousHost?.previousPid, PREVIOUS_HOST_PID, "the evicted pid never reached the daemon start, so the wait could not name who held the port");
    assert.ok(
      observedPreviousHost && resolveBoxExecDaemonPortReleaseBudget(observedPreviousHost).timeoutMs > 0,
      "a takeover still resolves to a zero wait budget, which is the race this test reproduces",
    );
    assert.ok(
      observedDaemon?.release?.released,
      "the port was never released, so this run only proves the wait did not help",
    );
    assert.ok(
      observedDaemon.release.waitedMs >= 600,
      `the wait returned after ${observedDaemon.release.waitedMs}ms although the holder keeps the port for 1200ms, so the host refused at its first probe instead of waiting for the OS`,
    );
  } finally {
    await holder.stop();
  }
});

test("the same race without the takeover signal ends the host with no app to fall back on", async () => {
  // The control for the test above: identical port, identical late release,
  // identical production helpers. The only difference is the lock outcome, so
  // the only thing standing between the two runs is the wait that a takeover
  // turns on. A first start that loses this race is a bug; a start that just
  // evicted the running host must not be one.
  const holder = await startPortHolder(1_200);
  const errors = [];
  let gatewayStarted = false;
  const processExit = makeProcessControl();

  try {
    const rejected = await runMain(
      makeDeps({
        sandRoot: workDir,
        onGatewayStarted: () => { gatewayStarted = true; },
        onDiscoveryWritten: noop,
        onError: line => errors.push(line),
        deps: {
          acquireHostLock: async () => ({
            outcome: "reclaimed-dead",
            previousPid: PREVIOUS_HOST_PID,
            lock: { release() {} },
          }),
          startBoxExecDaemon: previousHost => startBoxExecDaemonAsProduction(previousHost, holder.port),
        },
      }),
      processExit.control,
    );

    assert.equal(rejected, null, "main() rejected rather than reporting the refusal");
    assert.deepEqual(processExit.exits, [1], "an unresolved port did not end the process with a defined exit code");
    assert.equal(gatewayStarted, false, "the gateway started although the port the daemon needs was never free");
    assert.ok(
      errors.some(line => line.includes("already bound")),
      `the refusal never reached the log, so the operator sees a dead app with no cause. Log was: ${JSON.stringify(errors)}`,
    );
  } finally {
    await holder.stop();
  }
});

test("a listener that never leaves is refused by pid and is left running", async () => {
  const holder = await startPortHolder(120_000);
  try {
    const release = await waitForBoxExecDaemonPortRelease({
      port: holder.port,
      timeoutMs: 400,
      pollMs: 100,
      previousHostPid: PREVIOUS_HOST_PID,
    });

    assert.equal(release.released, false, "a port held for longer than the wait was reported as released");
    assert.ok(
      release.waitedMs <= 5_000,
      `the wait ran for ${release.waitedMs}ms, so it is not bounded and a foreign listener becomes a hang instead of a refusal`,
    );

    let thrown = null;
    try {
      if (!release.released) {
        throw new BoxExecDaemonPortHeldError(`127.0.0.1:${holder.port}`, release.holderPid, PREVIOUS_HOST_PID);
      }
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof BoxExecDaemonPortHeldError, "an unresolved port was not reported as a port-held refusal");
    assert.equal(thrown.holderPid, holder.pid, "the refusal names no pid, so the operator cannot tell a predecessor from a foreign program");
    assert.ok(
      thrown.message.includes(`pid ${holder.pid}`),
      `the pid is missing from the message the operator reads. Message was: ${thrown.message}`,
    );
    assert.equal(
      holder.exited === undefined,
      false,
      "this test proves nothing unless the holder was still a live process when it was refused",
    );
    process.kill(holder.pid, 0);
  } finally {
    await holder.stop();
  }
});

test("a port nobody holds is probed once and costs no waiting", async () => {
  const release = await waitForBoxExecDaemonPortRelease({ port: 1, timeoutMs: 5_000 });
  assert.equal(release.released, true, "a free port was reported as held, so every start pays the full release wait");
  assert.equal(release.waitedMs, 0, "a free port made this host sleep before it started, so the wait is on the path of every launch");
});

test("the pid holding the port is read from the running system, not guessed", async () => {
  const holder = await startPortHolder(30_000);
  try {
    const pids = readPortHolderPids(holder.port, process.platform);
    assert.ok(
      pids.includes(holder.pid),
      `the port-holder pid ${holder.pid} was not among ${JSON.stringify(pids)}, so a refusal would name the wrong process or none at all`,
    );
    assert.deepEqual(
      readPortHolderPids(1, process.platform),
      [],
      "a port with no listener reported a holder, so the lookup invents a culprit",
    );
  } finally {
    await holder.stop();
  }
});

test("a startup failure on this host's own account never reaches the running host", async () => {
  const errors = [];
  let lockAsked = false;
  const processExit = makeProcessControl();

  const rejected = await runMain(
    makeDeps({
      sandRoot: workDir,
      onGatewayStarted: noop,
      onDiscoveryWritten: noop,
      onError: line => errors.push(line),
      deps: {
        preflight: async () => { throw new Error("the box exec-daemon bundle is missing"); },
        acquireHostLock: async () => {
          lockAsked = true;
          return { outcome: "created", lock: { release() {} } };
        },
      },
    }),
    processExit.control,
  );

  assert.equal(rejected, null, "a preflight failure rejected instead of refusing the start");
  assert.equal(lockAsked, false, "the sandbox lock was taken even though this host was already known to be unable to start, so the app that was running was killed for nothing");
  assert.deepEqual(processExit.exits, [1], "a refused start must still end the process with a defined exit code");
  assert.ok(
    errors.some(line => line.includes("box exec-daemon bundle is missing")),
    `the reason never reached the log, so the operator cannot act on it. Log was: ${JSON.stringify(errors)}`,
  );
});

test("the gateway configuration is settled once, before the eviction", async () => {
  let resolveCalls = 0;
  let lockAsked = false;
  const gatewayConfig = { host: "127.0.0.1", port: 4242, authToken: "pinned" };
  const processExit = makeProcessControl();

  const rejected = await runMain(
    makeDeps({
      sandRoot: workDir,
      onGatewayStarted: noop,
      onDiscoveryWritten: noop,
      onError: noop,
      deps: {
        preflight: async () => {
          assert.equal(lockAsked, false, "the preflight ran after the eviction, so it no longer protects the running host");
          resolveCalls += 1;
          return { gatewayConfig, gatewayScheme: "http" };
        },
        acquireHostLock: async () => {
          lockAsked = true;
          return { outcome: "created", lock: { release() {} } };
        },
        resolveGatewayServerConfig: () => { resolveCalls += 1; return { host: "127.0.0.1", authToken: "regenerated" }; },
      },
    }),
    processExit.control,
  );

  assert.equal(rejected, null, "the start rejected on a host that passed its preflight");
  assert.equal(resolveCalls, 1, "the gateway configuration was resolved more than once, so the token written to gateway.json may describe a configuration this host never served");
  assert.deepEqual(processExit.exits, [], "a host that passed its preflight exited");
});

test("only a takeover buys the wait, and it buys a bounded one", () => {
  assert.ok(
    BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS > 0 && BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS <= 30_000,
    `the release wait is ${BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS}ms, which either does not cover the eviction or turns a squatter into a hang`,
  );
  assert.equal(
    resolveBoxExecDaemonPortReleaseBudget({ outcome: "took-over", previousPid: 11 }).timeoutMs,
    BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS,
    "a takeover still waits zero, which is the reported race",
  );
  assert.equal(
    resolveBoxExecDaemonPortReleaseBudget({ outcome: "created" }).timeoutMs,
    0,
    "a first start waits for a port nothing of ours could have left behind, so every cold launch pays a delay",
  );
  assert.equal(
    resolveBoxExecDaemonPortReleaseBudget(undefined).timeoutMs,
    0,
    "a caller that knows nothing about the previous host is charged the takeover wait",
  );
  assert.equal(
    resolveBoxExecDaemonPortReleaseBudget({ outcome: "took-over", previousPid: 11 }).previousHostPid,
    11,
    "the evicted pid is lost, so the refusal cannot tell a predecessor from a foreign listener",
  );
});
