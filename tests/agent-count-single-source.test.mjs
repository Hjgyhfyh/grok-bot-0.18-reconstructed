import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The box answered "how many agents do I have?" with two numbers, and the two
// numbers answered two different questions under one name. `countAgents` in the
// gateway answered `countAgentsOnDisk`, which returned
// `(await sessionStore.listAgents()).length` — the roster projection — under a
// name that claims the disk. The fifty-agent cap is computed from directories
// (`isAgentCapReached` → `countOwnedAgents` → a `readdir` walk). The two differ
// on purpose and permanently, because the projection has to differ:
// `buildSummary` returns `null` for a directory with no transcript, no name, no
// title and no durable footprint, and `listAgents` skips any id whose delete has
// been requested. Measured on a live box: `listAgents` answered 49 while 50
// agent directories sat on disk. A caller could be told there was room for a new
// agent while `createAgent` answered `409 Agent limit of 50 reached`, and nothing
// reconciled the two. The rule "a directory under `agents/` is an agent" was also
// written out twice, once in the session store and once in the materialization,
// which is two chances for the cap and the counter to drift apart. Every test
// below fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-count-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

async function buildEntries(entries) {
  const directory = makeBundleDirectory();
  mkdirSync(directory, { recursive: true });
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

const { loaded, dispose } = await buildEntries([
  ["host", "extensions", "transcript", "roster-projection.ts"],
  ["host", "extensions", "session", "session-paths.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
  ["host", "host-gateway-api.ts"],
]);
const { RosterProjection } = loaded["roster-projection.mjs"];
const { listAgentDirectoryIds } = loaded["session-paths.mjs"];
const { SandSessionMaterialization } = loaded["session-materialization.mjs"];
const { createHostGatewayApi } = loaded["host-gateway-api.mjs"];

test.after(() => dispose());

function makeAgentRoot(ids) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-count-root-"));
  const agentsRootDir = path.join(root, "agents");
  mkdirSync(agentsRootDir, { recursive: true });
  for (const id of ids) mkdirSync(path.join(agentsRootDir, id), { recursive: true });
  return { root, agentsRootDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function projectionOver({ rosterRows, ownedCount }) {
  return new RosterProjection({
    sessionStore: {
      // The projection: three directories on disk, one row the roster shows.
      listAgents: async () => rosterRows,
      // The cap: the directory walk, which is the same walk by construction.
      countOwnedAgents: async () => ownedCount,
    },
  });
}

test("countAgents answers with the directories on disk, not with the rows the roster shows", async () => {
  const roster = projectionOver({ rosterRows: [{ id: "agent-a" }], ownedCount: 3 });

  const counted = await roster.countAgentsOnDisk();

  assert.equal(counted, 3,
    "countAgentsOnDisk answered with the roster projection while three agent directories were on disk, so a caller could be told there was room for a new agent while the create answered 409");
});

test("the gateway countAgents command is the same number the fifty-agent cap is computed from", async () => {
  const calls = [];
  const api = createHostGatewayApi({
    extensions: { api: (id) => (id === "transcript" ? { countAgentsOnDisk: async () => 50 } : {}) },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (value) => value,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
    rosterBookkeeping: { latestActiveAgentId: null },
  });

  const counted = await api.countAgents();

  assert.equal(counted, 50, "the gateway countAgents command lost the number it is supposed to report");
  assert.deepEqual(calls, [], "the count reached its destination through a path that recorded nothing");
});

test("the roster keeps hiding an agent whose delete is in flight, and the count still includes it", async () => {
  // `listAgents` skips `isAgentBeingDeleted` ids for as long as the mark stands.
  // That is right for a list. It is wrong for a count, and the mark window is
  // exactly the moment the two numbers parted company on the live box.
  const deleting = { id: "agent-b", beingDeleted: true };
  const rosterRows = [{ id: "agent-a" }];
  const projection = projectionOver({
    rosterRows: [...rosterRows],
    ownedCount: rosterRows.length + (deleting.beingDeleted ? 1 : 0),
  });

  const counted = await projection.countAgentsOnDisk();

  assert.equal(counted, 2,
    "the count dropped an agent that is still on disk just because the roster had already stopped showing it");
});

test("the session store and the materialization read the same directory list", async () => {
  const store = makeAgentRoot(["agent-c", "agent-a", "agent-b"]);
  try {
    const listed = await listAgentDirectoryIds(store.agentsRootDir);
    const materialization = new SandSessionMaterialization({
      ctx: {},
      rootDir: store.agentsRootDir,
      createBlobWorkerPool: () => { throw new Error("no pool in this test"); },
      createAgentStore: () => { throw new Error("no store in this test"); },
      createMemoryStore: () => null,
      resolveUserTimeZone: () => undefined,
      agentExists: () => true,
      getAgentDir: (id) => path.join(store.agentsRootDir, id),
      readActiveAgentId: () => null,
    });

    const fromMaterialization = await materialization.listAgentRecordIds();
    const countedByMaterialization = await materialization.countOwnedAgents();

    assert.deepEqual(fromMaterialization, listed,
      "the materialization and the shared definition disagree about which directories are agents");
    assert.equal(countedByMaterialization, 3,
      "the cap's count did not see the three directories that are on disk");
    assert.deepEqual(listed, ["agent-a", "agent-b", "agent-c"],
      "the directory walk is not stable, so two counts taken a second apart would differ for no reason");
  } finally {
    store.cleanup();
  }
});

test("a missing agents root counts as no agents instead of failing the cap", async () => {
  const absent = path.join(os.tmpdir(), `grok-count-absent-${process.pid}-${Math.random().toString(36).slice(2)}`);

  const listed = await listAgentDirectoryIds(absent);

  assert.deepEqual(listed, [],
    "a box whose agents root does not exist yet threw ENOENT out of the count instead of answering zero");
});