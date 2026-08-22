# Grok Bot 0.18 reconstructed

An unofficial, source-oriented reconstruction of the publicly shipped Grok Bot
0.18.0 macOS application. The repository contains reviewed TypeScript runtime
and renderer code plus deterministic packaging tools. It does not commit the
original application archive, generated recovery reports, or release evidence;
`npm run bootstrap` downloads and verifies the public payload locally.

This is not Anysphere's original monorepo and it is not an official build.
Original names, types, and package boundaries cannot always be recovered from a
compiled application.

## Requirements

- macOS on Apple Silicon
- Node.js 26.5.x
- Xcode Command Line Tools

## Setup

```sh
npm ci
npm run bootstrap
npm run check
npm run package
```

`bootstrap` downloads the public 0.18.0 DMG unless `GROK_BOT_018_APP` points to
an existing copy. It verifies the pinned DMG and `app.asar` hashes, caches the
ABI-compatible Electron runtime, and hydrates the ignored `src/app/dist`
payload used as the reconstruction baseline.

`package` builds and ad-hoc signs:

```text
dist/Grok Bot 0.18 Reconstructed.app
```

It does not overwrite an installed Grok Bot application. The reconstructed app
uses a different bundle identifier and disables the upstream updater at the
packaging boundary. Reconstructed packages also default upstream Sentry and
telemetry emission off; explicitly supplied environment values are respected.

The packaged application keeps the checksum-pinned shipped renderer for its
polished UI. A narrow, deterministic packaging transform adds reconstructed
settings surfaces to the relevant renderer chunks and records their original
and patched hashes. The editable renderer under `frontend/` remains the readable
source reconstruction and design workspace.

### Inference Router

Settings → Router selects the inference backend used for new turns. Cursor uses
the signed-in account. Claude Code uses its installed SDK and existing local
login. Codex uses the existing local ChatGPT login through the Codex backend;
neither requires a separate API key. OpenRouter retains Grok Bot's tool-execution
loop through its chat API, and `OPENROUTER_API_KEY` can be saved through the
Router page using the existing desktop secrets bridge. Usage & Billing shows
requests and token totals recorded from completed provider calls. The same page
can route the reconstructed box runtime through an owned local Docker container
instead of the remote sandbox.

## Repository layout

- `source/` — reviewed TypeScript reconstruction of the application runtimes.
- `frontend/` — editable React/TypeScript renderer reconstruction.
- `frontend/manifests/` — small checked-in renderer identity and mapping data.
- `manifests/reconstruction/` — build inputs retained from the reconstruction
  process because packaging validates them directly.
- `scripts/` — bootstrap, build, verification, and macOS packaging tools.
- `src/app/package.json` — package metadata overlaid onto the bootstrapped
  upstream payload.
- `tests/` — small publication-facing regression suite.

Generated and local-only directories such as `src/app/dist`, `recovered`,
`.cache`, `.build`, and `dist` are intentionally ignored.

## Useful commands

```sh
npm test                 # focused publication regressions
npm run typecheck        # renderer TypeScript
npm run source:typecheck # runtime TypeScript
npm run frontend:build   # clean renderer build
npm run verify           # verify a packaged application
npm run smoke            # bounded native smoke check
```

`npm run frontend:recover` may be used locally to expand the bootstrapped
renderer for inspection. Its generated output is not committed.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the build boundary and
[docs/PUBLISHING.md](docs/PUBLISHING.md) for the clean-history export process.

## Publication status

The repository has been separated from its historical recovery reports and
machine-local evidence, but that is not a license grant for upstream material.
Read [PROVENANCE.md](PROVENANCE.md) and [NOTICE.md](NOTICE.md) before sharing it.
