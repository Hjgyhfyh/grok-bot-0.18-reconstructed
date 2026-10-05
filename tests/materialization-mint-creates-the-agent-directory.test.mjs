import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A class that mints agents could not mint one. `SandAgentDb` stopped creating
// the agent directory as a side effect of being opened, because a late read of a
// deleted agent's `store.db` used to run `mkdirSync` and rebuild the agent with a
// fresh empty database inside a brand new directory, and that directory then held
// a slot of the fifty-agent cap that `listAgents` never showed. Creating became an
// explicit act, and the line that performs it went into a wrapper subclass in
// `production.ts` instead of into `SandSessionMaterialization` itself. Every host
// that builds a materialization by any other route kept the broken half: minting
// threw `SandAgentDirectoryMissingError`, and no agent was created. The wrapper's
// own comment asked for the line to move into the base class; until it does,
// "the production host creates agent directories" is a fact about one file, not
// about minting. The tests below fail against the class and pass against the fix.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-mint-dir-"));
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
  ["host", "extensions", "session", "session-materialization.ts"],
]);
const { SandSessionMaterialization } = loaded["session-materialization.mjs"];

test.after(() => dispose());

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-mint-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

function agentDirectories(rootDir) {
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function makeHost(rootDir, overrides = {}) {
  return {
    ctx: {},
    rootDir,
    createBlobWorkerPool: () => ({ closeAll: async () => {} }),
    createAgentStore: () => ({ getFullConversation: async () => null, dispose: async () => {} }),
    createMemoryStore: () => ({}),
    resolveUserTimeZone: () => undefined,
    agentExists: (agentId) => existsSync(path.join(rootDir, agentId, "store.db")),
    getAgentDir: (agentId) => path.join(rootDir, agentId),
    readActiveAgentId: () => null,
    report: () => {},
    ...overrides,
  };
}

test("minting an agent creates the directory, the store and the profile", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const materialization = new SandSessionMaterialization(makeHost(rootDir));

    const session = await materialization.createSession(
      { name: "Minted", description: "a minted agent" },
      "user",
    );

    assert.equal(agentDirectories(rootDir).length, 1,
      "minting an agent produced no directory, so the class that mints agents cannot mint one");
    assert.equal(session.id, agentDirectories(rootDir)[0],
      "the minted session and the directory on disk disagree about which agent was created");
    assert.equal(existsSync(path.join(rootDir, session.id, "store.db")), true,
      "the minted agent has no store.db, so every later read of it fails");
    assert.equal(existsSync(path.join(rootDir, session.id, "profile.json")), true,
      "the minted agent has no profile.json, so the roster shows it as an unnamed agent");
    session.db.close();
  } finally {
    dropRoot(base);
  }
});

test("a named agent keeps its name on disk, not the store's default", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const materialization = new SandSessionMaterialization(makeHost(rootDir));
    const session = await materialization.createSession(
      { name: "Accountant", description: "" },
      "user",
    );
    const profile = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(path.join(rootDir, session.id, "profile.json"), "utf8"),
      ),
    );
    assert.equal(profile.name, "Accountant",
      "the profile on disk does not carry the name the create was given");
    assert.notEqual(session.db.get("name"), "Accountant",
      "the store was left holding its own default name, which is what a resurrected agent looks like");
    session.db.close();
  } finally {
    dropRoot(base);
  }
});

test("materializing the same agent id twice reuses the directory it already made", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const materialization = new SandSessionMaterialization(makeHost(rootDir));
    const agentId = "55555555-5555-4555-8555-555555555555";
    const first = await materialization.materializeSession(agentId, { name: "First", description: "" }, "user");
    const directoriesAfterFirst = agentDirectories(rootDir);
    const second = await materialization.materializeSession(agentId, { name: "Second", description: "" }, "user");

    assert.deepEqual(agentDirectories(rootDir), directoriesAfterFirst,
      "materializing the same agent twice produced a second directory, so the cap counted one agent twice");
    assert.equal(directoriesAfterFirst.length, 1,
      "the first materialization did not produce exactly one directory, so the comparison above proves nothing");
    assert.equal(second.id, first.id, "the two materializations disagree about the agent id");
    first.db.close();
    second.db.close();
  } finally {
    dropRoot(base);
  }
});

test("a mint that fails leaves no directory behind once its store is released", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const reports = [];
    const materialization = new SandSessionMaterialization(makeHost(rootDir, { report: (event) => reports.push(event) }));

    let failure = null;
    try {
      await materialization.mintAgent(async (agentId) => {
        const session = await materialization.materializeSession(agentId, { name: "Doomed", description: "" }, "user");
        session.db.close();
        throw new Error("the caller refused the agent after it was written");
      });
    } catch (error) {
      failure = error;
    }

    assert.notEqual(failure, null, "a mint whose body throws reported success and handed back nothing");
    assert.equal(agentDirectories(rootDir).length, 0,
      "the failed mint left a directory behind, so it holds a slot of the fifty-agent cap for an agent nobody has");
    assert.deepEqual(reports, [],
      "the cleanup of a failed mint reported a problem, so the directory it could not remove is still there");
  } finally {
    dropRoot(base);
  }
});

test("a mint whose cleanup cannot remove the directory says so out loud", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const reports = [];
    const materialization = new SandSessionMaterialization(makeHost(rootDir, { report: (event) => reports.push(event) }));

    // The one shape that leaves a directory behind: the mint body still holds the
    // `store.db` handle when it fails. Windows refuses to unlink an open file, so
    // `runMint` removes `profile.json` and `settings.json`, keeps `store.db`, and
    // the next roster pass writes `profile.json` back from the store's own
    // seeded metadata -- which is how a deleted agent comes back as a visible
    // agent named "New Agent". Neither of the two mint callbacks in the tree does
    // this today, so the leak is a narrowing rather than a live path; what is
    // asserted here is that it is never silent. A cleanup that fails quietly
    // would leave exactly that folder with no record anywhere that it could not
    // be removed.
    await assert.rejects(
      () => materialization.mintAgent(async (agentId) => {
        await materialization.materializeSession(agentId, { name: "Doomed", description: "" }, "user");
        throw new Error("the caller refused the agent after it was written");
      }),
      /refused the agent/,
      "the mint reported success although its body threw, so the leftover directory was never cleaned",
    );

    const cleanup = reports.filter((event) => event.kind === "mint_cleanup_failed");
    assert.equal(cleanup.length, 1,
      "the mint could not remove the directory it had created and said nothing, so the folder stayed with no trace that anything had gone wrong");
    assert.equal(existsSync(path.join(rootDir, cleanup[0].agentId, "store.db")), true,
      "the leftover folder is not the one the diagnostic names, so the diagnostic points at the wrong agent");
    assert.equal(existsSync(path.join(rootDir, cleanup[0].agentId, "profile.json")), false,
      "the partial cleanup is gone from disk, so this test is not exercising the shape it claims to describe");
  } finally {
    dropRoot(base);
  }
});

test("no pass other than a mint creates a directory", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const absent = "77777777-7777-4777-8777-777777777777";
    const materialization = new SandSessionMaterialization(makeHost(rootDir));

    const passes = [
      ["openSession of an agent that is not on disk", () => materialization.openSession(absent)],
      ["listAgentRecordIds", () => materialization.listAgentRecordIds()],
      ["countOwnedAgents", () => materialization.countOwnedAgents()],
      ["isAgentCapReached", () => materialization.isAgentCapReached()],
      ["reclaimPrunedPlaceholders", () => materialization.reclaimPrunedPlaceholders()],
    ];

    const refused = [];
    for (const [name, run] of passes) {
      try {
        await run();
      } catch (error) {
        refused.push([name, error.name]);
      }
      assert.equal(existsSync(path.join(rootDir, absent)), false,
        `${name} created a directory for an agent that is not on disk`);
      assert.deepEqual(agentDirectories(rootDir), [],
        `${name} created a directory, so the cap counts an agent that does not exist`);
    }

    assert.deepEqual(refused.map(([name]) => name), ["openSession of an agent that is not on disk"],
      "every pass that reads the store refused the absent agent, which means one of them stopped checking and would have gone on to write");
    assert.equal(refused[0][1], "SandAgentMissingError",
      "the refusal is not the error that names the missing agent, so a caller cannot tell it from a corrupt store");
  } finally {
    dropRoot(base);
  }
});

test("reclaiming a placeholder removes a directory and never leaves one behind", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const materialization = new SandSessionMaterialization(makeHost(rootDir));
    const live = await materialization.createSession({ name: "Keeper", description: "kept" }, "user");
    const junk = "88888888-8888-4888-8888-888888888888";
    mkdirSync(path.join(rootDir, junk), { recursive: true });
    writeFileSync(path.join(rootDir, junk, "profile.json"), "{}");

    assert.equal(await materialization.isPrunedPlaceholder(junk), true,
      "a directory with no store.db is not recognised as a placeholder, so it holds its cap slot forever");
    await materialization.reclaimPrunedPlaceholders();

    assert.equal(existsSync(path.join(rootDir, junk)), false,
      "the placeholder directory survived the reclaim pass that exists to remove it");
    assert.equal(existsSync(path.join(rootDir, live.id)), true,
      "the reclaim pass removed a real agent instead of the placeholder");
    live.db.close();
  } finally {
    dropRoot(base);
  }
});