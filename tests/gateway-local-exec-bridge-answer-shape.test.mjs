import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A malformed answer on the local-exec bridge channel answered `500` and told
 * the caller the host had broken, while the command route next door answered a
 * precise `400` for the very same shape.
 *
 * `/local-exec/responses` is a POST route that does not go through
 * `routeCommand`, so it is the only one that never asked `refuseUnparsableBody`
 * to check the SHAPE rather than only the parseability. The gate was added to
 * both bridge answer routes for truncated writes (see
 * `gateway-bridge-responses-json-gate.test.mjs`) but called with the default
 * `shape: "any"`, so anything `JSON.parse` accepted went straight into
 * `submitResponses`. Measured against the real `startGatewayServer` with the
 * real `SandLocalExecBridge` behind it:
 *
 *   body                       /local-exec/responses   /api/listAgents
 *   -------------------------  ---------------------  -------------------------------
 *   `null`                      500  TypeError in       400 "must be a JSON object,
 *                                    submitResponses        and null arrived"
 *   `{"frames":{"a":1}}`        500  "object is not      400
 *                                    iterable"
 *   `{"frames":[null]}`         500  "Cannot read        400
 *                                    properties of null"
 *   `123` / `"hello"` / `[..]`  200  silently accepted  400, naming the shape
 *
 * Two wrong behaviours in one route. The 500s are the sharp end: the sentence
 * handed back is `faultMessageForCaller("/local-exec/responses")` — "failed
 * inside the host; the detail is in the host log" — which blames the host for a
 * payload the host parsed perfectly well, and it hides a `TypeError` in the
 * bridge behind a log line the caller cannot read. The 200s are the quiet end:
 * `[1,2,3]` is answered `{"ok":true}` while `(batch).frames` is `undefined`,
 * `batch.frames ?? []` yields nothing, and every answer in that body is
 * silently discarded.
 *
 * The fix is the gate this file's neighbours already use: the bridge answer
 * routes ask for `shape: "object"` the way `routeCommand` does, and then check
 * that `frames` really is an array of frames, so a bad body is a `400` that
 * names the endpoint and the fault instead of a `500` or a silent no-op.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-bridge-shape-"));
await build({
  entryPoints: [path.join(repoRoot, "source", "host", "gateway-server.ts")],
  outfile: path.join(directory, "gateway-server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const gateway = await import(
  pathToFileURL(path.join(directory, "gateway-server.mjs")).href + "?" + Date.now()
);
const { startGatewayServer } = gateway;
test.after(() => rmSync(directory, { recursive: true, force: true }));

const TOKEN = "bridge-shape-token";
const ROUTE = "/local-exec/responses";

function recordingBridge() {
  const submitted = [];
  const failures = [];
  return {
    submitted,
    failures,
    registerProvider: () => () => {},
    submitResponses(batch) {
      submitted.push(batch);
      // The real bridge throws on the shapes this file is about. Reproducing the
      // throw here is what makes a `500` visible to the caller at all; without it
      // a recording bridge would happily accept everything and the route would
      // look correct.
      if (batch === null || batch === undefined) {
        const error = new TypeError("Cannot read properties of null (reading 'providerId')");
        failures.push(`${error.name}: ${error.message}`);
        throw error;
      }
      const frames = batch.frames;
      if (frames !== undefined && frames !== null && typeof frames !== "string" && typeof frames[Symbol.iterator] !== "function") {
        const error = new TypeError("object is not iterable (cannot read property Symbol(Symbol.iterator))");
        failures.push(`${error.name}: ${error.message}`);
        throw error;
      }
      if (Array.isArray(frames)) {
        for (const frame of frames) {
          if (frame === null || typeof frame !== "object") {
            const error = new TypeError("Cannot read properties of null (reading 'kind')");
            failures.push(`${error.name}: ${error.message}`);
            throw error;
          }
        }
      }
    },
  };
}

async function withServer(overrides, run) {
  const server = await startGatewayServer({
    api: {},
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: TOKEN,
    ...overrides,
  });
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed };
  };
  try {
    return await run(post);
  } finally {
    await server.close();
  }
}

/** The control: the same shapes on a route that already refuses them. */
async function commandRouteAnswerFor(body) {
  const answer = await withServer({}, (post) => post("/api/listAgents", body));
  assert.equal(answer.status, 400,
    `the control route answered ${answer.status} for ${body}, so this file can no longer show the bridge route is the odd one out`);
  return answer;
}

const BAD_BODIES = [
  { name: "a bare null", body: "null", shape: "null" },
  { name: "a bare number", body: "123", shape: "number" },
  { name: "a bare string", body: '"hello"', shape: "string" },
  { name: "a bare array", body: "[1,2,3]", shape: "an array" },
];

test("the sweep covers every bridge answer route", () => {
  assert.ok(BAD_BODIES.length >= 4,
    "the malformed-body list shrank, so this file no longer covers the shapes the route used to accept");
});

for (const { name, body, shape } of BAD_BODIES) {
  test(`${name} on the local-exec answer route is the caller's fault, answered as one`, async () => {
    await commandRouteAnswerFor(body);
    const bridgeUnderTest = recordingBridge();
    const answer = await withServer({ localExec: bridgeUnderTest }, (post) => post(ROUTE, body));

    assert.equal(answer.status, 400,
      `${name} came back as ${answer.status}: ${JSON.stringify(answer.body.error)}` +
      (answer.status === 500 ? ", which blames the host for a body the host parsed" : ""));
    const text = String(answer.body.error ?? "");
    assert.doesNotMatch(text, /failed inside the host/,
      `a host fault sentence reached the caller for a caller-side body: ${text}`);
    assert.match(text, /\/local-exec\/responses/,
      `the refusal does not name the endpoint, so a caller holding both bridge channels cannot tell which was refused: ${text}`);
    assert.match(text, /JSON object/,
      `the refusal does not say what shape the body must have: ${text}`);
    assert.match(text, new RegExp(shape),
      `the refusal does not say what actually arrived (${shape}): ${text}`);
    assert.deepEqual(bridgeUnderTest.submitted, [],
      "the malformed batch was handed to the bridge anyway, so the refusal came after the damage");
    assert.deepEqual(bridgeUnderTest.failures, [],
      "the bridge threw while handling a body the route should have refused, which is what produced the 500");
  });
}

const BAD_FRAME_BODIES = [
  { name: "frames that are not a list", body: '{"providerId":"p","frames":{"a":1}}' },
  { name: "frames that are a bare string", body: '{"providerId":"p","frames":"not-a-list"}' },
  { name: "frames holding a null", body: '{"providerId":"p","frames":[null]}' },
  { name: "frames holding a number", body: '{"providerId":"p","frames":[7]}' },
];

for (const { name, body } of BAD_FRAME_BODIES) {
  test(`${name} on the local-exec answer route is refused before it reaches the bridge`, async () => {
    const bridgeUnderTest = recordingBridge();
    const answer = await withServer({ localExec: bridgeUnderTest }, (post) => post(ROUTE, body));

    assert.equal(answer.status, 400,
      `${name} came back as ${answer.status}: ${JSON.stringify(answer.body.error)}` +
      (answer.status === 500 ? ", which blames the host for a body the host parsed" : ""));
    const text = String(answer.body.error ?? "");
    assert.match(text, /\/local-exec\/responses/,
      `the refusal does not name the endpoint: ${text}`);
    assert.match(text, /frames/,
      `the refusal does not say which field is wrong: ${text}`);
    assert.deepEqual(bridgeUnderTest.failures, [],
      "the bridge threw on this body, so the answer was produced by a fault rather than by a refusal");
    assert.deepEqual(bridgeUnderTest.submitted, [],
      "the malformed batch reached the bridge, so the caller is told the answers were accepted");
  });
}

test("a well-formed answer still reaches the bridge unchanged", async () => {
  // The gate must be narrow in the other direction. A refusal that also turned
  // away a good batch would be a worse defect than the one this file closes.
  const bridgeUnderTest = recordingBridge();
  const answer = await withServer({ localExec: bridgeUnderTest }, (post) =>
    post(ROUTE, '{"providerId":"p-1","frames":[{"kind":"ping"},{"kind":"client","requestId":"r-1","message":{"case":"shellResult"}}]}'),
  );

  assert.equal(answer.status, 200,
    `a well-formed answer came back as ${answer.status}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(bridgeUnderTest.submitted,
    [{ providerId: "p-1", frames: [{ kind: "ping" }, { kind: "client", requestId: "r-1", message: { case: "shellResult" } }] }],
    `the bridge received ${JSON.stringify(bridgeUnderTest.submitted)} instead of the batch the caller sent`);
});

test("a batch with no frames at all is still accepted", async () => {
  const bridgeUnderTest = recordingBridge();
  const answer = await withServer({ localExec: bridgeUnderTest }, (post) => post(ROUTE, '{"providerId":"p-1"}'));

  assert.equal(answer.status, 200,
    `a batch carrying only a providerId came back as ${answer.status}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(bridgeUnderTest.submitted, [{ providerId: "p-1" }],
    "a batch with no frames was refused, but a desktop posting only a heartbeat is exactly this batch");
});

test("an empty body still means no answers", async () => {
  const bridgeUnderTest = recordingBridge();
  const answer = await withServer({ localExec: bridgeUnderTest }, (post) => post(ROUTE, ""));

  assert.equal(answer.status, 200,
    `an empty body came back as ${answer.status}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual(bridgeUnderTest.submitted, [{}],
    `an empty body reached the bridge as ${JSON.stringify(bridgeUnderTest.submitted)} instead of an empty batch`);
});

test("the webauthn answer route refuses the same shapes", async () => {
  // The two bridge channels share one handler. A gate that only covered the
  // local-exec half would leave the other channel answering 500 for the same
  // body, and the fix would read as complete when it is not.
  const bridgeUnderTest = recordingBridge();
  const answer = await withServer({ webauthn: bridgeUnderTest }, (post) => post("/webauthn/responses", "null"));

  assert.equal(answer.status, 400,
    `the webauthn answer route answered ${answer.status} for a bare null: ${JSON.stringify(answer.body.error)}`);
  assert.match(String(answer.body.error), /\/webauthn\/responses/,
    `the webauthn refusal does not name its own endpoint: ${JSON.stringify(answer.body.error)}`);
});

test("a channel that is switched off still answers 404 before it looks at the body", async () => {
  const answer = await withServer({}, (post) => post(ROUTE, "null"));

  assert.equal(answer.status, 404,
    `a disabled channel answered ${answer.status}, so the new shape gate advertises an endpoint that is not listening`);
  assert.match(answer.body.error, /local-exec channel not enabled/,
    `the 404 no longer names the channel: ${JSON.stringify(answer.body.error)}`);
});
