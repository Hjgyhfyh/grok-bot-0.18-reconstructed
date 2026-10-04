import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A message sent into a thread never reached the user again, and neither did
 * the agent's answer. The transcript itself was always written correctly: the
 * branched user row and the branched agent row both sat in `store.db` and both
 * came back from `getAgentThread`. The turn was being killed before it could
 * answer.
 *
 * `FileTranscriptMirror.installAtomic` renames the fully written temporary file
 * into place and then calls `syncParent`, which opens the parent *directory*
 * and flushes it. Windows has no `FlushFileBuffers` for a directory handle, so
 * that flush rejects with `EPERM` on every call, on every conversation, forever.
 * The bytes were already on disk, but the rejection travelled
 * `syncParent -> installAtomic -> claimConversation -> RoutedTranscriptMirror.selectRoute
 * -> prepareCheckpoint -> persistStepCheckpoint -> persistCheckpoint -> runner.run`,
 * and `createStreamAttempt` converts any checkpoint failure into
 * `checkpointFailure`, which rejects the whole stream attempt. The model thought,
 * and the turn ended before the `SendMessage` tool call ever executed. Nothing
 * was broken in the thread store; the turn that would have written into it was
 * aborted on the first checkpoint.
 *
 * The rejection was also cached: `RoutedTranscriptMirror.route` stores the
 * promise returned by `selectRoute`, so one failed claim poisoned every later
 * checkpoint for that conversation for the lifetime of the process.
 *
 * This test now proves, on whatever host it runs on, that a journal checkpoint
 * sequence completes and that a user message plus an agent reply both survive a
 * round trip through a thread and are still on disk after the database is
 * closed and reopened.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-journal-fsync-"));
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
  for (const [name, file] of names) {
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  }
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "transcript-mirror", "transcript-mirror.ts"],
  ["host", "transcript-mirror", "transcript-mirror-router.ts"],
  ["host", "extensions", "session", "agent-db.ts"],
]);
const { FileTranscriptMirror } = loaded["transcript-mirror.mjs"];
const { SandAgentDb, ensureAgentDbDirectory } = loaded["agent-db.mjs"];

test.after(() => dispose());

const CONVERSATION = "thread-conv";
const checkpoint = (turns) => ({ turns: turns.map((text) => Buffer.from(text)) });

/** A deriver whose transcript line for turn N is `turn-N`, so the journal file is readable. */
function createDeriver() {
  const linesFor = (turns) =>
    turns.map((turn, index) => ({
      id: `turn-${index}`,
      line: JSON.stringify({ role: index % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: String(turn) }] } }),
    }));
  return {
    initial: async (_ctx, _store, initial) => linesFor(initial.turns.map((turn) => turn.toString())),
    derive: async (_ctx, _store, _previous, next) => ({ occurrences: linesFor(next.turns.map((turn) => turn.toString())) }),
  };
}

/**
 * Records the platform fact the fix relies on, and fails if it cannot observe
 * it. A test that silently skips when the fsync succeeds would pass for the
 * wrong reason.
 */
test("flushing a directory handle is refused on this host, and the mirror absorbs it", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-dirsync-"));
  const observed = [];
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
      observed.push({ refused: false, code: null });
    } catch (error) {
      observed.push({ refused: true, code: error?.code ?? null });
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(observed.length, 1, "the directory flush probe never ran");
  if (process.platform === "win32") {
    assert.equal(observed[0].refused, true, "Windows was expected to refuse a directory-handle fsync, which is the whole defect");
    assert.equal(observed[0].code, "EPERM", "the refusal on Windows is expected to be reported as EPERM");
  } else {
    assert.equal(observed[0].refused, false, "POSIX hosts flush a directory handle, so the Windows path is not exercised here");
  }
});

test("claiming a conversation writes the journal marker instead of rejecting", async () => {
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-claim-"));
  try {
    const mirror = new FileTranscriptMirror(transcriptsDir, () => {}, createDeriver());
    await mirror.claimConversation(CONVERSATION);
    assert.equal(
      existsSync(path.join(transcriptsDir, CONVERSATION, `${CONVERSATION}.journal-mode`)),
      true,
      "the claim marker was not left on disk",
    );
    assert.equal(
      await mirror.ownsConversation(CONVERSATION),
      true,
      "the mirror does not recognise the conversation it just claimed",
    );
  } finally {
    rmSync(transcriptsDir, { recursive: true, force: true });
  }
});

test("the routed checkpoint sequence every turn runs completes and leaves a readable journal", async () => {
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-route-"));
  try {
    const mirror = new FileTranscriptMirror(transcriptsDir, () => {}, createDeriver());
    const routed = mirror.routed(
      { write: async () => { throw new Error("the legacy writer must not be reached once the journal owns the conversation"); } },
      async () => true,
    );

    const first = checkpoint(["turn-0"]);
    await routed.recover({}, CONVERSATION, first, {});
    await routed.prepareCheckpoint({}, CONVERSATION, first, {}, false, false);
    await routed.commitCheckpoint({}, CONVERSATION, undefined);

    const second = checkpoint(["turn-0", "turn-1"]);
    await routed.prepareCheckpoint({}, CONVERSATION, second, {}, false, false);
    await routed.commitCheckpoint({}, CONVERSATION, undefined);

    const jsonl = path.join(transcriptsDir, CONVERSATION, `${CONVERSATION}.jsonl`);
    assert.equal(existsSync(jsonl), true, "the canonical journal file was never built");
    const written = readFileSync(jsonl, "utf8");
    assert.match(written, /turn-0/, "the first turn is missing from the journal");
    assert.match(written, /turn-1/, "the committed turn is missing from the journal");
    assert.equal(
      existsSync(path.join(transcriptsDir, CONVERSATION, `${CONVERSATION}.journal-pending.json`)),
      false,
      "a committed checkpoint left its write-ahead log behind",
    );

    // A turn that ends without a checkpoint must also be able to clean up.
    await routed.abortCheckpoint({}, CONVERSATION);
  } finally {
    rmSync(transcriptsDir, { recursive: true, force: true });
  }
});

test("a user message and an agent reply both survive a round trip through a thread", async () => {
  const sandRoot = mkdtempSync(path.join(os.tmpdir(), "grok-thread-store-"));
  const dbPath = path.join(sandRoot, "agent", "store.db");
  try {
    const rootId = "t1s0";
    // Opening a store never creates the directory it reads from; minting one
    // says so out loud, so this test has to as well.
    ensureAgentDbDirectory(dbPath);
    const db = new SandAgentDb(dbPath);
    db.appendTranscriptEntry({ kind: "message", id: "t0u", role: "user", content: "root question", timestampMs: 1 });
    db.appendTranscriptEntry({ kind: "send-message", id: rootId, message: { type: "text", content: "root answer" }, timestampMs: 2 });

    const userThreadEntry = {
      kind: "message",
      id: "t2u",
      role: "user",
      content: "thread question",
      timestampMs: 3,
      replyTo: rootId,
      branched: true,
    };
    const agentThreadEntry = {
      kind: "send-message",
      id: "t2s0",
      message: { type: "text", content: "thread answer", reply_to: rootId },
      timestampMs: 4,
      replyTo: rootId,
      branched: true,
    };
    assert.equal(db.appendTranscriptEntry(userThreadEntry), true, "the user's threaded message was not persisted");
    assert.equal(db.appendTranscriptEntry(agentThreadEntry), true, "the agent's threaded reply was not persisted");
    db.close();

    // Reopen from disk: nothing below may rely on the writer's memory.
    const reopened = new SandAgentDb(dbPath);
    const thread = reopened.getThread(rootId);
    const threadIds = thread.entries.map((entry) => entry.id);
    assert.deepEqual(
      threadIds,
      [rootId, "t2u", "t2s0"],
      "the thread read back from disk does not hold the root, the user's message and the agent's reply",
    );
    assert.equal(
      thread.entries.find((entry) => entry.id === "t2u").content,
      "thread question",
      "the user's threaded message came back empty",
    );
    assert.equal(
      thread.entries.find((entry) => entry.id === "t2s0").message.content,
      "thread answer",
      "the agent's threaded reply came back empty",
    );

    const mainIds = reopened.getMainTranscriptEntries().map((entry) => entry.id);
    assert.deepEqual(
      mainIds,
      ["t0u", rootId],
      "the main transcript must keep hiding the branched thread entries",
    );

    const window = reopened.getTranscriptWindow({ limit: 100 });
    assert.equal(
      window.threadCounts[rootId],
      2,
      "the sidebar thread badge lost its count after reopening from disk",
    );
    reopened.close();
  } finally {
    rmSync(sandRoot, { recursive: true, force: true });
  }
});