# REMOVE-CURSOR.md — full inventory of remaining Cursor dependencies

Audit date: 2026. Scope: `D:\ТЕСТЫ\DeepSeek-Harness\grok-bot-0.18-reconstructed`.
Method: read-only inspection of `source/**`, `scripts/**`. No builds, no app launch, no file
outside this document was modified.

**Evidence convention.** Every claim carries `file:line`. Claims marked **PROVEN** were read
directly in code. Claims marked **INFERRED** are reasoned from read code but not executed.
Where something does not exist, this document says *I could not find* rather than guessing.

**Not re-investigated (already fixed, out of scope):** `inferenceProvider: "custom"` works, and
`listInferenceRouterModels` is present in `MAIN_METHOD_TABLE`.

---

## 0. Headline answer: is there one chokepoint?

**No. There is no single flag that turns off all of it.** But there are **three** high-leverage
chokepoints, and two of them are one-line edits that each fix several items at once. Item-by-item
work is unavoidable for the rest.

| # | Chokepoint | `file:line` | What it controls | Verdict |
|---|---|---|---|---|
| C1 | `pinGateOnAuthenticatedBootstrap` | `source/shared/node/experiments/cursor-experiments.ts:38` | All 4 permanently-dead feature flags (GC, blob retirement, memory synthesis) | **Best single edit in the repo.** One function, four features. |
| C2 | `getConfiguredBackendUrl` | `source/shared/node/cursor-token.ts:38-40` | The backend host for ~20 modules, via `SAND_BACKEND_URL` | Retargets traffic; does **not** disable it, and misses Sentry/Statsig/update feed/website URLs entirely. |
| C3 | `SandProductAnalytics` constructor | `source/shared/node/analytics/product-analytics.ts:68` | Whether any product analytics leaves the machine | One condition; kills the only default-ON data leak. |

C2 is a redirect, not a cut. Pointing `SAND_BACKEND_URL` at a black hole still opens outbound
sockets, still burns the bootstrap timeout, and still leaves four hardcoded hosts untouched
(Sentry, Statsig, update feed, website). Use C3 for privacy and C2 for tests, not as the fix.

---

## 1. TOP 10 by user-visible impact

Ranked by what the user actually notices, worst first.

| Rank | Item | `file:line` | Class | What the user sees |
|---|---|---|---|---|
| **1** | Product analytics goes **live by default** with no account and posts to `api2.cursor.sh` | `source/shared/node/analytics/product-analytics.ts:68`, `:104`, `:114`, `:123-127`; gate default `true` at `source/shared/node/experiments/experiment-config.gen.ts:221-224` | **BLOCKING** (for "железно чисто локально") | Nothing. Data leaves silently, every day. This is the single worst item. |
| **2** | Default inference provider is `"cursor"` | `source/shared/node/settings/sand-settings-store.ts:159` | **BLOCKING** | Fresh install with no `settings.json` routes to Cursor and every turn fails. |
| **3** | Router UI defaults to `"cursor"` and renders the Cursor billing panel | `scripts/lib/router-renderer-patch.mjs:75`, `:87` | COSMETIC → DEGRADED | Settings flashes "Cursor" on open; the original Cursor usage/billing panel renders. |
| **4** | Structured logs are sent **anonymously** to `api2.cursor.sh` with no token | `source/electron-main/adapters/telemetry.ts:38-40`; `source/shared/node/cursor-backend/cursor-inference.ts:141` | **BLOCKING** (privacy) | Nothing. Machine id + event metadata leave the machine with the `authorization` header deleted. |
| **5** | `stale_root_gc` is unreachable — **no env escape exists** | `source/host/extensions/session/session-maintenance.ts:58` (gate `:13`) | DEGRADED | Checkpoint-root GC never runs. DB grows forever, silently. |
| **6** | Conversation hard cap never enforced → `SandConversationTooLargeError` never thrown | `source/host/extensions/session/conversation-size-limits.ts:48-49`, `:37` | DEGRADED | A long conversation grows without bound instead of compacting. No error is shown. |
| **7** | Legacy blob retirement permanently off | `source/host/extensions/session/session-maintenance.ts:15,72` | DEGRADED | Dead `blobs` table kept in every existing `store.db` forever. |
| **8** | Memory synthesis ("dreaming") permanently off | `source/host/extensions/memory/extension.ts:11` | DEGRADED | Agent never builds memories. `reportMemorySynthesis({outcome:"skipped_gate"})` is never even reached. |
| **9** | Sentry DSN points at Cursor's Sentry (`metrics.cursor.sh`) | `source/shared/observability/sentry.ts:4` | DEGRADED (kill switch exists) | Crash reports with stack traces leave the machine unless `SAND_DISABLE_SENTRY=1`. |
| **10** | App auto-update polls `https://api2.cursor.sh/updates` on every packaged Windows launch | `source/electron-main/update/update-feed.ts:8`; `source/electron-main/update/update-gate.ts:2` | DEGRADED (kill switch exists) | An update check fires on every start; may also offer to replace the build. |

---

## 2. Item 1 — `experiments/`: feature flags that never pin

### 2.1 The path in the task brief is wrong (corrected)

The brief says `source/host/extensions/experiments/`. That directory exists but contains only the
host-side wrapper. The file named is actually at:

- **`source/shared/node/experiments/cursor-experiments.ts`** (78 lines)
- `source/host/extensions/experiments/extension.ts` is a thin re-export facade (lines 14, 18-20).

### 2.2 The suspicion is CONFIRMED — PROVEN

`source/shared/node/experiments/cursor-experiments.ts:38`

```ts
pinGateOnAuthenticatedBootstrap(name, pin) {
  if (this.hasAuthenticatedNetworkBootstrap) { pin(this.checkFeatureGate(name)); return; }
  const unsubscribe = this.subscribe(() => {
    if (!this.hasAuthenticatedNetworkBootstrap) return;
    unsubscribe(); pin(this.checkFeatureGate(name));
  });
}
```

`pin` is called **only** when `hasAuthenticatedNetworkBootstrap === true`. There is no timeout, no
fallback, no error branch. Without it the closure is retained forever and nothing fires.

`hasAuthenticatedNetworkBootstrap` is declared at `cursor-experiments.ts:23` and assigned in
**exactly one place**, `cursor-experiments.ts:73`, inside `runRefresh`:

```ts
const userId = readStatsigBootstrapUserId(result.config);
this.hydrate(result.config);
this.hasLiveNetworkBootstrap = true;
this.hasAuthenticatedNetworkBootstrap = userId != null && userId.length > 0;
```

To get there, `runRefresh` must survive `fetchStatsigBootstrap` (`statsig-bootstrap.ts:28-45`),
which POSTs to `new URL("aiserver.v1.AnalyticsService/BootstrapStatsig", backendUrl)`
(`statsig-bootstrap.ts:39`) where `backendUrl` defaults to `DEFAULT_CURSOR_BACKEND_URL =
"https://api2.cursor.sh"` (`source/shared/node/cursor-token.ts:3`), called from
`cursor-experiments.ts:73`.

**Two precise details worth knowing before anyone edits this:**

1. **The token is optional for the bootstrap.** `statsig-bootstrap.ts:33` fetches the token with
   `.catch(() => undefined)` and `:36` sets `authorization` only when a token exists. So an
   anonymous bootstrap CAN succeed. The gate is not "did we send a token" — it is **"did the
   response config carry a non-empty `user.userID`"** (`readStatsigBootstrapUserId`,
   `statsig-bootstrap.ts:18`).
2. **The on-disk cache does not satisfy the gate.** `start()` at `cursor-experiments.ts:32` calls
   `loadCachedBootstrap` and `this.hydrate(cached.config)` — `hydrate` (`:75`) sets
   `lastHydratedUserId` and `hasHydratedStatsigUserId()` returns true — but it **never sets
   `hasAuthenticatedNetworkBootstrap`**. `cached.userId` is loaded (`statsig-bootstrap.ts:49`) and
   then discarded. **PROVEN:** a warm cache does not unblock the pins.

### 2.3 Every flag that is therefore permanently off — exactly four

Only two call sites use `pinGateOnAuthenticatedBootstrap`. Full list:

| Gate | Pinned at | Bundled default | Module state it writes | Env escape |
|---|---|---|---|---|
| `sand_stale_root_gc` | `source/host/extensions/session/extension.ts:7` | `false` (`experiment-config.gen.ts:255-258`) | `staleRootGc` — `session-maintenance.ts:13` | **NONE** |
| `sand_legacy_store_blob_retirement` | `source/host/extensions/session/extension.ts:7` | `false` (`experiment-config.gen.ts:273-276`) | `legacyRetirement` — `session-maintenance.ts:13` | `SAND_RETIRE_LEGACY_STORE_BLOBS` (`session-maintenance.ts:15`) |
| `grok_bot_conversation_gc` | `source/host/extensions/session/extension.ts:7` | `false` (`experiment-config.gen.ts:280-283`) | `pinnedConversationGcEnabled` — `conversation-size-limits.ts:18` | `SAND_CONVERSATION_GC` (`conversation-size-limits.ts:28`) |
| `sand_memory_dreaming` | `source/host/extensions/memory/extension.ts:11` | `false` (`experiment-config.gen.ts:153-156`) | calls `service.enableMemorySynthesis(...)` | **NONE** |

**`sand_stale_root_gc` is the worst of the four.** `session-maintenance.ts:58` reads the module
variable directly:

```ts
if (!staleRootGc || db.getStaleRootCleanupVersion() >= STALE_ROOT_CLEANUP_VERSION) return false;
```

There is no `process.env` read anywhere in that path. `pinStaleRootGc` (`:16`) is called from
exactly one place — the pin callback. So the feature is unreachable in a shipped build, today,
with or without an account.

Note a contradiction in the generated config: `experiment-config.gen.ts:270-272` states
*"There is deliberately no env override: this is the only switch"* for
`sand_legacy_store_blob_retirement`, but `session-maintenance.ts:15` **does** read
`SAND_RETIRE_LEGACY_STORE_BLOBS`. The comment is stale. The code is the truth.

### 2.4 What the dead flags actually cost

- **Conversation GC** — `conversation-size-limits.ts:48-49`
  `ensureConversationCapacityForTurn` returns immediately when `isConversationGcEnabled()` is false.
  So `runConversationGc` (`:41`) never runs, the hard cap never triggers, and
  `SandConversationTooLargeError` (`:37`) is **never thrown**. The soft-limit scheduler
  (`scheduleConversationSizeMaintenance`, `:44-45`) also returns immediately.
  **Net effect: conversation blobs grow without bound, with no error and no log.** This is the
  most expensive silent failure in the repo.
- **Size limits themselves DO work.** `extension.ts:7` calls
  `pinConversationSizeLimitsReader(...)` **directly**, not through the gate, so
  `conversationSoftLimitBytes` / `conversationHardLimitBytes` (`:24-25`) do read values
  (256 MB / 1024 MB from `experiment-config.gen.ts:5195-5201` `fallbackValues`). The numbers are
  live; nothing enforces them.
- **Legacy blob retirement** — `session-maintenance.ts:71-73` returns `false` at the guard.
  The dead `blobs` table is never cleared from existing `store.db` files.
- **Stale root GC** — `session-maintenance.ts:57-60` returns `false` at the guard.
  Superseded checkpoint roots accumulate in every `conversation-blobs.db`.
- **Memory dreaming** — `memory/extension.ts:11`. The callback is never invoked, so
  `service.enableMemorySynthesis(context.createSynthesis(service))` never runs. Note the
  `reportMemorySynthesis({outcome:"skipped_gate"})` line is also unreachable, so **telemetry
  does not even record that it was skipped.** Total silence.

### 2.5 Flags that are NOT pinned, and what they therefore resolve to

These use `checkFeatureGate` / `getFeatureGateProperty` / `checkGate`, which fall back to the
bundled default at `cursor-experiments.ts:39`
(`if (this.client == null) return FLAGS[name]?.default ?? false;`). They work — at a value frozen
at build time, with no way to change it without an account.

| Gate | Consumer `file:line` | Default | Effect of being frozen |
|---|---|---|---|
| `sand_product_analytics` | `source/shared/node/analytics/product-analytics.ts:104` | **`true`** (`experiment-config.gen.ts:221-224`) | **Analytics goes live. See §7.1.** |
| `sand_global_search` | `source/host/extensions/content-search/extension.ts:39,43` | `true` (`:355-358`) | Global search works; cannot be tuned. Fine. |
| `sand_computer_use_playwright` | `source/shared/node/experiments/cursor-experiments.ts:68` | `true` (`:165-168`) | Playwright computer-use on. Fine. |
| `sand_notify_safety_poll` | `source/host/extensions/notify-bus/extension.ts:59` | `true` (`:314-317`) | Safety poll on. Fine. |
| `sand_multiplayer` | `source/host/extensions/cross-user-sharing/extension.ts:18` | `false` (`:291-294`) | Cross-user sharing off. Correct locally. |
| `sand_notify_bus` | `source/host/extensions/notify-bus/extension.ts:56` | `false` (`:303-306`) | Notify bus off. Correct locally. |
| `sand_browser_use_subagent` | `cursor-experiments.ts:69` | `false` (`:195-198`) | Browser subagent off. |
| `sand_codebase_telemetry` | `source/host/extensions/codebase-telemetry/codebase-telemetry-host.ts:9` | `false` (`:3368-3371`) | Codebase telemetry off. Good for local-only. |
| `sand_action_audit_logs` | `source/host/extensions/action-audit/extension.ts:20` | `false` (`:241-244`) | Audit logs stay local. Good for local-only. |

`envGateOverride` (`cursor-experiments.ts:16`) reads `SAND_FEATURE_GATE_OVERRIDES`, but
`checkFeatureGate:39` only consults it when `canUseFeatureFlagOverrides()` (`:43`) is true, i.e.
`isDevBuild === true || isAnysphereUser`. In a packaged build (`SAND_PACKAGED=1`, per
`source/host/extensions/experiments/extension.ts:14`) with no account,
**`SAND_FEATURE_GATE_OVERRIDES` is dead.** Do not plan a fix around it.

---

## 3. Item 2 — every consumer of the `cursor` inference provider

### 3.1 The provider set

`source/shared/inference-router.ts:1`

```ts
export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter", "custom"] as const;
```

**Smallest change to make `custom` the only provider:** delete `"cursor"` from that array. That is
one edit, and it cascades correctly because `isSandInferenceProvider` (`:26-28`) rejects the value
everywhere it is validated. **But it will not compile on its own** — see the type usages below.

### 3.2 Every site that names `cursor`

| `file:line` | What it does | Class | Smallest change |
|---|---|---|---|
| `source/shared/node/settings/sand-settings-store.ts:159` | `return this.load().inferenceProvider ?? "cursor";` — **the default for a fresh install** | BLOCKING | Change the fallback to `"custom"`. One token. Highest value per byte in this document. |
| `source/electron-main/main-edge.ts:126` | `getInferenceRouter` falls back to `"cursor"` when the stored value is invalid | BLOCKING | Change to `"custom"`. |
| `source/shared/inference-router.ts:51` | `emptySandInferenceRouterUsage()` seeds a `cursor` usage slot | COSMETIC | Drops automatically when `"cursor"` leaves line 1. |
| `source/shared/inference-router.ts:23` | `Record<SandInferenceProvider, ...>` keyed by the union | — | Follows line 1 automatically. |
| `source/host/runner/turn-run-shell.ts:186,189` | `inferenceProvider === "cursor" ? input.inference.createSession(...) : createProviderPromptSession(...)` | BLOCKING | Becomes dead code; delete both ternary arms. |
| `source/node-agent-coordinator/inference-router.ts:11,121` | `Exclude<SandInferenceProvider, "cursor">` | — | Becomes a no-op alias; can widen to the plain type. |
| `source/host/extensions/inference/provider-session.ts:20` | `type RoutedProvider = Exclude<SandInferenceProvider, "cursor">` | — | Same. |
| `source/host/extensions/inference/cursor-session.ts:114` | Reads `getInferenceProvider()` to pick the session | BLOCKING | Follows the default change. |
| `source/shared/node/cursor-backend/cursor-inference.ts:189` | Reads `getInferenceProvider()` | BLOCKING | Same. |
| `scripts/lib/renderer-renderer-patch.mjs` → actually `scripts/lib/router-renderer-patch.mjs:59` | `{value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"}` | COSMETIC | Delete the array entry. |
| `scripts/lib/router-renderer-patch.mjs:75` | `de.useState({provider:"cursor",...})` — UI state before the async read resolves | COSMETIC | Change to `"custom"`. |
| `scripts/lib/router-renderer-patch.mjs:87` | `s.provider==="cursor"?a.jsx(Na,{}):null` — mounts the original Cursor usage/billing panel | DEGRADED | Delete the ternary. `Na` is an upstream minified name (the pre-patch panel from `:9`); **I could not find its source** because it lives in the checksum-pinned shipped chunk. Editing requires the `replaceExactlyOnce` path per `AGENTS.md` §1. |

### 3.3 Non-Cursor providers that also phone home

These matter for "железно чисто локально" and are **not** removed by touching `cursor`:

- `source/host/extensions/inference/provider-session.ts:108` — `https://auth.openai.com/oauth/token` (Codex OAuth)
- `source/host/extensions/inference/provider-session.ts:195` — `https://chatgpt.com/backend-api/codex/responses`
- `source/host/extensions/inference/provider-session.ts:264` — `https://openrouter.ai/api/v1`

### 3.4 What breaks at runtime when the provider is forced to `custom`

- **PROVEN:** nothing in the host loop. `turn-run-shell.ts:186` routes non-cursor providers to
  `createProviderPromptSession`, which is the path already used in production today.
- **PROVEN:** `SandSettingsStore.getInferenceProvider()` has no cursor-specific side effect; it is
  a pure read of `settings.json`.
- **INFERRED:** removing `"cursor"` from `SAND_INFERENCE_PROVIDERS` will break the type at
  `source/shared/node/settings/sand-settings-store.ts:164`
  (`recordInferenceUsage(provider: SandInferenceProvider, ...)`) and anything indexing
  `SandInferenceRouterUsage.providers` by a literal `"cursor"`. I did not enumerate every
  consumer of that record — **I could not find a complete list**; grep before you edit.
- **PROVEN guard to keep:** `source/electron-main/main-edge.ts:134` refuses
  `provider === "custom"` with no endpoint, and
  `source/electron-main/coordinator/coordinator-resync.ts:8` skips the sync leg in that case.
  Do not remove those; they prevent a bricked agent loop.

---

## 4. Item 3 — `cursorAccount`, `getValidAccessToken`, secrets

### 4.1 `getValidAccessToken` — PROVEN, read in full

`source/electron-main/account/cursor-auth.ts:277-283`

```ts
async getValidAccessToken(options?: { readonly backendUrl?: string }): Promise<string> {
  const operationEpoch = this.authOperationEpoch;
  if (this.credentialUseRevoked) throw new SandAuthSignInRequiredError();
  const backendUrl = options?.backendUrl ?? DEFAULT_CURSOR_BACKEND_URL;   // :279
  const [accessToken, refreshToken] = await Promise.all([
    this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY),                    // :280
    this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY)]);
  if (!this.isCurrentAuthOperation(operationEpoch) || this.credentialUseRevoked
      || accessToken == null || refreshToken == null) throw new SandAuthSignInRequiredError();  // :281
  return shouldRefreshAccessToken(backendUrl, accessToken)
    ? await this.refreshAccessToken({ backendUrl, operationEpoch, refreshToken })
    : accessToken;                                                       // :282
}
```

**Behaviour with no account:** **throws** `SandAuthSignInRequiredError`. It does not return `""`
and does not hang. Every call site must therefore already handle the throw, or the app would
crash today — which is why the app currently starts.

**Secrets it reads** (`cursor-auth.ts:19-20`):

```
ACCESS_TOKEN_SECRET_KEY  = "cursor-access-token"
REFRESH_TOKEN_SECRET_KEY = "cursor-refresh-token"
```

Read through `this.secrets.readSecret`, backed by Electron `safeStorage`
(`source/electron-main/secrets/secret-store.ts:140,251,429` — `encryptString`/`decryptString`;
on Windows that is DPAPI). **Nothing is written to the Windows Credential Manager by keytar** —
I could not find any `keytar` usage in `source/**`. `safeStorage` is the only secret backend.

**Two traps for whoever edits this:**

1. **`cursor-auth.ts:279` ignores `getConfiguredBackendUrl()`.** It falls back to the hardcoded
   `DEFAULT_CURSOR_BACKEND_URL` when no `backendUrl` is passed. So `SAND_BACKEND_URL` does **not**
   redirect a token refresh. Callers that pass `{backendUrl}` (about 20 sites) are fine; any that
   omit it are not.
2. **`shouldRefreshAccessToken` (`source/shared/node/cursor-token.ts:50`) returns `true`
   unconditionally when `isDevAuthBackend(backendUrl)`** (`:49`), which is true whenever the host
   is `localhost`/`127.0.0.1`/`*.lclhst.build`/`dev-staging.cursor.sh` or `SAND_AUTH_CLIENT_ID`
   is set (`:42-47`). Pointing `SAND_BACKEND_URL` at localhost therefore makes the app attempt a
   token refresh on **every** call. Harmless without secrets (it throws at `:281` first), but it
   makes local-backend testing noisy.

### 4.2 `cursorAccount` — the bridge object

`source/electron-main/main-edge.ts:48` declares it; `main-edge.ts:165` exposes **13 methods**, all
Cursor-account specific:

`getAuthStatus`, `login`, `cancelLogin`, `logout`, `updateAccountName`, `getAvatar`,
`getWeeklyUsage`, `getUsageSummary`, `getPrReviewPreferences`, `getPrivacyModeEnabled`,
`getSandAccess`, `getSandAccessFresh`, `invokeDashboardAction`, `cancelCursorSandTrial`.

Wiring: `source/electron-main/main-production-services.ts:402,761,763`;
`source/electron-main/production-adapters.ts:40,106-108,280-281`;
`source/electron-main/adapters/main-rpc.ts:26,154-158,209,242`.

Classification per method:

| Method | Class | Notes |
|---|---|---|
| `getAuthStatus` | BLOCKING to keep | The renderer gate depends on it. `router-renderer-patch.mjs:35-36` neutralises the *render* gate, not the status call. |
| `getSandAccess`, `getSandAccessFresh` | DEGRADED | Entitlement check. Without an account these fail or report "no access". |
| `login`, `cancelLogin`, `logout`, `updateAccountName`, `getAvatar` | COSMETIC | No local replacement needed; drop the UI entry, keep the bridge entry. |
| `getWeeklyUsage`, `getUsageSummary`, `cancelCursorSandTrial`, `invokeDashboardAction` | PERMANENT | Cursor billing API. Replace with nothing; hide the panel. |
| `getPrReviewPreferences`, `getPrivacyModeEnabled` | DEGRADED | Return defaults; PR review and privacy mode degrade silently. |

### 4.3 Account slot — the local-mode chokepoint (already in place)

`source/electron-main/coordinator/coordinator-account-runtime.ts:110-127`

```ts
export const LOCAL_ACCOUNT_SLOT = "local";
function localAccountSlotEnabled(env = process.env) { return env.SAND_LOCAL_ACCOUNT_SLOT?.trim() !== "0"; }
function cursorAccountSlot(status, env) {
  if (status.kind !== "logged-in") return localAccountSlotEnabled(env) ? LOCAL_ACCOUNT_SLOT : null;
  const slot = status.authId ?? status.email;
  return slot == null || slot.length === 0
    ? (localAccountSlotEnabled(env) ? LOCAL_ACCOUNT_SLOT : null) : slot;
}
```

This is already the local-mode switch for account identity. It is **on by default** and the signed-in
branch still wins. Do not change it — it is load-bearing for the current working state.

### 4.4 Dead code you can delete outright

`source/shared/auth.ts` (12 lines, whole file) exports `cursorAccountSlot` (`:8`). **PROVEN: nothing
imports it** — the only live function of that name is the non-exported local one at
`coordinator-account-runtime.ts:116`, used at `:299`, `:398`, `:410`. `source/shared/auth.ts` is
dead and safe to remove. Also dead: `CursorAccountStatus` (`:1`).

---

## 5. Item 4 — every hardcoded Cursor / Cursor-backend host

### 5.1 Cursor control-plane hosts

| Host | `file:line` | Env override | Reached without auth? |
|---|---|---|---|
| `https://api2.cursor.sh` | `source/shared/node/cursor-token.ts:3` (`DEFAULT_CURSOR_BACKEND_URL`) | `SAND_BACKEND_URL` / `CURSOR_API_BASE_URL` (`:39`) | Yes — anonymous bootstrap allowed |
| `https://api2.cursor.sh/updates` | `source/electron-main/update/update-feed.ts:8` | `SAND_UPDATE_FEED_BASE_URL` (`source/electron-main/update/update-wiring.ts:17`) | Yes |
| `api2.cursor.sh` (DNS diagnostics) | `source/node-agent-coordinator/gateway/gateway-dns-diagnostics.ts:8` | **none** | Only when the box is unreachable |
| `https://api3.cursor.sh/tev1/v1` | `source/shared/node/experiments/statsig-bootstrap.ts:12` | **none** | Yes — Statsig event proxy |
| `https://<redacted>@metrics.cursor.sh/<redacted>` | `source/shared/observability/sentry.ts:4` | **none** (only `SAND_DISABLE_SENTRY=1`) | Yes |
| `https://cursor.com` | `source/shared/deep-link.ts:3`; `source/electron-main/account/cursor-auth.ts:21`; `source/host/extensions/transcript/agent-run-error.ts:8` | `CURSOR_WEBSITE_URL` / `SAND_CURSOR_WEBSITE_URL` (`main-edge.ts:152`) | Browser only |
| `https://cursor.com/install` | `source/shared/node/experiments/experiment-config.gen.ts:4345` | none | Suggested shell command text |
| `https://cursor.com/dashboard?tab=integrations` | `source/host/extensions/automations/listener-integrations.ts:13` | none | UI link |
| `https://cursor.com/help` | `source/electron-main/application-menu.ts:101` | none | Menu item |
| `https://cursor.com/agents/<bcId>` | `source/host/extensions/cloud-agents/cloud-agents-service.ts:31`; `main-edge.ts:152` | yes (env above) | UI link |
| `origin.cursor.com` | `source/packages/cursor-plugins/origin-git-auth.ts:1` | none | Git auth |
| `review.cursor.com` | `source/host/runner/system-prompt.ts:212` | none | Prompt text |
| `playground.cursor.sh` | `source/packages/agent-store-sync/presigned-url.ts:89`; `source/host/extensions/box-store-sync/agent-store-sand-files.ts:178` | none | Allowlist check |
| `dev-staging.cursor.sh` | `source/shared/node/cursor-token.ts:46` | none | Hostname check |
| `api.typesafe.ai` (TypeSafe Jev) | `source/host/runner/decisions/plugin-search-jev.ts:122` | documented local override (`decision-client.ts:268`) | Yes — **not Cursor, but still off-machine** |

### 5.2 Non-Cursor hosts that still leave the machine

- `https://raw.githubusercontent.com/...` — `source/shared/node/mcp/mcp-marketplace.ts:67` (MCP marketplace manifests)
- `https://api.github.com` — `source/packages/cursor-plugins/backend-marketplace-client.ts:157`
- `https://auth.openai.com/oauth/token`, `https://chatgpt.com/backend-api/codex/responses` — `source/host/extensions/inference/provider-session.ts:108,195`
- `https://openrouter.ai/api/v1` — `source/host/extensions/inference/provider-session.ts:264`
- `https://cache.agilebits.com/...` — `source/electron-main/onepassword/onepassword-cli-runtime.ts:51` (1Password CLI download, macOS path)
- `https://www.google.com/s2/favicons?domain=` — `source/host/extensions/attachments/attachments-service.ts:143` (**fires per attachment**, leaks the hostnames the agent browses)
- `https://downloads.cursor.com/grokbot/...` — `scripts/lib/config.mjs:84` (macOS DMG URL, packaging only)

**The Google favicon call is worth a second look.** It is not Cursor, but for "железно чисто
локально" it discloses every domain the agent visits. I did not trace whether it has an
off-switch — **I could not find one.**

### 5.3 The one URL builder

Every `api2.cursor.sh` backend call funnels through `getConfiguredBackendUrl()`:
`source/shared/node/cursor-token.ts:38-40`, re-exported as `getSandInferenceBackendUrl()`
(`source/shared/node/cursor-backend/cursor-inference.ts:110` and
`source/host/extensions/auth/credential-renewer.ts:160`). ~20 call sites. It is the natural place to
hang a `LOCAL_MODE` check — but see the caveats in §9.

---

## 6. Item 5 — cloud / server-only features

**None of these block startup.** All are opt-in or gate-default-off. Classification first, then
what to do.

| Feature | `file:line` | Class | What actually happens today |
|---|---|---|---|
| **Cloud agents** | `source/host/extensions/cloud-agents/extension.ts:15-17`; `source/host/cloud-agents/cloud-agent-tool.ts:37` | PERMANENT | Runs entirely on the Cursor backend with `auth.getAccessToken`. Without an account every call fails. **Replacement: none.** Delete the tool registration so the agent stops offering it. |
| **Skill publishing** | `source/host/extensions/mcp/skill-publish.ts:52-64, 80-89` | PERMANENT | `listTargets` needs `getTeams` from the backend. On failure it returns `teams: []` and `unavailableReason: "Could not reach Cursor to check your teams."` — **a user-visible string naming Cursor** (`:87`). **Replacement: local publish = copy the skill folder into the local workflows dir.** `GlobalWorkflowLibrary` (`skill-publish.ts:77`) is already local. |
| **Private / team MCP marketplaces** | `source/packages/cursor-plugins/backend-marketplace-client.ts:229-301`; `source/shared/node/marketplace/cursor-marketplace-client.ts:37` | PERMANENT | Backend-served catalog + git clone. **Replacement: local marketplaces only** (git clone from a URL the user supplies). Private/team entries simply disappear. |
| **Shared groups / cross-user sharing** | `source/host/extensions/cross-user-sharing/extension.ts:18`; gate `sand_multiplayer` default `false` (`experiment-config.gen.ts:291-294`) | PERMANENT | Already off by default. Correct locally — no action beyond hiding the UI. |
| **Forever box / remote box** | `source/host/extensions/forever-box/extension.ts:16,23` | DEGRADED | `isImageAutoUpdateEnabled` requires `isBoxStoreSyncEnabled` **and** `isBoxStoreCopyInEnabled`, and both are **off by default** (`source/host/box/box-store-backend-policy.ts:9-11` — `enabled()` only accepts `1`/`true`/`yes`). So box image auto-update is already off unless `SAND_BOX_STORE_SYNC=1` and `SAND_BOX_STORE_COPY_IN=1`. **Leave it off.** |
| **Box image auto-update (explicit)** | `source/host/host-gateway-api.ts:561-562` (`autoUpdateBoxNow` → `forever-box.autoUpdateNow`) | PERMANENT | `forever-box-service.ts:16` returns `{started:false, reason:"auto-update-disabled"}` when off. Safe no-op. |
| **Box store sync / copy-in** | `source/host/extensions/box-store-sync/box-store-sync-service.ts:51`; `box-copy-in.ts:530` | DEGRADED | Off by default. Needs `auth` as the object-store provider, which throws without a token. |
| **Writing box secrets** | `source/electron-main/secrets/secrets-ipc.ts:119,135,141,193`; `main-production-services.ts:898` | PERMANENT | `pushBoxSecrets` pushes to a remote box. Without a box there is nothing to push to. Quiesces safely (`:898`). |
| **VNC** | `source/electron-main/vnc/vnc-trust.ts:11-19`; `vnc-session-telemetry.ts:3-23` | PERMANENT | Token comes from the box URL as `?network_token=` (`vnc-trust.ts:13`), injected as `x-anyrun-network-token` (`:19`). There is no remote box, so there is no VNC target. **Replacement: none needed — there is no remote display to view.** The local box is driven through `local-exec`, not VNC. |
| **App auto-update** | `source/electron-main/update/update-gate.ts:2`; `update-feed.ts:8` | DEGRADED | **Enabled by default on packaged win32** (`update-gate.ts:2` returns `null` = enabled). Polls `api2.cursor.sh/updates`. Kill: `SAND_DISABLE_UPDATES=1`. |
| **MCP OAuth / WebAuthn proxy** | `source/electron-main/mcp/mcp-oauth-loopback-provider.ts:12-29`; `source/host/extensions/webauthn-proxy/` | PERMANENT for account-backed IdPs | Local stdio MCP servers work fine. Only the Cursor-account OAuth handshakes are dead. |
| **Managed skills / team rules** | `source/host/extensions/managed-setup/extension.ts:18-21` | DEGRADED | `bestEffortAccessToken` (`:5`) swallows the throw and returns `null`. Skills silently never arrive. No error. |

---

## 7. Item 6 — telemetry and analytics (the "железно чисто локально" core)

### 7.1 Product analytics — BLOCKING, and it is ON by default

This is the finding that matters most. The chain, all PROVEN:

1. `source/shared/node/analytics/product-analytics.ts:68-70` — the constructor starts in state
   `deferred` unless `isAnalyticsOptedOut()` (`:18-20`, reads `SAND_DISABLE_TELEMETRY` /
   `SAND_DISABLE_ANALYTICS`). **Neither is set by default.**
2. `source/electron-main/main-production-services.ts:784` calls `.activate({...})` at startup.
3. `product-analytics.ts:104` — `enabled = await gate.checkGate("sand_product_analytics")`.
4. `cursor-experiments.ts:56` — `checkGate` awaits `whenReady` (10 s, `GATE_READY_TIMEOUT_MS` at
   `cursor-experiments.ts:13`) and then falls through to `checkFeatureGate`.
5. `cursor-experiments.ts:39` — `this.client == null` (no authenticated bootstrap) →
   `FLAGS["sand_product_analytics"].default` = **`true`** (`experiment-config.gen.ts:221-224`).
6. `product-analytics.ts:114` — `this.goLive()`.
7. `product-analytics.ts:123-127` — builds a `createSandCursorBackendClient(AnalyticsService, ...)`,
   i.e. a Connect client to `getSandInferenceBackendUrl()` = `https://api2.cursor.sh`.
8. `source/host/extensions/telemetry/host-telemetry-service.ts:263-264` —
   `.activate(this.options.experiments).then(() => this.analytics.markActive("host_startup"))`.
9. `product-analytics.ts:185-191` — `markActive` tracks `sand.app.active`; `:197-204` `flush()`
   sends it.

**Net: on every host start the app posts an analytics event to `api2.cursor.sh`, unauthenticated,
with no error and no visible setting.** The gate that was supposed to prevent this is stuck `true`
precisely because the authenticated bootstrap never arrives.

**Smallest fix (one line, C3):** change `experiment-config.gen.ts:223` from `default: true` to
`default: false` for `sand_product_analytics`. Nothing else depends on it being true — turning it
off only sends events into the `deferred` buffer (`product-analytics.ts:179` caps it at
`MAX_DEFERRED_EVENTS = 256`, `:16`), which is bounded and local.
Alternative (no code): set `SAND_DISABLE_TELEMETRY=1` or `SAND_DISABLE_ANALYTICS=1` in the
environment. **Do the code change — the env var is not a shipped default.**

### 7.2 Structured logs — sent ANONYMOUSLY, BLOCKING for privacy

`source/electron-main/adapters/telemetry.ts:38-40`

```ts
const createAnonymousClient = options.createAnonymousClient ?? (getMachineId === undefined
  ? undefined
  : () => createSandCursorBackendClient(AnalyticsService,
       { authMode: "anonymous", getAccessToken: async () => "", getMachineId }));
```

and `source/shared/node/cursor-backend/cursor-inference.ts:141`

```ts
if (auth.mode === "anonymous") request.header.delete("authorization");
```

So the anonymous transport deletes the auth header and sends anyway, carrying `x-cursor-checksum`
(`:142`, derived from the machine id) plus the client type/version tags (`:143-144`).
`desktop-structured-log-telemetry.ts:118` routes `reportDesktopSignin` through this anonymous
transport unconditionally.

**Events that leave the machine** include agent load, box setup/recreate/reachability, coordinator
lifecycle, crash, unclean exit, render timings, update checks, connector auth, and VNC sessions —
see the `report*` surface at `desktop-structured-log-telemetry.ts:113-118`.

**Kill switch:** `SAND_DISABLE_TELEMETRY=1`, honoured at `desktop-structured-log-telemetry.ts:94`
and `:106` (both transports). Also `process-metrics/collector.ts:40`,
`host-telemetry-service.ts:218`, `structured-log-telemetry.ts:305`,
`adapters/experiments.ts:56`, `main-production-services.ts:795`.

**Smallest fix:** make `SAND_DISABLE_TELEMETRY` the **default** — i.e. invert the check at
`desktop-structured-log-telemetry.ts:94`/`:106` and `product-analytics.ts:19` so telemetry is off
unless explicitly enabled. That is 3-4 one-token edits and it covers both §7.1 and §7.2 at once.

### 7.3 Sentry — DEGRADED, kill switch present but not default

- DSN: `source/shared/observability/sentry.ts:4` → `metrics.cursor.sh`.
- Desktop: `source/electron-main/telemetry/sentry.ts:62,64` — `initSandSentryForDesktop` returns
  early when `enabled` is false. `enabled` comes from
  `source/electron-main/adapters/account-oauth.ts:35` — `SAND_DISABLE_SENTRY !== "1"`, i.e. **on
  by default**.
- Daemon: `source/host/local-exec/sentry.ts:15-16` — `initSandSentryDaemon` returns `undefined`
  unless **both** `SAND_SENTRY_ENVIRONMENT` and `SAND_SENTRY_RELEASE` are set in env. Those are set
  at `electron-main/telemetry/sentry.ts:64`, i.e. **after** the `if (!args.enabled) return;` guard.
  **PROVEN chain:** `SAND_DISABLE_SENTRY=1` in main ⇒ those env vars are never set ⇒ the daemon
  never initialises. The daemon is therefore covered, but only indirectly.
- Privacy gate `SandSentryPrivacyGate` (`sentry.ts:14-20`) scrubs by tier — but with no account
  the tier stays at its initial `"fatal-metadata"` (`sentry.ts:15`), so fatals are still sent.

### 7.4 Other off-machine paths

| Path | `file:line` | Gate | Default |
|---|---|---|---|
| Codebase telemetry | `source/host/extensions/codebase-telemetry/codebase-telemetry-host.ts:2,9` | `sand_codebase_telemetry` | `false` (`experiment-config.gen.ts:3368-3371`) — **already off, good** |
| Action-audit backend forwarding | `source/host/extensions/action-audit/extension.ts:20` | `sand_action_audit_logs` | `false` (`experiment-config.gen.ts:241-244`) — **already off, good** |
| Feedback submission | `source/electron-main/feedback/feedback-report.ts:6` | none | User-initiated. Returns `{ok:false, code:"not-signed-in"}` when the JWT `sub`/`email` ≠ `feedback.accountSlot`. Cannot fire locally. |
| Process metrics | `source/electron-main/process-metrics/collector.ts:40` | `SAND_DISABLE_TELEMETRY` | on by default |
| Statsig event stream | `source/shared/node/experiments/statsig-bootstrap.ts:12,15-16` | none | **On by default.** `sandStatsigNetworkOverride` allows any URL containing `/rgstr` and forwards it. Once the Statsig client is hydrated (even anonymously) it emits events to `api3.cursor.sh`. **PROVEN.** |
| Google favicons | `source/host/extensions/attachments/attachments-service.ts:143` | none | Per attachment. Leaks browsed hostnames. |
| App update check | `source/electron-main/update/update-feed.ts:8` | `SAND_DISABLE_UPDATES` | on by default (packaged win32) |

---

## 8. Item 7 — user-visible strings that still say Cursor

The renderer is checksum-pinned (`AGENTS.md` §1). **All of these live in
`scripts/lib/router-renderer-patch.mjs` and must be changed through `replaceExactlyOnce`, never by
editing `src/app/dist`.**

### Already fixed (leave alone)

| `file:line` | Constant | Result |
|---|---|---|
| `:42-43` | `NOT_SIGNED_IN_CHIP_BEFORE/_AFTER` | "Not signed in" → **"Local"** |
| `:46-47` | `NOT_SIGNED_IN_ROW_BEFORE/_AFTER` | "Connect your Cursor account to Grok Bot" → **"Using your own endpoint"** |
| `:55-56` | `ACCOUNT_SLOT_BEFORE/_AFTER` | signed-out slot → **"local"** — this is what un-blocks `listAgents` |
| `:35-36` | `SIGNIN_GATE_BEFORE/_AFTER` | removes the `phase === "checking"` blank-window branch |

### Still says Cursor

| `file:line` | Text | Class | Smallest change |
|---|---|---|---|
| `:59` | `{value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"}` | COSMETIC | Delete the entry from `RRouterProviders`. Also removes it from `RRouterOptions` (`:64`). |
| `:75` | `de.useState({provider:"cursor",...})` | COSMETIC | Change to `"custom"`. Stops the "Cursor" flash before `getInferenceRouter()` resolves. |
| `:87` | `s.provider==="cursor"?a.jsx(Na,{}):null` | DEGRADED | Delete the ternary — mounts the original Cursor billing panel. |
| `:87` | `description:e.description` | COSMETIC | Follows `:59`. |
| `source/host/extensions/mcp/skill-publish.ts:87` | `"Could not reach Cursor to check your teams."` | COSMETIC | Change to "Could not reach the skill service…" or hide the surface. |

### Prompt text mentioning Cursor (safe to leave)

`source/host/runner/system-prompt.ts:137,212-213,229`;
`source/shared/channel-messaging.ts:108`;
`source/packages/agent/prompts/cloud/no-repository-access.ts:4`;
`source/host/extensions/automations/listener-integrations.ts:13`.
These describe Cursor cloud agents and `cursor.com` to the model. They cost nothing and become
inert when cloud agents are removed. **Lowest priority — do them last.**

### Anomaly worth flagging

`scripts/lib/renderer-renderer-patch.mjs` **does not exist.** The only renderer patch is
`scripts/lib/router-renderer-patch.mjs`. If another agent references the former path it is a typo —
I checked the `scripts/` tree and found only one.

---

## 9. Chokepoint analysis — the honest answer

**There is no single `LOCAL_MODE` flag.** Here is why, and what to do instead.

**What a chokepoint could cover:**

| Chokepoint | Covers | Misses |
|---|---|---|
| `getConfiguredBackendUrl` (`cursor-token.ts:38-40`) | ~20 modules: cross-user sharing, automations relay, notify-bus, MCP catalog, skill publish, marketplace, codebase telemetry, structured logs, product analytics | Sentry DSN, Statsig proxy, update feed, `cursor.com` website URLs, OpenAI/ChatGPT/OpenRouter, GitHub, Google favicons, and the whole renderer patch |
| `pinGateOnAuthenticatedBootstrap` (`cursor-experiments.ts:38`) | 4 dead flags, cleanly | Analytics, Sentry, the provider default, the renderer |
| `SandProductAnalytics` ctor (`product-analytics.ts:68`) | Product analytics only | Structured logs, Sentry, Statsig |

**Why a global flag fails:** the code has no shared "am I in local mode" concept. The three
nearest equivalents each cover a different slice, they live in different processes (main, host,
coordinator, renderer), and the renderer cannot read a host env var at all — it only has the
injected `COMPONENT_SOURCE`. A real `LOCAL_MODE` would need four coordinated edits (main, host,
coordinator, renderer patch) plus a fifth in the sealed shipped chunk. That is more work than
doing the items in order, and it is the same work with more places to get wrong.

**What I recommend instead:** the existing env switches ARE the local-mode mechanism, and they
already cover the highest-impact items. Make the safe ones **defaults** rather than inventing a
flag:

```
SAND_DISABLE_TELEMETRY=1     # §7.1 analytics, §7.2 structured logs, process metrics
SAND_DISABLE_SENTRY=1        # §7.3 Sentry, both main and daemon
SAND_DISABLE_UPDATES=1       # §6 update feed
SAND_CONVERSATION_GC=1       # §2.4 conversation GC + hard cap
SAND_RETIRE_LEGACY_STORE_BLOBS=1   # §2.4 legacy blob retirement
```

Five lines, all read from `process.env` in code I have quoted, zero new abstractions. Set these in
the launcher (`Запустить Grok Bot.cmd` at the repo root) and in `manifests/` so they survive
packaging. Then do the code edits for the things env vars cannot reach: `sand_stale_root_gc` and
`sand_memory_dreaming` (no env escape exists), the provider default, and the renderer.

---

## 10. Recommended order — cheapest and safest first

Each step lists what it breaks. **Steps 1-2 require no code change and no rebuild.**

### Step 1 — env kill switches in the launcher. Cost: 5 lines. Breaks: nothing.

Add `SAND_DISABLE_TELEMETRY=1`, `SAND_DISABLE_SENTRY=1`, `SAND_DISABLE_UPDATES=1`,
`SAND_CONVERSATION_GC=1`, `SAND_RETIRE_LEGACY_STORE_BLOBS=1` to `Запустить Grok Bot.cmd` and the
packaged launcher. **Kills items 1, 4, 9, 10 and half of 6 immediately.**

*Breaks:* nothing that works today. Every one of these paths currently fails or phones home.
Verify by confirming no connection to `api2.cursor.sh` / `metrics.cursor.sh` / `api3.cursor.sh`.

### Step 2 — `SAND_LOCAL_ACCOUNT_SLOT` sanity. Cost: 0. Breaks: nothing.

It already defaults to on (`coordinator-account-runtime.ts:113`). **Do not set it to `0`** — that
restores the refuse-to-start rule. Confirm it is unset.

### Step 3 — provider default. Cost: 2 tokens. Breaks: only fresh installs that relied on Cursor.

- `source/shared/node/settings/sand-settings-store.ts:159` — `?? "cursor"` → `?? "custom"`
- `source/electron-main/main-edge.ts:126` — `: "cursor"` → `: "custom"`

*Breaks:* a user who never touched settings now gets `custom` with no endpoint. That path is
already guarded: `main-edge.ts:134` rejects `custom` without an endpoint, and
`coordinator-resync.ts:8` skips the leg. **Recommendation: also add a migration in
`sand-settings-store.ts:72` that writes `inferenceProvider: "custom"` into any existing
`settings.json` that lacks the key**, so an existing install is not left on `cursor`.
Also confirm `OPENAI_COMPATIBLE_API_KEY` is in the secret store
(`router-renderer-patch.mjs:63` names it) — `custom` with no key fails at request time.

### Step 4 — make telemetry off by default. Cost: 4 one-token edits. Breaks: nothing user-facing.

- `source/shared/node/analytics/product-analytics.ts:19` — invert to opt-in
- `source/electron-main/telemetry/desktop-structured-log-telemetry.ts:94` and `:106` — invert
- `source/shared/node/experiments/experiment-config.gen.ts:223` — `sand_product_analytics` default `true` → `false`

*Breaks:* you lose the data that would tell you the app is broken. That is the intended trade for
this user. Verify: `SandProductAnalytics.state.kind === "disabled"` and no `AnalyticsService` call.

### Step 5 — the C1 chokepoint. Cost: one function. Breaks: behaviour changes, not crashes.

Rewrite `pinGateOnAuthenticatedBootstrap` (`cursor-experiments.ts:38`) to pin from
`checkFeatureGate(name)` unconditionally instead of waiting for an authenticated bootstrap:

```ts
pinGateOnAuthenticatedBootstrap(name, pin) { pin(this.checkFeatureGate(name)); }
```

Unblocks: `sand_stale_root_gc`, `sand_legacy_store_blob_retirement`, `grok_bot_conversation_gc`,
`sand_memory_dreaming` — all four default to `false` (`experiment-config.gen.ts:153,255,273,280`),
so this alone changes **nothing**. To actually enable them you must ALSO flip their `default` to
`true` in `experiment-config.gen.ts`, or set the env escapes
(`SAND_CONVERSATION_GC`, `SAND_RETIRE_LEGACY_STORE_BLOBS`).

*Breaks:* with defaults still `false`, nothing. With defaults flipped, the conversation GC starts
compacting blobs and can now throw `SandConversationTooLargeError`
(`conversation-size-limits.ts:37`) — **that is a new user-visible failure mode.** Enable GC and
memory dreaming separately, not in the same change. `sand_memory_dreaming: true` also starts
calling the inference provider from the memory service
(`memory/extension.ts:7,11`), which spends tokens on every session.

*Suggested split:* do `sand_stale_root_gc` alone first (pure cleanup, no user-visible failure).
GC second. Memory dreaming last.

### Step 6 — dead code. Cost: small. Breaks: nothing.

- Delete `source/shared/auth.ts` (12 lines, zero importers — PROVEN).
- Delete `source/node-agent-coordinator/gateway/gateway-dns-diagnostics.ts:8`'s hardcoded
  `GENERAL_CONTROL_HOSTNAME` reference **only if** box-recovery diagnostics are also removed;
  otherwise repoint it at the configured backend.

### Step 7 — renderer patch. Cost: 3 `replaceExactlyOnce` edits. Breaks: panel layout only.

`scripts/lib/router-renderer-patch.mjs` lines 59, 75, 87. Run `acorn.parse(COMPONENT_SOURCE)` after
each edit (`AGENTS.md` §1). Confirm the seven anchor md5s are untouched and that
`'Endpoint model list'` and `'RRouterFallbackModels'` survive in the built `app.asar`.

*Breaks:* `RRouterUsage` at `:87` filters by `s.usage?.providers?.[n.value]`; dropping the `cursor`
entry from `:59` means `RRouterProviders[0]` becomes `claude-code`. If you also want only `custom`,
delete the other four entries — then `RRouterProviders[0]` is `custom` and `:85`'s
`?? RRouterProviders[0]` fallback is correct.

### Step 8 — permanently-impossible features. Cost: UI only. Breaks: nothing that works.

Hide the surfaces for cloud agents, skill publishing, team/private marketplaces, managed skills,
VNC, box secrets, and Cursor billing. Keep the bridge methods (§4.2) so the RPC table stays whole —
removing them from `MAIN_METHOD_TABLE` is the exact failure mode `AGENTS.md` §0 warns about.
*Cosmetic only*: the `"Could not reach Cursor…"` string at `skill-publish.ts:87`.

### Step 9 — prompt text. Cost: prose. Breaks: nothing.

`system-prompt.ts:137,212-213,229` and `channel-messaging.ts:108`. Purely cosmetic.

---

## 11. PERMANENT — what honestly cannot be removed

State these as removals of the *surface*, never as features that "will work locally".

| Feature | Why impossible | Honest replacement |
|---|---|---|
| `cursor` inference provider | Requires a Cursor entitlement + token; the models are Cursor-hosted | `custom` against `space-bunny-free` — already the working path |
| Cursor model catalog | `Cursor` provider models are served by Cursor | The endpoint's own `/models` list, already wired via `listInferenceRouterModels` |
| Cloud agents | Remote VMs on Cursor infra | None. Run agents in the local box |
| Skill / plugin publishing to teams | Backend-side promotion + git push to Cursor's plugin store | Publish by copying into the local workflows dir (`GlobalWorkflowLibrary`, `skill-publish.ts:77`) |
| Private / team MCP marketplaces | Backend-gated catalog | Local marketplaces from git URLs the user supplies |
| Shared groups / cross-user sharing | Backend relay (`xuser-relay.ts:16`) | None. Single-user local only |
| Usage / billing / trial | Cursor dashboard API (`cursor-profile.ts:120-124`) | None. Hide the panel |
| Box image auto-update | Remote image registry | None. Pin the image |
| Remote box VNC | There is no remote box | None. The local box is driven through `local-exec` |
| Writing box secrets | Server-side secret store | Local secret store only (`secret-store.ts`, already `safeStorage`) |
| Live feature flags / experiments | Served from Cursor's Statsig | Pin bundled defaults in `experiment-config.gen.ts` — this is the whole of §2 |

---

## 12. What I could not find

Stated plainly, per the rules:

1. **`Na` (the Cursor usage/billing panel component)** — referenced at
   `scripts/lib/router-renderer-patch.mjs:87`, defined in the checksum-pinned shipped chunk
   `index-BoDVc20G.js`. I did not read the chunk. It is the pre-patch panel from `:9`
   (`USAGE_BEFORE`), but its internals are unverified.
2. **Every consumer of `SandInferenceRouterUsage.providers["cursor"]`** — I found
   `emptySandInferenceRouterUsage` (`inference-router.ts:51`) and the renderer reader at
   `router-renderer-patch.mjs:87`, but did not enumerate all. Grep before removing the provider key.
3. **Whether `googleFaviconUrl` (`attachments-service.ts:143`) has an off-switch.** I read the
   function; I did not find one, and I did not exhaustively trace its caller.
4. **Whether `SAND_BACKEND_URL` is set anywhere in the shipped launcher.** I did not read
   `Запустить Grok Bot.cmd` or `manifests/`. **Do this first in Step 1** — if it is already set to a
   local backend, several findings change.
5. **`agent-run-error.ts:8` `CURSOR_WEBSITE_ORIGIN` consumers** — found the constant, did not trace
   every read.
6. **Full list of `createSandCursorBackendClient` call sites.** I found many via grep but the
   result spilled to a file I did not fully read; ~20 modules route through
   `getSandInferenceBackendUrl`, and I have not verified the count.