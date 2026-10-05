import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Deleting an agent deleted its folder and left its transcript behind. Measured
// on a live box: 49 agent directories under `<root>\agents` and 52 directories
// under `<root>\agent-transcripts`, thirteen of which no agent owned. Four of
// those thirteen were named `subagent-<uuid>`, and no agent in the box reported a
// single subagent. The reason is that a subagent conversation owns a journal
// directory of its own — the mirror names a journal directory after the
// conversation id, and a subagent conversation id is `subagent-<uuid>`, not an
// agent id — while `deleteSession` removed exactly one directory,
// `agent-transcripts/<agentId>`. Nothing else in the host ever removed a subagent
// journal, so every deleted agent left one directory per subagent it had ever
// run. The second half was quieter: when a journal survived, `removeTranscriptJournal`
// wrote one diagnostic line and returned, so a delete answered `200` and the
// caller could not tell a removed transcript from a kept one. Every test below
// fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-journal-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
  ["host", "extensions", "session", "agent-transcript-journal.ts"],
  ["host", "extensions", "session", "session-paths.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const {
  isSafeTranscriptJournalId,
  removeTranscriptJournals,
  transcriptJournalDirFor,
} = loaded["agent-transcript-journal.mjs"];
const { getSandTranscriptsDir } = loaded["session-paths.mjs"];
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

function makeStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-journal-store-"));
  const agentsRootDir = path.join(root, "agents");
  mkdirSync(agentsRootDir, { recursive: true });
  const writeJournal = (conversationId, fileName = `${conversationId}.jsonl`) => {
    const dir = transcriptJournalDirFor(agentsRootDir, conversationId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, fileName), "{}\n");
    writeFileSync(path.join(dir, `${conversationId}.journal-mode`), "1\n");
    return dir;
  };
  const writeAgent = (agentId) => {
    mkdirSync(path.join(agentsRootDir, agentId), { recursive: true });
    writeFileSync(path.join(agentsRootDir, agentId, "store.db"), "");
    return agentId;
  };
  return { root, agentsRootDir, writeJournal, writeAgent, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the delete removes the transcript journal of every conversation the agent owns", async () => {
  const store = makeStore();
  try {
    const agentId = store.writeAgent("11111111-1111-4111-8111-111111111111");
    const subagentIds = [
      "subagent-7c7b0330-f731-44e4-bcbd-82c2b42c11d6",
      "subagent-b460f60e-5589-42d9-a67e-8b9221d59504",
    ];
    for (const id of [agentId, ...subagentIds]) store.writeJournal(id);

    const outcome = await removeTranscriptJournals({
      agentsRootDir: store.agentsRootDir,
      conversationIds: [agentId, ...subagentIds],
    });

    assert.deepEqual(outcome.leftovers, [],
      "a subagent journal outlived the agent whose subagent it was, and nothing told the caller");
    assert.deepEqual(outcome.refused, [],
      "an id the transcript writer itself would have accepted was refused by the delete");
    for (const id of [agentId, ...subagentIds]) {
      const dir = transcriptJournalDirFor(store.agentsRootDir, id);
      assert.equal(exists(dir), false,
        `the journal directory of ${id} is still on disk after the delete that removed its agent`);
    }
  } finally {
    store.cleanup();
  }
});

test("the delete touches only the conversations it was given, so a live agent keeps its own journal", async () => {
  const store = makeStore();
  try {
    const deletedId = store.writeAgent("11111111-1111-4111-8111-111111111111");
    const liveId = store.writeAgent("22222222-2222-4222-8222-222222222222");
    // A subagent conversation has no agent directory of its own, so every
    // directory under `agent-transcripts` looks unowned to anything that matches
    // them against `agents\`. A sweep built on that match eats live journals.
    const liveSubagentId = "subagent-f2ee2b80-aed6-44f7-9d60-d5e89c697c5c";
    store.writeJournal(deletedId);
    store.writeJournal(liveId);
    store.writeJournal(liveSubagentId);

    await removeTranscriptJournals({
      agentsRootDir: store.agentsRootDir,
      conversationIds: [deletedId],
    });

    assert.equal(exists(transcriptJournalDirFor(store.agentsRootDir, deletedId)), false,
      "the deleted agent's own transcript journal was left behind");
    assert.equal(exists(transcriptJournalDirFor(store.agentsRootDir, liveId)), true,
      "the transcript of an agent that still exists was removed as collateral");
    assert.equal(exists(transcriptJournalDirFor(store.agentsRootDir, liveSubagentId)), true,
      "a live agent's subagent transcript was removed, and the agent silently lost part of its journal");
  } finally {
    store.cleanup();
  }
});

test("the journal directory the delete removes is the one the transcript writer creates", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  // The agents root the host builds is `<sand root>\agents`, and the writer
  // builds its paths from `<sand root>\agent-transcripts`. Both derivations have
  // to land on one directory, or "removed" and "written" are different places
  // and the delete silently removes nothing.
  const agentsRootDir = path.join(path.dirname(getSandTranscriptsDir()), "agents");
  const journalDir = transcriptJournalDirFor(agentsRootDir, id);
  assert.equal(path.dirname(journalDir), getSandTranscriptsDir(),
    "the delete puts a journal somewhere other than the transcripts directory the writer writes into");
  assert.equal(path.basename(journalDir), id,
    "the delete does not name the journal directory after the conversation the writer named it after");
  assert.equal(journalDir, path.join(getSandTranscriptsDir(), id),
    "the two derivations of one journal path disagree, so the delete removes nothing and the orphan stays");
});

test("a conversation id the writer could never create is refused by name, not silently skipped", () => {
  assert.equal(isSafeTranscriptJournalId(".."), false,
    "a relative segment reaches the recursive unlink and walks out of the transcript directory");
  assert.equal(isSafeTranscriptJournalId("."), false,
    "the transcript directory itself must never be handed to a recursive unlink");
  assert.equal(isSafeTranscriptJournalId("subagent-7c7b0330-f731-44e4-bcbd-82c2b42c11d6"), true,
    "a subagent conversation id is a real journal the writer creates, and the delete must accept it");
  assert.equal(isSafeTranscriptJournalId("agent/escape"), false,
    "a path separator turns one journal id into a directory the delete was never asked about");
});

test("a delete reports the transcript journal that survived instead of answering as if none was left", async () => {
  const calls = [];
  const deletes = new Set(["agent-a"]);
  const tm = createLifecycleHarness({ deletes, calls, transcriptLeftoversByAgent: { "agent-a": ["subagent-stuck"] } });
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);

  const result = await lifecycle.deleteAgents(["agent-a"]);

  assert.deepEqual(result.deleted, ["agent-a"],
    "the agent whose directory could be removed was not reported as deleted");
  assert.deepEqual(result.transcriptLeftovers, [{ agentId: "agent-a", conversationIds: ["subagent-stuck"] }],
    "a transcript journal survived the delete and the answer never said so, so the caller cannot tell a removed transcript from a kept one");
  assert.equal(calls.find(([name]) => name === "deleteSession")?.[2],
    undefined,
    "the delete passed the subagent ids it captured on to the store");
  assert.deepEqual(calls.find(([name]) => name === "deleteSession")?.[1], ["subagent-a"],
    "the subagent ids were not handed to the store, so their journals were never candidates for removal");
});

test("a delete whose journal all went reports no leftovers field at all", async () => {
  const deletes = new Set(["agent-b"]);
  const tm = createLifecycleHarness({ deletes, calls: [], transcriptLeftoversByAgent: {} });
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);

  const result = await lifecycle.deleteAgents(["agent-b"]);

  assert.equal("transcriptLeftovers" in result, false,
    "a clean delete grew a field its callers must now learn to ignore");
});

function createLifecycleHarness({ deletes, calls, transcriptLeftoversByAgent }) {
  const runnerSubagents = new Map([["agent-a", [{ subagentId: "subagent-a", subagentType: "general" }]]]);
  const tm = {
    sessions: {
      activeSession: undefined,
      tryEnsureSession: async () => null,
      liveSessions: new Map(),
      pendingSessionOpens: new Map(),
      deletedAgentIds: new Set(),
      inMemoryTranscriptAgentId: null,
      openSessionOnce: async () => { throw new Error("no successor"); },
    },
    sessionStore: {
      agentDirExists: (id) => deletes.has(id),
      deleteSession: async (id, options) => {
        calls.push(["deleteSession", options?.subagentIds ?? null]);
        deletes.delete(id);
        return { transcriptLeftovers: transcriptLeftoversByAgent[id] ?? [] };
      },
      releaseSession: async () => {},
      listAgents: async () => [],
      listAgentRecordIds: async () => [],
      markSessionViewed: async () => {},
      createFallbackSession: async () => { throw new Error("no fallback session is available"); },
    },
    trayErrors: { clearForAgent: () => {} },
    runnerRegistry: {
      runners: new Map([["agent-a", {
        listSubagents: () => runnerSubagents.get("agent-a"),
        interruptAll: () => true,
        cancelBackgroundShellRewatches: () => {},
        drainBackgroundSubagents: async () => {},
      }]]),
      activeGroupMemberRunners: new Map(),
    },
    onAgentForgotten: () => {},
    pendingWakeStore: { clearAgent: () => {} },
    boxHandoff: { boxHandoffs: new Map(), awaitingSink: new Map() },
    roster: {
      emitAsyncTasksForAgent: () => {},
      emitAgents: async () => {},
      forgetAgentSubagentWork: () => {},
      lastRunnerAsyncTasks: new Map(),
    },
    runLifecycle: {
      runningAgentIds: () => new Set(),
      drainExclusiveRuns: async () => {},
      closeSessionWhenIdle: () => {},
    },
    ackObligations: { markAckObligationLost: () => {}, ackRunTokens: new Map() },
    backgroundWakes: {
      pendingSubagentCompletions: new Map(),
      pendingShellCompletions: new Map(),
      pendingInbound: new Map(),
      pendingAgentInbound: new Map(),
      pendingChannelFailures: new Map(),
      dmPreemptedWakeAgentIds: new Map(),
    },
    groupChat: { dmPreemptedGroupMemberIds: new Map() },
    telemetry: { reportTurnInterrupt: () => {} },
  };
  return tm;
}

function exists(target) {
  return existsSync(target);
}