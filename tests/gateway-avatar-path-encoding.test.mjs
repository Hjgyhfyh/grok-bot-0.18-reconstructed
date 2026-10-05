import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A truncated percent-escape in an avatar path was answered `500` with the text
 * of a V8 `URIError`.
 *
 * `handleAvatarImage` called `decodeURIComponent` on the path segment with no
 * guard. `%ZZ` is not a valid escape, `decodeURIComponent` throws
 * `URIError: URI malformed`, the throw left `handleRequest`, and the server's
 * catch-all answered `500 {"error":"URI malformed"}` — a sentence that names no
 * command, no field, no endpoint and no remedy, and that reads as a broken host
 * rather than a caller who mangled one segment of a URL. Every other malformed
 * request to the same server already answered `400` and named what was wrong.
 *
 * The live loopback box cannot demonstrate this: `HttpWebRequest` re-encodes
 * `%ZZ` to `%25ZZ` before it reaches the socket, so the box answers `404`. The
 * request target is therefore written onto a raw `node:http` socket, which is
 * exactly what a browser or a `curl --path-as-is` sends, and the id that arrives
 * is decoded by the host under test.
 *
 * The fix has to be narrow. `%25ZZ` — an id that is literally the text `%ZZ` —
 * is valid and must still resolve, and an agent that simply has no avatar must
 * still be a `404`, because "no picture" and "you asked for something that is
 * not a picture" are different answers.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// See the note in `gateway-request-error-is-400.test.mjs`: pointing this at a
// copy of `source/` built from `git HEAD` runs these assertions against the
// pre-fix code.
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-avatar-encoding-"));
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

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function apiOver(avatars, seen = []) {
  return {
    getAgentAvatar(args) {
      seen.push(args.id);
      return avatars[args.id] ?? { dataUrl: null, version: null };
    },
  };
}

/**
 * Sends `requestTarget` verbatim. `fetch` and `HttpWebRequest` both re-encode an
 * invalid escape before it reaches the socket, so the defect under test is
 * invisible through either of them.
 */
function rawGet(port, requestTarget, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: requestTarget,
        headers: { authorization: "Bearer test-token", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function withServer(api, run) {
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
  });
  try {
    return await run(server.port);
  } finally {
    await server.close();
  }
}

test("a truncated percent-escape is the caller's fault, not the host's", async () => {
  const seen = [];
  const answer = await withServer(apiOver({}, seen), (port) => rawGet(port, "/avatars/%ZZ"));

  assert.equal(answer.status, 400,
    `a truncated escape came back as ${answer.status}; it is the caller's URL, and ${answer.status} tells it the server broke`);
  const text = answer.body.toString("utf8");
  assert.doesNotMatch(text, /URI malformed/,
    `the raw V8 URIError text reached the caller: ${text}`);
  assert.match(text, /percent-encoding/,
    `the refusal does not say what is wrong with the path: ${text}`);
  assert.deepEqual(seen, [],
    "the avatar lookup ran with an id the host never decoded, so the refusal happened after the work rather than before it");
});

test("a lone percent is refused the same way as a broken escape", async () => {
  const answer = await withServer(apiOver({}), (port) => rawGet(port, "/avatars/100%"));
  assert.equal(answer.status, 400,
    `a path ending in a bare percent came back as ${answer.status}, which is the same defect with a different spelling`);
});

test("a well-formed id still serves its avatar", async () => {
  const seen = [];
  const api = apiOver({ "agent-with-avatar": { dataUrl: `data:image/png;base64,${PNG}`, version: "v7" } }, seen);

  const answer = await withServer(api, (port) => rawGet(port, "/avatars/agent-with-avatar"));

  assert.equal(answer.status, 200,
    `a valid avatar request came back as ${answer.status}, so the guard refused something that was fine`);
  assert.deepEqual(seen, ["agent-with-avatar"],
    `the decoded id was ${JSON.stringify(seen)}, so the guard changed the id that reached the store`);
  assert.equal(answer.headers["content-type"], "image/png",
    "the avatar was served with the wrong content type");
  assert.equal(answer.body.toString("base64"), PNG,
    "the avatar bytes were altered on the way out");
});

test("an id that is literally the text %ZZ is valid and still resolves", async () => {
  // `%25ZZ` decodes to `%ZZ`. It is a legal encoding of an awkward string, and a
  // guard that refused it would be refusing a caller who did nothing wrong.
  const seen = [];
  const answer = await withServer(apiOver({}, seen), (port) => rawGet(port, "/avatars/%25ZZ"));

  assert.deepEqual(seen, ["%ZZ"],
    `the escaped id decoded to ${JSON.stringify(seen)}, so a legal encoding was treated as a broken one`);
  assert.equal(answer.status, 404,
    `an agent with no avatar must stay 404, not become ${answer.status}: "no picture" and "not a picture" are different answers`);
  assert.match(answer.body.toString("utf8"), /no avatar/,
    `the 404 no longer says what is missing: ${answer.body.toString("utf8")}`);
});

test("an empty id is still missing, not malformed", async () => {
  const answer = await withServer(apiOver({}), (port) => rawGet(port, "/avatars/"));
  assert.equal(answer.status, 404,
    `a request for the avatar path with no id came back as ${answer.status}, so an absent segment was treated as a broken one`);
});