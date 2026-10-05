import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The two bridge answer routes handed a V8 parser sentence to the caller.
 *
 * `/local-exec/responses` and `/webauthn/responses` are the only POST routes in
 * the gateway that read a body without going through `routeCommand`, and so the
 * only ones that never met `refuseUnparsableBody`. Each called
 * `JSON.parse(body)` with no guard. Measured on a live box,
 * `POST /local-exec/responses {"broken` and `POST /webauthn/responses {"broken`
 * both answered `500 {"error":"Unterminated string in JSON at position 8 (line 1
 * column 9)"}`: a sentence about the host's parser, with no endpoint in it and a
 * status that blames the host for a caller's truncated write. The command routes
 * next door answered `400` for the same mistake on the same day.
 *
 * The answer is made from the route's own path, so a caller holding two bridge
 * channels can tell which one was refused, and it says the body is the fault.
 *
 * The gate has to be narrow in the other direction too. A well-formed body must
 * still reach `submitResponses` with the parsed value, an empty body must still
 * mean "no answers", and the two channels must stay independent — a gate that
 * answered for the wrong channel would be a worse defect than the one it closed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// See the note in `gateway-request-error-is-400.test.mjs`: pointing this at a
// copy of `source/` built from `git HEAD` runs these assertions against the
// pre-fix code.
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-bridge-json-gate-"));
await build({
  entryPoints: [path.join(sourceRoot, "source", "host", "gateway-server.ts")],
  outfile: path.join(directory, "gateway-server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { startGatewayServer } = await import(
  pathToFileURL(path.join(directory, "gateway-server.mjs")).href + "?" + Date.now()
);
test.after(() => rmSync(directory, { recursive: true, force: true }));

const CHANNELS = [
  { key: "localExec", route: "/local-exec/responses", missing: "local-exec channel not enabled" },
  { key: "webauthn", route: "/webauthn/responses", missing: "webauthn channel not enabled" },
];

function recordingBridge() {
  const submitted = [];
  return {
    submitted,
    registerProvider: () => () => {},
    submitResponses(batch) {
      submitted.push(batch);
    },
  };
}

async function withServer(overrides, run) {
  const server = await startGatewayServer({
    api: {},
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
    ...overrides,
  });
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };
  try {
    return await run(post);
  } finally {
    await server.close();
  }
}

test("the sweep reached both bridge answer routes", () => {
  assert.equal(CHANNELS.length, 2,
    "the channel list shrank, so the sweep no longer covers the whole bridge surface");
  for (const channel of CHANNELS) {
    assert.match(channel.route, /\/responses$/,
      `${channel.key} is not an answer route any more, so it no longer belongs in this sweep`);
  }
});

for (const channel of CHANNELS) {
  test(`a truncated answer on ${channel.route} is the caller's fault, not the host's`, async () => {
    const bridge = recordingBridge();
    const answer = await withServer({ [channel.key]: bridge }, (post) =>
      post(channel.route, '{"broken'),
    );

    assert.equal(answer.status, 400,
      `a truncated write came back as ${answer.status}, which blames the host for a payload the host never finished reading`);
    const text = JSON.stringify(answer.body.error ?? "");
    assert.doesNotMatch(text, /Unterminated string in JSON|JSON at position|Unexpected end of JSON|Unexpected token/,
      `a V8 parser sentence reached the caller: ${text}`);
    assert.match(text, /not valid JSON/,
      `the refusal does not say the body is what is wrong: ${text}`);
    assert.ok(text.includes(channel.route),
      `the refusal does not name the endpoint, so a caller holding two bridge channels cannot tell which was refused: ${text}`);
    assert.deepEqual(bridge.submitted, [],
      "the answers reached the channel provider even though the body was refused");
  });

  test(`a well-formed answer on ${channel.route} still reaches the channel`, async () => {
    const bridge = recordingBridge();
    const answer = await withServer({ [channel.key]: bridge }, (post) =>
      post(channel.route, '{"answers":[{"id":"req-1","result":"done"}]}'),
    );

    assert.equal(answer.status, 200,
      `a well-formed answer came back as ${answer.status}, so the gate refused something that was fine: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(bridge.submitted, [{ answers: [{ id: "req-1", result: "done" }] }],
      `the channel received ${JSON.stringify(bridge.submitted)} instead of the parsed body the caller sent`);
  });

  test(`an empty body on ${channel.route} still means no answers`, async () => {
    const bridge = recordingBridge();
    const answer = await withServer({ [channel.key]: bridge }, (post) => post(channel.route, ""));

    assert.equal(answer.status, 200,
      `an empty body came back as ${answer.status}, so a caller with nothing to report was refused: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(bridge.submitted, [{}],
      `an empty body reached the channel as ${JSON.stringify(bridge.submitted)} instead of an empty batch`);
  });

  test(`a refusal on ${channel.route} does not answer for the other channel`, async () => {
    const other = CHANNELS.find((candidate) => candidate.key !== channel.key);
    const mine = recordingBridge();
    const theirs = recordingBridge();
    const answer = await withServer({ [channel.key]: mine, [other.key]: theirs }, (post) =>
      post(channel.route, '{"broken'),
    );

    assert.equal(answer.status, 400, `a truncated write came back as ${answer.status}`);
    assert.deepEqual(mine.submitted, [],
      "the refused channel was still handed the body");
    assert.deepEqual(theirs.submitted, [],
      "the refusal reached the other bridge channel, so a caller on one channel was told about the other");
  });
}

test("a channel that is switched off still answers 404 before it looks at the body", async () => {
  // The gate must not run ahead of the channel check: a body that cannot be
  // parsed on a route that does not exist is still a route that does not exist,
  // and answering `400` there would advertise an endpoint that is not listening.
  const answer = await withServer({}, (post) => post("/local-exec/responses", '{"broken'));

  assert.equal(answer.status, 404,
    `a bridge that is switched off came back as ${answer.status}, so the endpoint answered for a channel that does not exist`);
  assert.match(answer.body.error, /local-exec channel not enabled/,
    `the 404 no longer names the channel: ${JSON.stringify(answer.body.error)}`);
});