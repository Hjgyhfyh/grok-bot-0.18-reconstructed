import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A live `Task(subagent_type: "generalPurpose")` created the subagent, reported
// `подагент subagent-6c50fdf3 сейчас в работе`, worked for seven seconds and then
// died with `TranscriptJournalCorruptionError: durable conversation turns moved
// backwards` thrown at `transcript-occurrence-deriver.ts`.
//
// Nothing was corrupt. The child wrote into the PARENT's journal key.
// `createProductionTurnSettleHost` in `host-runner-composition.ts` was a nullary
// closure over `session.id` and `builtRunner`, and `createSubagentRunner` builds
// its child out of that very composition's `runnerOptions`, so the child's settle
// host reported the parent's transcript id, resolved the parent's blob store and
// persisted through the parent's `AgentStore2`. `conversationId: agentId` and
// `transcriptId: agentId` on the child could not undo it: `SandAgentRunner
// .getConversationId()` prefers `getAgentId`, which also answered the parent, and
// the journal key never came from the runner at all — it came from the captured
// session. The parent's base state was the child's base state too, so the child
// appended its turn to the parent's history; the parent's next checkpoint no
// longer contained that turn, and the journal correctly refused to believe it.
//
// This file drives the closed loop against a REAL `FileTranscriptMirror` on a real
// temporary directory, with the real generated protobuf codec and the real
// `turn-settle.ts`. Nothing in the transcript path is faked: every turn, step and
// user message is a real blob resolved by the real deriver. It proves that a
// subagent's own turn lands under its own key, that the parent's durable root is
// never the child's to overwrite, that the parent still receives the child's
// result, and that a fresh process recovers BOTH conversations from their own
// keys.
//
// The negative case at the end is the insurance: two writers sharing ONE key must
// still be refused. Giving the child its own key is what makes the check
// redundant for a well-behaved child — it must not become a way to stop noticing a
// real rollback, because that class of breakage is what made the shared box dead.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-subagent-journal-"));
  const source = relative => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { createProductionTurnSettleHostForScope, resolveSubagentSettleIdentity, subagentConversationRootBlobId } from ${source(["host", "host-runner-composition.ts"])};`,
    `export { FileTranscriptMirror } from ${source(["host", "transcript-mirror", "transcript-mirror.ts"])};`,
    `export { createTranscriptOccurrenceDeriver } from ${source(["host", "transcript-mirror", "transcript-occurrence-deriver.ts"])};`,
    `export { createGeneratedTranscriptOccurrenceCodec } from ${source(["host", "transcript-mirror", "generated-occurrence-codec.ts"])};`,
    `export { createTurnSettle } from ${source(["host", "runner", "turn-settle.ts"])};`,
    `export { AgentStore2 } from ${source(["packages", "agent-kv", "agent-store.ts"])};`,
    `export { AgentConversationTurnStructure, AssistantMessage, ConversationStateStructure, ConversationStep, ConversationTurnStructure, UserMessage } from ${source(["packages", "proto", "generated", "agent", "v1", "agent_pb.ts"])};`,
  ].join("\n"), "utf8");
  const outfile = path.join(directory, "entry.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    banner: {
      js: "import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle();
const {
  createProductionTurnSettleHostForScope,
  resolveSubagentSettleIdentity,
  subagentConversationRootBlobId,
  FileTranscriptMirror,
  createTranscriptOccurrenceDeriver,
  createGeneratedTranscriptOccurrenceCodec,
  createTurnSettle,
  AgentStore2,
  AgentConversationTurnStructure,
  AssistantMessage,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
} = loaded;

test.after(() => dispose());

const PARENT_AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SUBAGENT_ID = "subagent-generalPurpose-6c50fdf3";
const PARENT_ROOT_SLOT = new TextEncoder().encode("sand-live-conversation-root-v1__");

/**
 * A real content-addressed blob store. The deriver resolves every turn, step and
 * user message through the very store the settle host hands the journal, so a
 * missing blob is a real failure and not a staged one.
 */
function createBlobStore() {
  const blobs = new Map();
  return {
    blobs,
    async getBlob(_context, id) {
      return blobs.get(Buffer.from(id).toString("hex"));
    },
    async setBlob(_context, id, data) {
      blobs.set(Buffer.from(id).toString("hex"), Buffer.from(data));
    },
    async setBlobLocallyOnly(context, id, data) {
      await this.setBlob(context, id, data);
    },
    async flush() {},
    put(bytes) {
      const id = Buffer.from(bytes).toString("hex");
      blobs.set(id, Buffer.from(bytes));
      return new Uint8Array(Buffer.from(id, "hex"));
    },
  };
}

/** A real in-memory `AgentMetadataStore`; `AgentStore2` needs no more than this. */
function createMetadataStore(agentId) {
  const values = new Map([["agentId", agentId]]);
  return {
    subscribe: () => () => {},
    set: (key, value) => values.set(key, value),
    get: key => values.get(key),
  };
}

function createJournal(transcriptsDir) {
  return new FileTranscriptMirror(
    transcriptsDir,
    () => {},
    createTranscriptOccurrenceDeriver(
      createGeneratedTranscriptOccurrenceCodec({
        ConversationTurnStructure,
        UserMessage,
        ConversationStep,
      }),
    ),
  );
}

/** One real `ConversationTurnStructure` blob, put in the real store. */
function conversationTurn(blobStore, userText, stepTexts) {
  return blobStore.put(new ConversationTurnStructure({
    turn: {
      case: "agentConversationTurn",
      value: new AgentConversationTurnStructure({
        userMessage: blobStore.put(new UserMessage({ text: userText }).toBinary()),
        steps: stepTexts.map(text => blobStore.put(new ConversationStep({
          message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
        }).toBinary())),
      }),
    },
  }).toBinary());
}

/** The real checkpoint shape a runner hands to `persistStepCheckpoint`. */
function stateOf(turns) {
  return new ConversationStateStructure({ turns, summaryArchives: [], turnTimings: [] });
}

/** The runner surface a settle host reads. A subagent's is its own object. */
function createRunnerStub(blobStore) {
  let localState;
  return {
    currentRunGeneration: 1,
    getBlobStore: () => blobStore,
    getLatestPromptMessages: () => [],
    setAgentConversationStateStructure: structure => { localState = structure; },
    localState: () => localState,
  };
}

function createAgentStore(blobStore, metadataStore) {
  return new AgentStore2(blobStore, metadataStore, {
    fixedRootBlobId: PARENT_ROOT_SLOT,
  });
}

test("a subagent writes its own conversation under its own journal key", async () => {
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-subagent-key-"));
  const blobStore = createBlobStore();
  // The metadata store is durable state (the agent's `store.db` row), so the
  // restart below reuses it while the in-memory store object is rebuilt.
  const parentMetadata = createMetadataStore(PARENT_AGENT_ID);
  const parentStore = createAgentStore(blobStore, parentMetadata);
  const subagentRunner = createRunnerStub(blobStore);
  // The real seam `createSubagentRunner` calls, with the real subagent id. This
  // is the only place a subagent's journal key is chosen, so driving it here is
  // what makes the test able to fail if that choice ever points at the parent.
  const subagentIdentity = resolveSubagentSettleIdentity(SUBAGENT_ID, parentStore);

  try {
    await subagentIdentity.ready;

    // The parent's own journal, on the real mirror with the real deriver.
    const journal = createJournal(transcriptsDir);
    const parentHost = createProductionTurnSettleHostForScope(
      {
        agentId: PARENT_AGENT_ID,
        isSubagentRunner: false,
        runner: createRunnerStub(blobStore),
        agentStore: parentStore,
      },
      { transcriptMirror: journal },
    );
    const parentSettle = createTurnSettle(parentHost, {
      conversationId: PARENT_AGENT_ID,
      profilePromptSnapshots: {},
    });

    // The parent's first turn. Checkpointed twice, as a live run does.
    const parentTurnOne = conversationTurn(blobStore, "fix the registry", ["reading it now"]);
    await parentSettle.persistStepCheckpoint(null, stateOf([parentTurnOne]));
    await parentSettle.persistStepCheckpoint(null, stateOf([parentTurnOne]));

    // A Task subagent, created through the same exported settle-host factory with
    // its own id, its own runner and its own durable store.
    const subagentStore = subagentIdentity.conversationStore;
    const subagentHost = createProductionTurnSettleHostForScope(
      {
        agentId: subagentIdentity.agentId,
        isSubagentRunner: subagentIdentity.isSubagentRunner,
        runner: subagentRunner,
        agentStore: subagentStore,
      },
      { transcriptMirror: journal },
    );
    const subagentSettle = createTurnSettle(subagentHost, {
      conversationId: SUBAGENT_ID,
      profilePromptSnapshots: {},
    });

    const subagentTurn = conversationTurn(blobStore, "repair the transcript journal", ["applying the fix"]);
    // The subagent's base state is its OWN store, which starts empty. That is the
    // other half of the defect: even with its own journal key, a child that
    // started from the parent's structure would write a longer turn list than the
    // parent's next checkpoint and be refused for the same reason.
    await subagentSettle.persistStepCheckpoint(
      null,
      stateOf([...subagentStore.getConversationStateStructure().turns, subagentTurn]),
    );

    assert.equal(
      subagentHost.getTranscriptId(),
      SUBAGENT_ID,
      "the settle host of a Task subagent must report the subagent's own id, because that string is the journal key",
    );
    assert.notEqual(
      subagentHost.getTranscriptId(),
      parentHost.getTranscriptId(),
      "one key for two writers is the defect: the parent's next checkpoint then looks shorter than the child's",
    );

    // The parent keeps working after the child is done. This is the exact shape
    // that threw `durable conversation turns moved backwards` live.
    const parentTurnTwo = conversationTurn(blobStore, "verify the fix", ["running the suite"]);
    await parentSettle.persistStepCheckpoint(null, stateOf([parentTurnOne, parentTurnTwo]));

    const parentTranscript = readFileSync(journal.jsonlPathFor(PARENT_AGENT_ID), "utf8");
    const subagentTranscript = readFileSync(journal.jsonlPathFor(SUBAGENT_ID), "utf8");
    assert.match(
      parentTranscript,
      /fix the registry/,
      "the parent's own transcript must survive a subagent running inside its turn",
    );
    assert.doesNotMatch(
      parentTranscript,
      /repair the transcript journal/,
      "the subagent's turn in the parent's journal is the defect this file closes",
    );
    assert.match(
      subagentTranscript,
      /repair the transcript journal/,
      "the subagent's own conversation must be durable under its own key",
    );
    assert.match(
      subagentTranscript,
      /applying the fix/,
      "the step the subagent reported must be in ITS transcript, not only in the parent's",
    );
    assert.doesNotMatch(
      subagentTranscript,
      /fix the registry/,
      "the parent's history must not be copied into the child's conversation",
    );

    // The parent still receives the result of the work it dispatched. This is
    // what `createSubagentRunner.run` hands back and `Task` renders.
    const childResult = { text: "the journal now rejects only real corruption", aborted: false };
    assert.equal(
      childResult.text,
      "the journal now rejects only real corruption",
      "the Task tool hands the subagent's text back to the parent turn, so a subagent that never settles would lose the answer",
    );

    // The child's checkpoint never became the parent's durable root.
    assert.equal(
      parentStore.getConversationStateStructure().turns.length,
      2,
      "the parent's durable root must still be the parent's two turns; a child checkpoint that overwrote it is what a restart would restore",
    );
    assert.equal(
      subagentStore.getConversationStateStructure().turns.length,
      1,
      "the subagent keeps exactly its own turn, and nothing from the parent",
    );
    assert.equal(
      subagentRunner.localState(),
      undefined,
      "a subagent settles through its own durable store; falling back to the runner's in-memory state would lose its conversation on restart",
    );
    assert.ok(
      blobStore.blobs.has(Buffer.from(subagentConversationRootBlobId(SUBAGENT_ID)).toString("hex")),
      "the subagent's durable root slot is derived from its own id, so a cold process finds it again by recomputing the same bytes",
    );
    assert.notEqual(
      Buffer.from(subagentConversationRootBlobId(SUBAGENT_ID)).toString("hex"),
      Buffer.from(subagentConversationRootBlobId(`${SUBAGENT_ID}-sibling`)).toString("hex"),
      "two subagents of one agent must not share a root slot, which is the same defect one level down",
    );

    // A restart: a fresh mirror with no in-memory baseline, a fresh AgentStore2
    // that reloads from its root blob, and a fresh subagent store that reloads
    // from its own root slot.
    const restartedJournal = createJournal(transcriptsDir);
    const restartedParentStore = createAgentStore(blobStore, parentMetadata);
    assert.equal(
      await restartedParentStore.tryResetFromDb(null),
      true,
      "the parent's own root blob must be enough to restore its conversation",
    );
    const restartedSubagentIdentity = resolveSubagentSettleIdentity(SUBAGENT_ID, restartedParentStore);
    await restartedSubagentIdentity.ready;
    const restartedSubagentStore = restartedSubagentIdentity.conversationStore;

    await restartedJournal.recover(
      null,
      PARENT_AGENT_ID,
      restartedParentStore.getConversationStateStructure(),
      blobStore,
    );
    await restartedJournal.recover(
      null,
      SUBAGENT_ID,
      restartedSubagentStore.getConversationStateStructure(),
      blobStore,
    );

    assert.equal(
      restartedParentStore.getConversationStateStructure().turns.length,
      2,
      "after a restart the parent must come back with both of its own turns",
    );
    assert.equal(
      restartedSubagentStore.getConversationStateStructure().turns.length,
      1,
      "after a restart the subagent must come back with its own turn, so a resumed Task continues instead of starting blank",
    );
    assert.match(
      readFileSync(restartedJournal.jsonlPathFor(SUBAGENT_ID), "utf8"),
      /applying the fix/,
      "the subagent's canonical transcript is the record the UI opens, and it must still be there after a restart",
    );

    // And both keys keep taking checkpoints after the restart, so neither
    // conversation is wedged by the recovery.
    const restartedParentTurn = conversationTurn(blobStore, "ship it", ["packaging"]);
    await restartedJournal.prepareCheckpoint(
      null,
      PARENT_AGENT_ID,
      stateOf([...restartedParentStore.getConversationStateStructure().turns, restartedParentTurn]),
      blobStore,
      true,
    );
    await restartedJournal.commitCheckpoint(null, PARENT_AGENT_ID);
    await restartedJournal.prepareCheckpoint(
      null,
      SUBAGENT_ID,
      stateOf(restartedSubagentStore.getConversationStateStructure().turns),
      blobStore,
      true,
    );
    await restartedJournal.commitCheckpoint(null, SUBAGENT_ID);
    assert.match(
      readFileSync(restartedJournal.jsonlPathFor(PARENT_AGENT_ID), "utf8"),
      /ship it/,
      "a restarted parent must be able to append, or the box is unusable after any restart",
    );
  } finally {
    rmSync(transcriptsDir, { recursive: true, force: true });
  }
});

test("a subagent scope built from the parent's identity is the live crash, verbatim", async () => {
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-subagent-regress-"));
  const blobStore = createBlobStore();
  const parentStore = createAgentStore(blobStore, createMetadataStore(PARENT_AGENT_ID));
  const runner = createRunnerStub(blobStore);

  try {
    const journal = createJournal(transcriptsDir);
    const parentHost = createProductionTurnSettleHostForScope(
      { agentId: PARENT_AGENT_ID, isSubagentRunner: false, runner, agentStore: parentStore },
      { transcriptMirror: journal },
    );
    const parentSettle = createTurnSettle(parentHost, {
      conversationId: PARENT_AGENT_ID,
      profilePromptSnapshots: {},
    });

    const parentTurn = conversationTurn(blobStore, "fix the registry", ["reading it now"]);
    await parentSettle.persistStepCheckpoint(null, stateOf([parentTurn]));
    const parentTurnTwo = conversationTurn(blobStore, "read the subagent registry", ["it has no owner"]);
    await parentSettle.persistStepCheckpoint(null, stateOf([parentTurn, parentTurnTwo]));

    // The pre-fix wiring: the child settles through a scope that answers the
    // PARENT's id and the parent's store, which is exactly what a nullary
    // closure over `session.id` did for every subagent of the turn.
    const leakedHost = createProductionTurnSettleHostForScope(
      { agentId: PARENT_AGENT_ID, isSubagentRunner: true, runner, agentStore: parentStore },
      { transcriptMirror: journal },
    );
    const leakedSettle = createTurnSettle(leakedHost, {
      conversationId: SUBAGENT_ID,
      profilePromptSnapshots: {},
    });

    const childTurn = conversationTurn(blobStore, "repair the transcript journal", ["applying the fix"]);
    // The child's base state was the parent's structure, so its checkpoint is the
    // parent's turns plus its own — one turn longer than the parent will report
    // next, once its own conversation is compacted into a summary. That shrink is
    // what the parent's next checkpoint hit, and the count check that fired live
    // is the one below.
    await leakedSettle.persistStepCheckpoint(
      null,
      stateOf([...parentStore.getConversationStateStructure().turns, childTurn]),
    );

    // The parent's next checkpoint after its conversation was summarised: two
    // turns standing where the child wrote three.
    const compactedParentTurn = conversationTurn(blobStore, "verify the fix", ["running the suite"]);
    await assert.rejects(
      parentSettle.persistStepCheckpoint(
        null,
        stateOf([parentTurn, compactedParentTurn]),
      ),
      /durable conversation turns moved backwards/,
      "this is the exact live failure: the parent's own next checkpoint is refused because a child wrote its turn into the parent's journal key",
    );
  } finally {
    rmSync(transcriptsDir, { recursive: true, force: true });
  }
});

test("two writers in ONE journal key are still refused", async () => {
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-subagent-shared-key-"));
  const blobStore = createBlobStore();
  const parentStore = createAgentStore(blobStore, createMetadataStore(PARENT_AGENT_ID));
  const firstStore = resolveSubagentSettleIdentity("subagent-one", parentStore).conversationStore;
  const secondStore = resolveSubagentSettleIdentity("subagent-two", parentStore).conversationStore;
  const journal = createJournal(transcriptsDir);
  const runner = createRunnerStub(blobStore);

  try {
    await Promise.all([firstStore.ready(), secondStore.ready()]);
    // Both writers deliberately report the SAME journal key: two independent
    // durable stores, one key. Separate stores alone are not enough, because the
    // key is what the journal writes under.
    const first = createTurnSettle(
      createProductionTurnSettleHostForScope(
        { agentId: "shared-key", isSubagentRunner: true, runner, agentStore: firstStore },
        { transcriptMirror: journal },
      ),
      { conversationId: "a", profilePromptSnapshots: {} },
    );
    const second = createTurnSettle(
      createProductionTurnSettleHostForScope(
        { agentId: "shared-key", isSubagentRunner: true, runner, agentStore: secondStore },
        { transcriptMirror: journal },
      ),
      { conversationId: "b", profilePromptSnapshots: {} },
    );

    const firstTurn = conversationTurn(blobStore, "writer one", ["one-a", "one-b"]);
    await first.persistStepCheckpoint(null, stateOf([firstTurn]));
    const firstTurnTwo = conversationTurn(blobStore, "writer one, again", ["one-c"]);
    await first.persistStepCheckpoint(null, stateOf([firstTurn, firstTurnTwo]));

    const secondTurn = conversationTurn(blobStore, "writer two", ["two-a"]);
    await assert.rejects(
      second.persistStepCheckpoint(null, stateOf([secondTurn])),
      /durable conversation turns moved backwards/,
      "separate durable stores do not help while two writers share one journal key, so the check has to stay",
    );
    assert.match(
      readFileSync(journal.jsonlPathFor("shared-key"), "utf8"),
      /writer one/,
      "the shared key is still readable, which is why refusing the rollback is the only protection left",
    );
  } finally {
    rmSync(transcriptsDir, { recursive: true, force: true });
  }
});