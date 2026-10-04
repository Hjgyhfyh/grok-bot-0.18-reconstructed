import { isEffectivePluginInstalled } from "../../mcp.js";
import { mergeUnresolvedAccountServers } from "./account-display-cache.js";
import { BUILTIN_MCP_SERVER_NAMES } from "./builtin-mcp.js";
import { SandMcpAccountSlotLifecycle } from "./mcp-account-slot-lifecycle.js";
import { SandMcpAuthWatchLifecycle } from "./mcp-auth-watch-lifecycle.js";
import {
  AUTH_WATCH_POLL_INTERVAL_MS,
  AUTH_WATCH_POLL_TIMEOUT_MS,
  AUTH_WATCH_TIMEOUT_MS,
} from "./mcp-auth-watch.js";
import { SandMcpCatalogFlow } from "./mcp-catalog-flow.js";
import { SandMcpConfigError } from "./mcp-config-error.js";
import {
  backendEntryBelongsToRow,
  SandMcpDefinitionSource,
} from "./mcp-definition-source.js";
import {
  runtimeConfigFromDisplay,
  validateMarketplacePluginId,
  type DisplayServer,
} from "./mcp-display-runtime.js";
import {
  createLocalMcpServerSource,
  localMcpServerIdForName,
  type LocalMcpServerSource,
} from "./local-mcp-config-provider.js";
import { SandMcpInstructionsAndToggles } from "./mcp-instructions-and-toggles.js";
import { SandMcpListingSummaries } from "./mcp-listing-summaries.js";
import { validateMcpServerId } from "./mcp-server-id.js";
import { parseServerConfig, validateServerName } from "./mcp-validation.js";
import { reportMcpHostEdgeFailure } from "./mcp-diagnostics.js";
const EMPTY_SETTINGS: any = {
  scopeToAccount() {},
  migrateMcpCustomInstructionToServerId() {},
  getMcpCustomInstructions: () => ({}),
  getMcpCustomInstructionsByServerId: () => ({}),
  getMcpDisabledToolsByServerId: () => ({}),
  setMcpDisabledToolsByServerId() {},
  getRawMcpCustomInstruction: () => undefined,
  getRawMcpCustomInstructionByServerId: () => undefined,
  setMcpCustomInstructionByServerId() {},
  deleteMcpCustomInstructionByServerId() {},
};
export class SandMcpManager {
  private settingsStore: any;
  private boxRuntime: any;
  private readonly backendMcpExec: any;
  private readonly definitionSource: SandMcpDefinitionSource;
  private readonly accountWriter: any;
  private readonly effectivePluginsProvider: any;
  private readonly accountServersProvider: any;
  private readonly accountDisplayConfigProvider: any;
  private accountPromise: Promise<any> | undefined;
  private generation = 0;
  private lastDisplay: any = null;
  private lastState: any = null;
  private lastBackendTools: any[] = [];
  private lastScope: string | undefined;
  private readonly authWatches: SandMcpAuthWatchLifecycle;
  private readonly summaries: SandMcpListingSummaries;
  private readonly instructions: SandMcpInstructionsAndToggles;
  private readonly slots: SandMcpAccountSlotLifecycle;
  private readonly catalog: SandMcpCatalogFlow;
  /**
   * The user's local stdio servers, read from disk and never written.
   *
   * Shared with {@link SandMcpDefinitionSource} so both can never disagree about
   * what is installed. Injected only by tests; production builds the default.
   */
  private readonly localServers: LocalMcpServerSource;
  constructor(private readonly options: any) {
    this.settingsStore = options.settingsStore ?? EMPTY_SETTINGS;
    this.boxRuntime = options.boxRuntime;
    this.backendMcpExec = options.backendMcpExec;
    this.accountWriter = options.accountMcpWriter;
    this.effectivePluginsProvider = options.effectivePluginsProvider;
    this.accountServersProvider = options.accountServersProvider;
    this.localServers = options.localMcpServers ?? createLocalMcpServerSource();
    this.accountDisplayConfigProvider =
      options.accountServersProvider == null
        ? options.accountDisplayConfigProvider
        : () => this.loadAccountServers();
    this.definitionSource = new SandMcpDefinitionSource(
      options.includeBuiltins ?? true,
      options.accountServersProvider == null
        ? options.accountConfigProvider
        : async () => runtimeConfigFromDisplay(await this.loadAccountServers()),
      () => this.localServers.servers(),
    );
    this.authWatches = new SandMcpAuthWatchLifecycle({
      backendMcpExec: this.backendMcpExec,
      authWatchPollIntervalMs:
        options.authWatchPollIntervalMs ?? AUTH_WATCH_POLL_INTERVAL_MS,
      authWatchTimeoutMs: options.authWatchTimeoutMs ?? AUTH_WATCH_TIMEOUT_MS,
      authWatchPollTimeoutMs:
        options.authWatchPollTimeoutMs ?? AUTH_WATCH_POLL_TIMEOUT_MS,
      resolveDisplayServer: (id, opts) => this.resolveDisplayServer(id, opts),
      reload: () => this.reload(),
      onConnectorAuth: options.onConnectorAuth,
    });
    this.summaries = new SandMcpListingSummaries({
      settingsStore: () => this.settingsStore,
      isBoxExecWired: () => this.boxRuntime?.isBoxExecWired() === true,
    });
    this.instructions = new SandMcpInstructionsAndToggles({
      settingsStore: () => this.settingsStore,
      resolveDisplayServer: (id) => this.resolveDisplayServer(id),
      listServers: () => this.listServers(),
      lastAccountDisplayConfig: () => this.lastDisplay,
      getToolsRaw: async () => (await this.boxRuntime?.getToolsRaw()) ?? [],
    });
    this.catalog = new SandMcpCatalogFlow({
      getMachineId: options.getMachineId,
      listEffectivePlugins: () => this.listEffectivePlugins(),
      requireAccountWriter: () => this.requireAccountWriter(),
      reloadServers: () => this.reloadServers(),
    });
    this.slots = new SandMcpAccountSlotLifecycle({
      backendMcpExec: this.backendMcpExec,
      definitionSource: this.definitionSource,
      resolveDisplayServer: (id) => this.resolveDisplayServer(id),
      reloadServers: () => this.reloadServers(),
      clearPendingAuthWatch: (id, key) =>
        this.authWatches.clearPendingAuthWatchCancelled(id, key),
      notifyWatchCancelled: (watch) =>
        this.authWatches.notifyWatchCancelled(watch),
      lastAccountDisplayConfig: () => this.lastDisplay,
      setLastAccountDisplayConfig: (display) => {
        this.lastDisplay = display;
      },
      lastListedState: () => this.lastState,
      setLastListedState: (state) => {
        this.lastState = state;
      },
      invalidateToolsCache: () => this.boxRuntime?.invalidateToolsCache(),
      resetPushState: () => this.boxRuntime?.resetPushState(),
    });
  }
  /**
   * The account display configuration with the user's local stdio servers added.
   *
   * Why the rows are added HERE and not only to the definition source: the
   * definition source is what gets pushed to the computer, but the per-server
   * settings (`getMcpDisabledToolsByServerId`, `getRawMcpCustomInstructionByServerId`)
   * are keyed by `DisplayServer.id` read out of `lastAccountDisplayConfig`
   * (`./tools-discovery.ts:90-102`). A server present only in the pushed config
   * has live tools and no row, so its toggles and instructions silently do
   * nothing, and `GetMcpServerStatus` keeps answering "No MCP servers are
   * installed" while the agent can already call the tools. One row per local
   * server fixes both at once, because every other read goes through this object.
   *
   * The account row WINS on a name collision: an account server is authenticated,
   * managed by the account API and removable through it, and a local file must not
   * shadow it with a process it would also start.
   *
   * Idempotent: re-merging an already merged display returns it untouched, which is
   * what lets `lastDisplay` be cached and re-merged on every read.
   */
  private withLocalServers(display: any): any {
    const local = this.localServers.servers();
    const names = Object.keys(local).sort();
    if (names.length === 0) return display;
    const servers: any[] = display?.servers ?? [];
    const takenIds = new Set<string>(servers.map((server: any) => server.id));
    const takenNames = new Set<string>(
      servers.map((server: any) => server.serverIdentifier ?? server.name),
    );
    const rows: DisplayServer[] = [];
    for (const name of names) {
      const config = local[name];
      if (config == null || takenNames.has(name)) continue;
      const id = localMcpServerIdForName(name, takenIds);
      takenIds.add(id);
      takenNames.add(name);
      rows.push({
        id,
        name,
        serverIdentifier: name,
        config: { command: config.command, ...(config.args === undefined ? {} : { args: [...config.args] }), ...(config.env === undefined ? {} : { env: { ...config.env } }) },
        isTeamServer: false,
        disabledByTeamAdminPolicy: false,
      });
    }
    if (rows.length === 0) return display;
    return { ...display, servers: [...servers, ...rows] };
  }

  /**
   * What the manager returns when the account list is empty or unreadable.
   *
   * Without local servers this is `null`, byte for byte what the account-only
   * code returned, so a machine with no local configuration behaves exactly as
   * before. With them, the definition source is adopted too, so the local stdio
   * configurations reach the computer even though the account read produced
   * nothing — `clearLastKnownAccountConfig()` above has just emptied that cache.
   */
  private localOnlyDisplayConfig(): any {
    if (Object.keys(this.localServers.servers()).length === 0) return null;
    const display = this.withLocalServers({ servers: [] });
    this.definitionSource.adoptAccountConfig(runtimeConfigFromDisplay(display));
    return display;
  }

  /** Local stdio entries, read from the user's file. Exposed for diagnostics. */
  localMcpServersView(): Readonly<Record<string, { readonly command: string }>> {
    return this.localServers.servers();
  }

  /** The file the local entries came from. Shown to the user when one is refused. */
  localMcpConfigPathView(): string {
    return this.localServers.path;
  }

  private loadAccountServers(): Promise<any> {
    if (this.accountPromise != null) return this.accountPromise;
    const generation = ++this.generation,
      promise = (this.accountServersProvider?.() ?? Promise.resolve(null)).then(
        (display: any) => {
          const cached =
            display?.cacheScope !== undefined &&
            display.cacheScope === this.lastScope
              ? this.lastDisplay
              : null;
          if (generation !== this.generation) return cached;
          if (display == null) {
            this.definitionSource.clearLastKnownAccountConfig();
            return this.localOnlyDisplayConfig();
          }
          if (
            display.cacheScope !== undefined &&
            display.cacheScope !== this.lastScope
          ) {
            if (this.lastScope !== undefined) {
              this.lastDisplay = this.lastState = null;
              this.authWatches.clearAllPendingAuthWatchesCancelled();
              this.boxRuntime?.invalidateToolsCache();
            }
            this.settingsStore.scopeToAccount(display.cacheScope);
            this.lastScope = display.cacheScope;
            this.options.onAccountScopeApplied?.();
            this.definitionSource.clearLastKnownAccountConfig();
            this.definitionSource.clearCache();
          }
          if (display.unavailable === true) {
            if (cached == null) {
              this.accountPromise = undefined;
              return this.localOnlyDisplayConfig();
            }
            return cached;
          }
          const resolved = this.withLocalServers(
            mergeUnresolvedAccountServers(display, cached),
          );
          this.lastDisplay = resolved;
          this.definitionSource.adoptAccountConfig(
            runtimeConfigFromDisplay(resolved),
          );
          this.instructions.migrateCustomInstructions(resolved.servers);
          return resolved;
        },
      );
    this.accountPromise = promise;
    const clear = () => {
      if (this.accountPromise === promise) this.accountPromise = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }
  setBoxRuntime(runtime: any): void {
    this.boxRuntime = runtime;
  }
  definitionSourceView() {
    return this.definitionSource;
  }
  lastAccountDisplayConfigView() {
    return this.lastDisplay;
  }
  settingsStoreView() {
    return this.settingsStore;
  }
  backendMcpExecView() {
    return this.backendMcpExec;
  }
  onDiscoveryFailedView() {
    return this.options.onDiscoveryFailed;
  }
  setSettingsStore(settings: any): void {
    this.settingsStore = settings;
  }
  setAuthCompletionObserver(observer: any): void {
    this.authWatches.setAuthCompletionObserver(observer);
  }
  async listServers() {
    // `withLocalServers` is what puts the local rows into `lastDisplay`, which
    // `GetMcpServerStatus` renders and `tools-discovery` keys settings by. With no
    // local configuration it returns its argument unchanged, so the account-only
    // path is bit-for-bit the one that shipped.
    const display = this.withLocalServers(
      await this.accountDisplayConfigProvider?.(),
    );
    if (display != null) this.lastDisplay = display;
    const effectiveDisplay =
        display ??
        (this.accountServersProvider == null ? this.lastDisplay : null),
      runtime = await this.definitionSource.getUserServerConfigs(),
      rows =
        effectiveDisplay?.servers ??
        (this.accountServersProvider == null
          ? Object.entries(runtime).map(([serverIdentifier, config]) => ({
              id: "0",
              name: serverIdentifier,
              serverIdentifier,
              config,
              isTeamServer: false,
              disabledByTeamAdminPolicy: false,
            }))
          : []),
      visible = rows.filter(
        (server: any) =>
          server.serverIdentifier == null ||
          !BUILTIN_MCP_SERVER_NAMES.has(server.serverIdentifier),
      );
    this.instructions.migrateCustomInstructions(visible);
    const http = visible.filter(
        (server: any) =>
          server.serverIdentifier != null &&
          !server.disabledByTeamAdminPolicy &&
          "url" in server.config,
      ),
      stdio = visible.filter(
        (server: any) =>
          server.serverIdentifier != null &&
          !server.disabledByTeamAdminPolicy &&
          "command" in server.config,
      ),
      backend = http.length
        ? await this.backendMcpExec.listTools(
            http.map((server: any) => server.serverIdentifier),
          )
        : [],
      boxByName = new Map<string, any>();
    const disabledByServer =
      this.settingsStore.getMcpDisabledToolsByServerId?.() ?? {};
    this.lastBackendTools = backend.flatMap((entry: any) => {
      const row = http.find((server: any) =>
        backendEntryBelongsToRow(entry, server.serverIdentifier),
      );
      if (row == null) return [];
      const disabled = disabledByServer[row.id] ?? [];
      return entry.tools.filter(
        (tool: any) => !disabled.includes(tool.toolName),
      );
    });
    let unavailable = false;
    if (this.boxRuntime?.isBoxExecWired())
      try {
        for (const server of await this.boxRuntime.listBoxServers(
          stdio.map((item: any) => item.serverIdentifier),
        ))
          boxByName.set(server.serverIdentifier, server);
        unavailable = stdio.length > 0 && boxByName.size === 0;
      } catch (error) {
        reportMcpHostEdgeFailure("box-settings-list", error);
        unavailable = true;
      }
    const servers: any[] = [];
    for (const server of visible) {
      if (server.disabledByTeamAdminPolicy)
        servers.push(this.summaries.createAdminDisabledServerSummary(server));
      else if (!("url" in server.config))
        servers.push(
          this.summaries.createBoxServerSummary(
            server,
            boxByName.get(server.serverIdentifier),
            unavailable,
          ),
        );
      else
        servers.push(
          ...this.summaries.createBackendServerSummaries(
            server,
            backend.filter((entry: any) =>
              backendEntryBelongsToRow(entry, server.serverIdentifier),
            ),
          ),
        );
    }
    return (this.lastState = { servers });
  }
  async listConnectedBackendTools() {
    await this.listServers();
    return [...this.lastBackendTools];
  }
  async addServer(request: any) {
    const name = this.validateInstallableName(request.name),
      config = parseServerConfig(
        request.configJson,
        this.options.parseServerConfig,
      );
    await this.addServersToAccount({ [name]: config });
    return this.reloadServers();
  }
  getCatalog(token: any, options?: any) {
    return this.catalog.getCatalog(token, options);
  }
  resolvePluginLogo(url: string) {
    return this.catalog.resolvePluginLogo(url);
  }
  installEntry(request: any, token: any) {
    return this.catalog.installEntry(request, token);
  }
  updatePluginInstall(request: any, token: any) {
    return this.catalog.updatePluginInstall(request, token);
  }
  private validateInstallableName(name: string) {
    const validated = validateServerName(name);
    if (BUILTIN_MCP_SERVER_NAMES.has(validated))
      throw new SandMcpConfigError(
        `MCP server name "${validated}" is reserved for a built-in Grok Bot server.`,
      );
    return validated;
  }
  private requireAccountWriter() {
    if (this.accountWriter == null)
      throw new SandMcpConfigError(
        "Managing MCP servers requires a signed-in Cursor account.",
      );
    return this.accountWriter;
  }
  private async addServersToAccount(
    servers: Record<string, any>,
  ): Promise<void> {
    const writer = this.requireAccountWriter(),
      { config, serverIdsByName } = await writer.getConfigForEdit();
    await writer.setConfig(
      { mcpServers: { ...config.mcpServers, ...servers } },
      serverIdsByName,
    );
  }
  async removeServer(rawId: string) {
    const id = validateMcpServerId(rawId),
      row = await this.resolveDisplayServer(id);
    if (
      row?.pluginId != null &&
      !row.isTeamServer &&
      !row.managedByTeamPluginPolicy &&
      !row.isRequired
    )
      return this.uninstallPluginRows(row.pluginId, id);
    const writer = this.requireAccountWriter(),
      current = await writer.getConfigForEdit(),
      name = Object.entries(current.serverIdsByName).find(
        ([, value]: any) => value.toString() === id,
      )?.[0];
    if (name == null || !(name in current.config.mcpServers))
      return this.classifyRemoveOutcome(id, await this.listServers());
    const servers = { ...current.config.mcpServers };
    delete servers[name];
    const ids = { ...current.serverIdsByName };
    delete ids[name];
    await writer.setConfig({ mcpServers: servers }, ids);
    this.authWatches.clearPendingAuthWatchesForServer(id);
    const displayName = row?.name;
    const sameNameRows =
      this.lastDisplay?.servers.filter(
        (server: any) => server.name === displayName,
      ).length ?? 1;
    this.settingsStore.deleteMcpCustomInstructionByServerId({
      serverId: id,
      displayName: displayName ?? name,
      deleteLegacyName: displayName != null && sameNameRows <= 1,
    });
    this.instructions.deleteDisabledToolsForServer(id);
    return this.classifyRemoveOutcome(id, await this.reloadServers(id));
  }
  private classifyRemoveOutcome(id: string, state: any) {
    const remaining = state.servers.find((server: any) => server.id === id);
    return remaining == null
      ? { state, removed: true }
      : {
          state,
          removed: false,
          reason: remaining.isTeamServer ? "team-server" : "still-present",
        };
  }
  listEffectivePlugins() {
    return this.effectivePluginsProvider == null
      ? Promise.resolve([])
      : this.effectivePluginsProvider();
  }
  async uninstallPlugin(raw: string) {
    const id = validateMarketplacePluginId(raw),
      state = await this.performPluginUninstall(id);
    let gone = this.effectivePluginsProvider == null;
    if (!gone)
      try {
        gone = !(await this.effectivePluginsProvider()).some(
          (plugin: any) =>
            plugin.pluginId === id && isEffectivePluginInstalled(plugin),
        );
      } catch {}
    const rows = state.servers.filter((server: any) => server.pluginId === id);
    return gone && rows.length === 0
      ? { state, removed: true }
      : {
          state,
          removed: false,
          reason:
            !gone || rows.some((row: any) => !row.isTeamServer)
              ? "still-present"
              : "team-server",
        };
  }
  private async performPluginUninstall(id: string) {
    const writer = this.requireAccountWriter();
    let display =
      this.accountDisplayConfigProvider == null ? this.lastDisplay : null;
    if (display == null && this.accountDisplayConfigProvider != null) {
      try {
        display = await this.accountDisplayConfigProvider();
        if (display != null) this.lastDisplay = display;
      } catch {
        display = this.lastDisplay;
      }
    }
    let effective = null;
    if (this.effectivePluginsProvider != null) {
      try {
        effective = await this.effectivePluginsProvider();
      } catch {
        effective = null;
      }
    }
    if (display == null && effective == null)
      throw new SandMcpConfigError(
        "Couldn't verify this plugin's team policy right now, so nothing was uninstalled. Try again.",
      );
    const rows = (display?.servers ?? []).filter(
      (server: any) => server.pluginId === id,
    );
    if (
      rows.some((row: any) => row.isRequired) ||
      (effective ?? []).some(
        (plugin: any) =>
          plugin.pluginId === id && plugin.installMode === "team-required",
      )
    )
      throw new SandMcpConfigError(
        "This plugin is required by the user's team and can't be uninstalled.",
      );
    const attributedRows = rows.filter((row: any) => !row.isTeamServer);
    await writer.uninstallPlugin({ pluginId: BigInt(id) });
    for (const row of attributedRows) {
      this.authWatches.clearPendingAuthWatchesForServer(row.id);
      const sameNameRows =
        display?.servers.filter((server: any) => server.name === row.name)
          .length ?? 1;
      this.settingsStore.deleteMcpCustomInstructionByServerId({
        serverId: row.id,
        displayName: row.name,
        deleteLegacyName: sameNameRows <= 1,
      });
      this.instructions.deleteDisabledToolsForServer(row.id);
    }
    return this.reloadServers();
  }
  private async uninstallPluginRows(pluginId: string, serverId: string) {
    return this.classifyRemoveOutcome(
      serverId,
      await this.performPluginUninstall(pluginId),
    );
  }
  logoutAccount(...args: [string, string]) {
    return this.slots.logoutAccount(...args);
  }
  renameAccount(...args: [string, string, string]) {
    return this.slots.renameAccount(...args);
  }
  removeAccount(...args: [string, string]) {
    return this.slots.removeAccount(...args);
  }
  setServerCustomInstructions(args: any) {
    return this.instructions.setServerCustomInstructions(args);
  }
  listServerTools(id: string) {
    return this.instructions.listServerTools(id);
  }
  toggleMcpToolDisabled(args: any) {
    return this.instructions.toggleMcpToolDisabled(args);
  }
  getMcpCustomInstructions() {
    return this.instructions.getMcpCustomInstructions();
  }
  async reloadServers(removed?: string) {
    await this.reload();
    if (removed != null && this.lastDisplay != null)
      this.lastDisplay = {
        ...this.lastDisplay,
        servers: this.lastDisplay.servers.filter(
          (server: any) => server.id !== removed,
        ),
      };
    return this.listServers();
  }
  refreshAccountConfigInBackground(): void {
    this.generation += 1;
    this.accountPromise = undefined;
    this.localServers.invalidate();
    this.definitionSource.refreshInBackground();
  }
  authenticateServer(...args: any[]) {
    return this.authWatches.authenticateServer(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
    );
  }
  async resolveDisplayServer(
    raw: string,
    options?: { requireFreshRead: boolean },
  ) {
    const id = validateMcpServerId(raw);
    if (options?.requireFreshRead && this.accountServersProvider != null) {
      const display = this.withLocalServers(await this.accountServersProvider());
      if (display == null || display.unavailable)
        throw new SandMcpConfigError("account display config unavailable");
      return display.servers.find((server: any) => server.id === id);
    }
    if (this.accountDisplayConfigProvider == null) {
      if (options?.requireFreshRead)
        throw new SandMcpConfigError("no account display config provider");
      return undefined;
    }
    let display = null;
    try {
      display = this.withLocalServers(
        await this.accountDisplayConfigProvider(),
      );
    } catch (error) {
      if (options?.requireFreshRead) throw error;
    }
    if (display != null) this.lastDisplay = display;
    else if (options?.requireFreshRead)
      throw new SandMcpConfigError("account display config unavailable");
    if (options?.requireFreshRead && display?.unavailable === true)
      throw new SandMcpConfigError("account display config unavailable");
    return (
      display ?? (this.accountServersProvider == null ? this.lastDisplay : null)
    )?.servers.find((server: any) => server.id === id);
  }
  noteAuthCompletedElsewhere(id: string, key: string) {
    return this.authWatches.noteAuthCompletedElsewhere(id, key);
  }
  async dispose(): Promise<void> {
    this.authWatches.clearAllPendingAuthWatches();
  }
  async reload(): Promise<void> {
    this.generation += 1;
    this.accountPromise = undefined;
    // `RestartMcpServers` is how a user tells Grok Bot they edited the file by
    // hand, so the re-read must not wait out the memo.
    this.localServers.invalidate();
    this.definitionSource.clearCache();
    this.boxRuntime?.invalidateToolsCache();
    this.boxRuntime?.resetPushState();
  }
}
