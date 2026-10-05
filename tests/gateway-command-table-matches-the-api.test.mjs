import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The two halves of the gateway surface were checked by reading, never by
 * running, and the product has shipped that failure before: the custom-model
 * picker called `listInferenceRouterModels`, which was absent from the command
 * table, `bridgeRpcEdge` built no function for it, the renderer caught the
 * `TypeError`, showed a "network error" state and fell back to a list of 33
 * model ids baked into a patch. The dropdown looked perfect and worked for
 * nothing.
 *
 * Both directions are silent here. A method implemented in
 * `createHostGatewayApi` but absent from `SAND_GATEWAY_COMMANDS` answers
 * `404 unknown gateway method: <name>` — no throw, no warning, and the
 * implementation sits right there looking finished. A command in the table with
 * no method behind it throws `host extension method is unavailable: <name>` only
 * when somebody calls it.
 *
 * The lists here are never hand-written. Both sides are read out of the modules:
 * the command table from the built bundle, the method set from an API object
 * built over a recording double, so a method added on either side moves this
 * test with it. A hand-written list goes stale the moment a method is added and
 * then the guard stops guarding — which is the defect it was written to catch.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-surface-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "host-gateway-api.ts"],
  ["host", "gateway-protocol.ts"],
]);
const { createHostGatewayApi } = loaded["host-gateway-api.mjs"];
const { SAND_GATEWAY_COMMANDS, SAND_GATEWAY_SLIM_COMMANDS } = loaded["gateway-protocol.mjs"];
test.after(() => dispose());

/** The real API object, built over a double that answers whatever is asked of it. */
function buildApi() {
  const record = (name) => (...args) => {
    if (name === "listTools") return [];
    if (name === "listAgents") return [];
    if (name === "listAgentsSync") return [];
    if (name === "getAgentAutomations" || name === "createAgentAutomation") return [];
    return undefined;
  };
  const proxy = new Proxy({}, { get: (_target, name) => record(String(name)) });
  const telemetryApi = new Proxy(
    { analytics: proxy },
    {
      get: (target, name) => (typeof name === "symbol"
        ? Reflect.get(target, name)
        : name in target
          ? target[name]
          : record(String(name))),
    },
  );
  return createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "mcp") return { mcp: {}, management: {}, listBoxServers: async () => [] };
        if (id === "telemetry") return telemetryApi;
        return proxy;
      },
    },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
}

const missing = (from, inSet) => [...from].filter((name) => !inSet.has(name)).sort();

test("the two sides of the gateway surface were actually read", () => {
  const api = buildApi();
  const implemented = Object.keys(api);
  const registered = Object.keys(SAND_GATEWAY_COMMANDS);
  assert.ok(implemented.length >= 100,
    `the API object offered only ${implemented.length} methods, so this guard is measuring a broken double rather than the product`);
  assert.ok(registered.length >= 100,
    `the command table holds only ${registered.length} commands, so this guard is measuring a broken bundle rather than the product`);
  assert.ok(Object.keys(SAND_GATEWAY_SLIM_COMMANDS).length > 0,
    "the slim command table came back empty, so the two halves can be compared for nothing");
});

test("every method the API implements is reachable as a gateway command", () => {
  const api = buildApi();
  const unregistered = missing(new Set(Object.keys(api)), new Set(Object.keys(SAND_GATEWAY_COMMANDS)));
  assert.deepEqual(unregistered, [],
    `these methods are implemented in createHostGatewayApi and no caller can reach them: ${unregistered.join(", ")}. A gateway command answers 404 unknown gateway method, so the implementation looks finished and works for nothing.`);
});

test("every gateway command has a method behind it", () => {
  const api = buildApi();
  const unimplemented = missing(new Set(Object.keys(SAND_GATEWAY_COMMANDS)), new Set(Object.keys(api)));
  assert.deepEqual(unimplemented, [],
    `these commands are in SAND_GATEWAY_COMMANDS and nothing implements them: ${unimplemented.join(", ")}. They fail only when somebody calls them.`);
});

test("the slim command table names no command the full table does not", () => {
  const slimOnly = missing(new Set(Object.keys(SAND_GATEWAY_SLIM_COMMANDS)), new Set(Object.keys(SAND_GATEWAY_COMMANDS)));
  assert.deepEqual(slimOnly, [],
    `the slim table carries ${slimOnly.join(", ")}, which the full dispatcher never routes, so a slim caller gets 404 for a command the protocol claims it has`);
});

test("a command really is reachable end to end through the table", async () => {
  // The guard above compares two name sets. This one proves the plumbing behind
  // the names: a command from the table, invoked the way the dispatcher invokes
  // it, reaches the API method of the same name.
  const api = buildApi();
  for (const name of ["listAgents", "countAgents"]) {
    assert.equal(typeof SAND_GATEWAY_COMMANDS[name], "function",
      `the command table has no function for ${name}, so the guard above compared two name sets that do not describe a router`);
    assert.equal(typeof api[name], "function",
      `${name} is routable but has nothing behind it`);
  }
  const called = [];
  const spy = new Proxy(api, { get: (target, name) => (...args) => { called.push(String(name)); return target[name]?.(...args); } });
  await SAND_GATEWAY_COMMANDS.listAgents(spy);
  assert.deepEqual(called, ["listAgents"],
    `the dispatcher reached ${JSON.stringify(called)} instead of the one method it names, so the table and the API are not wired together`);
});