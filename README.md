# Grok Bot 0.18 — Reconstructed

An unofficial, source-oriented reconstruction of the publicly shipped **Grok
Bot 0.18.0** desktop application, rebuilt to be **Windows-first** and able to
run **without a Cursor account**.

The repository preserves the original 0.18.0 installers as checksum-pinned
research inputs, reconstructs the Electron main / host / coordinator / renderer
sources, and ships a build pipeline that stages the pinned payload, overlays
reviewed reconstructed code, and produces a runnable Windows package.

> Not affiliated with Cursor or Anysphere. No upstream license or trademark
> rights are granted by this repository — see [NOTICE.md](NOTICE.md) and
> [docs/PUBLISHING.md](docs/PUBLISHING.md).

## What this project is

- **Local-first runtime.** When nobody is signed in, the coordinator launches
  from a local account slot (`LOCAL_ACCOUNT_SLOT`) instead of refusing to
  start, so the host, agents and chat run offline. The renderer's roster gate
  is a known remaining wall; see [AGENTS.md](AGENTS.md) §3 for the exact list
  of what does and does not work signed out.
- **Custom model routing.** Inference can point at any OpenAI-compatible
  endpoint through `inferenceProvider: "custom"`, and the model picker lists
  the endpoint's models.
- **Cursor detangled.** The provided launcher disables telemetry, product
  analytics, Sentry and update checks (`SAND_DISABLE_TELEMETRY`,
  `SAND_DISABLE_ANALYTICS`, `SAND_DISABLE_SENTRY`, `SAND_DISABLE_UPDATES`).
  What remains is inventoried in
  [docs/REMOVE-CURSOR.md](docs/REMOVE-CURSOR.md).
- **Reproducible packaging.** `npm run bootstrap` hydrates the checksum-pinned
  0.18.0 payload; `npm run package` produces
  `dist\Grok Bot 0.18 Reconstructed`; `npm run verify` checks the result.

## Layout

| Path | Contents |
| --- | --- |
| `source/` | reconstructed Electron main, host, coordinator, local-exec, shared and protocol code |
| `frontend/` | recovered React renderer source (editable; built with Vite) |
| `src/app/dist/` | pinned 0.18.0 payload, staged by `npm run bootstrap`; never edited by hand |
| `scripts/` | bootstrap, build, packaging, verification and publication pipeline |
| `tests/` | `node:test` suite that pins host behavior, defect by defect |
| `local-mcp/` | standalone MCP servers (Graphite notes, Telegram, DeepSeek Harness) |
| `research-archives/` | original 0.18.0 installers (Git LFS), SHA-256 pinned |
| `docs/` | architecture, publishing checklist, Cursor-removal audit |
| `manifests/` | reconstruction manifests consumed by the build |

## Requirements

- Node.js `>=26.5 <27` and npm
- Windows 10/11 for the packaged application and its tests
- [Git LFS](https://git-lfs.com/) for the preserved installers and pinned payload
- 7-Zip on Windows (`SEVEN_ZIP` overrides the path) — required by `npm run
  bootstrap` to unpack the pinned NSIS installer

## Build

```powershell
git lfs install
git lfs pull
npm ci
npm run bootstrap    # extracts the pinned 0.18.0 payload into src/app/dist
npm run check        # typechecks plus the full test suite
npm run build        # stages .build/fidelity
npm run package      # produces "dist\Grok Bot 0.18 Reconstructed"
npm run verify       # validates the packaged artifact
```

`npm run build` and `npm run package` are strictly sequential; do not run them
in parallel. The renderer payload is checksum-pinned and is patched only through
guarded exact replacements — see [AGENTS.md](AGENTS.md) before touching
`scripts/` or `source/`.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-grokbot.ps1
```

The launcher starts the local box host on `127.0.0.1:8790` (bearer token minted
at first launch), decrypts the DPAPI-protected secrets in
`%USERPROFILE%\.grokbot\launcher-secrets.txt`, and starts the packaged app.
Provider keys (`OPENAI_COMPATIBLE_API_KEY`, `TYPESAFE_API_KEY`) are read from
that file; no credentials live in this repository. The banner and the exact
environment it sets are documented in the script header.

## Tests and checks

- `npm test` — `node --test tests/*.test.mjs`
- `npm run check` — frontend and source typechecks plus the test suite
- `npm run publication:check` — proves a fresh archive export reproduces the
  tracked tree exactly
- `npm run smoke` — native end-to-end smoke check of the packaged app

## Preserved releases

`research-archives/original/0.18.0/` keeps the original macOS and Windows
installers byte-identical to the vendor downloads. Their SHA-256 digests are in
`SHA256SUMS` / `artifacts.json`; both files are tracked with Git LFS:

```sh
git lfs install
git lfs pull
(cd research-archives/original/0.18.0 && shasum -a 256 -c SHA256SUMS)
```

## Repository hygiene

Third-party telemetry credentials recovered from the original bundle (a Statsig
client key and a Sentry DSN) and machine-specific absolute paths were removed
from the source; the affected history was rewritten so they are not recoverable
from earlier commits. The preserved installers remain the publisher's
unmodified, hash-pinned artifacts and are kept only as research inputs.

## License

No license is granted by this repository for the upstream application, its
source, its installers or its trademarks. See [NOTICE.md](NOTICE.md).
