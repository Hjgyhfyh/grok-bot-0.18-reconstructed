/**
 * A structured UI control payload used to reach the chat as visible text. The local inference
 * router took every string the model returned and handed it straight to
 * `projectInferenceRouterTranscriptEntry`, which stores an assistant reply as a plain
 * `send-message` bubble. A reply that was nothing but a control envelope --
 * `{"isNewTopic":true,"title":"..."}` -- was therefore rendered as raw JSON and its title was
 * dropped on the floor. Nothing threw: the turn succeeded, the stored transcript was well
 * formed, and the user simply saw an unreadable line, which is why the defect survived every
 * green build in this repository.
 *
 * `routed-control-envelope.test.mjs` pinned that behaviour end to end. It asserted that
 * `dispatch("sendPrompt")` returned `handled: true`, that `inference-router-transcript.json`
 * collected the answer, and that the answer was streamed into the chat. Every one of those
 * assertions was the defect restated: the route was claiming the user's turn, so the user was
 * never talking to an agent. When the route was corrected to decline the turn (`handled:
 * false`, the turn runs on the agent on the box) the file could not be repaired without putting
 * the defect back, so it was deleted rather than edited. The turn-level obligation it described
 * now lives in `send-prompt-reaches-the-agent.test.mjs`: the route declines the turn, nothing
 * it produces can reach the chat, and the title still lands on the agent profile.
 *
 * What survives here is the recogniser. `parseRoutedControlEnvelope` is the entire envelope
 * contract, and it still decides, on a real model reply, whether the route consumes that reply
 * or drops it. That strictness is worth pinning on its own: it is the rule that keeps an
 * ordinary sentence, or an ordinary JSON answer, from renaming an agent. `applyRoutedControlEnvelope`
 * and `nameConversation` still carry the concern end to end.
 *
 * `classifyRoutedReply` is a dead export. It is the incremental form of a streaming decision no
 * route makes any more -- nothing streams a routed reply, and nothing imports the function -- so
 * it is deliberately not pinned here. A test that guards unused code outlives the reason it was
 * written and then holds a dead line in place against the next person who wants to delete it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONTROL_PAYLOAD = '{"isNewTopic":true,"title":"Создание агента"}';

/**
 * The recogniser is a pure function over the model's finished reply, so the real router module
 * is bundled unmodified -- no provider stub is needed, and a stubbed build would be testing the
 * stub's idea of the reply rather than the rule that reads it.
 */
async function loadRouter() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-control-envelope-"));
  const outfile = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "node-agent-coordinator", "inference-router.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { parse: module.parseRoutedControlEnvelope, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("a bare control payload is recognised, and its title is the one that is applied", async () => {
  const { parse, dispose } = await loadRouter();
  try {
    assert.deepEqual(
      parse(CONTROL_PAYLOAD),
      { isNewTopic: true, title: "Создание агента" },
      "the one reply the route exists to act on was not recognised, so the conversation could never be named",
    );
    assert.deepEqual(
      parse(`  ${CONTROL_PAYLOAD}\n`),
      { isNewTopic: true, title: "Создание агента" },
      "a provider reply that carries surrounding whitespace was not recognised, so a title was lost to formatting",
    );
    assert.deepEqual(
      parse('{"isNewTopic":false,"title":"Продолжение"}'),
      { isNewTopic: false, title: "Продолжение" },
      "the payload flag was not read, so the route cannot tell a new topic from a continuation",
    );
  } finally {
    await dispose();
  }
});

/**
 * Everything here is a reply the model can plausibly produce and the route must NOT treat as a
 * control payload. A false positive does not show raw JSON in the chat -- that defect is gone --
 * it renames an agent with the text of a sentence, which is worse and quieter.
 *
 * `{"isNewTopic":true}` is deliberately absent: it carries only control keys and a boolean flag,
 * so it IS an envelope -- one with no title, which the route consumes and then has nothing to
 * apply. Consuming it is the correct reading, and the "nothing to apply" case is pinned below.
 */
const ORDINARY_REPLIES = [
  'Here is the JSON you asked for: {"isNewTopic":true,"title":"Example"} and that is all of it.',
  '{"city":"Yekaterinburg","note":"ordinary JSON data, not a control payload"}',
  '{"isNewTopic":"yes","title":"Example"}',
  '{"title":"Example"}',
  "{}",
  "[{\"isNewTopic\":true,\"title\":\"Example\"}]",
  '{"isNewTopic":true,"title":"Example","extra":1}',
  '{"isNewTopic":true,"title":"Example',
  '```json\n{"isNewTopic":true,"title":"Example"}\n```',
  `{"isNewTopic":true,"title":"${"x".repeat(600)}"}`,
];

test("a reply that is not a control payload is never consumed as one", async () => {
  const { parse, dispose } = await loadRouter();
  try {
    // The rejections below only mean something if the same rule still accepts the real thing, so
    // the acceptance is proved first, in the same run, on the same function.
    assert.notEqual(
      parse(CONTROL_PAYLOAD),
      null,
      "the recogniser rejects everything, so the negative assertions below would pass for the wrong reason",
    );
    assert.ok(
      ORDINARY_REPLIES.length >= 10,
      `the corpus of ordinary replies shrank to ${ORDINARY_REPLIES.length} entries, so it is no longer covering the recogniser`,
    );
    const consumed = ORDINARY_REPLIES.filter(reply => parse(reply) !== null);
    assert.deepEqual(
      consumed,
      [],
      `the route consumed a reply that was ordinary assistant text, so it would act on it as if the application had asked: ${JSON.stringify(consumed)}`,
    );
  } finally {
    await dispose();
  }
});

test("an envelope whose title cannot be used is recognised and then dropped, never repaired", async () => {
  const { parse, dispose } = await loadRouter();
  try {
    // `applyRoutedControlEnvelope` returns early on a null title, so the envelope is recognised
    // (and therefore consumed rather than shown) while contributing nothing. A title that was
    // invented here -- truncated, or wrapped in the model's own filler -- would put text the
    // model never wrote into the user's chat list.
    assert.deepEqual(
      parse('{"isNewTopic":true,"title":""}'),
      { isNewTopic: true, title: null },
      "an empty title was turned into a name for the conversation",
    );
    assert.deepEqual(
      parse('{"isNewTopic":true,"title":"   "}'),
      { isNewTopic: true, title: null },
      "a blank title was treated as a name",
    );
    assert.deepEqual(
      parse('{"isNewTopic":true,"title":42}'),
      { isNewTopic: true, title: null },
      "a title that is not a string was coerced into one",
    );
    assert.deepEqual(
      parse('{"isNewTopic":true}'),
      { isNewTopic: true, title: null },
      "the flag on its own stopped being an envelope, so showing it as raw JSON in the chat is back",
    );
    assert.deepEqual(
      parse('{"isNewTopic":true,"title":"' + "я".repeat(81) + '"}'),
      { isNewTopic: true, title: null },
      "a title longer than the limit was truncated into a half-sentence instead of being dropped whole",
    );
  } finally {
    await dispose();
  }
});

test("a reply of any other shape is left alone rather than half-interpreted", async () => {
  const { parse, dispose } = await loadRouter();
  try {
    // The recogniser answers one question -- is this whole reply a control payload -- and the
    // route's only move on a yes is to store the title. There is no partial reading, so a reply
    // that merely resembles an envelope has to produce the same nothing as a sentence does.
    for (const reply of ["", "   \n  ", "{}", "[]", "null", '{"isNewTopic":null}', "Привет!", '{"a":1}']) {
      assert.equal(
        parse(reply),
        null,
        `the route consumed ${JSON.stringify(reply)} as a control payload, so it acts on a reply it was not sent`,
      );
    }
  } finally {
    await dispose();
  }
});