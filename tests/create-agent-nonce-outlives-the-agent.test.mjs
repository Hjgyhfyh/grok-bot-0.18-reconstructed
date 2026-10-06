import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A create whose `clientNonce` had already been used answered with an agent that
// no longer existed.
//
// The nonce ledger exists for one reason: `gateway-client.ts` stamps a nonce onto
// `createAgent` and retries with the *same* nonce when the first attempt's answer
// was lost, so a retried create mints one agent and not two. That is a promise
// about one specific answer, and the ledger kept it forever.
//
// `createAgentMintsByNonce` maps a nonce to the settled promise of the agent that
// nonce minted, and nothing ever removed an entry. Deleting the agent that nonce
// minted did not touch the ledger, so the next create that carried it was handed
// the same promise and answered `200` with an id whose directory was gone, whose
// name was the old one, and which `listAgents` does not contain. The caller was
// told a new agent had been made; nothing was made.
//
// Measured on a live box, in that order:
//
//   POST /api/createAgent {"clientNonce":"qa-res-…","name":"QA-Nonce-Agent"}   200 agent-0b8c971f
//   POST /api/deleteAgent {"id":"agent-0b8c971f"}                              200 deleted:[agent-0b8c971f]
//   POST /api/createAgent {"clientNonce":"qa-res-…","name":"QA-Same-Nonce-Again"}
//        -> 200, id agent-0b8c971f, name "QA-Nonce-Agent",
//           countAgents unchanged, listAgents does not contain the id,
//           <root>\agents\agent-0b8c971f does not exist
//   POST /api/createAgent {"clientNonce":"qa-res-…-b","name":"QA-Fresh-Nonce"} 200, a new id, on disk
//
// The last line is the control: only the nonce differs, so only the ledger
// explains the difference. `createAgent` also makes the returned agent the active
// session, so the app lands on a conversation that has no directory.
//
// The fix does not weaken the dedupe — a repeated create while the agent is alive
// must still return the same agent — it retires a ledger entry when the agent it
// minted is deleted. Every test below fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-nonce-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
  ["host", "host-gateway-api.ts"],
]);
const { createHostGatewayApi, CREATE_AGENT_NONCE_LEDGER_CAP } = loaded["host-gateway-api.mjs"];

test.after(() => dispose());

/** The gateway surface over an in-memory roster, with the side effects recorded. */
function makeApi() {
  const onDisk = new Set();
  const mints = [];
  const deletes = [];
  let counter = 0;
  const transcript = {
    createAgent: async (profile) => {
      const id = `agent-${++counter}`;
      onDisk.add(id);
      mints.push({ id, name: profile?.name });
      return { agent: { id, name: profile?.name }, transcript: [] };
    },
    deleteAgent: async (id) => {
      if (!onDisk.has(id)) return { transcript: [], deleted: [], failed: [] };
      onDisk.delete(id);
      deletes.push(id);
      return { transcript: [], deleted: [id], failed: [] };
    },
    deleteAgents: async (ids) => {
      const deleted = ids.filter((id) => onDisk.delete(id));
      deletes.push(...deleted);
      return { transcript: [], deleted, failed: [] };
    },
  };
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "transcript") return transcript;
        if (id === "telemetry") return { analytics: { markActive: () => {}, trackEvent: () => {} }, logs: {} };
        if (id === "cross-user-sharing") return { noteAgentDeleted: async () => {} };
        if (id === "session") return { forgetHandoff: () => {} };
        if (id === "automations") return { deleteAgentSchedules: async () => {} };
        return {};
      },
    },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
  return { api, onDisk, mints, deletes };
}

test("a create retried with the same nonce still mints one agent", async () => {
  const { api, mints } = makeApi();

  const first = await api.createAgent({ clientNonce: "n1", name: "Acceptance Alpha" });
  const second = await api.createAgent({ clientNonce: "n1", name: "Acceptance Alpha" });

  assert.equal(second.agent.id, first.agent.id,
    "the idempotent retry stopped deduplicating, so a lost answer now mints two agents");
  assert.equal(mints.length, 1, "the retried create reached the store a second time");
});

test("a create whose nonce was retired by a delete mints a new agent", async () => {
  const { api, onDisk, mints } = makeApi();

  const first = await api.createAgent({ clientNonce: "n1", name: "QA-Nonce-Agent" });
  await api.deleteAgent({ id: first.agent.id });
  const second = await api.createAgent({ clientNonce: "n1", name: "QA-Same-Nonce-Again" });

  assert.notEqual(second.agent.id, first.agent.id,
    "the create answered with the agent that nonce minted before it was deleted, so a new agent was requested and a deleted one was returned");
  assert.equal(second.agent.name, "QA-Same-Nonce-Again",
    "the answer carried the profile of the agent that was deleted, so the caller cannot tell which request it got");
  assert.equal(onDisk.has(second.agent.id), true,
    "the agent the caller was handed is not the one that was created on disk");
  assert.equal(mints.length, 2, "the second create never reached the store, so nothing was made");
});

test("a nonce that has never been deleted keeps deduplicating for other callers", async () => {
  const { api, mints } = makeApi();

  await api.createAgent({ clientNonce: "alive", name: "Kept" });
  await api.deleteAgent({ id: "agent-never-created" });

  const again = await api.createAgent({ clientNonce: "alive", name: "Kept" });

  assert.equal(mints.length, 1,
    "deleting an unrelated id retired a nonce that still had a live agent behind it, so the dedupe was weakened for everyone");
  assert.equal(again.agent.name, "Kept", "the live agent's answer changed under a delete that named something else");
});

test("the batch delete retires the nonce of every agent it actually removed", async () => {
  const { api, onDisk } = makeApi();

  const kept = await api.createAgent({ clientNonce: "kept", name: "Kept" });
  const dropped = await api.createAgent({ clientNonce: "dropped", name: "Dropped" });
  await api.deleteAgents({ ids: [dropped.agent.id] });

  const afterDropped = await api.createAgent({ clientNonce: "dropped", name: "Dropped again" });
  const afterKept = await api.createAgent({ clientNonce: "kept", name: "Kept" });

  assert.notEqual(afterDropped.agent.id, dropped.agent.id,
    "deleteAgents never reached the nonce ledger, so the same nonce still answered with the agent it just removed");
  assert.equal(afterKept.agent.id, kept.agent.id,
    "a batch delete retired a nonce whose agent was still on disk");
  assert.equal(onDisk.has(dropped.agent.id), false, "the removed agent's directory came back");
});

test("the ledger stays bounded after the delete-driven retirement", async () => {
  const { api } = makeApi();

  for (let index = 0; index <= CREATE_AGENT_NONCE_LEDGER_CAP; index++) {
    const created = await api.createAgent({ clientNonce: `nonce-${index}`, name: `Agent ${index}` });
    await api.deleteAgent({ id: created.agent.id });
  }

  // One more than the cap, then the cap is allowed to forget the oldest entry. A
  // retirement map that grows past the ledger would be a slower leak of the same
  // kind, and nothing else in the host bounds it.
  const oldest = await api.createAgent({ clientNonce: "nonce-0", name: "Recreated" });
  assert.equal(oldest.agent.name, "Recreated",
    "a retired nonce is still answering with the agent it minted before the ledger forgot it");
});
