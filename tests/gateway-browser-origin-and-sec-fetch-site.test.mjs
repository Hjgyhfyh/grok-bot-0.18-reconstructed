import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The browser-facing half of the gateway front door failed open on three counts.
 *
 * `rejectUntrustedBrowserRequest` is the only thing standing between a page in
 * the user's browser and a loopback server that carries one bearer token for ~124
 * host commands, and it enforced exactly one rule: refuse a request that carries
 * an `Origin`. A browser never has to send `Origin`. `<img>`, `<script>`,
 * `<link>`, `<iframe>` and same-site navigations do not send it at all, which is
 * why `handleAvatarImage` added a second rule — `Sec-Fetch-Site: cross-site` —
 * for the one route a browser can actually aim a subresource load at. Measured on
 * the shipped module, that rule was read as a byte-for-byte `=== "cross-site"`,
 * so `Sec-Fetch-Site: CROSS-SITE` answered `200` with the avatar bytes, and it
 * stood on one route of seven: `Sec-Fetch-Site: cross-site` on `GET /events`
 * answered `200` and opened the whole event stream.
 *
 * Underneath both, `handleRequest` wrote the bearer check as
 * `if (deps.authToken != null && !isAuthorized(...))`. An absent token did not
 * mean "refuse", it meant "skip the check" — so a server constructed without one
 * answered `200 {"called":"setHostSettings"}` and `200 {"called":"deleteAgents"}`
 * to any loopback caller, which is the defect `gateway-config.ts` was rewritten
 * to close. `resolveGatewayServerConfig` always mints a token today, so that mode
 * is latent; `authToken?: string` on `GatewayServerDeps` kept it one edit away,
 * and the `Host`-header fallback that was left to catch it reads the hostname
 * with `new URL()`, where `\` is a path separator — so `Host:
 * 127.0.0.1\.evil.example` parsed as loopback and passed.
 *
 * The fixes are read-side and narrow. `Sec-Fetch-Site` is normalised and honoured
 * by the one guard every route already passes through; an absent token now
 * refuses rather than skipping; and a `Host` header containing a backslash is not
 * a hostname.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-browser-"));
await build({
  entryPoints: [path.join(sourceRoot, "source", "host", "gateway-server.ts")],
  outfile: path.join(directory, "gateway-server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { startGatewayServer, hostHeaderHostname } = await import(
  pathToFileURL(path.join(directory, "gateway-server.mjs")).href + "?" + Date.now()
);
test.after(() => rmSync(directory, { recursive: true, force: true }));

const TOKEN = "test-token";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Every call the fake API received, so a refusal can be proved to precede it. */
function apiDouble(calls) {
  return new Proxy(
    {
      getAgentAvatar({ id }) {
        calls.push(`getAgentAvatar:${id}`);
        return { dataUrl: `data:image/png;base64,${PNG}`, version: "v1" };
      },
    },
    {
      get(target, property) {
        if (property in target) return target[property];
        return (args) => {
          calls.push(`${String(property)}`);
          return { called: String(property) };
        };
      },
    },
  );
}

async function withServer(options, run) {
  const calls = [];
  const server = await startGatewayServer({
    api: apiDouble(calls),
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, busyOnlyAwaitingApproval: false, lastBusyAtMs: 7, pid: 4242, activeAgentId: "must-not-leak" }),
    startedAt: 1,
    prepareForUpgrade: async () => ({ quiescing: true, runningTurns: 0 }),
    localExec: { registerProvider: () => () => {}, submitResponses: () => {} },
    webauthn: { registerProvider: () => () => {}, submitResponses: () => {} },
    ...options,
  });
  try {
    return await run(server.port, calls);
  } finally {
    await server.close();
  }
}

/**
 * Reads at most one chunk and then destroys the socket, so an event stream cannot
 * hold the suite open. `safetyCeiling` bounds the whole send/receive.
 */
function send(port, method, target, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        headers: { ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }), ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(chunk);
          response.destroy();
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.setTimeout(4000, () => request.destroy(new Error("no answer within the safety ceiling")));
    request.on("error", reject);
    request.end(body);
  });
}

const authed = { authorization: `Bearer ${TOKEN}` };
const DATA_ROUTES = [
  ["POST", "/api/listAgents", "{}"],
  ["POST", "/api/setHostSettings", "{}"],
  ["POST", "/api/deleteAgents", "{}"],
  ["POST", "/prepare-upgrade", "{}"],
  ["POST", "/local-exec/responses", "{}"],
  ["POST", "/webauthn/responses", "{}"],
  ["GET", "/events", undefined],
  ["GET", "/local-exec/requests", undefined],
  ["GET", "/webauthn/requests", undefined],
  ["GET", "/avatars/agent-1", undefined],
];

test("no route that returns data answers a caller with no token", async () => {
  await withServer({ authToken: TOKEN }, async (port, calls) => {
    for (const [method, target, body] of DATA_ROUTES) {
      const answer = await send(port, method, target, {}, body);
      assert.equal(answer.status, 401, `${method} ${target} answered ${answer.status} with no Authorization header at all`);
    }
    assert.deepEqual(calls, [], "a route refused for want of a token still reached the host API");
  });
});

test("a wrong, a truncated and an over-long token are all refused", async () => {
  await withServer({ authToken: TOKEN }, async (port) => {
    for (const presented of ["Bearer " + "x".repeat(TOKEN.length), `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`, TOKEN, `Bearer `, `bearer ${TOKEN}`, `Bearer  ${TOKEN}`]) {
      const answer = await send(port, "POST", "/api/listAgents", { authorization: presented }, "{}");
      assert.equal(answer.status, 401, `the token ${JSON.stringify(presented)} was answered ${answer.status}`);
    }
    const good = await send(port, "POST", "/api/listAgents", authed, "{}");
    assert.equal(good.status, 200, `the correct token was refused with ${good.status}; ${good.body}`);
  });
});

test("GET /health is the one route that needs no token, and it names nothing", async () => {
  await withServer({ authToken: TOKEN }, async (port) => {
    const answer = await send(port, "GET", "/health");
    assert.equal(answer.status, 200, `the reachability probe answered ${answer.status}; every report would read as a dead host`);
    assert.doesNotMatch(answer.body, /must-not-leak|pid|activeAgent|machine/i,
      `the unauthenticated answer carries an identifier: ${answer.body}`);
  });
});

test("a route that carries no Origin is still refused when the browser marks it cross-site", async () => {
  await withServer({ authToken: TOKEN }, async (port, calls) => {
    for (const [method, target, body] of DATA_ROUTES) {
      const answer = await send(port, method, target, { ...authed, "sec-fetch-site": "cross-site" }, body);
      assert.equal(answer.status, 403, `${method} ${target} answered ${answer.status} for a request the browser labelled cross-site`);
    }
    assert.deepEqual(calls, [], "a cross-site request was refused after the host had already run the command");
  });
});

test("the cross-site label is refused whatever spelling it arrives in", async () => {
  await withServer({ authToken: TOKEN }, async (port) => {
    for (const value of ["cross-site", "CROSS-SITE", "Cross-Site", " cross-site "]) {
      const answer = await send(port, "GET", "/avatars/agent-1", { ...authed, "sec-fetch-site": value });
      assert.equal(answer.status, 403, `Sec-Fetch-Site: ${JSON.stringify(value)} was answered ${answer.status} with the avatar bytes`);
    }
  });
});

test("a same-origin, same-site or header-less request is not a cross-site request", async () => {
  await withServer({ authToken: TOKEN }, async (port) => {
    for (const value of ["same-origin", "same-site", "none", undefined]) {
      const answer = await send(port, "GET", "/avatars/agent-1", { ...authed, ...(value === undefined ? {} : { "sec-fetch-site": value }) });
      assert.equal(answer.status, 200, `Sec-Fetch-Site: ${value} answered ${answer.status}; the desktop's own loads carry no such header`);
    }
  });
});

test("every route refuses a request that carries an Origin, and no route answers cross-origin", async () => {
  await withServer({ authToken: TOKEN }, async (port) => {
    for (const [method, target, body] of [["GET", "/health", undefined], ...DATA_ROUTES]) {
      const answer = await send(port, method, target, { ...authed, origin: "http://attacker.example" }, body);
      assert.equal(answer.status, 403, `${method} ${target} answered ${answer.status} for a browser request that carried an Origin`);
      assert.equal(answer.headers["access-control-allow-origin"], undefined,
        `${method} ${target} handed a browser a CORS header, which turns the refusal into a readable answer`);
    }
  });
});

test("a gateway with no bearer token configured refuses every route instead of skipping the check", async () => {
  await withServer({ authToken: undefined }, async (port, calls) => {
    for (const [method, target, body] of DATA_ROUTES) {
      const answer = await send(port, method, target, {}, body);
      assert.equal(answer.status, 401, `${method} ${target} answered ${answer.status} on a server whose deps carry no token`);
    }
    assert.deepEqual(calls, [], "a server with no bearer token ran a host command for a caller that presented none");
  });
});

test("the local bridge keeps its own refusal sentence when no token is configured", async () => {
  await withServer({ authToken: undefined }, async (port) => {
    const local = await send(port, "POST", "/local-exec/responses", {}, "{}");
    assert.match(local.body, /local-exec/, `the local-exec refusal lost its sentence: ${local.body}`);
    const web = await send(port, "GET", "/webauthn/requests");
    assert.match(web.body, /webauthn/, `the webauthn refusal lost its sentence: ${web.body}`);
  });
});

test("a Host header that is not a hostname is not loopback", () => {
  for (const header of ["127.0.0.1\\.evil.example", "127.0.0.1/evil.example", "localhost\\@evil.example"]) {
    assert.notEqual(hostHeaderHostname({ headers: { host: header } }), "127.0.0.1",
      `Host: ${header} was read as loopback, and this is the check that stands in for the bearer token when one is absent`);
  }
  assert.equal(hostHeaderHostname({ headers: { host: "127.0.0.1:8790" } }), "127.0.0.1", "an ordinary loopback Host must still resolve");
});