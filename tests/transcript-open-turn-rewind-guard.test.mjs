import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// "durable agent steps moved backwards" killed a live run and took the subagent's
// output with it. `transcript-occurrence-deriver.ts:140-147` refused any active
// turn that reports fewer steps than the durable one, and a RESUMED turn does
// exactly that: `stream-attempt.ts:85` restarts the stream from the last accepted
// checkpoint while `production-turn-run-shell-adapter.ts:321` hands the retry no
// `resumeFrom` at all, so the retry rebuilds the turn from its base state and
// writes a shorter one. A legitimate resumption was reported as data loss, and
// because the throw escapes `prepareCheckpoint` it took the whole turn with it.
//
// The fix does not switch the check off. It keys it on the evidence the journal
// already keeps: an OPEN turn holds a `deferredStep` cursor for its trailing
// assistant step, which is precisely the proof that the tail was never written to
// the canonical transcript. Only then is a shorter step list a rewind. This file
// is the insurance the fix has to earn: every shape of real corruption below must
// still be refused, including the one that hides behind an open turn's cursor.
// Softening the check would bring back the class of breakage that made the box
// dead — every `prepareCheckpoint` throwing on a shared host took every agent
// down with it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-open-turn-guard-"));
  const source = relative => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { FileTranscriptMirror } from ${source(["host", "transcript-mirror", "transcript-mirror.ts"])};`,
    `export { createTranscriptOccurrenceDeriver } from ${source(["host", "transcript-mirror", "transcript-occurrence-deriver.ts"])};`,
    `export { createGeneratedTranscriptOccurrenceCodec } from ${source(["host", "transcript-mirror", "generated-occurrence-codec.ts"])};`,
    `export { AgentConversationTurnStructure, AssistantMessage, ConversationStep, ConversationTurnStructure, UserMessage } from ${source(["packages", "proto", "generated", "agent", "v1", "agent_pb.ts"])};`,
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
  FileTranscriptMirror,
  createTranscriptOccurrenceDeriver,
  createGeneratedTranscriptOccurrenceCodec,
  AgentConversationTurnStructure,
  AssistantMessage,
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
} = loaded;

test.after(() => dispose());

const CONVERSATION_ID = "cccccccc-0000-4000-8000-000000000003";

/** A real blob store: the deriver resolves every turn, step and user message
 *  through it, so a corruption case cannot be staged by faking a decode. */
function createJournal() {
  const blobs = new Map();
  const put = bytes => {
    const id = Buffer.from(bytes).toString("hex");
    blobs.set(id, Buffer.from(bytes));
    return new Uint8Array(Buffer.from(id, "hex"));
  };
  const store = { async getBlob(_context, id) { return blobs.get(Buffer.from(id).toString("hex")); } };
  const turn = (userText, stepTexts) => put(new ConversationTurnStructure({
    turn: {
      case: "agentConversationTurn",
      value: new AgentConversationTurnStructure({
        userMessage: put(new UserMessage({ text: userText }).toBinary()),
        steps: stepTexts.map(text => put(new ConversationStep({
          message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
        }).toBinary())),
      }),
    },
  }).toBinary());
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-open-turn-"));
  const mirror = new FileTranscriptMirror(transcriptsDir, () => {}, createTranscriptOccurrenceDeriver(
    createGeneratedTranscriptOccurrenceCodec({ ConversationTurnStructure, UserMessage, ConversationStep }),
  ));
  const persist = async (turns, finalize = false) => {
    await mirror.prepareCheckpoint(null, CONVERSATION_ID, { turns }, store, finalize);
    await mirror.commitCheckpoint(null, CONVERSATION_ID);
  };
  const deferredCursor = () => mirror.deferredSteps.get(CONVERSATION_ID);
  return { turn, persist, deferredCursor, transcriptsDir };
}

/** Grows ONE open turn one step at a time and leaves the journal holding a
 *  deferred cursor for the trailing one — the state a live run is in between two
 *  checkpoints of the same turn. `history` are the already finalised turns that
 *  stay in front of it. */
async function openTurnAt(journal, count, { history = [], prompt = "do the work" } = {}) {
  let turn;
  for (let index = 1; index <= count; index += 1) {
    turn = journal.turn(prompt, Array.from({ length: index }, (_unused, step) => `step-${step}`));
    await journal.persist([...history, turn], false);
  }
  return turn;
}

test("a FINALISED turn that loses steps is still refused", async () => {
  const journal = createJournal();
  try {
    const turns = [];
    turns.push(journal.turn("do the work", ["step-0", "step-1", "step-2", "step-3"]));
    await journal.persist(turns, true);
    assert.equal(
      journal.deferredCursor(),
      undefined,
      "a finalised turn holds no deferred cursor, so this test would be meaningless if one were left behind",
    );

    await assert.rejects(
      journal.persist([journal.turn("do the work", ["step-0", "step-1"])], false),
      /durable agent steps moved backwards/,
      "every step of a finalised turn is already in the canonical transcript, so a shorter list means the writer is not this conversation",
    );
  } finally {
    rmSync(journal.transcriptsDir, { recursive: true, force: true });
  }
});

test("an open turn's deferred cursor does not excuse a step that was already written", async () => {
  const journal = createJournal();
  try {
    await openTurnAt(journal, 4);
    assert.ok(
      journal.deferredCursor() != null,
      "without a held cursor this case proves nothing about what the fix lets through",
    );

    await assert.rejects(
      journal.persist([
        journal.turn("do the work", ["rewritten", "step-1", "step-2", "step-3"]),
      ], false),
      /durable agent step changed before the checkpoint tail/,
      "the rewind allowance is one specific shape — a shorter tail of an unfinished turn — and must not become a way to rewrite committed history",
    );
  } finally {
    rmSync(journal.transcriptsDir, { recursive: true, force: true });
  }
});

test("an open turn's deferred cursor does not excuse a replaced user message", async () => {
  const journal = createJournal();
  try {
    await openTurnAt(journal, 3);
    assert.ok(
      journal.deferredCursor() != null,
      "without a held cursor this case proves nothing about what the fix lets through",
    );

    await assert.rejects(
      journal.persist([journal.turn("a different prompt", ["step-0"])], false),
      /durable agent user message changed after checkpoint/,
      "the prompt a turn belongs to is what the transcript is built around; a cursor must not allow it to be swapped",
    );
  } finally {
    rmSync(journal.transcriptsDir, { recursive: true, force: true });
  }
});

test("an open turn's deferred cursor does not excuse whole turns disappearing", async () => {
  const journal = createJournal();
  try {
    const firstTurn = journal.turn("the first prompt", ["step-0"]);
    await journal.persist([firstTurn], true);
    const secondTurn = journal.turn("the second prompt", ["step-0"]);
    await journal.persist([firstTurn, secondTurn], true);
    await openTurnAt(journal, 3, { history: [firstTurn, secondTurn], prompt: "the open prompt" });
    assert.ok(
      journal.deferredCursor() != null,
      "without a held cursor this case proves nothing about what the fix lets through",
    );

    await assert.rejects(
      journal.persist([firstTurn], false),
      /durable conversation turns moved backwards/,
      "a dropped turn cannot be unwritten from the canonical transcript, so no open-turn allowance may cover it",
    );
  } finally {
    rmSync(journal.transcriptsDir, { recursive: true, force: true });
  }
});

test("the rewind itself is allowed and the conversation keeps working afterwards", async () => {
  const journal = createJournal();
  try {
    await openTurnAt(journal, 4);

    // The resumed attempt rebuilds the SAME turn with fewer steps.
    await journal.persist([journal.turn("do the work", ["step-0", "step-1"])], false);
    assert.equal(
      journal.deferredCursor(),
      undefined,
      "the rewind consumed the open-turn cursor, so the next shrink must be refused again rather than staying open forever",
    );

    await assert.rejects(
      journal.persist([journal.turn("do the work", ["step-0"])], false),
      /durable agent steps moved backwards/,
      "once the cursor is gone the shrink is corruption again, which is what keeps the allowance from becoming a standing exemption",
    );

    // And the conversation is not wedged by the refusal: a turn that keeps its
    // own shape still commits.
    await journal.persist([journal.turn("do the work", ["step-0", "step-1", "step-2"])], true);
  } finally {
    rmSync(journal.transcriptsDir, { recursive: true, force: true });
  }
});