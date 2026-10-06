import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Reading a deleted agent rebuilt its directory, one file at a time.
//
// `ensureProfileFile` was fixed for exactly this and says so in its own comment:
// "Wave 9 moved directory creation out of every read and into the mint, because
// a directory that comes back for an agent nobody has holds a slot of the
// fifty-agent cap that the roster never shows and the user cannot delete -- and
// this function was the last reader left that could still make one." Its guard is
// `if (!existsSync(dirname(path))) return path;`.
//
// Its neighbour on the next line was not touched:
//
//   export function ensureSettingsFile(dbPath) {
//     const path = getSandSettingsPath(dirname(dbPath));
//     if (!existsSync(path)) writeSandSettingsFile(path, {});   // <-- mkdirSync
//     return path;
//   }
//
// `writeSandSettingsFile` ends in `mkdirSync(dirname(path), { recursive: true })`,
// so the "make sure it is there" half of a read is a create. And
// `ensureSettingsFile` is called on the first line of `buildSummary`, which every
// roster pass, every `summarizeOpenSession` and every `summarizeAgentById` goes
// through -- so any summary that reaches an agent whose directory has just been
// unlinked rebuilds it, holding one file, holding a cap slot.
//
// Measured on a live box, at the end of a sweep of forty-odd agent commands:
//
//   POST /api/deleteAgents {"ids":[...,"0bcd4a61-…"]}
//     200 {"deleted":["…","0bcd4a61-…"],"failed":[]}
//   POST /api/countAgents   3
//   POST /api/listAgents    2          <-- the third agent is on disk and not listed
//   <root>\agents\0bcd4a61-…\settings.json   "{}\n"   (3 bytes)
//
// Three bytes of `{}\n` is what `writeSandSettingsFile(path, {})` writes, and
// `ensureSettingsFile` is the only caller that passes an empty update. The
// directory was not left over by the delete: `removeAgentDirOrFail` checks
// `existsSync` twice and throws with a list of leftovers rather than answering
// `deleted`. It was rebuilt afterwards, by a summary that was already in flight.
//
// Every test below fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-ghostdir-"));
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
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "session", "session-recovery.ts"],
  ["host", "extensions", "session", "session-summaries.ts"],
]);
const { ensureSettingsFile, ensureProfileFile } = loaded["session-recovery.mjs"];
const { buildSummary } = loaded["session-summaries.mjs"];

test.after(() => dispose());

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-ghostdir-root-"));
  const agentsRoot = path.join(base, "agents");
  return { base, agentsRoot };
}

test("reading the settings of an agent that is not on disk creates its directory", () => {
  const { base, agentsRoot } = makeRoot();
  try {
    const dbPath = path.join(agentsRoot, "22222222-2222-4222-8222-222222222222", "store.db");

    const written = ensureSettingsFile(dbPath);

    assert.equal(existsSync(path.dirname(written)), false,
      "a read about an agent that does not exist created its directory, and that directory holds a slot of the fifty-agent cap that no roster shows and no delete can reach");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("building a summary for a directory that is not there does not create it", async () => {
  const { base, agentsRoot } = makeRoot();
  try {
    const agentDir = path.join(agentsRoot, "22222222-2222-4222-8222-222222222222");

    await buildSummary({
      dbPath: path.join(agentDir, "store.db"),
      dirName: "22222222-2222-4222-8222-222222222222",
      includeBlank: true,
    });

    assert.deepEqual(existsSync(agentsRoot) ? readdirSync(agentsRoot) : [], [],
      "summarising an agent that is not on disk left a directory behind, and the summary is the only thing that ran");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the profile reader next to it does not have this problem, which is the whole point", () => {
  const { base, agentsRoot } = makeRoot();
  try {
    const absentDir = path.join(agentsRoot, "33333333-3333-4333-8333-333333333333");
    const db = { get: () => "Grok", getSandProfile: () => ({ description: "" }) };

    ensureProfileFile(path.join(absentDir, "store.db"), db);

    assert.equal(existsSync(absentDir), false,
      "the guard that was added for the profile file is gone, so the fix was reverted rather than left alone");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a live agent that lost its settings file still gets one back", () => {
  const { base, agentsRoot } = makeRoot();
  try {
    const agentDir = path.join(agentsRoot, "44444444-4444-4444-8444-444444444444");
    mkdirSync(agentDir, { recursive: true });

    const written = ensureSettingsFile(path.join(agentDir, "store.db"));

    assert.equal(existsSync(written), true,
      "the refusal was widened past the directory that is really there, so an agent that lost its settings file can never get it back");
    assert.deepEqual(JSON.parse(readFileSync(written, "utf8")), {},
      "the settings file that is written for a live agent carries no defaults, so it is not the file a create writes");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
