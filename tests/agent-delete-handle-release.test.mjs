import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Deleting an agent failed with `EBUSY: resource busy or locked, unlink
// '...\agents\<id>\store.db'` on every attempt, including right after a restart,
// so a box that reached its fifty-agent cap had no way to free a slot. The
// `node:sqlite` handle to `store.db` and the blob worker handle to
// `conversation-blobs.db` were still open when `rm` ran, and Windows refuses to
// unlink an open file. Two related defects hid behind the same symptom: an agent
// directory without a `store.db` was never reclaimed and kept its cap slot
// forever, and the transcript journal under `<root>\agent-transcripts\<id>` was
// left behind by every delete. The tests below fail against the old store and
// pass against this one.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agent-delete-"));
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
  ["host", "extensions", "session", "agent-session.ts"],
]);
const { SandAgentSessionStore } = loaded["agent-session.mjs"];

test.after(() => dispose());

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-agents-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

test("an agent whose store.db handle is still open is removed from disk", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = new SandAgentSessionStore(rootDir);
    const session = await store.createSession({ name: "Locked", description: "" });
    assert.equal(existsSync(path.join(rootDir, session.id, "store.db")), true,
      "the test proves nothing unless the agent really has a store.db on disk");

    let failure = null;
    try {
      await store.deleteSession(session.id);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure, null,
      `deleteSession reported ${failure?.code ?? failure?.message} instead of removing the agent`);
    assert.equal(existsSync(path.join(rootDir, session.id)), false,
      "the agent directory survived the delete, so the cap slot was never freed");
  } finally {
    dropRoot(base);
  }
});

test("an agent directory without a store.db is reclaimed instead of holding a cap slot", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = new SandAgentSessionStore(rootDir);
    const live = await store.createSession({ name: "Live", description: "" });
    const dangling = "11111111-1111-4111-8111-111111111111";
    mkdirSync(path.join(rootDir, dangling), { recursive: true });
    writeFileSync(path.join(rootDir, dangling, "profile.json"), "{}");

    const counted = [];
    store.materialization = {
      isAgentCapReached: async () => {
        const directories = (await store.listAgentIds()).length;
        counted.push(directories);
        return directories >= 2;
      },
    };

    assert.equal(await store.isAgentCapReached(), false,
      "the cap was still reported as reached although the leftover directory was reclaimed");
    assert.equal(existsSync(path.join(rootDir, dangling)), false,
      "a directory with no store.db is never cleaned, so it holds its slot forever");
    assert.equal(existsSync(path.join(rootDir, live.id)), true,
      "the reclaim removed a real agent instead of the leftover directory");
    assert.equal(counted.at(-1), 1,
      "the cap was evaluated before the leftover directory was reclaimed");
    await store.releaseSession(live.id);
  } finally {
    dropRoot(base);
  }
});

test("creating an agent reclaims a leftover directory before the cap is counted", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = new SandAgentSessionStore(rootDir);
    const dangling = "33333333-3333-4333-8333-333333333333";
    mkdirSync(path.join(rootDir, dangling), { recursive: true });
    const counted = [];
    store.materialization = {
      createSession: async () => {
        const directories = (await store.listAgentIds()).length;
        counted.push(directories);
        if (directories >= 2) throw new Error("Agent limit of 50 reached");
        return {
          id: "44444444-4444-4444-8444-444444444444",
          dbPath: path.join(rootDir, "44444444-4444-4444-8444-444444444444", "store.db"),
          db: { close() {} },
          agentStore: { dispose: async () => {} },
        };
      },
    };

    const session = await store.createSession({ name: "New", description: "" });

    assert.equal(session.id, "44444444-4444-4444-8444-444444444444",
      "the create was refused by the cap although the only leftover directory was garbage");
    assert.equal(counted.at(-1), 0,
      "the cap was counted while a directory with no store.db still occupied a slot");
    assert.equal(existsSync(path.join(rootDir, dangling)), false,
      "the leftover directory survived a create attempt");
  } finally {
    dropRoot(base);
  }
});

test("deleting an agent also removes its transcript journal directory", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = new SandAgentSessionStore(rootDir);
    const session = await store.createSession({ name: "Journalled", description: "" });
    const journalDir = path.join(base, "agent-transcripts", session.id);
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, `${session.id}.jsonl`), "{}\n");
    writeFileSync(path.join(journalDir, `${session.id}.journal-mode`), "1\n");

    await store.deleteSession(session.id);
    assert.equal(existsSync(journalDir), false,
      "the transcript journal outlived the agent it belongs to");
  } finally {
    dropRoot(base);
  }
});
