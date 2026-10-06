import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SAND_THEME_PREFERENCE, isSandThemePreference, type SandThemePreference } from "../../desktop.js";
import { SAND_DISABLED_NOTIFICATION_CONFIG } from "../../host-settings.js";
import { SAND_DEFAULT_LOCAL_TOOL_PERMISSION, isSandLocalToolPermission, normalizeSandLocalToolPermission, resolveSandLocalToolPermission, type SandLocalToolPermission } from "../../local-tool-permission.js";
import { clampMcpCustomInstruction, getDefaultMcpCustomInstruction } from "../../mcp-custom-instructions.js";
import { DEFAULT_SAND_AUTO_REVIEW_INSTRUCTIONS, normalizeSandAutoReviewInstructions, type SandAutoReviewInstructions } from "../../sand-auto-review-instructions.js";
import { SidebarSections, type SidebarSection } from "../../sidebar-sections.js";
import { coerceToEnabledTrack, isSandUpdateTrack, type SandUpdateTrack } from "../../update-track.js";
import { isSandAgentModelSelection, type SandAgentModelSelection } from "../../agents/sand-agent-model.js";
import { activeCustomModelDemotion, emptySandInferenceRouterUsage, isSandInferenceProvider, normalizeSandInferenceCustomEndpoint, normalizeSandInferenceCustomModelDemotion, normalizeSandInferenceWriteEndpoint, resolveServedInferenceProvider, sandInferenceFallbackModelId, type SandInferenceCustomEndpoint, type SandInferenceCustomModelDemotion, type SandInferenceProvider, type SandInferenceRouterUsage, type SandInferenceWriteEndpoint } from "../../inference-router.js";
import { DEFAULT_SAND_BOX_RUNTIME, isSandBoxRuntime, type SandBoxRuntime } from "../../box-runtime.js";

export const SETTINGS_VERSION = 1;
export const SAND_DOWNGRADE_MAX_FAST_MIGRATION_ID = "downgrade-persisted-max-fast";
export const SAND_LOCAL_INFERENCE_PROVIDER_MIGRATION_ID = "local-inference-provider";
export const SAND_RETIRE_ACCOUNT_BACKED_PROVIDER_MIGRATION_ID = "retire-account-backed-inference-provider";
export const SAND_SETTINGS_MIGRATION_IDS = [SAND_DOWNGRADE_MAX_FAST_MIGRATION_ID, SAND_LOCAL_INFERENCE_PROVIDER_MIGRATION_ID, SAND_RETIRE_ACCOUNT_BACKED_PROVIDER_MIGRATION_ID] as const;

type StringMap = Record<string, string>;
type StringListMap = Record<string, string[]>;
export interface SandStoredSettings {
  version: 1; mcpBoxServers: string[]; autoUpdateWhenIdleOptIn: boolean; egressTunnelEnabled: boolean; webauthnProxyEnabled: boolean;
  mcpCustomInstructions: StringMap; mcpCustomInstructionsByServerId: StringMap; mcpDisabledToolsByServerId: StringListMap;
  conciergeConsent: "unset" | "allowed" | "denied"; settingsMigrations: string[];
  hasSeenOnboarding?: boolean; hasSeenOnboardingAccountScope?: string; updateTrackOverride?: SandUpdateTrack; themePreference?: SandThemePreference;
  agentDefaultModel?: SandAgentModelSelection; computerUseModel?: SandAgentModelSelection; notifications?: Record<string, unknown>;
  userTimeZone?: string; userTimeZoneOverride?: string; autoReviewInstructions?: SandAutoReviewInstructions;
  localToolPermission?: SandLocalToolPermission; localToolPermissionCeiling?: SandLocalToolPermission;
  inferenceProvider?: SandInferenceProvider; inferenceRouterUsage?: SandInferenceRouterUsage; inferenceCustomEndpoint?: SandInferenceCustomEndpoint;
  /**
   * The sticky demotion of the custom endpoint onto its spare model. A separate top-level key, and
   * not a field of `inferenceCustomEndpoint`, on purpose: the desktop rewrites the endpoint object
   * wholesale on every Router save and on every coordinator resync, so a demotion stored inside it
   * would be erased by an ordinary settings write and the broken model would come back.
   */
  inferenceCustomModelDemotion?: SandInferenceCustomModelDemotion;
  boxRuntime?: SandBoxRuntime;
  mcpCustomInstructionsAccountScope?: string; pinnedAgentIds?: string[]; sidebarSections?: SidebarSection[];
}

export function emptySettings(): SandStoredSettings {
  return { version: SETTINGS_VERSION, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [...SAND_SETTINGS_MIGRATION_IDS] };
}

function stringMap(value: unknown): StringMap { const result: StringMap = {}; if (typeof value !== "object" || value == null || Array.isArray(value)) return result; for (const [key, item] of Object.entries(value)) if (typeof item === "string") result[key] = item; return result; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function normalizeCustomInstructions(raw: StringMap): StringMap { const normalized: StringMap = {}; for (const [name, value] of Object.entries(raw)) { const clamped = clampMcpCustomInstruction(value); if (clamped.trim().length > 0) normalized[name] = clamped; else if (getDefaultMcpCustomInstruction(name).length > 0) normalized[name] = ""; } return normalized; }
function normalizeCustomInstructionsByServerId(raw: StringMap): StringMap { const normalized: StringMap = {}; for (const [id, value] of Object.entries(raw)) if (/^[1-9]\d*$/.test(id)) normalized[id] = clampMcpCustomInstruction(value); return normalized; }
function normalizeDisabledToolsByServerId(raw: unknown): StringListMap { const normalized: StringListMap = {}; if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return normalized; for (const [id, value] of Object.entries(raw)) { if (!/^[1-9]\d*$/.test(id)) continue; const tools = [...new Set(stringArray(value).filter((name) => name.length > 0))]; if (tools.length > 0) normalized[id] = tools; } return normalized; }
function downgradePersistedFast(model: SandAgentModelSelection): SandAgentModelSelection { return { modelId: model.modelId, maxMode: true, parameters: model.parameters.map((parameter) => ({ id: parameter.id, value: parameter.id === "fast" ? "false" : parameter.value })) }; }

function parseSettings(value: unknown): SandStoredSettings | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>; if (raw.version !== SETTINGS_VERSION) return null;
  const base = emptySettings();
  const result: SandStoredSettings = {
    ...base,
    mcpBoxServers: [...new Set(stringArray(raw.mcpBoxServers).filter((name) => name.length > 0))],
    autoUpdateWhenIdleOptIn: raw.autoUpdateWhenIdleOptIn === true,
    egressTunnelEnabled: raw.egressTunnelEnabled === true,
    webauthnProxyEnabled: raw.webauthnProxyEnabled !== false,
    mcpCustomInstructions: normalizeCustomInstructions(stringMap(raw.mcpCustomInstructions)),
    mcpCustomInstructionsByServerId: normalizeCustomInstructionsByServerId(stringMap(raw.mcpCustomInstructionsByServerId)),
    mcpDisabledToolsByServerId: normalizeDisabledToolsByServerId(raw.mcpDisabledToolsByServerId),
    conciergeConsent: raw.conciergeConsent === "allowed" || raw.conciergeConsent === "denied" ? raw.conciergeConsent : "unset",
    settingsMigrations: stringArray(raw.settingsMigrations)
  };
  if (typeof raw.hasSeenOnboarding === "boolean") result.hasSeenOnboarding = raw.hasSeenOnboarding;
  if (typeof raw.hasSeenOnboardingAccountScope === "string" && raw.hasSeenOnboardingAccountScope.length > 0) result.hasSeenOnboardingAccountScope = raw.hasSeenOnboardingAccountScope;
  if (isSandUpdateTrack(raw.updateTrackOverride)) result.updateTrackOverride = raw.updateTrackOverride;
  if (isSandThemePreference(raw.themePreference)) result.themePreference = raw.themePreference;
  if (isSandAgentModelSelection(raw.agentDefaultModel)) result.agentDefaultModel = raw.agentDefaultModel;
  if (isSandAgentModelSelection(raw.computerUseModel)) result.computerUseModel = raw.computerUseModel;
  if (typeof raw.notifications === "object" && raw.notifications != null && !Array.isArray(raw.notifications)) result.notifications = raw.notifications as Record<string, unknown>;
  for (const key of ["userTimeZone", "userTimeZoneOverride", "mcpCustomInstructionsAccountScope"] as const) if (typeof raw[key] === "string" && raw[key].length > 0) result[key] = raw[key];
  if (typeof raw.autoReviewInstructions === "object" && raw.autoReviewInstructions != null) result.autoReviewInstructions = normalizeSandAutoReviewInstructions(raw.autoReviewInstructions as Record<string, unknown>);
  if (isSandLocalToolPermission(raw.localToolPermission)) result.localToolPermission = raw.localToolPermission;
  if (isSandLocalToolPermission(raw.localToolPermissionCeiling)) result.localToolPermissionCeiling = raw.localToolPermissionCeiling;
  if (isSandInferenceProvider(raw.inferenceProvider)) result.inferenceProvider = raw.inferenceProvider;
  const customEndpoint = normalizeSandInferenceCustomEndpoint(raw.inferenceCustomEndpoint); if (customEndpoint !== undefined) result.inferenceCustomEndpoint = customEndpoint;
  const demotion = normalizeSandInferenceCustomModelDemotion(raw.inferenceCustomModelDemotion); if (demotion !== undefined) result.inferenceCustomModelDemotion = demotion;
  if (isSandBoxRuntime(raw.boxRuntime)) result.boxRuntime = raw.boxRuntime;
  if (typeof raw.inferenceRouterUsage === "object" && raw.inferenceRouterUsage != null && !Array.isArray(raw.inferenceRouterUsage)) {
    const usage = emptySandInferenceRouterUsage();
    const rawProviders = (raw.inferenceRouterUsage as { providers?: unknown }).providers;
    if (typeof rawProviders === "object" && rawProviders != null && !Array.isArray(rawProviders)) {
      for (const provider of Object.keys(usage.providers) as SandInferenceProvider[]) {
        const item = (rawProviders as Record<string, unknown>)[provider];
        if (typeof item !== "object" || item == null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const count = (key: string): number => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0 ? record[key] as number : 0;
        usage.providers[provider] = { requests: count("requests"), inputTokens: count("inputTokens"), outputTokens: count("outputTokens"), cacheReadTokens: count("cacheReadTokens"), cacheWriteTokens: count("cacheWriteTokens"), lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null };
      }
    }
    result.inferenceRouterUsage = usage;
  }
  if (Array.isArray(raw.pinnedAgentIds)) result.pinnedAgentIds = [...new Set(stringArray(raw.pinnedAgentIds).filter((id) => id.length > 0))];
  if (Array.isArray(raw.sidebarSections)) result.sidebarSections = SidebarSections.carryFolds({ sections: raw.sidebarSections.filter((entry): entry is SidebarSection => typeof entry === "object" && entry != null && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { name?: unknown }).name === "string" && Array.isArray((entry as { agentIds?: unknown }).agentIds)) });
  return result;
}

/**
 * Every top-level key this build writes. `SETTINGS_VERSION` is a single constant that no build
 * bumps, so two builds can both own a `version: 1` file and each can hold a field the other has
 * never heard of. Anything outside this set belongs to whichever build wrote it, and a write from
 * this build must not decide that field no longer exists.
 */
const SAND_MANAGED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "version", "mcpBoxServers", "autoUpdateWhenIdleOptIn", "egressTunnelEnabled", "webauthnProxyEnabled",
  "mcpCustomInstructions", "mcpCustomInstructionsByServerId", "mcpDisabledToolsByServerId",
  "conciergeConsent", "settingsMigrations", "hasSeenOnboarding", "hasSeenOnboardingAccountScope",
  "updateTrackOverride", "themePreference", "agentDefaultModel", "computerUseModel", "notifications",
  "userTimeZone", "userTimeZoneOverride", "autoReviewInstructions", "localToolPermission",
  "localToolPermissionCeiling", "inferenceProvider", "inferenceRouterUsage", "inferenceCustomEndpoint",
  "inferenceCustomModelDemotion",
  "boxRuntime", "mcpCustomInstructionsAccountScope", "pinnedAgentIds", "sidebarSections"
]);

export class SandSettingsStore {
  constructor(readonly settingsPath: string) {}
  /** The file as bytes, or `undefined` when there is none to read. */
  private readStoredText(): string | undefined { try { return readFileSync(this.settingsPath, "utf8"); } catch { return undefined; } }
  /** The file parsed as the plain object this store can carry keys in, or `null`. */
  private parseStoredObject(text: string | undefined): Record<string, unknown> | null {
    if (text === undefined) return null;
    try { const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, "")); return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
    catch { return null; }
  }
  load(): SandStoredSettings {
    if (!existsSync(this.settingsPath)) return emptySettings();
    const parsed = parseSettings(this.parseStoredObject(this.readStoredText()) as unknown);
    // An unreadable file answered `emptySettings()` and nothing warned, because the reader looked
    // harmless. Reading stays that way — the app has to run against a file it cannot understand.
    // `persist` is where the file is at risk, and it refuses there.
    if (parsed == null) return emptySettings();
    return this.applyPendingMigrations(parsed);
  }
  /**
   * Top-level keys this build does not manage, taken from the file itself.
   *
   * `SETTINGS_VERSION` is one constant that no build bumps, so two builds can both own a
   * `version: 1` file and each can hold a field the other has never heard of. `persist` used to
   * re-serialise only the fields this build knows, so the first ordinary write from either build
   * erased the other's field, with no warning and no backup. These keys are carried through
   * untouched; the managed keys in `settings` always win.
   */
  private foreignKeys(raw: Record<string, unknown> | null): Record<string, unknown> {
    if (raw === null || raw.version !== SETTINGS_VERSION) return {};
    const foreign: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) if (!SAND_MANAGED_SETTINGS_KEYS.has(key)) foreign[key] = value;
    return foreign;
  }
  persist(settings: SandStoredSettings): void {
    const text = this.readStoredText();
    const raw = this.parseStoredObject(text);
    // `parseSettings` answers `null` for a `version` this build does not know, and `load()` turned
    // that into `emptySettings()`. A file that is not even a JSON object answers the same way. The
    // reader looked harmless, so nothing warned — the damage came from this write, which put those
    // defaults straight back over the user's file. A file this build cannot read is the one file it
    // cannot rewrite from its own contents, so the first refusal takes a copy and holds. Once the
    // copy exists the write proceeds: the user's settings are recoverable, and a genuinely corrupt
    // file must not freeze every setting in the app.
    if (text !== undefined && (raw === null || parseSettings(raw) == null)) {
      const kept = `${this.settingsPath}.unreadable-v${SETTINGS_VERSION}`;
      if (!existsSync(kept)) { try { writeFileSync(kept, text, "utf8"); return; } catch {} }
    }
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temp = `${this.settingsPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...this.foreignKeys(raw), ...settings }, null, 2), "utf8");
    renameSync(temp, this.settingsPath);
  }
  private applyPendingMigrations(settings: SandStoredSettings): SandStoredSettings {
    const done = new Set(settings.settingsMigrations);
    const pending: string[] = []; let next = settings;
    // The early return this replaced only ever checked the first id, so a second
    // migration would have been unreachable on every already-migrated file.
    if (!done.has(SAND_DOWNGRADE_MAX_FAST_MIGRATION_ID)) { pending.push(SAND_DOWNGRADE_MAX_FAST_MIGRATION_ID); next = { ...next, ...(next.agentDefaultModel === undefined ? {} : { agentDefaultModel: downgradePersistedFast(next.agentDefaultModel) }) }; }
    if (!done.has(SAND_LOCAL_INFERENCE_PROVIDER_MIGRATION_ID)) { pending.push(SAND_LOCAL_INFERENCE_PROVIDER_MIGRATION_ID); next = { ...next, inferenceProvider: next.inferenceProvider ?? "custom" }; }
    // The migration above fills an absent key only, so a file that already named
    // the account-backed provider kept naming it. Every reader treats that value
    // as a live routing decision, and the branch it selects builds a session for a
    // hosted model on an account this build never signs in to. The reader refuses
    // it either way; this rewrites the file so it stops claiming otherwise.
    if (!done.has(SAND_RETIRE_ACCOUNT_BACKED_PROVIDER_MIGRATION_ID)) { pending.push(SAND_RETIRE_ACCOUNT_BACKED_PROVIDER_MIGRATION_ID); next = { ...next, inferenceProvider: resolveServedInferenceProvider(next.inferenceProvider) }; }
    if (pending.length === 0) return settings;
    const migrated = { ...next, settingsMigrations: [...settings.settingsMigrations, ...pending] };
    try { this.persist(migrated); } catch {}
    return migrated;
  }
  private update(mutator: (settings: SandStoredSettings) => SandStoredSettings): void { this.persist(mutator(this.load())); }
  getHasSeenOnboarding(): boolean | undefined { return this.load().hasSeenOnboarding; }
  setHasSeenOnboarding(value: boolean): void { this.update((current) => { const { hasSeenOnboardingAccountScope: _old, ...rest } = current; return { ...rest, hasSeenOnboarding: value, ...(rest.mcpCustomInstructionsAccountScope === undefined ? {} : { hasSeenOnboardingAccountScope: rest.mcpCustomInstructionsAccountScope }) }; }); }
  clearHasSeenOnboarding(): void { this.update((current) => { const { hasSeenOnboarding: _seen, hasSeenOnboardingAccountScope: _owner, ...rest } = current; return rest; }); }
  getAutoUpdateWhenIdleOptIn(): boolean { return this.load().autoUpdateWhenIdleOptIn; }
  setAutoUpdateWhenIdleOptIn(value: boolean): void { this.update((s) => ({ ...s, autoUpdateWhenIdleOptIn: value === true })); }
  getThemePreference(): SandThemePreference { return this.load().themePreference ?? DEFAULT_SAND_THEME_PREFERENCE; }
  // Each setter below normalises before it writes. They did not used to: the reader validates every
  // one of these fields and the writer accepted whatever it was handed, so a value outside the
  // schema was persisted, the write reported success, and the next `load()` dropped it. The user's
  // toggle came back off and nothing said why.
  setThemePreference(value: SandThemePreference): void { this.update((s) => ({ ...s, themePreference: isSandThemePreference(value) ? value : DEFAULT_SAND_THEME_PREFERENCE })); }
  getBoxRuntime(): SandBoxRuntime { return this.load().boxRuntime ?? DEFAULT_SAND_BOX_RUNTIME; }
  setBoxRuntime(value: SandBoxRuntime): void { this.update((s) => ({ ...s, boxRuntime: isSandBoxRuntime(value) ? value : DEFAULT_SAND_BOX_RUNTIME })); }
  getEgressTunnelEnabled(): boolean { return this.load().egressTunnelEnabled; }
  setEgressTunnelEnabled(value: boolean): void { this.update((s) => ({ ...s, egressTunnelEnabled: value === true })); }
  getWebauthnProxyEnabled(): boolean { return this.load().webauthnProxyEnabled; }
  // `parseSettings` reads this one field as `!== false`, so anything that is not the literal
  // `false` comes back enabled. A non-boolean had to be stopped at the writer, or
  // `webauthnProxyEnabled: "false"` on disk turned the proxy ON.
  setWebauthnProxyEnabled(value: boolean): void { this.update((s) => ({ ...s, webauthnProxyEnabled: value !== false })); }
  getAgentDefaultModel(): SandAgentModelSelection | undefined { const model = this.load().agentDefaultModel; return model === undefined ? undefined : { ...model, maxMode: true }; }
  setAgentDefaultModel(model: SandAgentModelSelection | undefined): void { this.update((s) => { const { agentDefaultModel: _old, ...rest } = s; return model === undefined ? rest : { ...rest, agentDefaultModel: { modelId: model.modelId, maxMode: true, parameters: model.parameters.map((p) => ({ ...p })) } }; }); }
  getComputerUseModel(): SandAgentModelSelection | undefined { return this.load().computerUseModel; }
  setComputerUseModel(model: SandAgentModelSelection | undefined): void { this.update((s) => { const { computerUseModel: _old, ...rest } = s; return model === undefined ? rest : { ...rest, computerUseModel: { modelId: model.modelId, maxMode: model.maxMode, parameters: model.parameters.map((p) => ({ ...p })) } }; }); }
  getUpdateTrackOverride(): SandUpdateTrack | null { const stored = this.load().updateTrackOverride ?? null; if (stored == null) return null; const coerced = coerceToEnabledTrack(stored); if (coerced !== stored) { try { this.setUpdateTrackOverride(coerced); } catch {} } return coerced; }
  setUpdateTrackOverride(track: SandUpdateTrack | null): void { this.update((s) => { const { updateTrackOverride: _old, ...rest } = s; return isSandUpdateTrack(track) ? { ...rest, updateTrackOverride: track } : rest; }); }
  getMcpCustomInstructions(): StringMap { return this.load().mcpCustomInstructions; }
  setMcpCustomInstructions(value: StringMap): void { this.update((s) => ({ ...s, mcpCustomInstructions: normalizeCustomInstructions(value) })); }
  getMcpCustomInstructionsByServerId(): StringMap { return this.load().mcpCustomInstructionsByServerId; }
  setMcpCustomInstructionsByServerId(value: StringMap): void { this.update((s) => ({ ...s, mcpCustomInstructionsByServerId: normalizeCustomInstructionsByServerId(value) })); }
  getMcpCustomInstructionsAccountScope(): string | undefined { return this.load().mcpCustomInstructionsAccountScope; }
  getMcpDisabledToolsByServerId(): StringListMap { return this.load().mcpDisabledToolsByServerId; }
  setMcpDisabledToolsByServerId(value: StringListMap): void { this.update((s) => ({ ...s, mcpDisabledToolsByServerId: normalizeDisabledToolsByServerId(value) })); }
  scopeToAccount(accountScope: string): void { this.update((current) => { const seen = current.hasSeenOnboarding === undefined || (current.hasSeenOnboardingAccountScope !== undefined && current.hasSeenOnboardingAccountScope !== accountScope) ? {} : { hasSeenOnboarding: current.hasSeenOnboarding, hasSeenOnboardingAccountScope: accountScope }; const { hasSeenOnboarding: _seen, hasSeenOnboardingAccountScope: _owner, ...withoutSeen } = current; if (current.mcpCustomInstructionsAccountScope === undefined || current.mcpCustomInstructionsAccountScope === accountScope) return { ...withoutSeen, ...seen, mcpCustomInstructionsAccountScope: accountScope }; const { autoReviewInstructions: _a, agentDefaultModel: _m, computerUseModel: _c, localToolPermission: _p, localToolPermissionCeiling: _pc, ...rest } = withoutSeen; return { ...rest, ...seen, mcpCustomInstructionsAccountScope: accountScope, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {} }; }); }
  clearAccountScope(): void { this.update((current) => { const { mcpCustomInstructionsAccountScope: _scope, autoReviewInstructions: _a, agentDefaultModel: _m, computerUseModel: _c, localToolPermission: _p, localToolPermissionCeiling: _pc, ...rest } = current; return { ...rest, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {} }; }); }
  getUserTimeZone(): string | undefined { const s = this.load(); return s.userTimeZoneOverride ?? s.userTimeZone; }
  getDetectedUserTimeZone(): string | undefined { return this.load().userTimeZone; }
  getUserTimeZoneOverride(): string | undefined { return this.load().userTimeZoneOverride; }
  setUserTimeZone(value?: string): void { this.update((s) => { const { userTimeZone: _old, ...rest } = s; const trimmed = value?.trim(); return trimmed == null || trimmed.length === 0 ? rest : { ...rest, userTimeZone: trimmed }; }); }
  setUserTimeZoneOverride(value?: string): void { this.update((s) => { const { userTimeZoneOverride: _old, ...rest } = s; const trimmed = value?.trim(); return trimmed == null || trimmed.length === 0 ? rest : { ...rest, userTimeZoneOverride: trimmed }; }); }
  getMcpBoxServers(): string[] { return this.load().mcpBoxServers; }
  setMcpBoxServers(names: readonly string[]): void { this.update((s) => ({ ...s, mcpBoxServers: [...new Set(stringArray(names).filter((name) => name.length > 0))] })); }
  getRawMcpCustomInstruction(name: string): string | undefined { return this.load().mcpCustomInstructions[name]; }
  getRawMcpCustomInstructionByServerId(id: string): string | undefined { return this.load().mcpCustomInstructionsByServerId[id]; }
  setMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; value: string; mirrorLegacyName: boolean }): void { this.update((s) => { const byId = { ...s.mcpCustomInstructionsByServerId, [args.serverId]: clampMcpCustomInstruction(args.value) }; const legacy = { ...s.mcpCustomInstructions }; if (args.mirrorLegacyName) { const value = clampMcpCustomInstruction(args.value); if (value.trim().length > 0 || getDefaultMcpCustomInstruction(args.displayName).length > 0) legacy[args.displayName] = value; else delete legacy[args.displayName]; } else delete legacy[args.displayName]; return { ...s, mcpCustomInstructionsByServerId: byId, mcpCustomInstructions: legacy }; }); }
  migrateMcpCustomInstructionToServerId(args: { serverId: string; displayName: string }): void { const current = this.load(); if (current.mcpCustomInstructionsByServerId[args.serverId] !== undefined) return; const legacy = current.mcpCustomInstructions[args.displayName]; if (legacy === undefined) return; this.persist({ ...current, mcpCustomInstructionsByServerId: { ...current.mcpCustomInstructionsByServerId, [args.serverId]: legacy } }); }
  deleteMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; deleteLegacyName: boolean }): void { this.update((s) => { const byId = { ...s.mcpCustomInstructionsByServerId }; delete byId[args.serverId]; const legacy = { ...s.mcpCustomInstructions }; if (args.deleteLegacyName) delete legacy[args.displayName]; return { ...s, mcpCustomInstructionsByServerId: byId, mcpCustomInstructions: legacy }; }); }
  setMcpCustomInstruction(name: string, value: string): void { this.update((s) => { const next = { ...s.mcpCustomInstructions }; const clamped = clampMcpCustomInstruction(value); if (clamped.trim().length === 0) { if (getDefaultMcpCustomInstruction(name).length > 0) next[name] = ""; else delete next[name]; } else next[name] = clamped; return { ...s, mcpCustomInstructions: next }; }); }
  deleteMcpCustomInstruction(name: string): void { const current = this.load(); if (!(name in current.mcpCustomInstructions)) return; const next = { ...current.mcpCustomInstructions }; delete next[name]; this.persist({ ...current, mcpCustomInstructions: next }); }
  getNotificationConfig() { const current = this.load(); if (current.notifications?.isEnabled !== false || Object.keys(current.notifications).length !== 1) this.persist({ ...current, notifications: { isEnabled: false } }); return SAND_DISABLED_NOTIFICATION_CONFIG; }
  setNotificationConfig(_input: unknown): void { this.update((s) => ({ ...s, notifications: { isEnabled: false } })); }
  getAutoReviewInstructions(): SandAutoReviewInstructions { return this.load().autoReviewInstructions ?? DEFAULT_SAND_AUTO_REVIEW_INSTRUCTIONS; }
  setAutoReviewInstructions(value: SandAutoReviewInstructions): void { const normalized = normalizeSandAutoReviewInstructions(value); this.update((s) => { const { autoReviewInstructions: _old, ...rest } = s; return normalized.isEnabled && normalized.allowInstructions.length === 0 && normalized.blockInstructions.length === 0 ? rest : { ...rest, autoReviewInstructions: normalized }; }); }
  getLocalToolPermission(): SandLocalToolPermission { const s = this.load(); return resolveSandLocalToolPermission(s.localToolPermission ?? SAND_DEFAULT_LOCAL_TOOL_PERMISSION, s.localToolPermissionCeiling); }
  getLocalToolPermissionChoice(): SandLocalToolPermission { return this.load().localToolPermission ?? SAND_DEFAULT_LOCAL_TOOL_PERMISSION; }
  getLocalToolPermissionCeiling(): SandLocalToolPermission | undefined { return this.load().localToolPermissionCeiling; }
  setLocalToolPermission(value: SandLocalToolPermission): void { this.update((s) => ({ ...s, localToolPermission: normalizeSandLocalToolPermission(value) })); }
  // The bundled default is the user's own endpoint. There is no account here to
  // serve the "cursor" provider, so defaulting to it routed every turn into a
  // provider that can never answer. A file that still names it is refused here
  // rather than honoured: this reader is the one every routing decision shares
  // (host turn shell, cursor session factory, inference service, coordinator
  // router, desktop panel), so a refusal here cannot be bypassed downstream.
  getInferenceProvider(): SandInferenceProvider { return resolveServedInferenceProvider(this.load().inferenceProvider); }
  // Refusing on read alone would leave the panel showing a provider the store
  // never agreed to, so a refused value is not written in the first place.
  setInferenceProvider(value: SandInferenceProvider): void { const served = resolveServedInferenceProvider(value); this.update((s) => ({ ...s, inferenceProvider: served })); }
  getInferenceCustomEndpoint(): SandInferenceCustomEndpoint | undefined { return this.load().inferenceCustomEndpoint; }
  // The endpoint and the demotion are written by different paths — the Router panel writes the
  // endpoint, a failed turn writes the demotion — so this is the one write that could erase a
  // demotion by accident.
  //
  // The rule, stated once because three defects lived in the space between its cases:
  //
  //   * NO `fallbackModelId` key in the offered endpoint  => leave the stored spare ALONE. This is
  //     the shape the Router panel actually sends (`{ baseUrl, modelId }`,
  //     `scripts/lib/router-renderer-patch.mjs`), so an ordinary Save must not be read as "delete
  //     my spare". Reading it that way is measured: the demotion stayed in the file but stopped
  //     matching the endpoint, `getInferenceCustomModelDemotion()` answered `undefined`, and
  //     `resolveEffectiveCustomModelId` returned `space-bunny` again on the very next turn.
  //   * `fallbackModelId: null`                            => the ONE explicit way to clear it.
  //   * a usable `fallbackModelId` (a non-empty token this build can put on the wire) => that
  //     spare, trimmed.
  //   * anything else (`""`, `"   "`, `42`, an object, a token with a space in it) => read as
  //     "this endpoint has no spare". It is NOT an instruction to clear a working one, and it is
  //     NOT a reason to refuse the whole endpoint: refusing it killed the primary route and told
  //     the user their base URL and model were wrong when both were fine.
  //
  // A spare that reaches the store is taken to belong to a route with the primary it was saved
  // with, so it is carried only while the endpoint's own identity (base URL and primary model)
  // survives the write. A record that demoted off the old primary, or onto a spare that is no
  // longer the endpoint's spare, is dropped rather than left in the file to reappear later: a
  // record that stops matching is exactly what `activeCustomModelDemotion` refuses to route with.
  setInferenceCustomEndpoint(value: SandInferenceWriteEndpoint | undefined): void {
    this.update((s) => {
      const { inferenceCustomEndpoint: previous, inferenceCustomModelDemotion: _demotion, ...rest } = s;
      if (value === undefined) return rest;
      const offered = normalizeSandInferenceWriteEndpoint(value);
      if (offered === undefined) return rest;
      const sameRoute = previous !== undefined &&
        previous.modelId.trim() === offered.modelId &&
        previous.baseUrl.trim() === offered.baseUrl;
      const fallbackModelId = offered.fallbackModelId === undefined
        ? (sameRoute ? sandInferenceFallbackModelId(previous.fallbackModelId) : undefined)
        : offered.fallbackModelId ?? undefined;
      const endpoint: SandInferenceCustomEndpoint = {
        baseUrl: offered.baseUrl,
        modelId: offered.modelId,
        ...(fallbackModelId === undefined ? {} : { fallbackModelId })
      };
      const stored = normalizeSandInferenceCustomModelDemotion(s.inferenceCustomModelDemotion);
      const demotionSurvives = stored !== undefined && previous !== undefined && sameRoute &&
        stored.fromModelId === endpoint.modelId &&
        stored.toModelId === fallbackModelId;
      return {
        ...rest,
        inferenceCustomEndpoint: endpoint,
        ...(demotionSurvives ? { inferenceCustomModelDemotion: stored } : {})
      };
    });
  }
  /**
   * The demotion in force, or `undefined`.
   *
   * Returns nothing when the endpoint is gone, has no spare, or no longer names the primary the
   * record demoted off — the same conditions `activeCustomModelDemotion` uses, applied here so a
   * stale record is invisible to every reader rather than re-derived by each of them.
   */
  getInferenceCustomModelDemotion(): SandInferenceCustomModelDemotion | undefined {
    const stored = this.load();
    const endpoint = stored.inferenceCustomEndpoint;
    if (endpoint === undefined || stored.inferenceCustomModelDemotion === undefined) return undefined;
    return activeCustomModelDemotion(endpoint, stored.inferenceCustomModelDemotion);
  }
  /** Stores a demotion, or clears it when given `undefined`. Junk is refused rather than written. */
  setInferenceCustomModelDemotion(value: SandInferenceCustomModelDemotion | undefined): void {
    this.update((s) => {
      const { inferenceCustomModelDemotion: _old, ...rest } = s;
      const demotion = normalizeSandInferenceCustomModelDemotion(value);
      return demotion === undefined ? rest : { ...rest, inferenceCustomModelDemotion: demotion };
    });
  }
  getInferenceRouterUsage(): SandInferenceRouterUsage { return this.load().inferenceRouterUsage ?? emptySandInferenceRouterUsage(); }
  recordInferenceUsage(provider: SandInferenceProvider, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    const safe = (value: number | undefined): number => Number.isFinite(value) && value! >= 0 ? Math.round(value!) : 0;
    this.update((settings) => {
      const current = settings.inferenceRouterUsage ?? emptySandInferenceRouterUsage();
      const previous = current.providers[provider];
      return { ...settings, inferenceRouterUsage: { schemaVersion: 1, providers: { ...current.providers, [provider]: { requests: previous.requests + 1, inputTokens: previous.inputTokens + safe(usage.inputTokens), outputTokens: previous.outputTokens + safe(usage.outputTokens), cacheReadTokens: previous.cacheReadTokens + safe(usage.cacheReadTokens), cacheWriteTokens: previous.cacheWriteTokens + safe(usage.cacheWriteTokens), lastUsedAt: new Date().toISOString() } } } };
    });
  }
  setLocalToolPermissionCeiling(value?: SandLocalToolPermission): void { this.update((s) => { const { localToolPermissionCeiling: _old, ...rest } = s; return isSandLocalToolPermission(value) ? { ...rest, localToolPermissionCeiling: value } : rest; }); }
  getPinnedAgentIds(): string[] | undefined { return this.load().pinnedAgentIds; }
  setPinnedAgentIds(ids: readonly string[]): void { this.update((s) => ({ ...s, pinnedAgentIds: [...new Set(stringArray(ids).filter((id) => id.length > 0))] })); }
  static storable(args: { sections: readonly SidebarSection[]; stored?: readonly SidebarSection[] }): SidebarSection[] { return SidebarSections.carryFolds(args).map((s) => ({ id: s.id, name: s.name, agentIds: [...s.agentIds], isCollapsed: s.isCollapsed ?? false })); }
  getSidebarSections(): SidebarSection[] | undefined { const stored = this.load().sidebarSections; return stored === undefined ? undefined : SidebarSections.carryFolds({ sections: stored }); }
  setSidebarSections(sections: readonly SidebarSection[]): void { this.update((s) => ({ ...s, sidebarSections: SandSettingsStore.storable(s.sidebarSections === undefined ? { sections } : { sections, stored: s.sidebarSections }) })); }
}
