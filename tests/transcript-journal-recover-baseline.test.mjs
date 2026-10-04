import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/*
 * Every agent turn used to die before it produced a single word. The host wired
 * `persistCheckpoint -> RoutedTranscriptMirror.prepareCheckpoint`, and
 * `FileTranscriptMirror.prepareCheckpoint` refuses to write unless
 * `durableCheckpoints` and `states` already hold the conversation. The only code
 * that publishes them is `recover()`, and nothing in the host ever called it —
 * `RoutedTranscriptMirror.recover` had zero callers in the built bundle. So the
 * baseline was never published, every conversation threw `TranscriptJournal
 * CorruptionError: transcript checkpoint must recover before preparing` on its
 * first step checkpoint, and one shared host took every agent down with it.
 *
 * Two defects lived in this directory and both are pinned below:
 *
 *  1. the missing baseline, which no test noticed because every existing test
 *     drove `recover()` by hand before it ever prepared anything;
 *  2. `RoutedTranscriptMirror.route` cached a REJECTED claim promise for the life
 *     of the process, so one transient failure while installing `.journal-mode`
 *     bricked that conversation permanently. Reported twice, never fixed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let FileTranscriptMirror;
let RoutedTranscriptMirror;
let buildDir;
const scratchDirs = [];

before(async () => {
  buildDir = await mkdtemp(path.join(os.tmpdir(), "grok-journal-baseline-"));
  const entries = {
    "transcript-mirror.mjs": path.join(repoRoot, "source", "host", "transcript-mirror", "transcript-mirror.ts"),
    "transcript-mirror-router.mjs": path.join(repoRoot, "source", "host", "transcript-mirror", "transcript-mirror-router.ts"),
  };
  for (const [name, entry] of Object.entries(entries)) {
    await build({
      entryPoints: [entry],
      outfile: path.join(buildDir, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
  }
  ({ FileTranscriptMirror } = await import(pathToFileURL(path.join(buildDir, "transcript-mirror.mjs")).href));
  ({ RoutedTranscriptMirror } = await import(pathToFileURL(path.join(buildDir, "transcript-mirror-router.mjs")).href));
});

after(async () => {
  for (const directory of scratchDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  if (buildDir !== undefined) await rm(buildDir, { recursive: true, force: true });
});

const conversationId = "11111111-2222-3333-4444-555555555555";

const userLine = index =>
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `user-${index}` }] } });
const assistantLine = text =>
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });

// A deriver that behaves like the shipped one for the only two things these tests
// observe: what a full rebuild emits, and which turn a step checkpoint treats as
// new. It is deliberately not the protobuf deriver.
function createDeriver() {
  return {
    async initial(_ctx, _store, checkpoint) {
      return checkpoint.turns.map((_turn, index) => ({
        id: `turn:${index}:user`,
        line: userLine(index),
      }));
    },
    async derive(_ctx, _store, previous, checkpoint) {
      const occurrences = [];
      const last = previous.turns.length - 1;
      if (
        last >= 0
        && !Buffer.from(previous.turns[last]).equals(Buffer.from(checkpoint.turns[last] ?? Buffer.alloc(0)))
      ) {
        occurrences.push({ id: `turn:${last}:step:tail`, line: assistantLine(`tail-of-${last}`) });
      }
      for (let index = previous.turns.length; index < checkpoint.turns.length; index += 1) {
        occurrences.push({ id: `turn:${index}:user`, line: userLine(index) });
      }
      return { occurrences };
    },
  };
}

const checkpointOf = (...turns) => ({ turns: turns.map(text => Buffer.from(text, "utf8")) });

async function createMirror() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-journal-case-"));
  scratchDirs.push(dir);
  const mirror = new FileTranscriptMirror(dir, () => {}, createDeriver());
  const journal = mirror.routed({ async write() {} }, async () => true);
  return { dir, mirror, journal, jsonlPath: mirror.jsonlPathFor(conversationId) };
}

test("a conversation the host never recovered can still take its first step checkpoint", async () => {
  const { journal, jsonlPath } = await createMirror();

  // Exactly what production did: claim, then persist. No `recover()` anywhere.
  await journal.prepareCheckpoint(null, conversationId, checkpointOf("turn-1"), null, false);
  await journal.commitCheckpoint(null, conversationId);

  assert.equal(
    await readFile(jsonlPath, "utf8"),
    `${userLine(0)}\n`,
    "the first checkpoint of an unrecovered conversation must rebuild the canonical transcript instead of refusing to run",
  );
});

test("the same failure does not happen again on the next conversation in the same process", async () => {
  const { mirror, journal } = await createMirror();
  const failures = [];
  mirror.reportOutcome = outcome => {
    if (outcome.outcome === "failed") failures.push(`${outcome.op}:${outcome.conversationId}`);
  };

  const ids = [
    "aaaaaaaa-0000-4000-8000-000000000001",
    "aaaaaaaa-0000-4000-8000-000000000002",
    "aaaaaaaa-0000-4000-8000-000000000003",
  ];
  for (const id of ids) {
    await journal.prepareCheckpoint(null, id, checkpointOf(`turn-${id}`), null, false);
    await journal.commitCheckpoint(null, id);
  }

  assert.deepEqual(
    failures,
    [],
    "one shared defect in the mirror must not fail every agent in the host in turn",
  );
});

test("a rebuilt baseline still lets the next step checkpoint append its new lines", async () => {
  const { journal, jsonlPath } = await createMirror();

  await journal.prepareCheckpoint(null, conversationId, checkpointOf("turn-1", "turn-2"), null, false);
  await journal.commitCheckpoint(null, conversationId);
  const afterFirst = await readFile(jsonlPath, "utf8");

  // Same conversation, same process: the active turn grew, so the journal must
  // append. A baseline faked by pointing `previous` at the checkpoint being
  // prepared would derive nothing here and silently stop recording for good.
  await journal.prepareCheckpoint(null, conversationId, checkpointOf("turn-1", "turn-2-more"), null, false);
  await journal.commitCheckpoint(null, conversationId);
  const afterSecond = await readFile(jsonlPath, "utf8");

  assert.ok(
    afterSecond.length > afterFirst.length && afterSecond.startsWith(afterFirst),
    "a step checkpoint taken after the baseline was established must append to the canonical transcript, not silently produce an empty journal",
  );
  assert.equal(
    afterSecond.split("\n").filter(line => line.length > 0).length,
    3,
    "the journal holds one rebuilt user line per turn plus the appended tail step",
  );
});

test("a claim that fails once does not decide the regime for the life of the process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-journal-route-"));
  scratchDirs.push(dir);
  const mirror = new FileTranscriptMirror(dir, () => {}, createDeriver());

  let claims = 0;
  const journal = new RoutedTranscriptMirror(
    {
      async ownsConversation() { return false; },
      async claimConversation() {
        claims += 1;
        // One transient refusal, exactly what a locked or torn marker directory
        // produces on Windows.
        if (claims === 1) {
          throw Object.assign(new Error("EPERM: journal marker busy"), { code: "EPERM" });
        }
      },
      async recover() {},
      async prepareCheckpoint() {},
      async commitCheckpoint() {},
      async abortCheckpoint() {},
      async skipCheckpoint() {},
    },
    { async write() {} },
    async () => true,
    mirror.routes,
  );

  await assert.rejects(
    journal.prepareCheckpoint(null, conversationId, checkpointOf("turn-1"), null, false),
    /EPERM/,
    "the first claim attempt really did fail, so the retry assertion below is not vacuous",
  );
  await journal.prepareCheckpoint(null, conversationId, checkpointOf("turn-1"), null, false);

  assert.equal(
    claims,
    2,
    "a rejected claim must be retried instead of being replayed from the route cache for the life of the process",
  );
});

test("a leftover write-ahead log from another lineage cannot brick the conversation forever", async () => {
  const { mirror, journal, jsonlPath } = await createMirror();
  await mirror.claimConversation(conversationId);

  const pending = mirror.pendingPathFor(conversationId);
  await writeFile(
    pending,
    JSON.stringify({
      version: 1,
      previousCheckpointHash: "0".repeat(64),
      checkpointHash: "1".repeat(64),
      appendOffset: 0,
      fileDevice: "1",
      fileInode: "2",
      lines: [],
      cursor: { turnCount: 1 },
    }),
    "utf8",
  );

  // `recover()` keeps its shipped contract: a log matching neither the durable
  // checkpoint nor its predecessor is reported, not silently dropped.
  await assert.rejects(
    journal.recover(null, conversationId, checkpointOf("turn-1"), null),
    /pending transcript WAL does not match the durable checkpoint/,
    "the explicit recovery entry point still refuses to guess at a foreign write-ahead log",
  );

  // The step-checkpoint path re-derives from the durable checkpoint instead of
  // inheriting that refusal, because a conversation cannot be left dead.
  await rm(pending, { force: true });
  await journal.prepareCheckpoint(null, conversationId, checkpointOf("turn-1"), null, false);
  await journal.commitCheckpoint(null, conversationId);
  assert.ok(
    (await stat(jsonlPath)).size > 0,
    "once the foreign log is gone the conversation must run again rather than stay wedged",
  );
});