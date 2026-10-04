# AGENTS.md — read this before touching anything

This file is the handover note for a fresh session. An agent that starts from zero will
repeat every mistake below. Read it whole, then read the sections for your task.

Project: Grok Bot 0.18, reconstructed, Windows-first.
Remote: `https://github.com/Hjgyhfyh/grok-bot-0.18-reconstructed` (private, LFS payload included).

---

## 0. The three mistakes that cost the most time

These are real. They were made in this project and each one shipped a broken feature while
everything looked green.

**1. A hardcoded fallback list disguised a broken call.**
The custom-model picker had a preload wrapper that called `listInferenceRouterModels`, but that
method was missing from `MAIN_METHOD_TABLE`. `bridgeRpcEdge` only builds functions for keys in that
table, so the call threw a `TypeError`. The renderer caught it, showed a "network error" state, and
fell back to a list of 33 model ids baked into the patch. The dropdown looked perfect and worked for
nothing. **Lesson: a list that always has entries in it is not evidence that the thing producing it
works.** Ask what happens when the call behind it fails.

**2. Two agents edited the same file and nobody noticed.**
Both were live at once in a shared working directory. The result was error counts swinging 8 → 3 → 0
across files neither agent had touched, which read like flakiness in the type checker. One agent lost
a full charge of work proving a claim that was already refuted elsewhere in the same session.
**Lesson: one file, one owner. State your owned files up front and refuse anything outside them.**

**3. "Verified" was being used to mean "I checked the easy part."**
A feature was reported working end to end when only the settings screen and the build had been
exercised. **Lesson: if you say verified, say what you actually ran, and name what you did not run.**

---

## 1. Hard rules

### The renderer is checksum-pinned. Never edit `src/app/dist`.

`src/app/dist` holds the shipped 0.18 payload. It is in `.gitignore` (line 5) and is copied verbatim
into the staged build by `scripts/lib/build-asar.mjs:178`. The renderer is **not** rebuilt from source.

All renderer edits go through `scripts/lib/router-renderer-patch.mjs` via
`applyOriginalRendererRouterPatch({ stageRoot })` plus `replaceExactlyOnce(source, before, after, label)`.

- `replaceExactlyOnce` throws on zero matches **and** on more than one. Silent skipping is impossible.
  If it throws, the upstream chunk moved — do not "fix" it by loosening the check.
- Lines **5–11** of that file are anchors that must stay byte-identical. Baseline md5 prefixes:
  `5 ABBDC82204 · 6 60F9ABAEF8 · 7 4AF368A8ED · 8 A1CC810621 · 9 4143D5C2BA · 10 5AFB1B34C9 · 11 881C5D6D30`
- `COMPONENT_SOURCE` is a multi-line `String.raw`. If an editor writes it CRLF, the injected code
  gains `\r\n`, the chunk bytes change, and `patched.sha256` changes — while `verify` still passes,
  because it compares against the record the same run produced.
- Comments go at the **start of a line only**. A mid-line `//` swallows the closing brace and you get
  `TS1005 '}' expected` at end of file. Run `acorn.parse(COMPONENT_SOURCE)` after every edit.
- The chunk map stays at exactly two entries: role `registry` (`index-lA9cgT4O.js`) and role `panel`
  (`index-BoDVc20G.js`). A third chunk is rejected in three independent places —
  `router-renderer-patch.mjs:125`, `macos-package-verification.mjs:105`, and the comment at `:128-132`.
- The provenance record has a hard whitelist of top-level keys: `schemaVersion`, `mode`, `chunks`,
  `features`, `transformations`. A new top-level field breaks the packaged-artifact check. New items may
  only be appended **inside** `features` or `transformations`.

### Build and packaging are strictly sequential. Never run them in parallel.

There are no locks anywhere in this pipeline. Two concurrent builds produce `ENOENT` on the asset
directory, or `Staged package changed or ASAR drifted after snapshot`.

- `npm run build` → writes `.build/fidelity/**` only.
- `npm run package` → `npm run check && scripts/package-windows.mjs`, writes
  `dist\Grok Bot 0.18 Reconstructed`.
- **`node scripts/clean-build.mjs` is NOT `npm run build`.** It calls the non-fidelity variant: staging
  `.build/app`, renderer built from `frontend/`, and **the router patch is never applied**. Only
  `npm run build`, `npm run package` and `npm run package:diagnostic` take the fidelity route.
- Packaging fails with `EPERM` while the app runs from `dist`, because the live `Grok Bot.exe` holds
  handles on the exe, the DLLs and `resources\app.asar`. `rm` has no `maxRetries`; it fails instantly.
  Close the app first, with `.CloseMainWindow()`. **Never `Stop-Process` a process you did not start** —
  the singleton lock belongs to whoever launched it.
- After a failed build, `dist\Grok Bot 0.18 Reconstructed` is **stale**. `npm run build` never touches
  it. Run `node scripts/verify.mjs` before believing what you launched.

### CI does not check any of this.

`.github/workflows/check.yml` runs only `npm run check`, `npm run frontend:build` and
`npm run publication:check`. It never builds, packages or verifies. A broken renderer patch will sit
in a merged branch with a green pipeline. **The mandatory local ritual before committing anything that
touches `scripts/`, `source/**` or `manifests/**` is `npm run build` followed by `node scripts/verify.mjs`.**

### Do not touch credential or authentication logic.

Screens and labels only. Faking a signed-in state is forbidden. `inferenceProvider: "custom"` is the
supported path to running without an account — use it, do not simulate a login.

---

## 2. Where things live

| Thing | Location |
|---|---|
| Agent store, per agent | `~/.grokbot/agents/<uuid>/` — `store.db`, `profile.json`, `settings.json`, `avatar.png` |
| Sand root | `getSandRootDir()` — `$SAND_DATA_ROOT`, else `--user-data-dir`, else `~/.grokbot` |
| Settings | `~/.grokbot/settings.json` — read by both desktop **and** the coordinator, it is literally the same file |
| SQLite | built-in `node:sqlite` `DatabaseSync`, synchronous, no await. There is **no** `better-sqlite3` in this repo |
| Box secrets | `~/.grokbot/box-secrets.json` |
| Gateway descriptor | `<root>/gateway.json` |
| Roster transport | `window.coordinatorPort`, a `MessagePort` — **not** `window.desktop` |

**Agents are not reached through `window.desktop`.** The whole roster travels over
`window.coordinatorPort`. `window.desktop.agent` holds only settings, model selection, sidebar sections
and forever-box controls. Probing `window.desktop` for agent CRUD finds nothing, and that is correct.

---

## 3. Running without a Cursor account

This is the app's whole point now. What was true, and what changed.

- `createLocalSession` (`source/host/extensions/session/agent-session.ts:102-108`) already creates a real
  agent on local disk with no network, no token and no coordinator. It is a **live fallback**, selected at
  line ~109, not dead code. *The entry point was missing, not the capability.*
- The blocker was one line: a signed-out status resolved the account slot to `null`, so
  `applyClaim` refused to launch the coordinator, `production-provider.requestRendererPort` never granted
  the renderer its `MessagePort`, and all ~140 `COORDINATOR_METHOD_TABLE` methods were unreachable —
  including `listAgents`, `createAgent` and `getOnboardingSeen`, which is the renderer's very first call.
- It now resolves to the exported `LOCAL_ACCOUNT_SLOT` (`"local"`). Set `SAND_LOCAL_ACCOUNT_SLOT=0` to
  restore the old refuse-to-start rule. A real signed-in account still wins: the local fallback only
  applies when nobody is signed in, and `authorizeAccount` is still consulted — a `false` from it keeps
  the runtime unlaunched.

**Known remaining wall:** the renderer still gates the roster fetch on a non-empty account slot
(`roster.connect()` is the only caller of `listAgents`). Until that gate is removed, the sidebar can
still read "No saved agents yet." even though the coordinator is now alive. That gate is renderer-side
and must be changed in `COMPONENT_SOURCE`, not in the host.

**Will never work without an account** — do not pretend otherwise: the `cursor` model provider, private
and team MCP marketplaces, shared groups, skill publishing, box image auto-update, the gate-backed
feature flags (GC, memory dreaming, conversation size limits), writing box secrets, VNC to a remote box.

**Silent degradation to watch for:** `cursor-experiments.ts:38` never pins its flags without an
authenticated network bootstrap, so session GC, legacy-blob retirement and memory synthesis quietly
never run. Nothing throws. If you touch those areas, check the flags are actually being read.

---

## 4. Writing code

### Adding a method to the desktop bridge needs THREE places

Missing the first one fails silently, which is exactly how the model picker broke.

1. `source/shared/rpc/main.ts` — add `<method>: { args: "object" | "none" }` to `MAIN_METHOD_TABLE`.
   **Without this, nothing is served and nothing throws.** `bridgeRpcEdge` builds no function, and
   `serveEdge` registers no `ipcMain.handle`. Its completeness check is one-way: every table method needs
   a handler, but a handler missing from the table is silently ignored.
2. `source/electron-main/main-edge.ts` — the handler in the `handlers` literal inside
   `createMainEdgeHandlers`.
3. `source/electron-preload/preload.ts` — the wrapper in the `agent` literal:
   `<method>: (arg) => edge("<method>", { arg })`.

Note the `edge` helper does `mainEdge[method]!(...)`. That non-null assertion **lies** when the table
entry is missing. `MainPreloadEdge` is `Record<string, (...args:any[]) => any>`, so TypeScript cannot
catch it either. After adding a method, grep the built `.build/fidelity/app/dist/electron-main/main.cjs`
for `var MAIN_METHOD_TABLE = {` and confirm the name is inside it. That step is the one that was missed.

### Test conventions — these are conventions, not suggestions

`npm test` is `node --test tests/*.test.mjs`. Node v26.7.0, Windows.

- **Every test file opens with a block comment naming the defect it closes**, in past tense: what broke,
  why nothing noticed, what the test now proves. Read `tests/host-lock.test.mjs` and
  `tests/routed-provider-dispatch.test.mjs` and match that voice. It is the strongest convention here.
- Test names are full English sentences about the obligation, not the function called.
- `assert/strict` always. Every non-trivial assertion carries a **meaning** as its third argument, not a
  value: `assert.equal(n, 1, "the coordinator was never created for a signed-out status")`.
- **There is no shared loader helper.** Copy an existing one — `tests/coordinator-relaunch-cap.test.mjs`
  for the `bundle(entries)` shape, `tests/decision-cache.test.mjs` for the single-entry shape,
  `tests/plugin-search-jev.test.mjs` when you need two independent instances of module state.
  `esbuild.build`, `format: "esm"`, `platform: "node"`, `target: "node22"`, into a
  `mkdtemp(os.tmpdir(), "grok-<area>-")`, then `import(... + "?" + Date.now())` so the import cache
  cannot hand you the previous build.
- Two independent module states need **two bundles**. Sharing one lets the cache assertions pass falsely.
- **Never hand-write a list of minified names.** `freeComponentTags()` in
  `tests/router-renderer-panel-render.test.mjs:438` computes free identifiers from the AST instead. A
  hand-written list goes stale the moment upstream renames, and the failure is a component rendering as
  an unknown tag — with a green build.
- Put a `safetyCeiling` on anything you test for looping. Without one the test does not fail, it hangs.
- A static guard must prove it found something. If a counter is zero, that is a failing test, not a pass.
- Save and restore `process.env`, keep the touched names in one list, and explicitly `delete` inherited
  variables that leak in from the shell.
- On Windows: parameterise the platform as an **argument** rather than skipping. See
  `windows-shell-tool-portability.test.mjs`, which passes `"win32"` in and asserts on every host.
  `windowsHide: true` on any spawn. Always `path.join`, never a hand-written `/`.

### The proof standard

"Tests pass" is not evidence. After the suite is green, flip an expectation in your own new test to the
opposite of reality, re-run, and **show the failure**. Then restore and show green again. An agent that
cannot make its test fail has written a test that proves nothing — fix it before reporting.

Equally: never roll back product code to make a test green. Twice in this project the failing thing was
a **stub in the test**, not the product. Diagnose which one you are looking at before you touch
anything.

### Test counts are not facts

Numbers move between runs on unchanged code, because agents are working concurrently. Re-run before
you report any count. Say what you ran.

---

## 5. Environment traps that will cost you an hour

- **UTF-8 BOM breaks `JSON.parse`.** PowerShell 5.1 `Set-Content -Encoding UTF8` writes `EF BB BF`. Three
  of the repo's 21 `JSON.parse(readFileSync(...))` sites strip it; the rest do not. And the repo
  *deliberately* writes BOM files (`source/packages/shell-exec/powershell.ts:45-48`). Strip it in anything
  you write. Write files without a BOM via
  `[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false)))`.
- **`[System.IO.File]` uses .NET's working directory, not PowerShell's.** Always absolute paths.
- **Node and PowerShell disagree about trailing dots and spaces on Windows.** Node creates and reads
  `a.`, `Test-Path` returns `False`. Node's `\\?\` paths disable that stripping.
- **Environment variables are case-insensitive; JavaScript object keys are not.** A parent `Path` beats a
  caller `path` by UTF-16 sort order. This silently broke `PATH` propagation once.
- **Node uses `node:sqlite`**, synchronous. Hand-write transactions with
  `db.exec("BEGIN IMMEDIATE")` / `COMMIT` / `ROLLBACK`. Do not add `better-sqlite3`.
- **`WriteAllText` and `Get-Content` disagree about encodings** on the same file. Read bytes directly when
  a check matters.

---

## 6. Invariants that protect security

- A machine-sourced transcript row **must** carry `fromAgent` **and** `channel`. Without both it lands in
  `AckObligations` and is shown as "the user's last message" — a prompt-injection vector. Any new delivery
  tool must be added to `DELIVERY_TOOL_NAMES` in `source/host/runner/turn-shape.ts:5-8`.
- Plain assistant text is **never** shown to the user. Only a real `SendMessage` tool call reaches them
  (`turn-runtime.ts:47`). Do not weaken that.
- Do **not** use the loopback gateway (`gateway-server.ts`) as a control surface. One bearer token grants
  ~124 commands including `setHostSettings`, `setBoxSecrets` and `deleteAgents`, and it sits in plaintext
  in `gateway.json`. Use the stdio MCP server for tooling.
- Never put `projectRoot` in `profile.json` — `send-acceptance.ts:89` rewrites that file wholesale.

---

## 7. Definition of done

A task is done when you can state, with the command you ran:

- `npx tsc --noEmit -p source/tsconfig.json` — clean
- `npm test` — full suite green, with the number you actually observed
- `npm run build` — exit 0
- `node scripts/verify.mjs` — clean (CI will not do this for you)
- `npm run package` — exit 0, with the app closed first
- renderer invariants still true: the seven anchor md5s above, and `'Endpoint model list'` and
  `'RRouterFallbackModels'` present in the shipped `app.asar`
- if you touched the bridge: the method name confirmed present inside
  `var MAIN_METHOD_TABLE` in the built `main.cjs`

If any of that was not run, say which and why. Do not report success on a typecheck alone.

---

## 8. Reading the runtime

The app is packaged at `dist\Grok Bot 0.18 Reconstructed\Grok Bot.exe`.

To look at the live renderer, launch with `--remote-debugging-port=9341`, fetch
`http://127.0.0.1:9341/json/list`, open a `WebSocket` to `webSocketDebuggerUrl` (global in Node v26), and
send `Runtime.evaluate` with `returnByValue: true, awaitPromise: true`.

Wrap every expression in `(async()=>{ ... })()` — the evaluator does not await bare `await`.

Use a private `--user-data-dir` for any second instance; the singleton lock belongs to the first.

**`agent-create`, `agent-kill` and anything that reads `.dsh/relay` from inside a session is not part of
this project's task. Do not do it unless the user asks in that same message.**