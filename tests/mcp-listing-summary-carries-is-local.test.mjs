import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The MCP listing did not say where a server came from. Every summary built by
 * `SandMcpListingSummaries` in `source/shared/node/mcp/mcp-listing-summaries.ts` —
 * the account row, the box row and the team-disabled row — had no such field, and
 * `McpServerSummary` in `source/host/extensions/mcp/mcp-service.ts` had no field
 * to hold it. The `isLocal` flag was invented one hop further out, in
 * `toInstalledServer`, by re-running `isLocalMcpServerId(summary.id)`: the answer
 * was re-derived from the identifier band at the last possible moment instead of
 * being carried.
 *
 * So `ServerState` could not tell a file the user edits by hand from an account
 * row, and any consumer that read `servers` without going through the installed
 * mapper — the manager, the port, `toPluginSummary` — saw account rows only. The
 * installed row was right by coincidence: it was right as long as the id happened
 * to sit in the reserved band, and a row from any other source silently lost the
 * flag, which is the difference between refusing to uninstall a local server and
 * offering to.
 *
 * The flag is now decided where the listing is assembled and travels on the
 * summary. The band is kept as a second signal at the consumer rather than the
 * only one. The tests below fail against the old relay and pass against this one.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-is-local-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.cjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "cjs",
      mainFields: ["module", "main"],
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  // CommonJS on purpose: `mcp-service.ts` reaches the network stack through
  // `undici`, whose dynamic `require("assert")` an ESM bundle cannot serve. The
  // `.cjs` suffix matters — the same output under `.mjs` is loaded as an ES module
  // and dies on `module is not defined`, which measures the loader, not this file.
  const require = createRequire(import.meta.url);
  const loaded = {};
  for (const [name, file] of names) loaded[name] = require(file);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["shared", "node", "mcp", "mcp-listing-summaries.ts"],
  ["host", "extensions", "mcp", "mcp-service.ts"],
]);
const { SandMcpListingSummaries } = loaded["mcp-listing-summaries.cjs"];
const { toInstalledServer, toInstalledServers } = loaded["mcp-service.cjs"];

test.after(() => dispose());

/** A server id inside the band reserved for the user's own local MCP file. */
const LOCAL_ID = "900000123";
const LOCAL_ID_OUT_OF_BAND = "4242";

function summaries({ boxWired = true } = {}) {
  return new SandMcpListingSummaries({
    settingsStore: () => ({
      getMcpDisabledToolsByServerId: () => ({}),
      getRawMcpCustomInstructionByServerId: () => undefined,
      getRawMcpCustomInstruction: () => undefined,
    }),
    isBoxExecWired: () => boxWired,
  });
}

const stdioServer = (id) => ({
  id,
  name: "notes",
  serverIdentifier: "notes",
  config: { command: "node", args: ["mcp-servers/notes.mjs"] },
  isTeamServer: false,
});

const remoteServer = (id) => ({
  id,
  name: "linear",
  serverIdentifier: "linear",
  config: { url: "https://mcp.example/linear", type: "http" },
  isTeamServer: false,
});

test("the box summary of a local stdio server says the server is local", () => {
  const summary = summaries().createBoxServerSummary(stdioServer(LOCAL_ID), { status: "connected", toolCount: 2, tools: [] }, false);
  assert.equal(summary.isLocal, true,
    "the box summary carries no isLocal, so a server read from the user's own file reads as an account row to every consumer of ServerState");
  assert.equal(summaries().createBoxServerSummary(stdioServer(LOCAL_ID_OUT_OF_BAND), undefined, false).isLocal, false,
    "an account row was marked local, so an account connector would refuse the management actions only local ones must refuse");
});

test("the backend summary of a local server says the server is local, once per account slot", () => {
  const rows = summaries().createBackendServerSummaries(remoteServer(LOCAL_ID), []);
  assert.equal(rows.length, 1, "the fixture is wrong, not the code: one slot means one row");
  assert.equal(rows[0].isLocal, true, "the account-shaped summary of a local server carries no isLocal either");

  const slotted = summaries().createBackendServerSummaries(
    { ...remoteServer(LOCAL_ID), accounts: [{ accountKey: "work", hasToken: true, serverIdentifier: "linear-work" }] },
    [],
  );
  assert.equal(slotted.length, 1, "the slotted fixture produced the wrong number of rows");
  assert.equal(slotted[0].isLocal, true, "a local server listed under an account slot lost its isLocal, which is the row the host shows");
  assert.equal(summaries().createBackendServerSummaries(remoteServer(LOCAL_ID_OUT_OF_BAND), [])[0].isLocal, false,
    "an account row with an account slot was marked local");
});

test("the team-disabled summary of a local server says the server is local", () => {
  const summary = summaries().createAdminDisabledServerSummary({ ...stdioServer(LOCAL_ID), disabledByTeamAdminPolicy: true });
  assert.equal(summary.isLocal, true,
    "the disabled row carries no isLocal, so a locally managed server disabled by a team policy reads as an account row");
});

test("the installed row keeps isLocal for a summary that declares it", () => {
  const summary = summaries().createBoxServerSummary(stdioServer(LOCAL_ID_OUT_OF_BAND), undefined, false);
  const row = toInstalledServer({ ...summary, id: LOCAL_ID_OUT_OF_BAND, isLocal: true });
  assert.equal(row.isLocal, true,
    "a summary that says isLocal lost the flag on its way to the installed row, so the flag still depends on the id band alone");
  assert.equal(row.managedBy, "local-file",
    `the row that claims isLocal does not say which file owns it: ${JSON.stringify(row)}`);
  assert.match(String(row.configFile), /mcp-servers\.json$/,
    `the row points the user at the wrong file: ${row.configFile}`);
});

test("an account row is not marked local by either signal", () => {
  const summary = summaries().createBoxServerSummary(stdioServer(LOCAL_ID_OUT_OF_BAND), undefined, false);
  const row = toInstalledServer({ ...summary, id: LOCAL_ID_OUT_OF_BAND, isLocal: false });
  assert.equal(row.isLocal, undefined, "an account row was marked local, so the tools would refuse to manage a working connector");
  assert.equal(row.managedBy, undefined, "an account row claims the user's local file owns it");
});

test("a listing built end to end keeps exactly one local row and the rest account-owned", () => {
  const listing = summaries();
  const box = boxEntry => ({ status: "connected", toolCount: 2, tools: [] });
  const state = {
    servers: [
      listing.createBoxServerSummary(stdioServer(LOCAL_ID), box(), false),
      listing.createBoxServerSummary(stdioServer(LOCAL_ID_OUT_OF_BAND), box(), false),
    ],
  };
  const rows = toInstalledServers(state);
  assert.equal(rows.length, 2, "the fixture produced the wrong number of installed rows");
  assert.deepEqual(
    rows.filter(row => row.isLocal === true).map(row => row.id),
    [LOCAL_ID],
    "the local row did not survive the trip from the summary to the installed listing, so the model is told a user's own file is an account connector",
  );
});