import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * One desktop's identity and heartbeat were rewritten by another desktop's
 * answer batch, and the gateway answered `200 {"ok":true}` while it happened.
 *
 * `SandLocalExecBridge.providerForBatch` resolved the sender of an answer batch
 * like this:
 *
 *   return (providerId === undefined ? undefined : this.byId.get(providerId))
 *        ?? [...this.providers].at(-1);
 *
 * The `??` is the defect. It was written to cover the daemon's first batch, and
 * it does that — but it also covers every batch whose `providerId` names a
 * desktop that has already left, and it hands that batch to whichever desktop
 * registered LAST. Nothing in between asks whether the two are the same desktop.
 *
 * WHY THE DESKTOP SENDS A BATCH THAT NAMES NOBODY. This is not a hostile
 * caller; it is the shipped provider on every connect.
 * `SandLocalExecProvider.streamRequests` issues the `hello` POST
 * (`local-exec-provider.ts:116`) immediately after the stream opens, while its
 * own `providerId` is still `undefined` — that field is only filled in when the
 * `welcome` frame is dispatched off the stream, which happens later, in
 * `handleRequest`. `JSON.stringify({ providerId: this.providerId, frames })`
 * then omits the key entirely. Recorded off a real `startGatewayServer` with the
 * real provider class, the first two bodies on the wire were:
 *
 *   {"frames":[{"kind":"hello","localRoot":"...\\root-A","terminalsFolder":"...",
 *               "computerId":"pc-A","label":"A"}]}
 *   {"frames":[{"kind":"ping"}]}
 *
 * No `providerId` on either. The same is true of every heartbeat the daemon
 * emits in the window after its stream drops, because `streamRequests`' `finally`
 * sets `this.providerId = undefined` before the polling heartbeat fires again.
 *
 * MEASURED CONSEQUENCE, live, through the real gateway and the real bridge:
 *
 *   1. `pc-A` and `pc-B` are registered. `pc-B` goes stale (clock past the 30 s
 *      liveness window): `listComputers()` reports `{pc-B, connected:false}`.
 *   2. The batch a dropped daemon sends next — `{"frames":[{"kind":"ping"}]}`, no
 *      id — answers `200` and flips `pc-B` back to `connected:true`. A desktop
 *      that has not spoken since is declared live by one that is not it.
 *   3. The batch every daemon sends on reconnect — `{"frames":[{"kind":"hello",
 *      localRoot:"C:\\NOTHING-DECLARED-THIS", computerId:"pc-GHOST", ...}]}`, no
 *      id — answers `200`, and `listComputers()` becomes `[{pc-GHOST}]` and
 *      `getProviderInfo()` becomes `C:\\NOTHING-DECLARED-THIS`. The one desktop
 *      on this machine has been replaced by one that never existed, and every
 *      later read, upload and download resolves its path against a root no
 *      daemon declared.
 *
 * The rule the bridge needs is narrow and does not depend on the protocol
 * catching up: a batch that names nobody may only describe a desktop that has
 * not described itself yet, and a batch that names a desktop that is gone may
 * describe nothing at all. Both are refusals, not reroutings. Answers are still
 * delivered by `requestId`, so a late answer from a desktop that has since
 * disconnected still reaches the request that is waiting for it — refusing the
 * identity must not turn into dropping the answer.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-bridge-attribution-"));
// Two bundles, not one: the liveness window lives in a different module from
// the bridge, and the file has to read the value the BRIDGE will compare
// against rather than a copy of it.
for (const [name, entry] of [
  ["local-exec-bridge", ["host", "extensions", "local-exec", "local-exec-bridge.ts"]],
  ["local-exec-gateway", ["shared", "local-exec-gateway.ts"]],
]) {
  await build({
    entryPoints: [path.join(repoRoot, "source", ...entry)],
    outfile: path.join(directory, `${name}.mjs`),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
}
const load = (name) => import(
  pathToFileURL(path.join(directory, `${name}.mjs`)).href + "?" + Date.now()
);
const { SandLocalExecBridge } = await load("local-exec-bridge");
const { SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS } = await load("local-exec-gateway");
test.after(() => rmSync(directory, { recursive: true, force: true }));

const LIVENESS_WINDOW_MS = 30_000;

/** A bridge whose clock only moves when a test moves it. */
function makeBridge() {
  let now = 1_000_000;
  const bridge = new SandLocalExecBridge({
    clock: { now: () => now },
    responseWatchdog: { arm: () => ({ kick() {}, dispose() {} }) },
    blockedReason: () => undefined,
  });
  return {
    bridge,
    advance: (ms) => { now += ms; },
    now: () => now,
  };
}

/** Registers a desktop and walks it through the handshake the daemon performs. */
function attachDesktop(harness, name, root) {
  const frames = [];
  const detach = harness.bridge.registerProvider((frame) => frames.push(frame));
  const providerId = frames.find((frame) => frame.kind === "welcome")?.providerId;
  assert.equal(typeof providerId, "string",
    `the welcome frame for ${name} never arrived, so this desktop cannot be set up and the test proves nothing`);
  // The handshake, in the order `SandLocalExecProvider.streamRequests` performs
  // it: `hello` names nobody (the welcome has not been read yet), then the first
  // heartbeat names the desktop. The second frame matters: `isLive` treats a
  // provider that has NEVER heartbeated as live, so without it the desktop
  // could not be made stale and the liveness assertions below prove nothing.
  harness.bridge.submitResponses({
    frames: [{ kind: "hello", localRoot: root, terminalsFolder: `${root}\\terminals`, computerId: name, label: name.toUpperCase() }],
  });
  harness.bridge.submitResponses({ providerId, frames: [{ kind: "ping" }] });
  return {
    name,
    root,
    providerId,
    frames,
    detach,
    /** The exact shape `local-exec-provider.ts` puts on the wire: no id. */
    postUnattributed: (frame) => harness.bridge.submitResponses({ frames: [frame] }),
    /** The exact shape it puts on the wire once the welcome has been read. */
    post: (frame) => harness.bridge.submitResponses({ providerId, frames: [frame] }),
  };
}

test("a batch naming a desktop that has left changes nobody", () => {
  const harness = makeBridge();
  const live = attachDesktop(harness, "pc-live", "C:\\live");

  harness.bridge.submitResponses({
    providerId: "a-desktop-that-never-existed",
    frames: [{ kind: "ping" }],
  });
  harness.bridge.submitResponses({
    providerId: "a-desktop-that-never-existed",
    frames: [{ kind: "hello", localRoot: "C:\\ghost", terminalsFolder: "C:\\ghost\\t", computerId: "pc-ghost", label: "GHOST" }],
  });

  assert.deepEqual(harness.bridge.listComputers(), [{ id: "pc-live", label: "PC-LIVE", connected: true }],
    "a batch that named a desktop that is not registered was applied to the desktop that is, so its identity came from a sender that does not exist");
  assert.deepEqual(harness.bridge.getProviderInfo(), { localRoot: "C:\\live", terminalsFolder: "C:\\live\\terminals" },
    "the desktop's declared root was replaced by one from an unknown providerId, so every later path resolves against a root no daemon declared");
  assert.equal(harness.bridge.isComputerLive("pc-live"), true,
    "the live desktop was disturbed by a batch that named nobody that exists");
  live.detach();
});

test("the last desktop to reconnect cannot be relabelled by a desktop that is already gone", () => {
  // The measured scenario, in order. The order is the whole point: a fallback
  // that happens to be right while the desktops register in the same sequence
  // they answer in is still wrong, and only the departure exposes it.
  const harness = makeBridge();
  const first = attachDesktop(harness, "pc-A", "C:\\root-A");
  const second = attachDesktop(harness, "pc-B", "C:\\root-B");
  assert.deepEqual(harness.bridge.listComputers().map((computer) => computer.id), ["pc-A", "pc-B"],
    "both desktops were not registered, so the departure below changes nothing");

  // pc-A's stream drops. Its provider goes with it; its answer batch does not.
  first.detach();
  harness.advance(LIVENESS_WINDOW_MS + 1);
  assert.deepEqual(harness.bridge.listComputers().map((computer) => computer.id), ["pc-B"],
    "pc-A is still listed after detaching, so the test is not exercising a departed desktop");

  // pc-A's late batch, stamped with the id it was given before it left.
  harness.bridge.submitResponses({
    providerId: first.providerId,
    frames: [{ kind: "hello", localRoot: "C:\\root-A-stale", terminalsFolder: "C:\\root-A-stale\\t", computerId: "pc-A", label: "A-STALE" }],
  });

  assert.deepEqual(harness.bridge.listComputers().map((computer) => computer.id), ["pc-B"],
    `the departed desktop's late hello was applied to pc-B: ${JSON.stringify(harness.bridge.listComputers())}`);
  assert.deepEqual(harness.bridge.getProviderInfo(), { localRoot: "C:\\root-B", terminalsFolder: "C:\\root-B\\terminals" },
    `pc-B's declared root was replaced by pc-A's stale one: ${JSON.stringify(harness.bridge.getProviderInfo())}`);
  second.detach();
});

test("a heartbeat that names nobody does not keep a desktop alive that has stopped answering", () => {
  const harness = makeBridge();
  const dropped = attachDesktop(harness, "pc-A", "C:\\root-A");
  const other = attachDesktop(harness, "pc-B", "C:\\root-B");

  dropped.detach();
  harness.advance(LIVENESS_WINDOW_MS + 1);
  assert.equal(harness.bridge.isComputerLive("pc-B"), false,
    `pc-B is not stale after ${LIVENESS_WINDOW_MS + 1}ms of silence, so this test cannot tell a credited heartbeat from a dropped one`);
  assert.deepEqual(harness.bridge.listComputers(), [
    { id: "pc-B", label: "PC-B", connected: false },
  ], `the surviving desktop should be listed and stale after ${LIVENESS_WINDOW_MS + 1}ms of silence`);

  // Exactly what `SandLocalExecProvider`'s polling heartbeat posts once its
  // stream has dropped and `this.providerId` is undefined: a bare ping.
  harness.bridge.submitResponses({ frames: [{ kind: "ping" }] });

  assert.equal(harness.bridge.isComputerLive("pc-B"), false,
    "a ping that named nobody was credited to the desktop that registered last, so a desktop that stopped answering is still reported connected");
  other.detach();
});

test("an announcement that names nobody may still describe the desktop that has not described itself yet", () => {
  // The control for the refusal above, and the path the shipped daemon takes on
  // every single connect: it is registered, it has been sent `welcome`, and it
  // has not yet said `hello`. Refusing THAT would break every reconnect.
  const harness = makeBridge();
  const frames = [];
  const detach = harness.bridge.registerProvider((frame) => frames.push(frame));
  assert.equal(harness.bridge.getProviderInfo(), undefined,
    "the desktop declared an identity before it sent one, so the assertion below would pass for the wrong reason");

  harness.bridge.submitResponses({
    frames: [{ kind: "hello", localRoot: "C:\\fresh", terminalsFolder: "C:\\fresh\\terminals", computerId: "pc-fresh", label: "FRESH" }],
  });

  assert.deepEqual(harness.bridge.listComputers(), [{ id: "pc-fresh", label: "FRESH", connected: true }],
    "the daemon's first, unattributed hello was refused, so no desktop could ever connect");
  assert.deepEqual(harness.bridge.getProviderInfo(), { localRoot: "C:\\fresh", terminalsFolder: "C:\\fresh\\terminals" },
    `the first unattributed hello did not land: ${JSON.stringify(harness.bridge.getProviderInfo())}`);
  detach();
});

test("an attributed heartbeat still keeps a desktop alive", () => {
  const harness = makeBridge();
  const desktop = attachDesktop(harness, "pc-A", "C:\\root-A");
  harness.advance(LIVENESS_WINDOW_MS + 1);
  assert.equal(harness.bridge.isComputerLive("pc-A"), false, "the desktop is not stale, so this proves nothing");

  desktop.post({ kind: "ping" });

  assert.equal(harness.bridge.isComputerLive("pc-A"), true,
    "a desktop's own heartbeat stopped refreshing its liveness, so every desktop goes stale 30s after connecting");
  desktop.detach();
});

test("an attributed announcement still replaces the desktop's own earlier announcement", () => {
  const harness = makeBridge();
  const desktop = attachDesktop(harness, "pc-A", "C:\\root-A");

  desktop.post({ kind: "hello", localRoot: "C:\\moved", terminalsFolder: "C:\\moved\\terminals", computerId: "pc-A", label: "MOVED" });

  assert.deepEqual(harness.bridge.listComputers(), [{ id: "pc-A", label: "MOVED", connected: true }],
    "a desktop could not re-announce itself, so a user who moved their local-exec root would keep the old one");
  assert.deepEqual(harness.bridge.getProviderInfo(), { localRoot: "C:\\moved", terminalsFolder: "C:\\moved\\terminals" },
    `the re-announcement did not take: ${JSON.stringify(harness.bridge.getProviderInfo())}`);
  desktop.detach();
});

test("an answer from a desktop that has since left still reaches the request waiting for it", async () => {
  // The refusal above must not become a dropped answer. A desktop that streams
  // a command's output and then loses its SSE connection is ordinary, and the
  // host is holding that command open; refusing the identity is right, dropping
  // the frame would hang the turn until the response watchdog fires.
  const harness = makeBridge();
  const desktop = attachDesktop(harness, "pc-A", "C:\\root-A");

  const received = [];
  const drained = (async () => {
    for await (const frame of harness.bridge.request(
      { signal: new AbortController().signal, agentId: "agent-1" },
      { kind: "exec", serverMessage: { id: 1 } },
      "pc-A",
    )) received.push(frame);
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const requestId = desktop.frames.find((frame) => frame.kind === "exec")?.requestId;
  assert.equal(typeof requestId, "string", "no exec frame reached the desktop, so this proves nothing");

  desktop.detach();
  harness.bridge.submitResponses({
    providerId: desktop.providerId,
    frames: [{ kind: "client", requestId, message: { case: "shellResult", value: { exitCode: 0 } } }],
  });

  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  assert.deepEqual(received, [{ kind: "client", requestId, message: { case: "shellResult", value: { exitCode: 0 } } }],
    `the late answer was not delivered to the waiting request: ${JSON.stringify(received)}`);
});

test("the liveness window this file relies on is the one the bridge actually uses", () => {
  assert.equal(SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS, LIVENESS_WINDOW_MS,
    `the bridge's liveness window is ${SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS}ms, so the clock jumps above do not make a desktop stale and this file proves nothing`);
});
