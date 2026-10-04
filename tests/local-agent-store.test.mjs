/**
 * The local agent store — the code that actually creates, opens, lists, rebuilds
 * and forgets an agent on this machine — had no test at all. `createSession` falls
 * back to the private `createLocalSession` whenever `materialization.createSession`
 * is absent, and nothing ever executed that fallback, so `source/host/agents/*` and
 * `source/host/extensions/session/agent-session.ts` shipped untested. A profile
 * written with the wrong fields, a `store.db` that was never really opened, a
 * corrupt store that crashed the session instead of being quarantined, or an
 * `active-agent.json` pointer that never round-tripped would all have stayed green.
 * These tests drive the real module against a temporary `SAND_DATA_ROOT`: no
 * network, no token, no coordinator, just the agent lifecycle.
 */

import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-local-agents-build-"));
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
  for (const [name, file] of names) loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rm(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([["host", "extensions", "session", "agent-session.ts"]]);
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
test.after(dispose);

const TOUCHED_ENV = ["SAND_DATA_ROOT", "SAND_USER_DATA_DIR"];
const savedEnv = new Map();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQLITE_HEADER = "SQLite format 3\u0000";
const STORE_FILENAME = "store.db";
const PROFILE_FILENAME = "profile.json";
const POINTER_FILENAME = "active-agent.json";
const QUARANTINE_PREFIX = "store.db.corrupt-";
let sandboxRoot;

before(async () => {
  sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "grok-local-agents-"));
  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
  // `getSandRootDir()` returns `SAND_DATA_ROOT` whenever it is absolute, and it is
  // read at call time, so every product path below resolves inside this directory
  // instead of the real `~/.grokbot`. Dropping `SAND_USER_DATA_DIR` removes the only
  // other override that could point somewhere else.
  process.env.SAND_DATA_ROOT = sandboxRoot;
  delete process.env.SAND_USER_DATA_DIR;
});

after(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (sandboxRoot !== undefined) await rm(sandboxRoot, { recursive: true, force: true });
});

/**
 * Points `SAND_DATA_ROOT` at a directory of this test's own for the duration of
 * `body` and hands back a store whose default agents root is the one underneath it.
 * Every test gets its own root, so agents created by one test can never turn up in
 * another test's listing.
 */
async function withSandbox(name, body) {
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  const previousUserDataDir = process.env.SAND_USER_DATA_DIR;
  const root = await mkdtemp(path.join(sandboxRoot, `${name}-`));
  process.env.SAND_DATA_ROOT = root;
  delete process.env.SAND_USER_DATA_DIR;
  try {
    return await body({ root, store: new SandAgentSessionStore() });
  } finally {
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    if (previousUserDataDir === undefined) delete process.env.SAND_USER_DATA_DIR;
    else process.env.SAND_USER_DATA_DIR = previousUserDataDir;
  }
}

function sqliteQuickCheck(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try { return db.prepare("PRAGMA quick_check").get()?.quick_check; }
  finally { db.close(); }
}

function sqliteTableNames(storePath) {
  const db = new DatabaseSync(storePath);
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name).sort(); }
  finally { db.close(); }
}

/**
 * Grows an agent's store with a foreign `filler` table and then destroys the header
 * byte of one filler leaf page. SQLite stores no page checksums, so random bytes in
 * a blob go unnoticed; a broken b-tree page header is the corruption a real store
 * shows, and it leaves the `kv` rows on the early pages readable — which is exactly
 * the case the salvage path in `agent-db-recovery.ts` exists for.
 */
async function damageOneForeignBtreePage(storePath, fillerRows = 400) {
  const filler = new DatabaseSync(storePath);
  try {
    filler.exec("PRAGMA journal_mode = DELETE");
    filler.exec("CREATE TABLE filler(id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    filler.exec("BEGIN");
    for (let index = 0; index < fillerRows; index += 1) filler.exec(`INSERT INTO filler VALUES(${index}, randomblob(4000))`);
    filler.exec("COMMIT");
  } finally { filler.close(); }

  const bytes = await readFile(storePath);
  const pageSize = bytes.readUInt16BE(16) || 4096;
  const pageCount = Math.floor(bytes.length / pageSize);
  assert.ok(pageCount > 8, `the damaged fixture must have several pages, got ${pageCount}`);
  const handle = await open(storePath, "r+");
  try { await handle.write(Buffer.from([0x00, 0x99, 0x42, 0x77]), 0, 4, pageSize * (pageCount - 3) + 1); }
  finally { await handle.close(); }
  return { pageCount, pageSize };
}

test("creating a local agent writes its profile file and its sqlite store into a directory of its own", async () => {
  await withSandbox("create", async ({ root, store }) => {
    assert.equal(
      store.getRootDir(),
      path.join(root, "agents"),
      "the default agents root must resolve under SAND_DATA_ROOT, otherwise this test writes into the real user profile",
    );

    const session = await store.createSession(
      { name: "  Ada  ", description: "  audits stores  ", title: "  Store Auditor  ", avatarShape: "  hex  ", avatarColor: "  #ff8800  " },
      "dev",
      "audit",
    );

    assert.match(session.id, UUID_PATTERN, "a created agent must receive a real minted id");
    assert.equal(session.db.get("agentId"), session.id, "the minted id must be recorded inside the agent's own store");

    const agentDir = path.join(store.getRootDir(), session.id);
    const entries = await readdir(agentDir);
    assert.ok(entries.includes(PROFILE_FILENAME), `the agent directory must hold a profile file, got ${entries.join(", ")}`);
    assert.ok(entries.includes(STORE_FILENAME), `the agent directory must hold a sqlite store, got ${entries.join(", ")}`);
    assert.equal(session.dbPath, path.join(agentDir, STORE_FILENAME), "the session must report the store inside its own agent directory");

    const header = (await readFile(session.dbPath)).subarray(0, 16).toString("latin1");
    assert.equal(header, SQLITE_HEADER, "store.db must be a real sqlite file, not a placeholder file with the right name");

    assert.deepEqual(
      store.getAgentProfileText(session.id),
      { name: "Ada", description: "audits stores", title: "Store Auditor", avatarShape: "hex", avatarColor: "#ff8800" },
      "the profile written on creation must carry exactly the caller's fields, trimmed",
    );
    assert.equal(session.db.getAgentOrigin(), "dev", "the origin the caller passed must be persisted in the store");
    assert.equal(session.db.getAgentPurpose(), "audit", "the purpose the caller passed must be persisted in the store");
    assert.equal(session.db.getIntroductionPending(), true, "a freshly created agent must still owe the user its introduction");

    session.db.close();
  });
});

test("a second open of the same agent id returns the same session and the same state instead of minting a new one", async () => {
  await withSandbox("reopen", async ({ store }) => {
    const created = await store.createSession({ name: "Keeper", description: "keeps state" }, "user");
    created.db.recordRequestId("req-keep", 1_700_000_000_000, "write then read", "turn");
    created.db.appendTranscriptEntry({ id: "entry-keep", kind: "message", content: "written before the reopen", timestampMs: 1_700_000_000_001 });
    created.db.close();

    const reopened = await store.openSession(created.id);
    assert.equal(reopened.id, created.id, "opening a known agent must return that agent, not a new one");
    assert.equal(reopened.dbPath, created.dbPath, "opening a known agent must reuse its existing store file");
    assert.equal(reopened.db.get("agentId"), created.id, "the reopened store must still be the store of that agent");
    assert.deepEqual(
      reopened.db.getRequestIds(),
      [{ id: "req-keep", at: 1_700_000_000_000, prompt: "write then read", source: "turn" }],
      "state written through the first handle must survive the reopen instead of being reset",
    );
    assert.deepEqual(
      reopened.db.getTranscriptEntries(),
      [{ id: "entry-keep", kind: "message", content: "written before the reopen", timestampMs: 1_700_000_000_001 }],
      "the transcript written through the first handle must survive the reopen",
    );
    assert.deepEqual(
      store.getAgentProfileText(created.id),
      { name: "Keeper", description: "keeps state", title: "", avatarShape: "", avatarColor: "" },
      "the profile written on creation must still be there after the reopen",
    );
    reopened.db.close();

    assert.deepEqual(
      await store.listAgentIds(),
      [created.id],
      "opening an existing agent must not mint a second directory for it",
    );
  });
});

test("two agents created in the same root do not collide and the root listing returns both of them", async () => {
  await withSandbox("two-agents", async ({ store }) => {
    const first = await store.createSession({ name: "First", description: "one" }, "user");
    const second = await store.createSession({ name: "Second", description: "two" }, "user");

    assert.notEqual(first.id, second.id, "two agents in one root must not share an id");
    assert.notEqual(first.dbPath, second.dbPath, "two agents in one root must not share a store file");
    assert.equal(first.db.get("agentId"), first.id, "the first store must belong to the first agent");
    assert.equal(second.db.get("agentId"), second.id, "the second store must belong to the second agent");

    first.db.recordRequestId("req-first", 11);
    assert.deepEqual(second.db.getRequestIds(), [], "a write to one agent's store must not appear in the other agent's store");
    assert.deepEqual(store.getAgentProfileText(second.id).name, "Second", "the second agent must keep its own profile");

    const listed = await store.listAgentIds();
    assert.deepEqual(listed, [first.id, second.id].sort(), "the root listing must return both agents, sorted");

    store.writeActiveAgentId(first.id);
    assert.deepEqual(
      await store.listAgentIds(),
      listed,
      "a pointer file dropped in the agents root must not be mistaken for an agent directory",
    );

    first.db.close();
    second.db.close();
  });
});

test("a profile written from partial input is normalised with the product defaults instead of being rejected", async () => {
  await withSandbox("partial-profile", async ({ store }) => {
    const blankName = await store.createSession({}, "user");
    const paddedName = await store.createSession({ name: "   " }, "user");
    const described = await store.createSession({ description: "  only a description  " }, "user");

    const defaults = { name: "Grok", description: "", title: "", avatarShape: "", avatarColor: "" };
    assert.deepEqual(store.getAgentProfileText(blankName.id), defaults, "an agent created with no profile at all must be filled with the product defaults");
    assert.deepEqual(store.getAgentProfileText(paddedName.id), defaults, "a whitespace-only name must fall back to the default name instead of persisting an empty one");
    assert.deepEqual(
      store.getAgentProfileText(described.id),
      { ...defaults, description: "only a description" },
      "filling in the missing fields must not discard the description the caller did give",
    );

    for (const session of [blankName, paddedName, described]) session.db.close();
  });
});

test("a truncated store.db is quarantined and rebuilt so the session still opens", async () => {
  await withSandbox("truncated-store", async ({ store }) => {
    const created = await store.createSession({ name: "Truncated", description: "" }, "user");
    created.db.recordRequestId("req-doomed", 5);
    created.db.appendTranscriptEntry({ id: "entry-doomed", kind: "message", content: "doomed", timestampMs: 5 });
    created.db.close();

    const agentDir = path.join(store.getRootDir(), created.id);
    const storePath = path.join(agentDir, STORE_FILENAME);
    for (const suffix of ["-wal", "-shm"]) await rm(`${storePath}${suffix}`, { force: true });
    const whole = await readFile(storePath);
    await truncate(storePath, Math.floor(whole.length / 2));
    const truncatedSize = (await stat(storePath)).size;
    assert.ok(truncatedSize > 0 && truncatedSize < whole.length, "the fixture must really be shorter than a healthy store");

    const session = await store.openSession(created.id);
    assert.equal(session.id, created.id, "a damaged store must still yield a session for its own agent");
    assert.equal(session.db.get("agentId"), created.id, "the rebuilt store must be seeded for the agent that owns it");
    assert.deepEqual(
      session.db.getRequestIds(),
      [],
      "half a store cannot be salvaged, so the degraded path must come back with an empty store rather than resurrected half-read rows",
    );
    session.db.close();

    const entries = await readdir(agentDir);
    const quarantined = entries.filter((name) => name.startsWith(QUARANTINE_PREFIX));
    assert.equal(quarantined.length, 1, `the damaged file must be quarantined next to the rebuilt one, got ${entries.join(", ")}`);
    assert.deepEqual(
      await readFile(path.join(agentDir, quarantined[0])),
      whole.subarray(0, truncatedSize),
      "the quarantine copy must preserve the damaged bytes so the failure can be investigated",
    );
    assert.equal(
      (await readFile(storePath)).subarray(0, 16).toString("latin1"),
      SQLITE_HEADER,
      "a usable sqlite store must exist again at the original path",
    );
    assert.ok(entries.includes(PROFILE_FILENAME), "the agent profile must survive the store rebuild");
  });
});

test("a store.db with one damaged b-tree page is quarantined and its still-readable rows are salvaged", async () => {
  await withSandbox("damaged-store", async ({ store }) => {
    const created = await store.createSession({ name: "Damaged", description: "" }, "user");
    created.db.recordRequestId("req-damaged", 2_000, "still readable");
    created.db.appendTranscriptEntry({ id: "entry-damaged", kind: "message", content: "still readable", timestampMs: 9 });
    created.db.close();

    const storePath = created.dbPath;
    for (const suffix of ["-wal", "-shm"]) await rm(`${storePath}${suffix}`, { force: true });
    const { pageCount } = await damageOneForeignBtreePage(storePath);
    const check = sqliteQuickCheck(storePath);
    assert.notEqual(check, "ok", `the fixture must be a store sqlite itself rejects, quick_check said ${check} over ${pageCount} pages`);

    const session = await store.openSession(created.id);
    assert.equal(session.id, created.id, "a store that fails its integrity check must not stop the agent from opening");
    assert.deepEqual(
      session.db.getRequestIds(),
      [{ id: "req-damaged", at: 2_000, prompt: "still readable" }],
      "rows that are still readable in the damaged store must be salvaged into the rebuilt one",
    );
    assert.deepEqual(
      session.db.getTranscriptEntries(),
      [{ id: "entry-damaged", kind: "message", content: "still readable", timestampMs: 9 }],
      "the transcript must be salvaged together with the key-value rows",
    );
    session.db.close();

    const agentDir = path.join(store.getRootDir(), created.id);
    const entries = await readdir(agentDir);
    assert.ok(
      entries.some((name) => name.startsWith(QUARANTINE_PREFIX)),
      `the damaged store must be quarantined, got ${entries.join(", ")}`,
    );
    assert.deepEqual(
      sqliteTableNames(storePath),
      ["blobs", "kv", "transcript_entries"],
      "the store must be rebuilt from the product schema, so the foreign table of the damaged file is gone",
    );
    assert.ok(entries.includes(PROFILE_FILENAME), "the agent profile must survive the store rebuild");
  });
});

test("the active-agent pointer round-trips through active-agent.json and a missing or broken pointer reads as null", async () => {
  await withSandbox("active-pointer", async ({ store }) => {
    assert.equal(store.readActiveAgentId(), null, "a root with no pointer must read as null instead of throwing");
    assert.equal(
      store.activeAgentPointerPath(),
      path.join(store.getRootDir(), POINTER_FILENAME),
      "the pointer must live in the agents root",
    );

    const created = await store.createSession({ name: "Pointed", description: "" }, "user");
    created.db.close();
    store.writeActiveAgentId(created.id);

    assert.deepEqual(
      JSON.parse(await readFile(store.activeAgentPointerPath(), "utf8")),
      { activeAgentId: created.id },
      "the pointer must be written as the agent id the caller passed",
    );
    assert.equal(store.readActiveAgentId(), created.id, "the pointer must read back as the agent it names");
    assert.deepEqual(
      (await readdir(store.getRootDir())).filter((name) => name.endsWith(".tmp")),
      [],
      "the pointer must be renamed into place instead of leaving a temporary file behind",
    );

    await writeFile(store.activeAgentPointerPath(), "{not json", "utf8");
    assert.equal(store.readActiveAgentId(), null, "a damaged pointer must read as null instead of crashing the caller");
    await writeFile(store.activeAgentPointerPath(), JSON.stringify({ activeAgentId: "" }), "utf8");
    assert.equal(store.readActiveAgentId(), null, "a pointer with an empty agent id must read as null");
  });
});

test("deleting an agent removes its directory, drops it from the root listing and reports the removal once", async () => {
  await withSandbox("delete", async ({ root }) => {
    // NOTE on a platform hazard found while writing this: on Windows `deleteSession`
    // rejects with EBUSY while any `SandAgentDb` handle for that agent is still open
    // in this process, and `agentExists` then reports the half-deleted directory. The
    // product arguably should close the live handles itself, or retry the removal, so
    // that callers do not have to know which store handles the roster still holds.
    // The test therefore closes its own handles before deleting, and asserts the
    // removal semantics that hold on every platform.
    const removed = [];
    const store = new SandAgentSessionStore(undefined, undefined, { onAgentRemoved: (agentId) => removed.push(agentId) });
    assert.equal(store.getRootDir(), path.join(root, "agents"), "the store under test must be the one rooted in the sandbox");

    const keep = await store.createSession({ name: "Keep", description: "" }, "user");
    const drop = await store.createSession({ name: "Drop", description: "" }, "user");
    keep.db.close();
    drop.db.close();

    await store.deleteSession(drop.id);

    assert.deepEqual(removed, [drop.id], "a successful delete must report the agent as removed exactly once");
    assert.deepEqual(await store.listAgentIds(), [keep.id], "the deleted agent must disappear from the root listing");
    await assert.rejects(
      () => store.openSession(drop.id),
      /Agent missing/,
      "a deleted agent must no longer be openable",
    );
    await assert.rejects(
      readdir(path.join(store.getRootDir(), drop.id)),
      (error) => error.code === "ENOENT",
      "the whole agent directory must be gone, not only its pointer entry",
    );
    assert.deepEqual(store.getAgentProfileText(keep.id).name, "Keep", "deleting one agent must leave the other agent intact");
  });
});