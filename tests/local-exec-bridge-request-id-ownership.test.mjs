import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A bridge request that carried its own `requestId` never got an answer, and
 * nothing said so.
 *
 * `SandLocalExecBridge.request` builds the frame it puts on the wire like this:
 *
 *   provider.send({ requestId, ...frame });
 *
 * The spread comes second, so a `requestId` on the caller's frame overwrites the
 * one the bridge just generated — and the bridge registers its waiting queue
 * under the generated one. The request goes out under the caller's id and comes
 * back under the caller's id, into a `pending` map that has no such key. The
 * generator never yields, never returns and never throws; it simply waits for a
 * frame that will never be routed to it.
 *
 * `LocalExecBridgeFrame` declares `requestId?: string` on the frame itself
 * (`local-exec-bridge.ts:15`), so a caller that sets it is inside the declared
 * contract. The three in-repo callers do not — they build `exec`, `upload` and
 * `download` frames as object literals carrying `kind`, `serverMessage`, `path`,
 * `bytesBase64` and `approvalId` — so no shipped path reaches this today. It is
 * the bridge's own public type that promises the frame may carry the field, and
 * the bridge that cannot honour it.
 *
 * MEASURED, against the real `SandLocalExecBridge` over the real frame
 * handshake:
 *
 *   request({kind:"exec", requestId:"caller-chosen", ...})
 *     frame on the wire   { requestId: "caller-chosen", ... }
 *     answer delivered    none — the waiter was still open when the run ended
 *
 *   two concurrent requests, both with requestId "same"
 *     frames on the wire  [ {requestId:"same", id:A}, {requestId:"same", id:B} ]
 *     answers delivered   0 of 2, because `pending` holds one queue per id and
 *                         the first generator's `finally` deletes the other's
 *
 *   control: two concurrent requests with no requestId
 *     frames on the wire  [ {requestId:"bridge-id-2", id:A},
 *                          {requestId:"bridge-id-3", id:B} ]
 *     answers delivered   2 of 2, each to its own waiter
 *
 * WHY THIS HANGS RATHER THAN FAILS. Only `gateway-local-exec-sand-box.ts:45`
 * passes `watchResponse: true`, and only for `exec`. The response watchdog is
 * what turns a silent queue into an error; `upload` and `download` call
 * `bridge.request` with no options at all, so a clobbered id there is not slow,
 * it is permanent. The cost of the defect is one property's position in an
 * object literal: the bridge's id has to be written LAST so that it is the one
 * the wire and the queue agree on.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-bridge-requestid-"));
await build({
  entryPoints: [path.join(repoRoot, "source", "host", "extensions", "local-exec", "local-exec-bridge.ts")],
  outfile: path.join(directory, "local-exec-bridge.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { SandLocalExecBridge } = await import(
  pathToFileURL(path.join(directory, "local-exec-bridge.mjs")).href + "?" + Date.now()
);
test.after(() => rmSync(directory, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a drained request is given before it counts as unanswered. */
const ANSWER_CEILING_MS = 1_500;

function makeBridge() {
  const sent = [];
  let counter = 0;
  const bridge = new SandLocalExecBridge({
    clock: { now: () => 1_000 },
    // A watchdog that never fires: the defect this file is about is that a
    // clobbered id produces NO answer at all, so a watchdog that rescued it would
    // hide the defect behind a timeout instead of showing the lost frame.
    responseWatchdog: { arm: () => ({ kick() {}, dispose() {} }) },
    blockedReason: () => undefined,
    randomId: () => `bridge-id-${++counter}`,
  });
  bridge.registerProvider((frame) => sent.push(frame));
  // `randomId` is the provider's own id factory too, so the registration above
  // took the first one. The test reads the ids off the wire rather than counting.
  bridge.submitResponses({
    frames: [{ kind: "hello", localRoot: "C:\\root", terminalsFolder: "C:\\root\\terminals", computerId: "pc", label: "PC" }],
  });
  return { bridge, sent, welcome: sent.find((frame) => frame.kind === "welcome") };
}

/** Starts a request, returns its frames and a promise for its completion. */
function startRequest(bridge, frame) {
  const received = [];
  const done = (async () => {
    for await (const response of bridge.request({ signal: new AbortController().signal }, frame, "pc")) {
      received.push(response);
    }
    return received;
  })();
  return { received, done };
}

function execRequests(sent) {
  return sent.filter((frame) => frame.kind === "exec");
}

test("a request frame that carries its own requestId is still answered", async () => {
  const { bridge, sent, welcome } = makeBridge();
  const call = startRequest(bridge, { kind: "exec", requestId: "caller-chosen", serverMessage: { id: 1 } });
  await sleep(50);

  const onWire = execRequests(sent)[0];
  assert.ok(onWire, "no exec frame reached the desktop, so this test proves nothing");
  bridge.submitResponses({ frames: [{ kind: "client", requestId: onWire.requestId, message: { case: "shellResult", value: { exitCode: 0 } } }] });
  await Promise.race([call.done, sleep(ANSWER_CEILING_MS)]);

  assert.equal(call.received.length, 1,
    `the answer came back under ${JSON.stringify(onWire.requestId)} and was not delivered to the request that asked for it, so the caller waits forever: ${JSON.stringify(call.received)}`);
  assert.deepEqual(call.received[0].message, { case: "shellResult", value: { exitCode: 0 } },
    `the wrong answer reached the request: ${JSON.stringify(call.received[0])}`);
  assert.notEqual(call.received[0].requestId, "caller-chosen",
    "the caller's own requestId was put on the wire, which is how the wire and the queue stopped agreeing");
  assert.notEqual(onWire.requestId, welcome.providerId,
    `the request reused the provider id ${JSON.stringify(welcome.providerId)}, so a desktop could not tell a request from its own registration`);
});

test("the bridge's own requestId is the one that reaches the wire", async () => {
  const { bridge, sent, welcome } = makeBridge();
  startRequest(bridge, { kind: "exec", requestId: "caller-chosen", serverMessage: { id: 1 } });
  await sleep(50);

  const onWire = execRequests(sent)[0];
  assert.ok(
    typeof onWire.requestId === "string" && onWire.requestId !== "caller-chosen" && onWire.requestId !== welcome.providerId,
    `the bridge put ${JSON.stringify(onWire.requestId)} on the wire while registering its queue under a different id, so the two can never meet`);
});

test("two concurrent requests naming the same requestId are each answered once", async () => {
  // The collision is not merely a lost frame: both requests go out under one id,
  // `pending` holds one queue under that id, and the first generator to finish
  // deletes the second's entry in its `finally`. Answering the shared id once can
  // therefore never satisfy both.
  const { bridge, sent } = makeBridge();
  const first = startRequest(bridge, { kind: "exec", requestId: "same", serverMessage: { id: "A" } });
  await sleep(30);
  const second = startRequest(bridge, { kind: "exec", requestId: "same", serverMessage: { id: "B" } });
  await sleep(80);

  const onWire = execRequests(sent).map((frame) => ({ requestId: frame.requestId, serverMessageId: frame.serverMessage.id }));
  assert.equal(onWire.length, 2, `only ${onWire.length} exec frame(s) reached the desktop, so this test cannot show a collision`);
  assert.notEqual(onWire[0].requestId, onWire[1].requestId,
    `both requests went out as requestId ${JSON.stringify(onWire[0].requestId)}, so one answer cannot tell them apart`);

  for (const frame of onWire) {
    bridge.submitResponses({ frames: [{ kind: "client", requestId: frame.requestId, message: { marker: frame.serverMessageId } }] });
  }
  await Promise.race([Promise.all([first.done, second.done]), sleep(ANSWER_CEILING_MS)]);

  const total = first.received.length + second.received.length;
  assert.equal(total, 2,
    `${total} of 2 concurrent requests were answered; the other ${2 - total} is still waiting on a queue nobody will ever push to, and nothing reported it`);
});

test("requests that name nothing are still routed to their own waiters", async () => {
  // The control. The bridge's generated ids are what the queue and the wire
  // agree on today, and the fix must not disturb them.
  const { bridge, sent } = makeBridge();
  const first = startRequest(bridge, { kind: "exec", serverMessage: { id: "A" } });
  await sleep(30);
  const second = startRequest(bridge, { kind: "exec", serverMessage: { id: "B" } });
  await sleep(80);

  const onWire = execRequests(sent).map((frame) => ({ requestId: frame.requestId, serverMessageId: frame.serverMessage.id }));
  assert.equal(new Set(onWire.map((frame) => frame.requestId)).size, 2,
    `two concurrent requests went out under ${JSON.stringify(onWire.map((f) => f.requestId))}, so they cannot be told apart`);

  for (const frame of onWire) {
    bridge.submitResponses({ frames: [{ kind: "client", requestId: frame.requestId, message: { marker: frame.serverMessageId } }] });
  }
  await Promise.race([Promise.all([first.done, second.done]), sleep(ANSWER_CEILING_MS)]);

  assert.deepEqual(first.received.map((frame) => frame.message.marker), ["A"],
    `the first request received ${JSON.stringify(first.received.map((frame) => frame.message.marker))}`);
  assert.deepEqual(second.received.map((frame) => frame.message.marker), ["B"],
    `the second request received ${JSON.stringify(second.received.map((frame) => frame.message.marker))}`);
});

test("the rest of the caller's frame still reaches the wire", async () => {
  // The fix reorders a spread. It must not drop anything the caller sent.
  const { bridge, sent } = makeBridge();
  startRequest(bridge, { kind: "exec", requestId: "caller-chosen", serverMessage: { id: 7 }, approvalId: "approval-9", extra: "kept" });
  await sleep(50);

  const onWire = execRequests(sent)[0];
  assert.deepEqual(onWire.serverMessage, { id: 7 }, `the command itself was lost: ${JSON.stringify(onWire.serverMessage)}`);
  assert.equal(onWire.approvalId, "approval-9", "the approval id the caller sent did not reach the desktop");
  assert.equal(onWire.extra, "kept", "an unrelated field the caller sent did not reach the desktop");
});
