import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `main()` in `source/host/main.ts` took the sandbox lock and built the host
// OUTSIDE its only try/catch. `acquireHostLock` writes this process's own pid
// into `<root>\host.lock`; if `createHost` then threw, nothing released that
// handle and the promise rejected, so the process died on an unhandled
// rejection with no `[sand-host]` line, no `reportProcessCrash`, and
// `host.lock` left naming a pid that no longer exists. The launcher papers over
// this for its own start path (`Remove-Item host.lock` at start-grokbot.ps1:211)
// which is exactly why it went unnoticed; a direct `node host-main.cjs` start
// has no such paper. A lock naming a dead pid also makes `probeLegacyHost`
// read the root as free while `readdir` still lists `host.lock`, so the desktop
// settles a data root the host still owns.
//
// The tests below drive the real `main()` with the real `acquireHostLock` over
// a `mkdtemp` root and assert the obligation directly: once a startup attempt
// has ended in failure, `host.lock` names no pid at all, and the failure was
// reported rather than thrown into an unhandled rejection.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `main()` reaches every collaborator through `deps`, which this test supplies.
// The module's own imports build the production graph, which drags in ~1300
// modules and several CommonJS packages that only `createProductionHostMainDependencies`
// ever touches. They are stubbed so the test exercises the startup control flow
// and nothing else; `node:` specifiers are deliberately not matched, so the real
// `path` still comes from Node.
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

const stubHostGraph = (stubPath) => ({
  name: "stub-host-graph",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, args =>
      args.kind === "entry-point" ? null : { path: stubPath });
  },
});

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-host-zombie-"));
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
      // Only main.ts is stubbed. host-lock.ts is bundled whole, because these
      // tests assert against the real lock file it writes.
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
  ["host", "host-lock.ts"],
]);
const { main } = loaded["main.mjs"];
const { acquireHostLock } = loaded["host-lock.mjs"];

test.after(() => dispose());

/** A pid above any real one, so `isAlive` is only ever told what the test says. */
const HOST_PID = 424_242;

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-sandbox-root-"));
  return { root, lockPath: path.join(root, "host.lock") };
}

function makeLockAcquirer(lockPath) {
  return () => acquireHostLock({ path: lockPath, pid: HOST_PID, isProcessAlive: () => true });
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
    reportProcessCrash() { host.calls.push("reportProcessCrash"); },
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
    createHost: overrides.createHost,
    resolveGatewayServerConfig: () => ({ host: "127.0.0.1" }),
    gatewayScheme: () => "http",
    async startGatewayServer() { throw new Error("the gateway must not start in these tests"); },
    async writeGatewayDiscovery() {},
    async clearGatewayDiscovery() {},
    log: { log() {}, error() {} },
    ...overrides.deps,
  };
}

function makeProcessControl() {
  const exits = [];
  return {
    exits,
    control: {
      argv: [],
      pid: HOST_PID,
      on() {},
      exit: code => exits.push(code),
    },
  };
}

function readLockPid(lockPath) {
  if (!existsSync(lockPath)) return null;
  const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  return Number.isInteger(pid) ? pid : Number.NaN;
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

test("a host that cannot be built leaves no lock naming a pid that is gone", async () => {
  const { root, lockPath } = makeRoot();
  const lockTaken = makeLockAcquirer(lockPath);
  const processExit = makeProcessControl();

  const rejected = await runMain(
    makeDeps({
      sandRoot: root,
      acquireHostLock: lockTaken,
      createHost: () => { throw new Error("the agent store could not be opened"); },
      deps: { acquireHostLock: lockTaken },
    }),
    processExit.control,
  );

  assert.equal(rejected, null, "main() rejected instead of handling the failure, so the host died on an unhandled rejection with no report");
  assert.deepEqual(processExit.exits, [1], "a failed startup must leave the process with a defined exit code, not a running promise");
  assert.equal(
    readLockPid(lockPath),
    null,
    `host.lock still names pid ${readLockPid(lockPath)}, which is a pid that is gone; the next start reads that as a lock nobody holds`,
  );
});

test("a lock that cannot be taken fails the startup instead of rejecting", async () => {
  const { root, lockPath } = makeRoot();
  const processExit = makeProcessControl();
  const reported = [];

  const rejected = await runMain(
    makeDeps({
      sandRoot: root,
      acquireHostLock: async () => { throw new Error("the sandbox root is not writable"); },
      createHost: () => makeHost(),
      deps: {
        acquireHostLock: async () => { throw new Error("the sandbox root is not writable"); },
        log: { log() {}, error: (...args) => reported.push(args.map(String).join(" ")) },
      },
    }),
    processExit.control,
  );

  assert.equal(rejected, null, "main() rejected instead of handling the failure, so a refused lock killed the process with nothing on stderr");
  assert.deepEqual(processExit.exits, [1], "a refused lock must end the process with a defined exit code");
  assert.ok(
    reported.some(line => line.includes("sandbox root is not writable")),
    "the reason the lock was refused never reached the log, so the operator sees a dead box with no cause",
  );
  assert.equal(readLockPid(lockPath), null, "a lock file was left behind by a startup that never took one");
});

test("the next start takes the lock cleanly instead of evicting a host that is already gone", async () => {
  const { root, lockPath } = makeRoot();
  const lockTaken = makeLockAcquirer(lockPath);
  const failed = makeProcessControl();

  await runMain(
    makeDeps({
      sandRoot: root,
      createHost: () => { throw new Error("the agent store could not be opened"); },
      deps: { acquireHostLock: lockTaken },
    }),
    failed.control,
  );

  // The next launch, as the packaged entry does it. Every probe here answers
  // "yes, alive" and "yes, that is a host", which is the friendliest possible
  // reading: a lock left by the failed start then looks like a live host that
  // has to be evicted. `terminateProcess` is stubbed so this test can never
  // signal a real process.
  const next = await acquireHostLock({
    path: lockPath,
    pid: HOST_PID + 1,
    isProcessAlive: () => true,
    isSandHostProcess: () => true,
    terminateProcess: () => {},
    takeoverTimeoutMs: 1,
    pollIntervalMs: 1,
  });
  assert.equal(
    next.outcome,
    "created",
    `the next start had to ${next.outcome} the lock instead of taking it, because the failed start left a pid behind that still reads as a live host`,
  );
  next.lock.release();
  assert.equal(readLockPid(lockPath), null, "a healthy shutdown does not remove host.lock, so the lock outlives every host");
});

test("a host that fails after it started still releases the lock", async () => {
  const { root, lockPath } = makeRoot();
  const lockTaken = makeLockAcquirer(lockPath);
  const host = makeHost();
  host.start = async () => { throw new Error("the box exec daemon never answered"); };
  const processExit = makeProcessControl();

  const rejected = await runMain(
    makeDeps({
      sandRoot: root,
      createHost: () => host,
      deps: { acquireHostLock: lockTaken },
    }),
    processExit.control,
  );

  assert.equal(rejected, null, "a failed startup rejected instead of reporting and exiting");
  assert.equal(readLockPid(lockPath), null, "the catch block that already existed did not release the lock, so this fix is what keeps it that way");
  assert.ok(host.calls.includes("reportProcessCrash"), "a failed startup never told the telemetry, so the crash was invisible");
});
