import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The fifty-agent cap had no test on the boundary itself.
//
// Every cap test in this repository checks a property — invisible directories do
// not hold a slot, a leftover directory is reclaimed, the counter and the roster
// are one walk. None of them asks what happens at exactly forty-nine, exactly
// fifty, or fifty-one, which is the only thing the number in the message is for.
// The cap lives in two files that were written separately: `shared/agents/agents.ts`
// exports `MAX_AGENTS_PER_USER = 50` and a `SandAgentLimitError` whose message is
// `"50 is the maximum"`, and `extensions/session/session-materialization.ts`
// exports its own `MAX_AGENTS_PER_USER = 50` and its own `SandAgentLimitError`
// whose message is `"Agent limit of 50 reached"`. Only the second one is ever
// thrown. `isSandAgentLimitError` compares the message against the first, so the
// two `catch` sites that exist to recognise a cap refusal —
// `agent-lifecycle.ts` after `createFallbackSession` and `session-runtime.ts`
// after `tryEnsureSession` — never match the error the store raises, and both are
// unreachable code dressed as a guard. The `409` still happens, because
// `statusForCommandError` matches the class NAME, which both classes set.
//
// The numbers below are the ones a caller sees. They are read off the real store
// over a real directory walk, not off a stub.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-cap-edge-"));
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
  ["host", "gateway-server.ts"],
  ["shared", "agents", "agents.ts"],
  ["host", "extensions", "session", "agent-db.ts"],
  ["host", "extensions", "session", "agent-session.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const { statusForCommandError } = loaded["gateway-server.mjs"];
const shared = loaded["agents.mjs"];
const { ensureAgentDbDirectory } = loaded["agent-db.mjs"];
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { SandSessionMaterialization, MAX_AGENTS_PER_USER, SandAgentLimitError } = loaded["session-materialization.mjs"];
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

/** The production host mints through this subclass; the cap has to see it too. */
class ExplicitDirectoryMaterialization extends SandSessionMaterialization {
  async materializeSession(agentId, profile, origin, purpose) {
    ensureAgentDbDirectory(path.join(this.host.rootDir, agentId, "store.db"));
    return await super.materializeSession(agentId, profile, origin, purpose);
  }
}

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-cap-edge-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

function dropRoot(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

function makeStore(rootDir) {
  const store = new SandAgentSessionStore(rootDir);
  store.materialization = new ExplicitDirectoryMaterialization({
    ctx: {},
    rootDir,
    createBlobWorkerPool: () => ({ connections: new Map() }),
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

async function createNamedAgent(store, name) {
  const session = await store.createSession({ name, description: "" });
  await store.releaseSession(session.id);
  return session.id;
}

test("the cap is fifty: forty-nine leaves room, fifty does not, and the refusal is a 409", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    for (let index = 0; index < MAX_AGENTS_PER_USER - 1; index++)
      await createNamedAgent(store, `Live ${index}`);

    assert.equal(await store.isAgentCapReached(), false,
      "forty-nine directories were refused, so the cap is not the fifty the message claims");
    assert.equal((await store.listAgentIds()).length, 49,
      "the walk the cap is computed from does not see the forty-nine agents that were created");

    const fiftieth = await createNamedAgent(store, "The fiftieth");
    assert.equal(existsSync(path.join(rootDir, fiftieth)), true,
      "the fiftieth agent was not minted, so the rest of this test measures nothing");

    let refusal = null;
    try {
      await createNamedAgent(store, "The fifty-first");
    } catch (error) {
      refusal = error;
    }
    assert.notEqual(refusal, null, "the fifty-first agent was created, so the cap is not a cap");
    assert.equal(statusForCommandError(refusal), 409,
      "a cap refusal is not a conflict, so a client cannot tell it from a crash and keeps retrying");
    assert.equal((await store.listAgentIds()).length, MAX_AGENTS_PER_USER,
      "the refused create left a directory behind, so it took a slot while answering that it did not");
    assert.equal(refusal.name, "SandAgentLimitError",
      "the refusal is not the class the status mapping recognises");
  } finally {
    dropRoot(base);
  }
});

test("one delete frees exactly one slot", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    const ids = [];
    for (let index = 0; index < MAX_AGENTS_PER_USER; index++)
      ids.push(await createNamedAgent(store, `Live ${index}`));
    await assert.rejects(() => createNamedAgent(store, "Over the line"),
      "the harness never reached the cap, so freeing a slot proves nothing");

    await store.deleteSession(ids[0]);

    const replacement = await createNamedAgent(store, "Fits now");
    assert.equal(existsSync(path.join(rootDir, replacement)), true,
      "a slot was free and the create still refused, so the cap never noticed the delete");
    assert.equal((await store.listAgentIds()).length, MAX_AGENTS_PER_USER,
      "the delete freed a slot and the create took it back, so the count is not what the cap reads");
  } finally {
    dropRoot(base);
  }
});

test("a duplicate at the cap is refused the same way a create is", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const store = makeStore(rootDir);
    const ids = [];
    for (let index = 0; index < MAX_AGENTS_PER_USER; index++)
      ids.push(await createNamedAgent(store, `Live ${index}`));

    // `cloneAgent` reaches the same `mintAgent` the create does, so the cap has
    // to hold on that path too — a duplicate button is the one control a user
    // presses without thinking about how many agents they already have.
    const tm = {
      sessionStore: {
        listAgents: async () => [{ id: ids[0], name: "Live 0", isGroup: false }],
        mintAgent: (mint) => store.materialization.mintAgent(mint),
        getAgentDir: (agentId) => store.getAgentDir(agentId),
      },
    };
    const lifecycle = new AgentLifecycle(tm);

    let refusal = null;
    try {
      await lifecycle.cloneAgent(ids[0]);
    } catch (error) {
      refusal = error;
    }
    assert.notEqual(refusal, null, "the duplicate was minted at the cap, so the cap is not held on that path");
    assert.equal(statusForCommandError(refusal), 409,
      "the duplicate's cap refusal is not the conflict every other cap refusal is");
    assert.equal((await store.listAgentIds()).length, MAX_AGENTS_PER_USER,
      "the refused duplicate left a directory behind");
  } finally {
    dropRoot(base);
  }
});

test("the class the cap refusal is recognised by is not the one the store raises", async () => {
  // Not a status defect: `statusForCommandError` reads the class NAME, which both
  // classes set, so the caller still gets 409. It is a guard that never fires.
  // `agent-lifecycle.ts` catches `isSandAgentLimitError(error)` after
  // `createFallbackSession` so that deleting the last agent at the cap lands on
  // an empty transcript instead of an error, and `session-runtime.ts` catches it
  // after `tryEnsureSession` for the same reason. Neither branch can be taken,
  // because the predicate matches a message the store never produces.
  const raised = new SandAgentLimitError();

  assert.equal(raised.message, "Agent limit of 50 reached",
    "the store stopped raising the sentence this test pins the other predicate to");
  assert.equal(shared.isSandAgentLimitError(raised), false,
    "the predicate the two cap guards use does not recognise the error the store actually raises, so both guards are unreachable code");
  assert.equal(statusForCommandError(raised), 409,
    "the status does not depend on the predicate, which is why nobody noticed the guard is dead");
  assert.equal(shared.isSandAgentLimitError(new shared.SandAgentLimitError()), true,
    "the predicate still matches its own class, so a reader cannot tell from the predicate alone that it is the wrong one");
});
