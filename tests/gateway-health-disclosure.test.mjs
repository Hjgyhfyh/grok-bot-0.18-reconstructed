import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `GET /health` answered before the bearer check and answered with the host's
// `pid` and the `activeAgentId` of whatever the user was last doing. One token
// governs roughly 124 commands here, and that token sits in plaintext in
// `<root>\gateway.json`, so the loopback port is reachable by anything running
// as this user -- including the agent itself. An unauthenticated probe could
// therefore learn which process to signal and which agent to target before it
// ever presented a credential. `gateway-config` cannot close this: the handler
// runs first, so no configuration makes the response stop leaking.
//
// The constraint the fix must NOT break is liveness. The supervisor probes
// `/health` with no `Authorization` header at all (`fetchHealth` in
// `source/node-agent-coordinator/gateway/host-supervisor.ts`), so demanding the
// token here would turn every reachability report into a 401. The tests below
// build the real handler with esbuild, serve it over a real socket, and assert
// both halves: the probe still answers 200 with no token, and what it answers
// with is enough to say alive-or-busy and nothing that names a process or a user.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-health-disclosure-"));
test.after(() => rmSync(directory, { recursive: true, force: true }));
const outfile = path.join(directory, "gateway-server.mjs");
await build({
  entryPoints: [path.join(repoRoot, "source", "host", "gateway-server.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { startGatewayServer } = await import(pathToFileURL(outfile).href + "?" + Date.now());

const TOKEN = "health-probe-token-".padEnd(43, "z");
const SECRET_AGENT_ID = "0f9a2c1e-7b4d-4a6f-9c33-5e8d1b7a4f02";

async function serveHealth(health) {
  const gateway = await startGatewayServer({
    api: { getAgentAvatar: () => ({ dataUrl: null, version: null }) },
    subscribe: () => () => {},
    getHealth: () => health,
    startedAt: 1_700_000_000_000,
    authToken: TOKEN,
  });
  return {
    url: `http://127.0.0.1:${gateway.port}`,
    close: () => gateway.close(),
  };
}

function probe(url, options) {
  return fetch(`${url}/health`, options);
}

test("a liveness probe with no Authorization header still answers 200", async () => {
  const server = await serveHealth({ isBusy: false, activeAgentId: null, lastBusyAtMs: 5 });
  try {
    const response = await probe(server.url);
    assert.equal(response.status, 200, "the supervisor probes /health with no token; a 401 here erases all gateway reachability reporting");
    const body = await response.json();
    assert.equal(body.ok, true, "the probe answers 200 but not ok, so the supervisor reads it as unreachable");
  } finally {
    await server.close();
  }
});

test("the unauthenticated health body names neither the process nor the active agent", async () => {
  const server = await serveHealth({
    isBusy: true,
    busyOnlyAwaitingApproval: false,
    activeAgentId: SECRET_AGENT_ID,
    lastBusyAtMs: 1_700_000_123_456,
  });
  try {
    const response = await probe(server.url);
    const text = await response.text();
    const body = JSON.parse(text);

    assert.ok(
      !Object.hasOwn(body, "pid"),
      "the unauthenticated /health body still carries the host pid, which is the process id to signal",
    );
    assert.ok(
      !Object.hasOwn(body, "activeAgentId"),
      "the unauthenticated /health body still carries activeAgentId, which is the agent a caller would then target",
    );
    assert.ok(!text.includes(SECRET_AGENT_ID), "the active agent id is still somewhere in the unauthenticated body, under a different key");
    assert.ok(!text.includes(String(process.pid)), "the host pid is still somewhere in the unauthenticated body, under a different key");
    assert.equal(body.isBusy, true, "the busy flag was dropped instead of the identifiers, so the probe can no longer say busy");
  } finally {
    await server.close();
  }
});

test("the health body keeps the fields the liveness probe actually reads", async () => {
  const server = await serveHealth({
    isBusy: false,
    busyOnlyAwaitingApproval: true,
    activeAgentId: SECRET_AGENT_ID,
    lastBusyAtMs: 1_700_000_123_456,
  });
  try {
    const response = await probe(server.url);
    const body = await response.json();
    for (const field of ["ok", "isBusy", "busyOnlyAwaitingApproval", "startedAt", "lastBusyAtMs"]) {
      assert.ok(Object.hasOwn(body, field), `/health stopped answering ${field}, which is what the reachability probe reads`);
    }
    assert.deepEqual(
      Object.keys(body).sort(),
      ["busyOnlyAwaitingApproval", "isBusy", "lastBusyAtMs", "ok", "startedAt"],
      "the unauthenticated body grew or lost a field beyond the two identifiers being removed",
    );
  } finally {
    await server.close();
  }
});

test("moving the health handler did not open the authenticated surface", async () => {
  const server = await serveHealth({ isBusy: false, activeAgentId: null });
  try {
    const anonymousCommand = await fetch(`${server.url}/api/listAgents`, { method: "POST", body: "{}" });
    assert.equal(anonymousCommand.status, 401, "a gateway command ran with no bearer token");

    const wrongToken = await probe(server.url, { headers: { authorization: `Bearer ${"x".repeat(43)}` } });
    assert.equal(wrongToken.status, 200, "/health ignores the token, which is required for the liveness probe");

    const anonymousEvents = await fetch(`${server.url}/events`, { headers: { accept: "text/event-stream" } });
    assert.equal(anonymousEvents.status, 401, "the event stream opened with no bearer token");
    await anonymousEvents.body?.cancel();
  } finally {
    await server.close();
  }
});
