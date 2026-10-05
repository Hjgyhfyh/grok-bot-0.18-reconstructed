import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * A connection that closed on its own was reported to the user as a connection
 * failure, and the user was told to check their own connection for something
 * they had not done wrong. The report named
 * `source/host/box/reconnection-policy.ts` as the site; that file has never
 * existed in this repository — not in `HEAD`, not in any commit, and not in the
 * working tree — and it carries no policy at all. The behaviour the report
 * describes was already handled, in two files it never pointed at.
 *
 * `GatewaySseClient.streamEvents` initialises `down` to
 * `{ reason: "stream-ended", cause: null }` before it reads a single byte, and
 * the only statement that replaces `down` sits inside a `catch` block, so a
 * stream that ends with `done` — the server closing a connection the user has
 * no part in — reports `stream-ended` and nothing else. `classifyStreamDown` is
 * reached only from that `catch`, which is why it is never handed the absence
 * of an error and never invents a fault from nothing.
 *
 * WHY NOTHING NOTICED, AND WHY A NEW TEST WAS STILL WORTH WRITING. The neutral
 * case and the fault case are told apart downstream in
 * `transport-stream-telemetry.ts`, which keeps two disjoint lists: reasons that
 * describe a lifecycle transition, and reasons that describe a failure. A clean
 * close lands in the first list, is emitted at level `info`, and carries no
 * registered transport error code at all. The same list would have hidden a real
 * fault too, so these tests prove both halves at once: a clean close raises
 * nothing, and a real fault still raises its code.
 *
 * The demand behind the report was "do not blame the user where the cause is
 * not them, but do not swallow a real failure either". These tests now hold both
 * ends of that sentence in place.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One bundle carrying the stream-down classifier and the telemetry that consumes it.
 *
 * Two module states need two bundles, but neither module here holds state — they
 * are pure functions over a reason string and an error — so a single bundle
 * proves the link between them, which is the whole point: a classifier that
 * returns the right reason and a telemetry layer that treats it as a fault
 * would be a defect that neither module can see alone.
 */
const SHIM_SOURCE = `
export { classifyStreamDown, classifyGatewayFetchFailure } from "./node-agent-coordinator/gateway/gateway-reachability.js";
export { streamDownTelemetry, streamDownError, gatewayOutcomeError } from "./electron-main/telemetry/transport-stream-telemetry.js";
`;

let shim;
let disposeShim;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-stream-down-"));
  const outfile = path.join(directory, "stream-down-shim.cjs");
  await build({
    stdin: {
      contents: SHIM_SOURCE,
      resolveDir: path.join(repoRoot, "source"),
      sourcefile: "stream-down-shim.ts",
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

/** The reason a stream that simply ended carries, as the shipped client sets it. */
const CLEAN_CLOSE_REASON = "stream-ended";

/** A down with no fault in it: no paused client, no stall, nothing forced. */
const plainDown = error => ({
  clientPaused: false,
  stalled: false,
  forced: false,
  devInducedOffline: false,
  error,
});

const errnoError = code => Object.assign(new Error(`connect ${code}`), { code });

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
});

test.after(() => {
  disposeShim?.();
});

test("a stream that ended on its own is a lifecycle event and raises no fault", () => {
  const telemetry = shim.streamDownTelemetry({ reason: CLEAN_CLOSE_REASON, generation: 1 });
  assert.equal(telemetry.metadata.reason, "stream_ended",
    `a connection that closed by itself was not named as a lifecycle transition: ${JSON.stringify(telemetry.metadata)}`);
  assert.equal(telemetry.level, "info",
    `a connection that closed by itself was escalated above info, which is what makes the user think something needs their attention: ${telemetry.level}`);
  assert.equal(telemetry.metadata.error_code, undefined,
    `a connection that closed by itself was published as the registered fault ${telemetry.metadata.error_code}, which is a failure the user did not cause`);
  assert.equal(telemetry.metadata.error_retryable, undefined,
    "a connection that closed by itself was published as retryable, which invites a retry for a fault that does not exist");
  assert.equal(shim.streamDownError(CLEAN_CLOSE_REASON), null,
    "the error mapper invented a registered fault for a clean close, so something downstream will blame the user's connection");
});

test("the same telemetry raises a real fault when the stream really failed", () => {
  // The other half of the demand: a clean close must stay quiet without making
  // genuine failures quiet too.
  const refused = shim.streamDownTelemetry({ reason: "refused", cause: "Error/ECONNREFUSED", generation: 1 });
  assert.equal(refused.metadata.error_code, "SAND-E0101",
    `a refused connection raised no fault code, so the user is never told their connection is the problem: ${JSON.stringify(refused.metadata)}`);
  assert.equal(refused.metadata.error_retryable, "true",
    "a refused connection was published as permanent, so the loop stops instead of reconnecting");

  const stalled = shim.streamDownTelemetry({ reason: "stall-timeout", generation: 1 });
  assert.equal(stalled.level, "warn",
    `a stream that stalled was emitted at ${stalled.level}, which is below the warning a silent connection deserves`);
  assert.equal(stalled.metadata.error_code, "SAND-E0110",
    `a stream that stalled raised no fault code: ${JSON.stringify(stalled.metadata)}`);
});

test("every reason the classifier returns from a real error still raises a fault", () => {
  const realErrors = [
    { error: errnoError("ECONNREFUSED"), expected: "refused" },
    { error: errnoError("ENOTFOUND"), expected: "dns" },
    { error: errnoError("ETIMEDOUT"), expected: "timeout" },
    { error: new Error("socket hang up"), expected: "network" },
    { error: errnoError("EAI_AGAIN"), expected: "dns" },
  ];
  for (const { error, expected } of realErrors) {
    const down = shim.classifyStreamDown(plainDown(error));
    assert.equal(down.reason, expected,
      `${error.message} was classified as "${down.reason}" instead of "${expected}"`);
    const telemetry = shim.streamDownTelemetry({ reason: down.reason, cause: down.cause, generation: 1 });
    assert.ok(telemetry.metadata.error_code !== undefined,
      `a genuine ${down.reason} failure was swallowed, so the user is never told when their participation is needed`);
  }
});

test("a reconnect the user asked for is not published as their fault either", () => {
  const forced = shim.classifyStreamDown({ ...plainDown(undefined), forced: true });
  assert.equal(forced.reason, "forced-reconnect",
    `a reconnect the user asked for was classified as ${forced.reason}, so their own action is reported as a fault`);
  const telemetry = shim.streamDownTelemetry({ reason: forced.reason, cause: forced.cause, generation: 1 });
  assert.equal(telemetry.metadata.error_code, undefined,
    `a forced reconnect was published as the registered fault ${telemetry.metadata.error_code}`);
  assert.equal(telemetry.metadata.reason, "forced_reconnect",
    `a forced reconnect was not named as a lifecycle transition: ${JSON.stringify(telemetry.metadata)}`);
});

test("the shipped client keeps the neutral reason until a catch actually fires", () => {
  // The classifier above cannot invent a fault on its own — every branch that
  // returns a failure reason reads the error. The one way a clean close could
  // still be reported as a failure is a call site that feeds it the absence of
  // an error, so this reads the shipped source and proves the neutral default
  // is initialised before the first read and replaced only from a `catch`.
  const source = readFileSync(
    path.join(repoRoot, "source", "node-agent-coordinator", "gateway", "gateway-client.ts"),
    "utf8",
  );

  const neutralDefaults = [...source.matchAll(/reason:\s*"stream-ended"/g)];
  assert.ok(neutralDefaults.length > 0,
    "the gateway client no longer carries a neutral default for a stream that ended, so a clean close would fall through to a failure classification");

  const classifierCalls = [...source.matchAll(/classifyStreamDown\(/g)];
  assert.equal(classifierCalls.length, 1,
    `classifyStreamDown is called ${classifierCalls.length} times in the gateway client, so the claim that only a catch reaches it no longer holds`);

  // `} catch (error) {` and the call sit on two lines, so the guard looks at the
  // nearest preceding non-empty line rather than demanding both on one line.
  const lines = source.split(/\r?\n/).map(line => line.trim());
  const callIndex = lines.findIndex(line => line.includes("classifyStreamDown("));
  let preceding = callIndex - 1;
  while (preceding >= 0 && lines[preceding].length === 0) preceding -= 1;
  assert.match(lines[preceding] ?? "", /catch\s*\(/,
    "the gateway client classifies a stream-down outside a catch, so a stream that ended with no error would be classified as a fault the user did not cause");
});