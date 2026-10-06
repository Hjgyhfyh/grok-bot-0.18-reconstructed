/*
  A settings file this build cannot parse used to be deleted by a call that only reads it.

  `parseSettings` answered `null` for any `version` it did not recognise, and `load()` turned that
  `null` into `emptySettings()`. The reader looked harmless, so nothing warned. The damage came from
  `getNotificationConfig()`, which is a getter but persists on the way through, and from the first
  ordinary setter. Both wrote `emptySettings()` straight back over the user's file.

  MEASURED on this machine, before the fix, over a copy of a fully populated settings.json carrying
  30 top-level keys and `version: 99`:

    `new SandSettingsStore(p).getNotificationConfig()`      30 keys -> 11 keys
    `new SettingsService(p).getHostSettings()`              13 keys -> 11 keys
    `new SandSettingsStore(p).setPinnedAgentIds(["new"])`   the file became a fresh v1 with one key

  Gone afterwards, silently: `themePreference`, `inferenceCustomEndpoint`, `pinnedAgentIds`,
  `sidebarSections`, `autoReviewInstructions`, `localToolPermission`, `userTimeZone`,
  `hasSeenOnboarding`, `computerUseModel`, `mcpCustomInstructionsAccountScope`. The call returned a
  normal-looking notification config and reported no error.

  The same hole lost data in the other direction. `SETTINGS_VERSION` is one constant, never bumped
  since the initial import, while `inferenceCustomEndpoint` was added later, so two builds both write
  `version: 1`. `persist()` re-serialised only the fields this build knows, so the first write from
  either build erased the other's field. MEASURED: a v1 file carrying `aFieldOnlyANewerBuildKnows`
  and `anotherNew` lost both to a single `setPinnedAgentIds` call.

  This file owns the write integrity of `settings.json`. `router-usage-cross-process-ledger.test.mjs`
  owns the separate unsynchronised read-modify-write race, and `local-only-cursor-removal.test.mjs`
  owns the provider migrations; neither of them covers a file whose version this build does not share.
*/

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let store;
let service;
let agent;
let workspace;

test.before(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "grok-settings-integrity-"));
  const buildTo = async (entry, name) => {
    const outfile = path.join(workspace, name);
    await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", target: "node22" });
    return import(`${pathToFileURL(outfile).href}?${Date.now()}${name}`);
  };
  store = await buildTo(path.join("source", "shared", "node", "settings", "sand-settings-store.ts"), "settings.mjs");
  service = await buildTo(path.join("source", "host", "extensions", "settings", "settings-service.ts"), "settings-service.mjs");
  agent = await buildTo(path.join("source", "host", "agents", "settings-file.ts"), "agent-settings.mjs");
});

test.after(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
});

/** A temp settings file. Every case here is a copy; the real settings.json is never opened. */
function scratchFile(name, value) {
  const settingsPath = path.join(workspace, `${name}.json`);
  if (value !== undefined) writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
  return settingsPath;
}

function onDisk(settingsPath) {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

/** Every field a populated settings.json carries, on one line, so a diff is readable in a failure. */
function keysOnDisk(settingsPath) {
  return Object.keys(onDisk(settingsPath)).sort();
}

const POPULATED = {
  version: 1,
  mcpBoxServers: ["box-a"],
  autoUpdateWhenIdleOptIn: true,
  egressTunnelEnabled: true,
  webauthnProxyEnabled: false,
  mcpCustomInstructions: { hex: "legacy" },
  mcpCustomInstructionsByServerId: { "1": "by-id" },
  mcpDisabledToolsByServerId: { "1": ["read_file"] },
  conciergeConsent: "allowed",
  settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "retire-account-backed-inference-provider"],
  hasSeenOnboarding: true,
  themePreference: "dark",
  computerUseModel: { modelId: "cu", maxMode: false, parameters: [{ id: "thinking", value: "true" }] },
  userTimeZone: "Europe/Berlin",
  userTimeZoneOverride: "Asia/Tokyo",
  autoReviewInstructions: { isEnabled: true, allowInstructions: ["x"], blockInstructions: [] },
  localToolPermission: "always",
  inferenceCustomEndpoint: { baseUrl: "https://api.example.com/v1", modelId: "m" },
  pinnedAgentIds: ["a1", "a2"],
  sidebarSections: [{ id: "s1", name: "Work", agentIds: ["a1"], isCollapsed: true }]
};

test("reading the notification config from a settings file of an unknown schema version leaves every setting on disk", () => {
  const settingsPath = scratchFile("future-version-read", { ...POPULATED, version: 99 });
  const before = keysOnDisk(settingsPath);
  const recovered = new store.SandSettingsStore(settingsPath).getNotificationConfig();

  assert.equal(recovered.isEnabled, false, "the reader still has to answer something, and the disabled config is what this build serves");
  const lost = before.filter((key) => !(key in onDisk(settingsPath)));
  assert.deepEqual(lost, [], "a getter must not delete settings it did not write; every field it cannot parse must still be on disk");
  assert.equal(onDisk(settingsPath).pinnedAgentIds?.join(","), "a1,a2", "the pinned agents were silently dropped by a read");
  assert.equal(onDisk(settingsPath).inferenceCustomEndpoint?.modelId, "m", "the custom endpoint was silently dropped by a read");
  assert.equal(onDisk(settingsPath).themePreference, "dark", "the theme was silently dropped by a read");
});

test("getHostSettings(), the gateway read, does not delete a settings file of an unknown schema version", () => {
  const settingsPath = scratchFile("future-version-host", { ...POPULATED, version: 2 });
  const before = keysOnDisk(settingsPath);
  const settingsService = new service.SettingsService(settingsPath);
  settingsService.getHostSettings();
  const lost = before.filter((key) => !(key in onDisk(settingsPath)));
  assert.deepEqual(lost, [], "host-gateway-api getHostSettings is the first thing an operator calls against a box it does not recognise");
});

test("a settings file this build cannot parse is copied aside instead of being overwritten in place", () => {
  const settingsPath = scratchFile("future-version-quarantine", { ...POPULATED, version: 99 });
  new store.SandSettingsStore(settingsPath).setPinnedAgentIds(["replacement"]);
  const siblings = readdirSync(workspace).filter((name) => name.startsWith("future-version-quarantine.json.") && !name.endsWith(".tmp"));
  assert.ok(siblings.length >= 1, `the unreadable file was replaced with no copy left behind; the workspace holds ${JSON.stringify(readdirSync(workspace))}`);
  const kept = JSON.parse(readFileSync(path.join(workspace, siblings[0]), "utf8"));
  assert.equal(kept.version, 99, "the copy has to be the file as it was, not a re-serialised one");
  assert.equal(kept.inferenceCustomEndpoint.modelId, "m", "the copy has to carry the custom endpoint the user paid for");
  assert.deepEqual(kept.pinnedAgentIds, ["a1", "a2"], "the copy has to carry the agents that were pinned before the write");
});

test("a field only a newer build knows survives an ordinary write from this build", () => {
  const settingsPath = scratchFile("forward-compatible", {
    ...store.emptySettings(),
    aFieldOnlyANewerBuildKnows: { enabled: true },
    anotherNewField: "keep me",
    pinnedAgentIds: ["a"]
  });
  new store.SandSettingsStore(settingsPath).setPinnedAgentIds(["a", "b"]);
  const written = onDisk(settingsPath);
  assert.deepEqual(written.aFieldOnlyANewerBuildKnows, { enabled: true }, "SETTINGS_VERSION is one constant that no build bumps, so a same-version file carries fields this build does not know and a write erased them");
  assert.equal(written.anotherNewField, "keep me", "the second unknown field was erased by the same write");
  assert.deepEqual(written.pinnedAgentIds, ["a", "b"], "the write this build was asked to make did not land");
});

test("an unknown provider, a missing field, a wrong type and a future version each load to defined values", () => {
  const settingsPath = scratchFile("damaged-fields", {
    version: 1,
    inferenceProvider: "totally-unknown",
    mcpBoxServers: "not-an-array",
    pinnedAgentIds: 5,
    sidebarSections: "not-an-array",
    themePreference: 42,
    boxRuntime: "quantum",
    conciergeConsent: "maybe",
    updateTrackOverride: "beta",
    localToolPermission: "sometimes",
    userTimeZone: "",
    hasSeenOnboarding: "yes",
    notifications: "not-an-object",
    inferenceCustomEndpoint: { baseUrl: "ftp://nope", modelId: "" }
  });
  const settings = new store.SandSettingsStore(settingsPath);
  assert.doesNotThrow(() => settings.load(), "one damaged field must not take the whole file down");
  assert.equal(settings.getInferenceProvider(), "custom", "an unknown provider has to land somewhere routable");
  assert.deepEqual(settings.getMcpBoxServers(), [], "a wrong-typed list has to read as empty, not as garbage");
  assert.deepEqual(settings.getPinnedAgentIds(), undefined, "a wrong-typed pin list is absent, not invented");
  assert.deepEqual(settings.getSidebarSections(), undefined, "a wrong-typed section list is absent, not invented");
  assert.equal(settings.getThemePreference(), "system", "an out-of-schema theme falls back to the default");
  assert.equal(settings.getBoxRuntime(), "remote", "an out-of-schema runtime falls back to the default");
  assert.equal(settings.getUpdateTrackOverride(), null, "an out-of-schema update track reads as no override");
  assert.equal(settings.getLocalToolPermission(), "ask", "an out-of-schema permission falls back to the default rather than to the most permissive value");
  assert.equal(settings.getInferenceCustomEndpoint(), undefined, "an endpoint this build refuses must not come back out of the file");
  assert.doesNotThrow(() => settings.getNotificationConfig(), "the notification read writes to disk, so a damaged file reaches it");
});

test("a setter does not leave a value on disk that the store's own reader throws away", () => {
  const cases = [
    ["setPinnedAgentIds", ["a", "", "b"], "pinnedAgentIds", ["a", "b"]],
    ["setMcpBoxServers", ["a", "", "b"], "mcpBoxServers", ["a", "b"]],
    ["setBoxRuntime", "local", "boxRuntime", "remote"],
    ["setThemePreference", "neon", "themePreference", "system"],
    ["setUpdateTrackOverride", "beta", "updateTrackOverride", undefined],
    ["setLocalToolPermission", "sometimes", "localToolPermission", "ask"],
    ["setLocalToolPermissionCeiling", "sometimes", "localToolPermissionCeiling", undefined],
    ["setInferenceCustomEndpoint", { baseUrl: "http://evil.example", modelId: "m" }, "inferenceCustomEndpoint", undefined],
    ["setEgressTunnelEnabled", "no", "egressTunnelEnabled", false],
    ["setWebauthnProxyEnabled", "no", "webauthnProxyEnabled", true],
    ["setAutoUpdateWhenIdleOptIn", "no", "autoUpdateWhenIdleOptIn", false]
  ];
  for (const [setter, value, diskKey, expected] of cases) {
    const settingsPath = scratchFile(`asymmetry-${setter}`, store.emptySettings());
    const settings = new store.SandSettingsStore(settingsPath);
    settings[setter](value);
    assert.deepEqual(
      onDisk(settingsPath)[diskKey],
      expected,
      `${setter} wrote ${JSON.stringify(value)} to disk under "${diskKey}", and this build's own reader discards that on the next load, so the write reported success and the value silently vanished`,
    );
  }
});

test("every setting the panel can change reads back after the store is rebuilt, as a restart would", () => {
  const settingsPath = scratchFile("round-trip", store.emptySettings());
  const before = new store.SandSettingsStore(settingsPath);
  before.setThemePreference("dark");
  before.setBoxRuntime("local-docker");
  before.setEgressTunnelEnabled(true);
  before.setWebauthnProxyEnabled(false);
  before.setAutoUpdateWhenIdleOptIn(true);
  before.setUpdateTrackOverride("dogfood");
  before.setHasSeenOnboarding(true);
  before.setUserTimeZone("Europe/Berlin");
  before.setUserTimeZoneOverride("Asia/Tokyo");
  before.setPinnedAgentIds(["a1", "a2"]);
  before.setMcpBoxServers(["box-a"]);
  before.setSidebarSections([{ id: "s1", name: "Work", agentIds: ["a1"], isCollapsed: true }]);
  before.setLocalToolPermission("always");
  before.setLocalToolPermissionCeiling("always");
  before.setInferenceProvider("openrouter");
  before.setInferenceCustomEndpoint({ baseUrl: "https://api.example.com/v1", modelId: "m" });
  before.setComputerUseModel({ modelId: "cu", maxMode: false, parameters: [{ id: "thinking", value: "true" }] });
  before.setAutoReviewInstructions({ isEnabled: true, allowInstructions: ["x"], blockInstructions: ["y"] });
  before.setMcpCustomInstructions({ hex: "instructions" });
  before.setMcpCustomInstructionsByServerId({ "1": "by-id" });
  before.setMcpDisabledToolsByServerId({ "1": ["read_file"] });

  // A restart is a new store object over the same path. The gateway, the coordinator and the
  // desktop all hold their own instance, so this is the shape every read actually takes.
  const after = new store.SandSettingsStore(settingsPath);
  assert.equal(after.getThemePreference(), "dark", "the theme did not survive a restart");
  assert.equal(after.getBoxRuntime(), "local-docker", "the box runtime did not survive a restart");
  assert.equal(after.getEgressTunnelEnabled(), true, "the egress tunnel toggle did not survive a restart");
  assert.equal(after.getWebauthnProxyEnabled(), false, "the webauthn proxy toggle did not survive a restart");
  assert.equal(after.getAutoUpdateWhenIdleOptIn(), true, "the idle auto-update opt-in did not survive a restart");
  assert.equal(after.getUpdateTrackOverride(), "dogfood", "the update track did not survive a restart");
  assert.equal(after.getHasSeenOnboarding(), true, "the onboarding marker did not survive a restart");
  assert.equal(after.getDetectedUserTimeZone(), "Europe/Berlin", "the detected time zone did not survive a restart");
  assert.equal(after.getUserTimeZoneOverride(), "Asia/Tokyo", "the time zone override did not survive a restart");
  assert.deepEqual(after.getPinnedAgentIds(), ["a1", "a2"], "the pinned agents did not survive a restart");
  assert.deepEqual(after.getMcpBoxServers(), ["box-a"], "the selected box servers did not survive a restart");
  assert.equal(after.getSidebarSections()[0].isCollapsed, true, "the collapsed state of a sidebar section did not survive a restart");
  assert.equal(after.getLocalToolPermission(), "always", "the local tool permission did not survive a restart");
  assert.equal(after.getLocalToolPermissionCeiling(), "always", "the local tool permission ceiling did not survive a restart");
  assert.equal(new store.SandSettingsStore(settingsPath).getLocalToolPermission(), "always", "a ceiling at the same level leaves the choice alone");
  assert.equal(after.getInferenceProvider(), "openrouter", "the inference provider did not survive a restart");
  assert.deepEqual(after.getInferenceCustomEndpoint(), { baseUrl: "https://api.example.com/v1", modelId: "m" }, "the custom endpoint did not survive a restart");
  assert.deepEqual(after.getComputerUseModel(), { modelId: "cu", maxMode: false, parameters: [{ id: "thinking", value: "true" }] }, "the computer-use model did not survive a restart");
  assert.deepEqual(after.getAutoReviewInstructions(), { isEnabled: true, allowInstructions: ["x"], blockInstructions: ["y"] }, "the auto-review instructions did not survive a restart");
  assert.deepEqual(after.getMcpCustomInstructions(), { hex: "instructions" }, "the legacy connector instructions did not survive a restart");
  assert.deepEqual(after.getMcpCustomInstructionsByServerId(), { "1": "by-id" }, "the per-server connector instructions did not survive a restart");
  assert.deepEqual(after.getMcpDisabledToolsByServerId(), { "1": ["read_file"] }, "the disabled connector tools did not survive a restart");
});

test("setHostSettings writes every field the update carries, and reports what it could not apply", () => {
  const settingsPath = scratchFile("service-write", store.emptySettings());
  const settingsService = new service.SettingsService(settingsPath);
  const written = settingsService.setHostSettings({
    userTimeZone: "Europe/Berlin",
    webauthnProxyEnabled: false,
    pinnedAgentIds: ["a1"],
    localToolPermission: "ask",
    autoReviewInstructions: { isEnabled: true, allowInstructions: ["ok"], blockInstructions: [] },
    mcpBoxServers: ["box-a"],
    mcpCustomInstructionsByServerId: { "1": "by-id" },
    inferenceProvider: "codex"
  });
  const disk = onDisk(settingsPath);
  assert.equal(disk.userTimeZone, "Europe/Berlin", "a field setHostSettings accepted is not on disk");
  assert.equal(disk.webauthnProxyEnabled, false, "a false toggle must not be mistaken for an absent one");
  assert.equal(disk.localToolPermission, "ask", "the local tool permission is not on disk");
  assert.equal(disk.inferenceProvider, "codex", "the inference provider is not on disk");
  assert.deepEqual(disk.mcpBoxServers, ["box-a"], "the box server list is not on disk");
  assert.equal(written.inferenceProvider, "codex", "the caller has to be told what landed");

  const rejected = new service.SettingsService(settingsPath).setHostSettings({ userTimeZone: "Not/AZone", webauthnProxyEnabled: "yes" });
  assert.equal(rejected.userTimeZone, "Europe/Berlin", "an invalid time zone must not overwrite the stored one, and the caller must be told it did not land");
  assert.equal(rejected.webauthnProxyEnabled, false, "a non-boolean toggle must not flip the stored one");
});

test("a settings file that cannot be parsed at all is still copied aside before it is replaced", () => {
  const settingsPath = path.join(workspace, "corrupt.json");
  writeFileSync(settingsPath, "{ this is not json", "utf8");
  new store.SandSettingsStore(settingsPath).getNotificationConfig();
  const copies = readdirSync(workspace).filter((name) => name.startsWith("corrupt.json."));
  assert.ok(copies.length >= 1, "a corrupt file was overwritten in place and the user's last readable copy is gone");
  assert.equal(readFileSync(path.join(workspace, copies[0]), "utf8"), "{ this is not json", "the copy has to be the bytes that were on disk");
});

test("the settings file the user actually runs on is never opened by this suite", () => {
  assert.equal(
    existsSync(path.join(workspace, "settings.json")),
    false,
    "every case here must be its own temp file; the live ~/.grokbot/settings.json is out of bounds",
  );
});

// --- The per-agent settings file, <root>\agents\<uuid>\settings.json -----------------

test("an agent's two settings round-trip through disk, one field at a time", () => {
  const settingsPath = path.join(workspace, "agent-round-trip.json");
  agent.writeSandSettingsFile(settingsPath, { notifyOnAgentUpdates: false, hiddenFromSidebar: true });
  assert.deepEqual(agent.readSandSettingsFile(settingsPath), { notifyOnAgentUpdates: false, hiddenFromSidebar: true }, "both toggles did not land in the file");
  agent.writeSandSettingsFile(settingsPath, { notifyOnAgentUpdates: true });
  assert.deepEqual(agent.readSandSettingsFile(settingsPath), { notifyOnAgentUpdates: true, hiddenFromSidebar: true }, "changing one toggle cleared the other");
});

test("an agent settings file carrying a UTF-8 BOM reads its own settings instead of the defaults", () => {
  const settingsPath = path.join(workspace, "agent-bom.json");
  writeFileSync(settingsPath, `\uFEFF${JSON.stringify({ notifyOnAgentUpdates: false, hiddenFromSidebar: true })}`, "utf8");
  assert.deepEqual(
    agent.readSandSettingsFile(settingsPath),
    { notifyOnAgentUpdates: false, hiddenFromSidebar: true },
    "a BOM makes JSON.parse throw, the throw was swallowed, and both toggles read as their defaults no matter what the file said",
  );
  agent.writeSandSettingsFile(settingsPath, { notifyOnAgentUpdates: false });
  assert.equal(
    readFileSync(settingsPath, "utf8").startsWith("\uFEFF"),
    false,
    "the rewrite has to drop the BOM too, or the file stays unreadable to this store forever",
  );
  assert.deepEqual(agent.readSandSettingsFile(settingsPath), { notifyOnAgentUpdates: false, hiddenFromSidebar: true }, "the hidden-from-sidebar toggle was lost when the BOM was cleared");
});

test("an agent settings file this store cannot parse is copied aside, not overwritten in place", () => {
  const settingsPath = path.join(workspace, "agent-corrupt.json");
  writeFileSync(settingsPath, "{ not json at all", "utf8");
  agent.writeSandSettingsFile(settingsPath, { hiddenFromSidebar: true });
  assert.equal(readFileSync(settingsPath, "utf8"), "{ not json at all", "the only copy of the file was replaced by the toggle it did not understand");
  const kept = `${settingsPath}.unreadable`;
  assert.equal(existsSync(kept), true, "the unreadable file was replaced with no copy left behind");
  assert.equal(readFileSync(kept, "utf8"), "{ not json at all", "the copy has to be the bytes that were on disk");
  agent.writeSandSettingsFile(settingsPath, { hiddenFromSidebar: true });
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).hiddenFromSidebar, true, "once a copy exists the write has to go through, or a damaged file freezes the agent's settings for good");
});

test("an agent settings file holding a JSON array or null is treated as unreadable, not as empty settings", () => {
  for (const [label, text] of [["array", "[1,2,3]"], ["null", "null"], ["string", '"hello"']]) {
    const settingsPath = path.join(workspace, `agent-shape-${label}.json`);
    writeFileSync(settingsPath, text, "utf8");
    agent.writeSandSettingsFile(settingsPath, { hiddenFromSidebar: true });
    assert.equal(readFileSync(settingsPath, "utf8"), text, `a file holding ${label} was rewritten and the copy the store made of it kept nothing`);
    assert.equal(existsSync(`${settingsPath}.unreadable`), true, `a file holding ${label} left no copy behind`);
  }
});

test("repeated toggles never leave the settings file unparseable or half written", () => {
  const settingsPath = path.join(workspace, "agent-repeat.json");
  const REPETITIONS = 200;
  let parseFailures = 0;
  for (let index = 0; index < REPETITIONS; index += 1) {
    agent.writeSandSettingsFile(settingsPath, { notifyOnAgentUpdates: index % 2 === 0, hiddenFromSidebar: index % 3 === 0 });
    try { JSON.parse(readFileSync(settingsPath, "utf8")); } catch { parseFailures += 1; }
  }
  assert.equal(parseFailures, 0, `${parseFailures} of ${REPETITIONS} toggles left settings.json unreadable`);
  assert.deepEqual(agent.readSandSettingsFile(settingsPath), { notifyOnAgentUpdates: false, hiddenFromSidebar: false }, "the last toggle did not win");
  assert.deepEqual(
    readdirSync(workspace).filter((name) => name.includes(".tmp")),
    [],
    "a temp file was left behind beside the settings file",
  );
});