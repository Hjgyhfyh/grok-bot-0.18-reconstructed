import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// An agent forgot its own name and stayed that way. `ensureProfileFile` reads
// `profile.json` and, when the file is gone, rebuilds it from `db.get("name")`
// -- but nothing ever wrote the name to the store. `materializeSession` writes it
// to `profile.json` only, and `db.set("name", ...)` had exactly one caller in the
// whole tree, `recoverConversationIfRootMissing`, which runs on the recovery path
// and not on the read path. So the store kept the `"New Agent"` that
// `getDefaultAgentMetadata` seeded at mint, and the rebuild had nothing better to
// copy: measured on a live box, an agent called "Fossil Probe" lost its
// `profile.json`, one `listAgents` reported it as "New Agent" with an empty
// description, and the file written back agreed. The name was not recovered from
// a backup later -- it was overwritten, once, permanently. Two agents the user
// owns by name ("Аудитор проектов" and "Сборщик идей") lose their identity, and
// with it the instruction that travels in the description. Nothing noticed: the
// roster still shows the agent, so every caller that checks "is there a record"
// saw a healthy agent wearing someone else's name.
//
// Reading the profile now mirrors the name and the description into the agent's
// own store, which is the only place that outlives the file. The tests below walk
// the whole cycle -- create with a description, rename, change the description,
// lose the file, restart the host -- and the last one holds the line wave 9 drew:
// reading must never create, because a resurrected directory holds a slot of the
// fifty-agent cap that the roster never shows and the user cannot delete.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-profile-identity-"));
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
  ["host", "extensions", "session", "agent-session.ts"],
  ["host", "extensions", "session", "session-recovery.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
]);
const { SandAgentDb } = loaded["agent-db.mjs"];
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { ensureProfileFile } = loaded["session-recovery.mjs"];
const { SandSessionMaterialization } = loaded["session-materialization.mjs"];

test.after(() => dispose());

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-profile-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

/**
 * Wires the store the way the host does: the real `SandAgentSessionStore` over the
 * real `SandSessionMaterialization`, so the roster is the one the box answers
 * `listAgents` with rather than a stand-in that only counts directories.
 */
function makeStore(rootDir) {
  const store = new SandAgentSessionStore(rootDir);
  store.materialization = new SandSessionMaterialization({
    ctx: {},
    rootDir,
    createBlobWorkerPool: () => ({ connections: new Map(), closeAll: async () => {} }),
    createAgentStore: () => ({ dispose: async () => {} }),
    createMemoryStore: () => ({}),
    resolveUserTimeZone: () => undefined,
    agentExists: (agentId) => store.agentExists(agentId),
    getAgentDir: (agentId) => store.getAgentDir(agentId),
    readActiveAgentId: () => store.readActiveAgentId(),
    report: () => {},
  });
  return store;
}

const profilePathOf = (rootDir, agentId) => path.join(rootDir, agentId, "profile.json");

async function readProfileOnDisk(rootDir, agentId) {
  return JSON.parse(await readFile(profilePathOf(rootDir, agentId), "utf8"));
}

/** Opens the agent's own store the way any later pass would, and closes it again. */
function readStore(dbPath, run) {
  const db = new SandAgentDb(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

test("an agent created with a name and a description carries both into the store the first time it is read", async () => {
  const { base, rootDir } = makeRoot();
  const store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Аудитор проектов", description: "Проверяет чужие проекты" });
    const agentId = session.id;
    await store.releaseSession(agentId);

    assert.deepEqual(await readProfileOnDisk(rootDir, agentId), {
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      title: "",
      avatarShape: "",
      avatarColor: "",
    }, "the create did not write the identity the user gave it");

    await store.listAgents();

    readStore(session.dbPath, (db) => {
      assert.equal(db.get("name"), "Аудитор проектов",
        "the store still holds the seeded default, so the name exists in exactly one file and dies with it");
      assert.equal(db.getSandProfile().description, "Проверяет чужие проекты",
        "the description exists in exactly one file too, and it is the instruction the agent works by");
    });
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("renaming an agent writes the new name into the store, not only into the profile file", async () => {
  const { base, rootDir } = makeRoot();
  const store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Аудитор проектов", description: "Проверяет чужие проекты" });
    const agentId = session.id;
    await store.releaseSession(agentId);
    await store.updateAgentProfile(agentId, { name: "Сборщик идей", description: "Собирает идеи" });

    assert.equal(store.getAgentProfileText(agentId).name, "Сборщик идей",
      "the rename is not on disk, so the profile file never learned about it");
    readStore(session.dbPath, (db) => {
      assert.equal(db.get("name"), "Сборщик идей",
        "the rename reached the file but not the store, so the store is ready to resurrect the old name");
    });
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("updating only the description still writes the description into the store", async () => {
  const { base, rootDir } = makeRoot();
  const store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Сборщик идей", description: "Собирает идеи" });
    const agentId = session.id;
    await store.releaseSession(agentId);
    await store.updateAgentProfile(agentId, { name: "Сборщик идей", description: "Собирает идеи по понедельникам" });

    readStore(session.dbPath, (db) => {
      assert.equal(db.getSandProfile().description, "Собирает идеи по понедельникам",
        "the store kept the first description, so a lost profile would restore the agent to its old instruction");
    });
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an agent that loses its profile file keeps its name and its description", async () => {
  const { base, rootDir } = makeRoot();
  const store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Аудитор проектов", description: "Проверяет чужие проекты" });
    const agentId = session.id;
    await store.releaseSession(agentId);
    await store.updateAgentProfile(agentId, { name: "Сборщик идей", description: "Собирает идеи" });
    await rm(profilePathOf(rootDir, agentId), { force: true });
    assert.equal(existsSync(profilePathOf(rootDir, agentId)), false,
      "the test proves nothing unless the profile really is gone from disk");

    const [listed] = await store.listAgents();

    assert.equal(listed.name, "Сборщик идей",
      "one roster pass renamed the agent for good, and the name was never recoverable again");
    assert.equal(listed.description, "Собирает идеи",
      "the description was lost with the file, so the agent came back without its instruction");
    const restored = await readProfileOnDisk(rootDir, agentId);
    assert.equal(restored.name, "Сборщик идей",
      "the profile written back does not carry the name the roster just reported");
    assert.equal(restored.description, "Собирает идеи",
      "the profile written back does not carry the description the roster just reported");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an agent that loses its profile file and is then reopened by a fresh host keeps its name", async () => {
  const { base, rootDir } = makeRoot();
  let store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Аудитор проектов", description: "Проверяет чужие проекты" });
    const agentId = session.id;
    await store.releaseSession(agentId);
    await store.updateAgentProfile(agentId, { name: "Сборщик идей", description: "Собирает идеи" });
    await store.closeWorkerPool();

    // The host restarts: nothing of the first store is left, including the read
    // cache that could have been hiding the loss.
    store = makeStore(rootDir);
    await rm(profilePathOf(rootDir, agentId), { force: true });

    const [listed] = await store.listAgents();

    assert.equal(listed.name, "Сборщик идей",
      "a restarted host turned the agent into a nameless one, so every restart was one step closer to losing it for good");
    assert.equal(listed.description, "Собирает идеи",
      "a restarted host also lost the instruction the agent works by");
    assert.equal(store.getAgentProfileText(agentId).name, "Сборщик идей",
      "the profile on disk after the restart disagrees with the roster about who this agent is");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("reading a profile never creates anything, so a deleted agent stays deleted", async () => {
  const { base, rootDir } = makeRoot();
  const store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Аудитор проектов", description: "Проверяет чужие проекты" });
    const agentId = session.id;
    await store.releaseSession(agentId);

    // The user deletes the agent through the product, so the directory really is
    // gone before the next roster pass -- not merely hidden.
    await store.deleteSession(agentId);
    assert.equal(existsSync(store.getAgentDir(agentId)), false,
      "the test proves nothing unless the delete really removed the directory");

    // Everything a late read can reach: the roster, a single-agent summary, a
    // reopen. Wave 9 drew this line -- `ensureAgentDbDirectory` runs at mint and
    // nowhere else -- and mirroring the profile into the store is a write, so a
    // read pass must not grow into a write pass on disk.
    assert.equal(await store.summarizeAgentById(agentId), null,
      "a deleted agent answered a summary, so something still believes it is on disk");
    assert.deepEqual(await store.listAgents(), [],
      "the roster shows an agent whose directory was deleted");
    await assert.rejects(
      () => store.openSession(agentId),
      /missing|Missing|not exist/i,
      "opening a deleted agent reported success and handed back a session for it",
    );

    // And the reader itself, asked directly for the agent that is not there. Its
    // rebuild path writes through `writeSandProfileFile`, which runs `mkdirSync`,
    // so without a guard on the directory it resurrects the very folder wave 9
    // removed the creation of -- one holding a cap slot the roster never shows.
    const absent = "99999999-9999-4999-8999-999999999999";
    const absentDbPath = path.join(rootDir, absent, "store.db");
    ensureProfileFile(absentDbPath, { get: () => "New Agent", getSandProfile: () => ({ description: "" }) });

    assert.equal(existsSync(path.join(rootDir, absent)), false,
      "reading the profile of a deleted agent rebuilt its directory, so the cap counts an agent the roster never shows");
    assert.deepEqual(readdirSync(rootDir).sort(), [],
      "the directory of a deleted agent is back on disk and holds a slot of the fifty-agent cap for good");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("a roster pass over an agent that is already in order writes nothing at all", async () => {
  const { base, rootDir } = makeRoot();
  const store = makeStore(rootDir);
  try {
    const session = await store.createSession({ name: "Аудитор проектов", description: "Проверяет чужие проекты" });
    const agentId = session.id;
    await store.releaseSession(agentId);
    await store.updateAgentProfile(agentId, { name: "Сборщик идей", description: "Собирает идеи" });

    await store.listAgents();
    const filesBefore = readdirSync(store.getAgentDir(agentId)).sort();
    const dbStatBefore = await stat(session.dbPath);

    await store.listAgents();
    await store.listAgents();

    assert.deepEqual(readdirSync(store.getAgentDir(agentId)).sort(), filesBefore,
      "reading a settled agent's profile wrote into its directory, so a read can no longer be told apart from a repair");
    const dbStatAfter = await stat(session.dbPath);
    assert.equal(dbStatAfter.mtimeMs, dbStatBefore.mtimeMs,
      "every roster pass rewrote the store, so the mtime its own read cache is keyed on changes on every pass");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});