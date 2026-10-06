import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Quitting the app while a turn was running left `%LOCALAPPDATA%\GrokBotLocalBox\gateway.json`
// naming a host that no longer existed. That file is the desktop's only way to
// find the box: `port`, `pid`, `startedAt` and the bearer token. A stale one
// describes a server that answered 1.5 minutes ago, and the desktop reads it at
// startup, long before anything could correct it.
//
// Two paths leave it behind, and both are ordinary:
//
//  1. the shutdown watchdog. `SHUTDOWN_WATCHDOG_MS` is 5 s, and `host.dispose()`
//     waits for in-flight work - a running turn, a live shell - so a quit during
//     a turn hits the watchdog. The watchdog releases the lock and exits 1. It
//     never clears the discovery file, so the descriptor of the process that just
//     died stays on disk pointing at its pid.
//  2. a `box-exec-daemon` that refuses to stop cleanly. `close()` throws
//     "box exec-daemon shutdown left 127.0.0.1:1337 bound" or "required forced
//     shutdown" by design, and `clearGatewayDiscovery()` sits AFTER that call
//     inside the same `try`, so the throw skips it. The catch reports the error
//     and the finally still exits 0 - the process claims a clean shutdown while
//     leaving its own descriptor behind.
//
// Clearing the descriptor is the one step that cannot be skipped: it is the last
// thing that makes the box un-discoverable, and every later start overwrites it.
// The tests below drive the real `installShutdownHandlers` on both paths.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOST_GRAPH_STUB = `
export const installInvariantReporter = () => {};
export const gatewayScheme = () => "http";
export const resolveGatewayServerConfig = () => ({ host: "127.0.0.1" });
export const startGatewayServer = async () => ({ port: 0, close: async () => {} });
export const clearGatewayDiscovery = async () => {};
export const writeGatewayDiscovery = async () => {};
export const pinHostDiagnosticsReporter = () => {};
export const acquireHostLock = async () => { throw new Error("stubbed"); };
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

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-shutdown-descriptor-"));
const stubPath = path.join(directory, "host-graph-stub.js");
writeFileSync(stubPath, HOST_GRAPH_STUB);
const outfile = path.join(directory, "main.mjs");
await build({
  entryPoints: [path.join(repoRoot, "source", "host", "main.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  plugins: [stubHostGraph(stubPath)],
  logLevel: "silent",
});
const { installShutdownHandlers } = await import(pathToFileURL(outfile).href);
test.after(() => rmSync(directory, { recursive: true, force: true }));

function makeHost(dispose) {
  const host = {
    calls: [],
    reportProcessCrash(error, kind) { host.calls.push(`crash:${kind}`); },
    async flushTelemetryForFatalExit() { host.calls.push("flush"); },
    dispose: dispose ?? (async () => {}),
  };
  return host;
}

/** A control that records the signals it was asked to listen for, so the test can fire one. */
function makeSignalControl() {
  const listeners = {};
  const exits = [];
  return {
    exits,
    control: {
      argv: [],
      pid: 4242,
      on(signal, listener) { (listeners[signal] ??= []).push(listener); },
      exit(code) { exits.push(code); },
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60));

test("a quit during a running turn still removes the descriptor it published", async () => {
  // `host.dispose()` never resolves: that is what a turn in flight looks like to
  // the shutdown path, and it is what trips the 5 s watchdog. The watchdog is
  // scaled down to 20 ms here so the test does not wait five seconds for it.
  const cleared = [];
  const host = makeHost(() => new Promise(() => {}));
  const signal = makeSignalControl();
  const registration = installShutdownHandlers(
    host,
    { close: async () => {} },
    { release() {} },
    async () => { cleared.push("cleared"); },
    signal.control,
    { log() {}, error() {} },
    20,
    undefined,
  );

  registration.shutdown("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 120));

  assert.equal(
    cleared.length > 0,
    true,
    "the watchdog path exited the process without clearing gateway.json, so the desktop found a descriptor naming a pid that had just died",
  );
  assert.equal(signal.exits.at(-1), 1, "the watchdog no longer ends the process with the code it always used, so the exit contract moved under this fix");
});

test("a box exec-daemon that refuses to stop still removes the descriptor", async () => {
  // `close()` throws by design when the daemon leaves 1337 bound, and that is a
  // shutdown path the product already handles - it reports the crash and still
  // exits 0. What it did not do was clear the descriptor on the way out.
  const cleared = [];
  const host = makeHost();
  const signal = makeSignalControl();
  const registration = installShutdownHandlers(
    host,
    { close: async () => {} },
    { release() {} },
    async () => { cleared.push("cleared"); },
    signal.control,
    { log() {}, error() {} },
    5_000,
    { pid: 1, entryPath: "", ready: Promise.resolve(), close: async () => { throw new Error("box exec-daemon shutdown left 127.0.0.1:1337 bound"); } },
  );

  registration.shutdown("SIGTERM");
  await settle();

  assert.equal(
    cleared.length,
    1,
    "a box exec-daemon that would not stop left gateway.json behind, so the next desktop start found the descriptor of a host that had already exited 0",
  );
  assert.deepEqual(
    host.calls,
    ["crash:shutdown_error", "flush"],
    "the refusal was reported before the descriptor was cleared, so the order the operator reads in a log is the order the code ran",
  );
});

test("an ordinary quit clears the descriptor exactly once", async () => {
  // The control for the two tests above: nothing throws, nothing times out. If
  // this one clears twice, the fix is a bug rather than a repair.
  const cleared = [];
  const signal = makeSignalControl();
  const registration = installShutdownHandlers(
    makeHost(),
    { close: async () => {} },
    { release() {} },
    async () => { cleared.push("cleared"); },
    signal.control,
    { log() {}, error() {} },
    5_000,
    { pid: 1, entryPath: "", ready: Promise.resolve(), close: async () => {} },
  );

  registration.shutdown("SIGTERM");
  registration.shutdown("SIGTERM");
  await settle();

  assert.deepEqual(cleared, ["cleared"], "a clean quit cleared the descriptor a number of times other than once");
});