import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// `resolveGatewayServerConfig` computed `requireAuth` from three conditions and
// every one of them could be false at once: `SAND_GATEWAY_BIND_HOST=0.0.0.0`
// with no `SAND_GATEWAY_TOKEN` produced `requireAuth === false`, so `authToken`
// came back `undefined` and the bearer check in `gateway-server.ts` was skipped
// for all ~124 host commands. The LAN scenario was the *only* scenario that
// needed the token, and it was the one scenario that silently dropped it. The
// test now proves the token is mandatory on every bind address, and that a
// loopback box keeps working with the token the launcher generated.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-auth-"));
test.after(() => rmSync(directory, { recursive: true, force: true }));
const outfile = path.join(directory, "gateway-config.mjs");
await build({
  entryPoints: [path.join(repoRoot, "source", "host", "gateway-config.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const { resolveGatewayServerConfig } = await import(pathToFileURL(outfile).href + "?" + Date.now());

test("a non-loopback bind without a pinned token still gets a generated token", () => {
  const config = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: "0.0.0.0", SAND_HOST_PORT: "1340" });
  assert.equal(
    typeof config.authToken,
    "string",
    "binding the gateway to the LAN with no pinned token disabled authentication entirely, so every host command was open to the network",
  );
  assert.ok(
    config.authToken.length >= 32,
    "a two-character guessable token would not be a bearer credential",
  );
});

test("a wildcard bind address is not treated as loopback", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
    const config = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: host });
    assert.ok(
      typeof config.authToken === "string" && config.authToken.length > 0,
      `${host} is reachable from another machine, so it must never come back without a bearer token`,
    );
  }
});

test("loopback still authenticates, which is what the launcher and the desktop depend on", () => {
  const config = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: "127.0.0.1", SAND_HOST_PORT: "8790" });
  assert.equal(
    typeof config.authToken,
    "string",
    "loopback came back unauthenticated, so the launcher's generated token had nothing to match against",
  );
  assert.ok(config.authToken.length >= 32, "the loopback token must still be unguessable");
});

test("a pinned token survives unchanged so the stored gateway.json token keeps working", () => {
  const pinned = "a".repeat(43);
  const config = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: "127.0.0.1", SAND_GATEWAY_TOKEN: pinned });
  assert.equal(config.authToken, pinned, "the launcher wrote this token into gateway.json and the desktop reads it back from there");
});

test("SAND_GATEWAY_REQUIRE_AUTH cannot be used to switch the check off", () => {
  const config = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: "127.0.0.1", SAND_GATEWAY_REQUIRE_AUTH: "0" });
  assert.equal(
    typeof config.authToken,
    "string",
    "an environment variable could turn authentication off again, which is the same defect under a different name",
  );
});

test("two resolutions produce two different tokens", () => {
  const first = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: "127.0.0.1" });
  const second = resolveGatewayServerConfig({ SAND_GATEWAY_BIND_HOST: "127.0.0.1" });
  assert.notEqual(first.authToken, second.authToken, "a fixed token would be a published token, which is the defect being closed");
});
