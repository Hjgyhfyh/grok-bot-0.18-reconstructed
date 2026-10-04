import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A deleted agent came back from the dead. `SandAgentDb`'s constructor began with
// `mkdirSync(dirname(dbPath), { recursive: true })` before it opened anything, so
// one late read of the database of an agent that no longer existed rebuilt
// `<root>\<id>\` with a fresh, empty `store.db` inside it. Measured on the box:
// delete the agent, the directory is gone; read `store.db` once more, the
// directory is back and contains exactly `store.db`; `listAgents` still shows
// nothing, so the resurrected directory holds a cap slot the user cannot see and
// cannot delete by hand either. The transcript manager kept a deleted id in
// memory for the rest of the run purely to hide those leftovers, which is a
// workaround with its own lifetime problems. Creation now says so out loud:
// `ensureAgentDbDirectory` is the only thing that makes a directory, and opening
// a store never makes one. The tests below fail against the old constructor and
// pass against this one.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agent-db-dir-"));
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
  ["host", "extensions", "session", "agent-db.ts"],
]);
const { SandAgentDb, ensureAgentDbDirectory } = loaded["agent-db.mjs"];

test.after(() => dispose());

const AGENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-agents-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir, agentDir: path.join(rootDir, AGENT_ID), dbPath: path.join(rootDir, AGENT_ID, "store.db") };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

test("a late read of a deleted agent's store.db does not rebuild the agent directory", () => {
  const { base, rootDir, agentDir, dbPath } = makeRoot();
  try {
    mkdirSync(agentDir, { recursive: true });
    const db = new SandAgentDb(dbPath);
    db.close();
    rmSync(agentDir, { recursive: true, force: true });
    assert.equal(existsSync(agentDir), false,
      "the test proves nothing unless the agent really is gone from disk");

    // One late read of the database of an agent that no longer exists. This is
    // what a roster pass in flight or a queued unread marker does after a
    // delete answered 200.
    let failure = null;
    try {
      new SandAgentDb(dbPath).close();
    } catch (error) {
      failure = error;
    }

    assert.equal(existsSync(agentDir), false,
      "reading the store of a deleted agent rebuilt its directory, so the cap slot it held was never freed");
    assert.deepEqual(readdirSync(rootDir), [],
      "the resurrected directory is what the user cannot delete and cannot see");
    assert.notEqual(failure, null,
      "opening the store of an agent that does not exist reported success and handed the caller a fresh empty database");
  } finally {
    dropRoot(base);
  }
});

test("creating an agent directory is an explicit action", () => {
  const { base, agentDir } = makeRoot();
  try {
    assert.equal(typeof ensureAgentDbDirectory, "function",
      "there is no way to create an agent directory, so minting an agent has nothing to call");
    ensureAgentDbDirectory(path.join(agentDir, "store.db"));
    assert.equal(existsSync(agentDir), true,
      "the explicit creation did not create anything");
    const db = new SandAgentDb(path.join(agentDir, "store.db"));
    db.close();
    assert.equal(existsSync(path.join(agentDir, "store.db")), true,
      "the store that opened the freshly created directory produced no database");
  } finally {
    dropRoot(base);
  }
});

test("opening the store of an agent whose directory is missing names the missing directory", () => {
  const { base, dbPath, agentDir } = makeRoot();
  try {
    let failure = null;
    try {
      new SandAgentDb(dbPath).close();
    } catch (error) {
      failure = error;
    }
    assert.notEqual(failure, null,
      "the constructor accepted a store whose agent directory does not exist");
    assert.equal(failure.name, "SandAgentDirectoryMissingError",
      "the failure is a raw SQLite error, so the caller cannot tell a missing directory from a corrupt file");
    assert.equal(failure.agentDir, agentDir,
      "the error does not say which directory has to be created");
  } finally {
    dropRoot(base);
  }
});
