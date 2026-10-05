import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Two switches in the sidebar created agents. `setAgentHiddenFromSidebar` and
// `setAgentNotificationsEnabled` went straight to `writeSandSettingsFile`, which
// runs `mkdirSync(dirname(path), { recursive: true })`, and neither of them asked
// whether the agent was on disk. Measured on a live box carrying forty-nine
// agents: one `POST /api/setAgentHiddenFromSidebar {"id":"<a fresh uuid>",
// "isHidden":true}` answered `200`, and `<root>\<uuid>\settings.json` was on disk
// afterwards -- a directory for an agent that had never been created and was not
// in `listAgents`, counted by the same directory walk that enforces the
// fifty-agent ceiling. The same call with `setAgentNotificationsEnabled` did the
// same thing. Nothing errored, no log line named the folder, and a later cap
// check had to reclaim it before it could create anything.
//
// `updateAgent` in the same class already refuses an id that is not on disk. The
// switch handlers are the same operation on the same id, so the guard belongs
// with them. The tests below fail against the old handlers and pass against these.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agent-switch-"));
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
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

const ABSENT_ID = "0d3f1c66-2a54-4c2b-9f1e-7a0b5c6d8e91";

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-switch-root-"));
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

function makeLifecycle(rootDir) {
  const sessionStore = new SandAgentSessionStore(rootDir);
  const emitted = [];
  const tm = {
    sessionStore,
    roster: {
      emitAgentUpdate: async (agentId) => { emitted.push(agentId); },
      emitProfileChanged: () => {},
      reserveSnapshotStamp: () => 1,
      finalizeSummaryForRpc: (summary) => summary,
    },
    sessions: { activeSession: undefined },
  };
  return { lifecycle: new AgentLifecycle(tm), sessionStore, emitted };
}

test("hiding an agent that is not on disk does not create one", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);
    assert.equal(existsSync(path.join(rootDir, ABSENT_ID)), false,
      "the test proves nothing unless the agent really is absent from disk");

    await assert.rejects(
      () => lifecycle.setAgentHiddenFromSidebar(ABSENT_ID, true),
      (error) => error instanceof Error && /no longer exists on disk/.test(error.message),
      "the switch reported success for an agent that is not on disk, so the caller closed a dialog that changed nothing",
    );

    assert.equal(existsSync(path.join(rootDir, ABSENT_ID)), false,
      "the switch wrote settings.json into a directory it created, so an agent that never existed now occupies a slot of the fifty-agent cap and appears in no roster");
    assert.deepEqual(agentDirectories(rootDir), [],
      "the agent directory count changed although no agent was created, which is the number the cap is computed from");
  } finally {
    dropRoot(base);
  }
});

test("the notification switch does not create an agent either", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);

    await assert.rejects(
      () => lifecycle.setAgentNotifyOnUpdates(ABSENT_ID, false),
      (error) => error instanceof Error && /no longer exists on disk/.test(error.message),
      "the notification switch reported success for an agent that is not on disk",
    );

    assert.equal(existsSync(path.join(rootDir, ABSENT_ID)), false,
      "the notification switch wrote settings.json into a directory it created, so an agent that never existed holds a cap slot");
    assert.deepEqual(agentDirectories(rootDir), [],
      "the agent directory count changed although no agent was created");
  } finally {
    dropRoot(base);
  }
});

test("the refusal names the agent and writes nothing", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, emitted } = makeLifecycle(rootDir);

    let failure = null;
    try {
      await lifecycle.setAgentHiddenFromSidebar(ABSENT_ID, true);
    } catch (error) {
      failure = error;
    }

    assert.notEqual(failure, null,
      "the switch reported success for an agent that is not on disk, so the caller closed a dialog that changed nothing");
    assert.match(String(failure?.message ?? ""), new RegExp(ABSENT_ID),
      "the refusal does not name the agent, so a caller holding several ids cannot tell which one is gone");
    assert.deepEqual(agentDirectories(rootDir), [],
      "a refused switch still left a directory behind");
    assert.deepEqual(emitted, [],
      "a refused switch announced an update for an agent that does not exist, so the roster was told about a ghost");
  } finally {
    dropRoot(base);
  }
});

test("both switches still work for an agent that is on disk", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle, sessionStore } = makeLifecycle(rootDir);
    const session = await sessionStore.createSession({ name: "Real", description: "" });
    const settingsPath = path.join(rootDir, session.id, "settings.json");

    await lifecycle.setAgentHiddenFromSidebar(session.id, true);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).hiddenFromSidebar, true,
      "hiding an agent that exists did not reach its settings file");

    await lifecycle.setAgentNotifyOnUpdates(session.id, false);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).notifyOnAgentUpdates, false,
      "the notification switch did not reach the settings file of an agent that exists");

    assert.deepEqual(agentDirectories(rootDir), [session.id],
      "operating on a real agent changed the number of directories on disk");
    await sessionStore.releaseSession(session.id);
  } finally {
    dropRoot(base);
  }
});

test("no agent-scoped write on the lifecycle creates a directory for an agent that is not on disk", async () => {
  const { base, rootDir } = makeRoot();
  try {
    const { lifecycle } = makeLifecycle(rootDir);
    const before = agentDirectories(rootDir);

    // Every public operation of this class that names an agent and writes
    // something about it. `updateAgent` is the control: it has refused an absent
    // id for a long time, and a regression in it must fail here too.
    const operations = [
      ["setAgentHiddenFromSidebar", (id) => lifecycle.setAgentHiddenFromSidebar(id, true)],
      ["setAgentNotifyOnUpdates", (id) => lifecycle.setAgentNotifyOnUpdates(id, true)],
      ["setAgentUnread", (id) => lifecycle.setAgentUnread(id, true)],
      ["updateAgent", (id) => lifecycle.updateAgent(id, { name: "Renamed" })],
      ["setAgentAvatarBytes", (id) => lifecycle.setAgentAvatarBytes(id, new Uint8Array([1, 2, 3]))],
      ["deleteAgent", (id) => lifecycle.deleteAgent(id)],
      ["deleteAgents", (ids) => lifecycle.deleteAgents(ids)],
      ["interruptAgentForDeletion", (id) => lifecycle.interruptAgentForDeletion(id)],
    ];

    const outcomes = [];
    for (const [name, run] of operations) {
      try {
        await run(name === "deleteAgents" ? [ABSENT_ID] : ABSENT_ID);
        outcomes.push([name, "resolved"]);
      } catch (error) {
        outcomes.push([name, error.name]);
      }
      assert.deepEqual(agentDirectories(rootDir), before,
        `${name} created or removed an agent directory for an id that is not on disk`);
    }

    assert.deepEqual(
      outcomes.map(([name]) => name),
      operations.map(([name]) => name),
      "the sweep did not run every operation it claims to, so the class is not closed",
    );
    assert.equal(
      outcomes.filter(([, outcome]) => outcome === "resolved").length,
      0,
      `an operation reported success for an agent that is not on disk: ${JSON.stringify(outcomes)}`,
    );
  } finally {
    dropRoot(base);
  }
});