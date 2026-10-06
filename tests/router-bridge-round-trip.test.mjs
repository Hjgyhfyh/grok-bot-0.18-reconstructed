/*
  The account-backed provider must not survive anywhere as a value, and the settings round-trip
  must not lose the provider the user actually chose.

  `cursor` is the one member of `SAND_INFERENCE_PROVIDERS` this build cannot serve. It is kept in
  the enum so an older settings file still parses, and every reader of the stored setting is
  supposed to pass through `resolveServedInferenceProvider`. Two things were worth proving rather
  than assuming, because both had a silent failure mode:

  `setInferenceRouter` is a live bridge method whose only provider check is `isSandInferenceProvider`,
  and that check *accepts* `cursor`. So the refusal cannot happen on the way in: it has to happen
  on the way out, in the value handed back to the panel and in the value pushed to the box. A
  refusal that only rewrote the local store would leave the box routing to an account-backed
  session this build cannot construct, and would hand the panel back a route no turn ever took.

  `tests/account-backed-provider-cannot-be-selected.test.mjs` already owns the store-level half —
  the enum, the reader, the persisted rewrite and the migration. This file owns the half that
  file cannot reach: the bridge handlers, and a settings round-trip that goes save → panel read →
  box store.

  These tests execute the real `main-edge` handlers against a real `SandSettingsStore` over a
  real temp settings file, rather than reading source text.
*/

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ACCOUNT_BACKED = "cursor";
const SERVED = ["claude-code", "codex", "openrouter", "custom"];
const ENDPOINT = { baseUrl: "https://api.example.com/v1", modelId: "round-trip-model" };

let settingsModule;
let mainEdgeModule;
let workspace;

async function loadAll() {
  const buildTo = async (entry, name) => {
    const out = path.join(workspace, name);
    await build({ entryPoints: [path.join(repoRoot, entry)], outfile: out, bundle: true, format: "esm", platform: "node", target: "node22" });
    return import(`${pathToFileURL(out).href}?${Date.now()}${name}`);
  };
  settingsModule = await buildTo(path.join("source", "shared", "node", "settings", "sand-settings-store.ts"), "settings.mjs");
  mainEdgeModule = await buildTo(path.join("source", "electron-main", "main-edge.ts"), "main-edge.mjs");
}

test.before(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "grok-router-provider-"));
  await loadAll();
});

test.after(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

/** A store over a settings file that is written first, so the file exists. */
async function freshStoreFile(name) {
  const settingsPath = path.join(workspace, name);
  await writeFile(settingsPath, JSON.stringify({ version: 1 }, null, 2), "utf8");
  return settingsPath;
}

function makeStore(settingsPath) {
  return new settingsModule.SandSettingsStore(settingsPath);
}

/** Main-edge handlers wired to a desktop store and a stand-in box store. */
function handlersFor(desktopStore, box) {
  const nullProxy = new Proxy({}, { get: () => () => null });
  const pushed = [];
  const deps = {
    readLiveUpdateService: () => null,
    readThemeController: () => null,
    readEgressTunnelController: () => null,
    settingsStore: desktopStore,
    agentPrefsStore: nullProxy,
    boxToggleStore: nullProxy,
    onboardingSeen: nullProxy,
    shell: nullProxy,
    boxRecovery: nullProxy,
    windowChrome: nullProxy,
    avatarImages: nullProxy,
    attachments: nullProxy,
    cursorAccount: nullProxy,
    experiments: nullProxy,
    syncHostSettingsToBox: async (settings) => {
      pushed.push(settings);
      if (box.reachable === false) return null;
      box.applied.push(settings);
      // What `SettingsService.setHostSettings` does on the far side of the wire. The endpoint is
      // handed over with its `fallbackModelId` key intact — including `null` — because that key is the
      // one instruction the box store needs, and a stub that strips it would silently pass a test
      // about clearing the spare.
      if (settings.inferenceProvider !== undefined) box.store.setInferenceProvider(settings.inferenceProvider);
      if (settings.inferenceCustomEndpoint === null) box.store.setInferenceCustomEndpoint(undefined);
      else if (settings.inferenceCustomEndpoint !== undefined) box.store.setInferenceCustomEndpoint(settings.inferenceCustomEndpoint);
      return {
        inferenceProvider: box.store.getInferenceProvider(),
        inferenceCustomEndpoint: box.store.getInferenceCustomEndpoint() ?? null,
        inferenceRouterUsage: null,
      };
    },
    readHostSettingsFromBox: async () => ({
      inferenceProvider: box.store.getInferenceProvider(),
      inferenceCustomEndpoint: box.store.getInferenceCustomEndpoint() ?? null,
    }),
    recordLocalToolApproval: async () => {},
    clearLocalToolApprovals: async () => {},
    getComputerUseModelOverride: () => undefined,
    fetchAvailableModels: () => [],
    emitEgressTunnelChanged: () => {},
    emitWebauthnProxyChanged: () => {},
    ensureTranscriptionManager: async () => ({}),
    platform: "win32",
    delay: async () => {},
  };
  return { handlers: mainEdgeModule.createMainEdgeHandlers(deps), pushed };
}

test("saving the account-backed provider answers and pushes the fallback, never the account-backed value", async () => {
  const boxStore = makeStore(await freshStoreFile("box-account.json"));
  const desktopSettingsPath = await freshStoreFile("desktop-account.json");
  const desktop = makeStore(desktopSettingsPath);
  const box = { store: boxStore, reachable: true, applied: [] };
  const { handlers, pushed } = handlersFor(desktop, box);

  const result = await handlers.setInferenceRouter({ provider: ACCOUNT_BACKED, endpoint: ENDPOINT });

  assert.equal(result.provider, "custom", "the panel must be told the fallback, not a route no turn can take");
  assert.notEqual(result.provider, ACCOUNT_BACKED, "the account-backed provider must not be handed back as the current route");
  for (const update of pushed) {
    assert.notEqual(update.inferenceProvider, ACCOUNT_BACKED, "the account-backed provider must never be pushed at the box");
  }
  assert.equal(desktop.getInferenceProvider(), "custom", "and the desktop store must hold the fallback too");
});

test("the settings round-trip keeps every served provider, from the panel save to the panel read", async () => {
  const boxStore = makeStore(await freshStoreFile("box-roundtrip.json"));
  const desktopSettingsPath = await freshStoreFile("desktop-roundtrip.json");
  const desktop = makeStore(desktopSettingsPath);
  const box = { store: boxStore, reachable: true, applied: [] };
  const { handlers } = handlersFor(desktop, box);

  for (const provider of SERVED) {
    const saved = await handlers.setInferenceRouter({ provider, endpoint: ENDPOINT });
    assert.equal(saved.provider, provider, `saving ${provider} must answer with ${provider}, not with a different route`);

    const readBack = await handlers.getInferenceRouter();
    assert.equal(readBack.provider, provider, `the round-trip lost ${provider}: the panel saved one route and read another`);
    assert.deepEqual(readBack.endpoint, ENDPOINT, `the round-trip lost the endpoint saved alongside ${provider}`);

    // A second store instance over the same file is what the next process start sees.
    assert.equal(makeStore(desktopSettingsPath).getInferenceProvider(), provider, `${provider} did not survive the settings file`);

    // And the box, which is a separate store in a real deployment.
    assert.equal(boxStore.getInferenceProvider(), provider, `${provider} did not reach the box store`);
  }
});

test("a save that cannot reach the box leaves the stored route exactly as it was", async () => {
  const boxStore = makeStore(await freshStoreFile("box-unreachable.json"));
  const desktopSettingsPath = await freshStoreFile("desktop-unreachable.json");
  const desktop = makeStore(desktopSettingsPath);
  desktop.setInferenceCustomEndpoint(ENDPOINT);
  desktop.setInferenceProvider("openrouter");
  const box = { store: boxStore, reachable: false, applied: [] };
  const { handlers } = handlersFor(desktop, box);

  await assert.rejects(
    handlers.setInferenceRouter({ provider: "codex", endpoint: ENDPOINT }),
    (error) => {
      assert.match(String(error.message), /Couldn't reach the computer/i, "an unreachable box must say so rather than report a saved route");
      return true;
    },
  );

  assert.equal(desktop.getInferenceProvider(), "openrouter", "a save that failed must not leave the previous route half-written");
  assert.deepEqual(desktop.getInferenceCustomEndpoint(), ENDPOINT, "and must not drop the endpoint it already had");
  assert.equal(boxStore.getInferenceProvider(), "custom", "the box must not have taken a partial write either");
});

/*
  The Router panel's Save sends `{ baseUrl, modelId }` — no spare — so an ordinary Save of an
  already-demoted endpoint used to delete the spare, make the demotion unreachable, and put the next
  turn back on the model the user had just watched fail.

  This file owns the half the store-level test cannot reach: the two bridge legs. `main-edge` used to
  normalise the request through `normalizeSandInferenceCustomEndpoint` before the store ever saw it,
  which threw away the distinction between "the panel said nothing about the spare" and "the panel
  cleared the spare". It also echoed its own normalised object back to the panel and pushed it at the
  box, so both copies of the route agreed on the wrong answer. The test below drives the real handler
  against a real desktop store and a real box store, with the panel's own payload shape, and checks
  all three legs: the desktop file, the panel read, and what reached the box.
*/
test("an ordinary panel Save keeps the spare the stored endpoint already had", async () => {
  const SPARE = "deepseek-v4.1-flash";
  const demotedEndpoint = { baseUrl: "https://api.example.com/v1", modelId: "space-bunny", fallbackModelId: SPARE };
  const boxStore = makeStore(await freshStoreFile("box-keep-spare.json"));
  const desktopSettingsPath = await freshStoreFile("desktop-keep-spare.json");
  const desktop = makeStore(desktopSettingsPath);
  desktop.setInferenceCustomEndpoint(demotedEndpoint);
  desktop.setInferenceCustomModelDemotion({ fromModelId: "space-bunny", toModelId: SPARE, reason: "model_not_found", httpStatus: 400, at: new Date().toISOString() });
  boxStore.setInferenceCustomEndpoint(demotedEndpoint);
  boxStore.setInferenceCustomModelDemotion({ fromModelId: "space-bunny", toModelId: SPARE, reason: "model_not_found", httpStatus: 400, at: new Date().toISOString() });
  const box = { store: boxStore, reachable: true, applied: [] };
  const { handlers, pushed } = handlersFor(desktop, box);

  // Exactly what `RRouterCredential`'s save handler builds.
  const saved = await handlers.setInferenceRouter({ provider: "custom", endpoint: { baseUrl: "https://api.example.com/v1", modelId: "space-bunny" } });

  assert.equal(saved.endpoint?.fallbackModelId, SPARE, "the panel was handed back an endpoint with its spare deleted");
  assert.equal(saved.endpoint?.fallbackModelId, makeStore(desktopSettingsPath).getInferenceCustomEndpoint()?.fallbackModelId, "the panel read and the desktop file disagree about the spare");
  assert.equal(makeStore(desktopSettingsPath).getInferenceCustomModelDemotion()?.toModelId, SPARE, "the ordinary Save made the demotion unreachable, so the next turn asks for the retired model again");
  assert.equal(boxStore.getInferenceCustomEndpoint()?.fallbackModelId, SPARE, "the box was sent an endpoint with its spare deleted, so the two copies of this route disagree");
  assert.equal(boxStore.getInferenceCustomModelDemotion()?.toModelId, SPARE, "the box lost the demotion on an ordinary Save");
  const pushedEndpoint = pushed.at(-1).inferenceCustomEndpoint;
  assert.equal(pushedEndpoint?.fallbackModelId, SPARE, "the wire carried an endpoint with its spare deleted");

  // An explicit null is still the way to clear it, and it reaches the box too.
  const cleared = await handlers.setInferenceRouter({ provider: "custom", endpoint: { baseUrl: "https://api.example.com/v1", modelId: "space-bunny", fallbackModelId: null } });
  assert.equal(cleared.endpoint?.fallbackModelId, undefined, "an explicit null did not clear the spare");
  assert.equal(boxStore.getInferenceCustomEndpoint()?.fallbackModelId, undefined, "an explicit null did not reach the box");
  assert.equal(boxStore.getInferenceCustomModelDemotion(), undefined, "the box kept a demotion whose spare the user cleared");
});

test("the panel read path never reports the account-backed provider, whatever the file says", async () => {
  const boxStore = makeStore(await freshStoreFile("box-read-panel.json"));
  const desktopSettingsPath = path.join(workspace, "desktop-read-panel.json");
  await writeFile(
    desktopSettingsPath,
    JSON.stringify({ version: 1, inferenceProvider: ACCOUNT_BACKED, settingsMigrations: [...settingsModule.SAND_SETTINGS_MIGRATION_IDS] }, null, 2),
    "utf8",
  );
  const desktop = makeStore(desktopSettingsPath);
  const box = { store: boxStore, reachable: true, applied: [] };
  const { handlers } = handlersFor(desktop, box);

  const reported = await handlers.getInferenceRouter();
  assert.notEqual(reported.provider, ACCOUNT_BACKED, "the panel must not be offered the account-backed route");
  assert.equal(reported.provider, "custom", "and must be offered the fallback instead");
  const onDisk = JSON.parse(await readFile(desktopSettingsPath, "utf8"));
  assert.equal(onDisk.inferenceProvider, ACCOUNT_BACKED, "READ-ONLY: the stale literal is still on disk, which is exactly why every reader resolves");
});

test("a custom route with no endpoint is refused, and asking for it as the account-backed provider is refused too", async () => {
  const desktopSettingsPath = await freshStoreFile("desktop-no-endpoint.json");
  const desktop = makeStore(desktopSettingsPath);
  const box = { store: makeStore(await freshStoreFile("box-no-endpoint.json")), reachable: true, applied: [] };
  const { handlers, pushed } = handlersFor(desktop, box);

  await assert.rejects(
    handlers.setInferenceRouter({ provider: "custom" }),
    (error) => {
      assert.match(String(error.message), /custom endpoint/i, "routing to the custom provider with no endpoint must be refused by name");
      return true;
    },
    "a custom route with nothing to route to must not be accepted",
  );

  // MEASURED: the same refused outcome is accepted when it is requested as `cursor`, because the
  // endpoint guard runs against the *requested* provider and `cursor` is not `custom`. The route
  // the box ends up on (`custom`, no endpoint) is the same state a fresh install already reports,
  // so nothing breaks — but a save is answered as a success for a request the identical request
  // was refused for. This assertion records the behaviour so the inconsistency cannot be mistaken
  // for the guard working.
  const viaAccountBacked = await handlers.setInferenceRouter({ provider: ACCOUNT_BACKED });
  assert.equal(viaAccountBacked.provider, "custom", "the account-backed request still resolves to the fallback");
  assert.equal(viaAccountBacked.endpoint, null, "and it leaves no endpoint behind");
  assert.equal(pushed.length, 1, "MEASURED: the box was written, where the same outcome requested as `custom` was refused before any write");
  assert.equal(pushed[0].inferenceProvider, "custom");
  assert.equal("inferenceCustomEndpoint" in pushed[0], false, "MEASURED: no endpoint is pushed alongside it");
});