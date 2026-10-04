import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The app still shipped as a Cursor client with a local mode bolted on. Three
// coupled defaults kept it that way and nothing threw, so nothing looked broken:
// the `sand_product_analytics` gate defaulted to true and every host start
// posted an event to api2.cursor.sh with no account; every feature gate pinned
// through `pinGateOnAuthenticatedBootstrap` stayed dead forever because a
// signed-out host can never complete an authenticated Statsig bootstrap; and both
// readers of the routing decision fell back to the "cursor" provider, so a fresh
// install sent every turn to an account-backed endpoint that can never answer.
// The renderer then opened the Router settings on "Cursor" and mounted the
// Cursor billing panel. A fatal startup failure compounded it: it was reported
// to telemetry only, so a host that could not reach Cursor exited 1 with nothing
// on stderr at all.
//
// These tests pin the local behaviour. The two that matter most are the ones
// that observe an outbound client never being constructed and a gate callback
// firing with no network at all: a default read out of a file proves nothing.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ANALYTICS_ENV_NAMES = ["SAND_DISABLE_TELEMETRY", "SAND_DISABLE_ANALYTICS"];

const savedEnv = {};
for (const name of ANALYTICS_ENV_NAMES) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
test.after(() => {
  for (const name of ANALYTICS_ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-only-"));
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
      // The analytics client reaches undici, which is CommonJS and calls
      // `require("assert")` from inside the bundle. Defining `require` for the
      // emitted ESM is what lets that interop resolve; without it the whole
      // product-analytics import dies on "Dynamic require of assert".
      banner: { js: 'import { createRequire as __sandCreateRequire } from "node:module"; const require = __sandCreateRequire(import.meta.url);' },
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["shared", "node", "experiments", "experiment-config.gen.ts"],
  ["shared", "node", "experiments", "cursor-experiments.ts"],
  ["shared", "node", "analytics", "product-analytics.ts"],
  ["shared", "node", "settings", "sand-settings-store.ts"],
]);
test.after(() => dispose());

const { FLAGS } = loaded["experiment-config.gen.mjs"];
const { SandExperimentService } = loaded["cursor-experiments.mjs"];
const { SandProductAnalytics } = loaded["product-analytics.mjs"];
const store = loaded["sand-settings-store.mjs"];

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "grok-local-only-case-"));
}

test("the product-analytics gate defaults to off in the shipped flag table", () => {
  assert.equal(
    FLAGS.sand_product_analytics.default,
    false,
    "the bundled default is the only value a signed-out host can ever read, so a true here ships an analytics event on every start",
  );
});

test("a signed-out host never constructs an analytics client, even with the gate readable", async () => {
  const cacheDir = scratch();
  let clientBuilt = 0;
  let tokensRequested = 0;
  const analytics = new SandProductAnalytics({
    hostInBox: false,
    getAccessToken: async () => {
      tokensRequested += 1;
      return "";
    },
    getMachineId: async () => "machine-local",
    createClient: () => {
      clientBuilt += 1;
      return { trackEvents: async () => undefined };
    },
  });
  // A gate that answers the bundled default, exactly as `checkFeatureGate` does
  // when no Statsig client has ever been hydrated.
  const gate = { checkGate: async (name) => FLAGS[name]?.default ?? false, subscribe: () => () => {} };
  await analytics.activate(gate);
  try {
    assert.equal(analytics.state.kind, "deferred", "the analytics buffer must stay local and bounded instead of going live");
    assert.equal(clientBuilt, 0, "no AnalyticsService client may be constructed, because that is the call that reaches api2.cursor.sh");
    assert.equal(tokensRequested, 0, "no credential may be requested on the way to an endpoint the user never opted into");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a gate pinned at host startup fires with no authenticated bootstrap and no network", () => {
  const cacheDir = scratch();
  let tokenRequests = 0;
  const service = new SandExperimentService({
    getAccessToken: async () => {
      tokenRequests += 1;
      return "";
    },
    getMachineId: async () => "machine-local",
    getCacheDir: () => cacheDir,
    // The packaged-build shape: overrides are disabled, so the bundled default
    // is the only value any reader can see.
    isDevBuild: false,
  });
  const pinned = [];
  let pinCalls = 0;
  try {
    assert.equal(
      service.hasAuthenticatedStatsigBootstrap(),
      false,
      "no Statsig bootstrap has run, which is the state a signed-out host is stuck in permanently",
    );
    service.pinGateOnAuthenticatedBootstrap("sand_stale_root_gc", (value) => {
      pinCalls += 1;
      pinned.push(value);
    });
    assert.ok(pinCalls > 0, "the pin callback must fire at startup; the old code only ever fired it from an authenticated bootstrap that never arrives locally");
    assert.equal(tokenRequests, 0, "resolving a bundled default must not touch the network for a credential");
    assert.deepEqual(
      pinned,
      [FLAGS.sand_stale_root_gc.default],
      "the pin must carry the bundled default, which is the only value a local host can read",
    );
    assert.equal(FLAGS.sand_stale_root_gc.default, true, "stale checkpoint-root cleanup is guarded, runs once per store, and is the one dead gate safe to switch on");
  } finally {
    service.dispose();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the three flags that can newly fail the user stay off in the shipped flag table", () => {
  assert.equal(
    FLAGS.grok_bot_conversation_gc.default,
    false,
    "conversation GC can throw SandConversationTooLargeError, a failure mode the user has never seen; it needs its own change",
  );
  assert.equal(
    FLAGS.sand_legacy_store_blob_retirement.default,
    false,
    "legacy blob retirement deletes rows from store.db and has never run in a shipped build",
  );
  assert.equal(
    FLAGS.sand_memory_dreaming.default,
    false,
    "memory dreaming calls the inference provider from the memory service and spends tokens on every session",
  );
});

test("a settings file with no routing key reads as the user's own endpoint", () => {
  const directory = scratch();
  try {
    const settings = new store.SandSettingsStore(path.join(directory, "settings.json"));
    assert.equal(
      settings.getInferenceProvider(),
      "custom",
      "a fresh install has no settings.json, and the old fallback routed every turn into Cursor",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an existing settings file without the routing key is migrated onto the user's own endpoint", () => {
  const directory = scratch();
  const settingsPath = path.join(directory, "settings.json");
  try {
    // A file written by a build that predates the local provider: the old
    // migration id is present, so the store's old early-return would have
    // skipped every migration added afterwards.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...store.emptySettings(),
        settingsMigrations: ["downgrade-persisted-max-fast"],
      }),
      "utf8",
    );
    const settings = new store.SandSettingsStore(settingsPath);
    assert.equal(
      settings.getInferenceProvider(),
      "custom",
      "a store that already carries the first migration id must still receive the provider migration",
    );
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(
      onDisk.inferenceProvider,
      "custom",
      "the migration has to persist the key, or every later read falls back again",
    );
    assert.deepEqual(
      onDisk.settingsMigrations,
      ["downgrade-persisted-max-fast", "local-inference-provider"],
      "the migration id must be recorded exactly once so a second load is a no-op",
    );
    const second = new store.SandSettingsStore(settingsPath);
    assert.equal(second.getInferenceProvider(), "custom", "a migrated store stays on the local provider across reloads");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit provider choice is left alone by the migration", () => {
  const directory = scratch();
  const settingsPath = path.join(directory, "settings.json");
  try {
    writeFileSync(settingsPath, JSON.stringify({ ...store.emptySettings(), inferenceProvider: "openrouter" }), "utf8");
    const settings = new store.SandSettingsStore(settingsPath);
    assert.equal(
      settings.getInferenceProvider(),
      "openrouter",
      "the migration fills an absent key only; rewriting a value the user chose would be a different decision",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- Renderer -----------------------------------------------------------------
// The renderer is checksum-pinned, so these are guards over the injected source
// rather than edits. A guard that finds nothing is a failing test, so each one
// counts its matches first.

const require = createRequire(path.join(repoRoot, "package.json"));
const acorn = require("acorn");
const { COMPONENT_SOURCE } = await import(
  pathToFileURL(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs")).href
);

test("the injected Router panel offers no Cursor provider and mounts no billing panel", () => {
  acorn.parse(COMPONENT_SOURCE, { ecmaVersion: "latest" });
  assert.ok(
    COMPONENT_SOURCE.includes("RRouterProviders"),
    "the guard must find the provider table it is about to inspect, or it proves nothing",
  );
  assert.ok(
    COMPONENT_SOURCE.includes('de.useState({provider:"custom"'),
    "the panel must open on the local provider; it used to flash \"Cursor\" before the async read resolved",
  );
  assert.equal(
    COMPONENT_SOURCE.includes('value:"cursor"'),
    false,
    "the Cursor provider entry routes a turn into an account-backed endpoint that can never answer",
  );
  assert.equal(
    COMPONENT_SOURCE.includes("a.jsx(Na,{})"),
    false,
    "the original Cursor usage/billing panel must not be mounted",
  );
  assert.equal(
    /provider:"cursor"/.test(COMPONENT_SOURCE),
    false,
    "no Router state may be seeded with the Cursor provider",
  );
});

test("the endpoint model picker survives the provider removal", () => {
  assert.equal(
    COMPONENT_SOURCE.includes("Endpoint model list"),
    true,
    "the model picker's aria-label is a shipped invariant and must survive removing the Cursor entry",
  );
  assert.ok(
    COMPONENT_SOURCE.includes("RRouterFallbackModels"),
    "the fallback model list is a shipped invariant and must survive removing the Cursor entry",
  );
});

// --- Fatal startup reporting --------------------------------------------------

test("a fatal startup failure is written to stderr before it is reported to telemetry", () => {
  const source = readFileSync(path.join(repoRoot, "source", "host", "main.ts"), "utf8");
  const reported = source.indexOf('host.reportProcessCrash(error, "fatal_startup")');
  assert.ok(reported > 0, "the guard must find the fatal startup report it is about to order against");
  const start = source.lastIndexOf("catch (error) {", reported);
  const logged = source.indexOf('log.error("[sand-host] fatal startup failure:"', start);
  assert.ok(logged > start, "a fatal startup failure must reach stderr; telemetry alone left a silent exit code 1");
  assert.ok(logged < reported, "the stderr line has to come first, so the cause survives a telemetry flush that never returns");
});