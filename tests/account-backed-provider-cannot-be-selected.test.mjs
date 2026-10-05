import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The renderer stopped offering the account-backed provider, so a settings file
// naming it looked unreachable and nothing guarded it. It was reachable. The
// routing value is read in five places across the host and the coordinator, every
// one of them branching on `=== "cursor"` to build a session for a hosted model
// on an account this build never signs in to, and the settings store returned the
// stored string untouched. The `local-inference-provider` migration could not
// close it either: it fills an absent key with `?? "custom"`, so a file that
// already said "cursor" kept saying it forever. Nothing threw and nothing looked
// broken — `getAccessProvider()` was read as proof the provider was inert, which
// proves only that the value survived, not that any branch was closed.
//
// These tests pin the refusal where the decision is made. The value is refused at
// the single reader every routing decision shares, so no branch downstream has to
// be trusted, and the enum member itself is kept so a file written by an earlier
// build still parses against the same schema.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-account-provider-"));
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
      banner: { js: 'import { createRequire as __sandCreateRequire } from "node:module"; const require = __sandCreateRequire(import.meta.url);' },
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["shared", "inference-router.ts"],
  ["shared", "node", "settings", "sand-settings-store.ts"],
]);
test.after(() => dispose());

const router = loaded["inference-router.mjs"];
const store = loaded["sand-settings-store.mjs"];

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "grok-account-provider-case-"));
}

function writeSettings(settingsPath, overrides) {
  writeFileSync(settingsPath, JSON.stringify({ ...store.emptySettings(), ...overrides }), "utf8");
}

// --- The enum member ---------------------------------------------------------

test("the account-backed provider stays a member so an older settings file still parses", () => {
  assert.ok(
    router.SAND_INFERENCE_PROVIDERS.includes("cursor"),
    "deleting the member would reject a settings file written by an earlier build, and would turn the two Exclude guards into the full union with no compiler signal",
  );
  assert.equal(
    router.isSandInferenceProvider("cursor"),
    true,
    "the persisted schema still has to accept the value in order to refuse it in a way the user can be told about",
  );
  assert.equal(
    router.isServedSandInferenceProvider("cursor"),
    false,
    "a provider this build cannot answer a turn with is not a provider a turn may be routed to",
  );
});

test("every provider a turn may be routed to is one the build can actually serve", () => {
  const served = router.SAND_INFERENCE_PROVIDERS.filter((provider) => router.isServedSandInferenceProvider(provider));
  assert.ok(served.length > 0, "a guard that refuses everything would look identical to a guard that works");
  assert.equal(
    served.includes("cursor"),
    false,
    "the account-backed member must not survive into the served set",
  );
  assert.deepEqual(
    served,
    ["claude-code", "codex", "openrouter", "custom"],
    "the served set is every member except the one that needs an account",
  );
});

// --- The refusal -------------------------------------------------------------

test("a stored account-backed provider is refused by the reader, not only by the migration", () => {
  const directory = scratch();
  try {
    const settingsPath = path.join(directory, "settings.json");
    // The migration rewrites the file, so testing the refusal on an earlier build's
    // file proves nothing: the migration answers it either way. This file claims
    // every shipped migration id already ran, which is the only shape that isolates
    // the reader. It is reachable in practice because a migration id on disk
    // records that a migration ran; it is not permission to honour a value that
    // migration would have rewritten.
    writeSettings(settingsPath, {
      settingsMigrations: [...store.SAND_SETTINGS_MIGRATION_IDS],
      inferenceProvider: "cursor",
    });
    const settings = new store.SandSettingsStore(settingsPath);
    assert.equal(
      settings.getInferenceProvider(),
      "custom",
      "this is the value every host branch tests, so returning it hands the turn to the account-backed session factory",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the account-backed provider is never written back to disk", () => {
  const directory = scratch();
  try {
    const settingsPath = path.join(directory, "settings.json");
    const settings = new store.SandSettingsStore(settingsPath);
    settings.setInferenceProvider("cursor");
    assert.equal(
      JSON.parse(readFileSync(settingsPath, "utf8")).inferenceProvider,
      "custom",
      "refusing only on read would leave the panel showing a provider the store never agreed to",
    );
    assert.equal(
      settings.getInferenceProvider(),
      "custom",
      "the refused value must not come back on the next read",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the migration rewrites a persisted account-backed provider for a file from an earlier build", () => {
  const directory = scratch();
  try {
    const settingsPath = path.join(directory, "settings.json");
    writeSettings(settingsPath, {
      settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider"],
      inferenceProvider: "cursor",
    });
    new store.SandSettingsStore(settingsPath).getInferenceProvider();
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(
      onDisk.inferenceProvider,
      "custom",
      "the reader refuses the value, so only the file rewriting stops it from claiming a route that was never taken",
    );
    assert.ok(
      onDisk.settingsMigrations.includes(store.SAND_RETIRE_ACCOUNT_BACKED_PROVIDER_MIGRATION_ID),
      "the id has to be recorded or the migration re-runs on every load",
    );
    assert.equal(
      new store.SandSettingsStore(settingsPath).getInferenceProvider(),
      "custom",
      "a migrated store stays on the local provider across reloads",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a provider the user can actually serve is left alone by the refusal", () => {
  const directory = scratch();
  try {
    const settingsPath = path.join(directory, "settings.json");
    writeSettings(settingsPath, { inferenceProvider: "openrouter" });
    const settings = new store.SandSettingsStore(settingsPath);
    assert.equal(
      settings.getInferenceProvider(),
      "openrouter",
      "a guard that refuses everything would break every route that does work, which is not the same as being safe",
    );
    settings.setInferenceProvider("codex");
    assert.equal(
      new store.SandSettingsStore(settingsPath).getInferenceProvider(),
      "codex",
      "a choice that can be served must still survive a write",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- The branches the refusal has to cover -----------------------------------

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

test("every host branch that would select an account-backed session reads the routing decision from the store", () => {
  // Only a comparison against a provider-shaped value, and the prefix is optional
  // because half the sites bind the bare name `provider`. `schema === "cursor"` in
  // the plugin loader is a hooks-schema discriminator with nothing to do with
  // routing, and a guard loose enough to match it would flag files for the wrong
  // reason.
  const comparesProviderToCursor = /(?:[A-Za-z_$][\w$]*)?[Pp]rovider[\w$]*\s*(?:===|!==)\s*"cursor"/;
  const readsTheStore = /getInferenceProvider/;
  const branchSites = sourceFiles(path.join(repoRoot, "source"))
    .filter((file) => comparesProviderToCursor.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"));

  assert.ok(
    branchSites.length > 0,
    "a static guard that finds no branch proves nothing; the branches moved or were renamed",
  );
  for (const relative of branchSites) {
    assert.match(
      readFileSync(path.join(repoRoot, relative), "utf8"),
      readsTheStore,
      `${relative} branches on the account-backed provider without reading the store, so it is not covered by the single refusal`,
    );
  }
  // Named so a future branch added outside the store shows up as a diff, not as a
  // silent new way to reach the cloud.
  assert.deepEqual(
    branchSites.sort(),
    [
      "source/host/extensions/inference/cursor-session.ts",
      "source/host/extensions/inference/inference-service.ts",
      "source/host/runner/turn-run-shell.ts",
      "source/node-agent-coordinator/inference-router.ts",
      "source/shared/node/cursor-backend/cursor-inference.ts",
    ],
    "the set of places that select the account-backed provider changed; re-check that each one reads the refused value",
  );
});

test("an existing installation's usage record still parses against the kept enum member", () => {
  const usage = router.emptySandInferenceRouterUsage();
  assert.ok(
    Object.hasOwn(usage.providers, "cursor"),
    "the persisted per-provider usage record is keyed by the enum, so dropping the member would silently discard a stored counter",
  );
  assert.deepEqual(
    Object.keys(usage.providers).sort(),
    [...router.SAND_INFERENCE_PROVIDERS].sort(),
    "the usage record and the enum have to stay the same set or an old file loses a key on the next write",
  );
});
