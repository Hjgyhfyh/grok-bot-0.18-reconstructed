import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The reaction loop was broken in both directions and nothing failed, because
 * every leg reported success.
 *
 * Outbound, `sand-reaction-tool.ts` spent most of its description telling the
 * model to avoid the action ("Only react to the user's own messages ... never
 * your own sends", "Use this VERY sparingly", "Mirror the user - if they don't
 * use emoji, basically never do this"). A model that read it correctly concluded
 * it had no such ability, and answered "I can't put a like on a message" in
 * plain text. The parameter agreed: `message_address` accepted only the user's
 * tag.
 *
 * Outbound again, one layer down: even a perfect `ReactToMessage` call aimed at
 * the agent's own message was discarded by `TurnRuntime.handleAgentUpdate`,
 * which dropped any target that was not a user message. The tool returned
 * "Reacted X on Y", no pill appeared, and `lastReactionApplied()` was false, so
 * the turn was even treated as owing a reply. The description rewrite alone
 * would have turned a refusal into a lie.
 *
 * Inbound, a reaction the user left on the agent's own message was stored on
 * the transcript entry and rendered as a pill, and nothing on the agent side
 * ever read it back. The conversation state that feeds the model is rebuilt from
 * message blobs, so "what did the user think of that" had no answer on the next
 * turn either. `collectUserReactionNotices` now feeds it through the mechanism
 * the codebase already had - the same option the unanswered-widget summaries use
 * and the same `prependUserMessages` slot - and `toGeneratedTurnPromptOptions`
 * had to learn the name, because that function is a whitelist and an option
 * missing from it is dropped without a trace.
 *
 * What this file proves: the model-facing description obliges the call instead
 * of discouraging it, both sides of the conversation are accepted, the
 * agent's-own-message target is applied rather than dropped, and the user's
 * reactions reach the assembled turn context exactly once.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-reaction-loop-"));
  const loaded = {};
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    const outfile = path.join(directory, name);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    loaded[name] = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  }
  return { loaded, dispose: () => rm(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "runner", "tools", "sand-reaction-tool.ts"],
  ["shared", "message-reference.ts"],
  ["host", "extensions", "transcript", "turn-runtime.ts"],
  ["host", "extensions", "transcript", "widget-responses.ts"],
  ["host", "runner", "prompt-collector-glue.ts"],
]);

after(() => dispose());

const reactionTool = loaded["sand-reaction-tool.mjs"].createReactToMessageTool({
  react: () => {},
});
const toolDescription = reactionTool.descriptionGenerator();
// `createZodAgentTool` hands the wire format to the model, so the parameter text
// is asserted where the model reads it: the generated JSON schema.
const addressDescription =
  reactionTool.parameters.jsonSchema.properties.message_address.description;

test("the reaction description obliges the call instead of discouraging it", () => {
  assert.equal(reactionTool.name, "ReactToMessage", "the tool keeps its model-facing name");
  assert.match(
    toolDescription,
    /When the user asks for a reaction, the tool call IS the reply/,
    "the description must say an explicit reaction request is answered with the tool call",
  );
  assert.match(
    toolDescription,
    /never tell them you have no way to react/,
    "the description must forbid the refusal that started this report",
  );
  assert.match(
    toolDescription,
    /your own sends hands back its address/,
    "the description must offer the agent's own messages as reaction targets",
  );
});

test("the taste advice survived the rewrite", () => {
  assert.match(
    toolDescription,
    /A reaction is still not a substitute for a real reply/,
    "a reaction must not become a way to dodge a reply the user asked for",
  );
  assert.match(
    toolDescription,
    /mirror the user/i,
    "the model still has to be told not to spam tapbacks at someone who never uses emoji",
  );
  assert.doesNotMatch(
    toolDescription,
    /Only react to the user/,
    "the sentence that read as a prohibition is gone",
  );
  assert.doesNotMatch(
    toolDescription,
    /basically never do this/,
    "the sentence that told the model to skip the action outright is gone",
  );
});

test("the address parameter accepts the agent's own send", () => {
  assert.doesNotMatch(
    addressDescription,
    /Only the user's own messages, never your own sends/,
    "the parameter description no longer forbids reacting to the agent's own message",
  );
  const { isMessageAddress } = loaded["message-reference.mjs"];
  assert.equal(
    isMessageAddress("t3s1"),
    true,
    "the tool's own address guard rejected the id SendMessage hands back",
  );
  assert.equal(
    isMessageAddress("not-an-address"),
    false,
    "the guard must still reject free text",
  );
});

function fakeTranscriptManager(applied) {
  return {
    runLifecycle: {
      activeRunSession: undefined,
      trackComposingFromUpdate: () => {},
      trackRetryingFromUpdate: () => {},
      trackActivityFromUpdate: () => {},
    },
    sessions: { activeSession: { id: "on-screen" } },
    roster: {
      applyAgentUpdateToOutline: () => {},
      emit: () => {},
      emitAgentUpdate: () => {},
    },
    groupChat: { isGroupSession: () => false },
    widgetResponses: {
      applyReaction: (args) => {
        applied.push(args);
        return { before: { kind: "send-message", id: args.entryId }, isAdding: true };
      },
    },
  };
}

function fakeSession(entries) {
  return {
    id: "agent-1",
    db: {
      getTranscriptEntries: () => entries,
      updateTranscriptEntry: () => null,
    },
  };
}

const AGENT_SEND = {
  kind: "send-message",
  id: "t1s0",
  message: { type: "text", content: "Here is the breakdown you asked for." },
  timestampMs: 1,
};
const USER_MESSAGE = {
  kind: "message",
  id: "t1u",
  role: "user",
  content: "thanks!",
  timestampMs: 0,
};

test("a reaction aimed at the agent's own message is applied, not dropped", () => {
  const { TurnRuntime } = loaded["turn-runtime.mjs"];
  const applied = [];
  const runtime = new TurnRuntime(fakeTranscriptManager(applied));
  const session = fakeSession([USER_MESSAGE, AGENT_SEND]);

  const assigned = runtime.handleAgentUpdate(
    { type: "react-to-message", messageAddress: "t1s0", emoji: "\u{1F44D}" },
    session,
  );

  assert.equal(
    assigned,
    "t1s0",
    "handleAgentUpdate returned no entry id, so the transport never marked the reaction applied",
  );
  assert.equal(applied.length, 1, "the reaction was discarded before applyReaction ran");
  assert.equal(
    applied[0].by,
    "agent-1",
    "the reaction must be attributed to the reacting agent, not to the user",
  );
});

test("the target guard still refuses an entry that is not in the conversation", () => {
  const { TurnRuntime } = loaded["turn-runtime.mjs"];
  const applied = [];
  const runtime = new TurnRuntime(fakeTranscriptManager(applied));
  const session = fakeSession([
    ...[USER_MESSAGE, AGENT_SEND],
    { kind: "notice", id: "t1n", text: "internal" },
  ]);

  const assigned = runtime.handleAgentUpdate(
    { type: "react-to-message", messageAddress: "t1n", emoji: "\u{1F44D}" },
    session,
  );

  assert.equal(assigned, undefined, "a non-message entry must stay unreachable");
  assert.equal(applied.length, 0, "no reaction may be recorded against an unknown target");
});

function reactionManager(entries) {
  return {
    sessions: { activeSession: { id: "on-screen" } },
    roster: { emit: () => {}, emitAgentUpdate: () => {} },
    boxHandoff: { resumeWithHiddenPrompt: async () => {} },
  };
}

function reactionSession(entries) {
  return {
    id: "agent-1",
    db: {
      getTranscriptEntries: () => entries,
      updateTranscriptEntry: (id, update) => {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index < 0) return null;
        entries[index] = update(entries[index]);
        return entries[index];
      },
    },
  };
}

test("the user's reaction to the agent's own message reaches the turn context", async () => {
  const { WidgetResponses } = loaded["widget-responses.mjs"];
  const entries = [
    USER_MESSAGE,
    { ...AGENT_SEND, reactions: [{ emoji: "\u{1F44D}", by: "me" }] },
  ];
  const responses = new WidgetResponses(reactionManager(entries));
  const session = reactionSession(entries);

  const notices = responses.collectUserReactionNotices(session);
  assert.equal(
    notices.userReactionNotices.length,
    1,
    "the reaction the user left on the agent's message was not collected at all",
  );
  assert.match(
    notices.userReactionNotices[0],
    /\u{1F44D}/u,
    "the notice does not carry the emoji the user actually chose",
  );
  assert.match(
    notices.userReactionNotices[0],
    /t1s0/,
    "the notice does not carry the address of the message that was reacted to",
  );

  const { createPromptCollectorGlue } = loaded["prompt-collector-glue.mjs"];
  const glue = createPromptCollectorGlue({});
  const assembly = await glue.assembleTurnAction({
    trimmedPrompt: "what next?",
    options: { userReactionNotices: notices.userReactionNotices },
    compactionEpoch: () => 0,
  });
  const prepended = assembly.action.action.value.prependUserMessages;
  assert.equal(
    prepended.length,
    1,
    "the notice was collected but never prepended to the turn",
  );
  assert.match(
    prepended[0].text,
    /Reactions from the user to your own messages/,
    "the turn context does not tell the model these are reactions to its own sends",
  );

  const repeat = responses.collectUserReactionNotices(session);
  assert.deepEqual(
    repeat.userReactionNotices,
    [],
    "the same reaction was reported to the agent on every later turn forever",
  );
});

test("a reaction the user left is not written off by the wake", async () => {
  // `resumeAfterReaction` is a courtesy wake that aborts before the prompt is
  // sent whenever the transcript mirror cannot prepare a checkpoint, and it
  // swallows that failure. Marking the reaction reported there would say "the
  // agent knows" for a turn that never ran, and the notice would be gone.
  const { WidgetResponses } = loaded["widget-responses.mjs"];
  const entries = [{ ...AGENT_SEND, reactions: [{ emoji: "\u{1F389}", by: "me" }] }];
  let resumes = 0;
  const tm = reactionManager(entries);
  // The real `resumeWithHiddenPrompt` catches its own failure and reports a tray
  // error, so the wake resolves having told the agent nothing at all.
  tm.boxHandoff = { resumeWithHiddenPrompt: async () => { resumes += 1; } };
  const responses = new WidgetResponses(tm);
  const session = reactionSession(entries);

  await responses.resumeAfterReaction("agent-1", "\u{1F389}", "Mango.");

  assert.equal(resumes, 1, "the courtesy wake was never attempted");
  assert.equal(
    entries[0].reactionNoticesSeen,
    undefined,
    "the wake marked the reaction reported, so the agent would never be told",
  );
  const notices = responses.collectUserReactionNotices(session);
  assert.equal(
    notices.userReactionNotices.length,
    1,
    "the reaction was dropped entirely after the wake failed",
  );
});

test("a reaction on the user's own message is not reported as feedback about the agent's work", () => {
  const { WidgetResponses } = loaded["widget-responses.mjs"];
  const entries = [
    { ...USER_MESSAGE, reactions: [{ emoji: "\u{1F44D}", by: "me" }] },
    { ...AGENT_SEND, reactions: [{ emoji: "\u{1F44D}", by: "agent-1" }] },
  ];
  const responses = new WidgetResponses(reactionManager(entries));
  const notices = responses.collectUserReactionNotices(reactionSession(entries));

  assert.deepEqual(
    notices.userReactionNotices,
    [],
    "a tapback on the user's own message, or the agent's own tapback, was read back as user feedback",
  );
});

test("the production turn option whitelist carries the reaction notices through", async () => {
  const source = await readFile(
    path.join(repoRoot, "source", "host", "host-runner-composition.ts"),
    "utf8",
  );
  const start = source.indexOf("function toGeneratedTurnPromptOptions");
  assert.ok(start > 0, "toGeneratedTurnPromptOptions is gone; the guard below would pass on anything");
  const rest = source.slice(start);
  // The body is indented, so the first closing brace in column 0 ends the
  // function. Matched either way round the line ending, or the guard silently
  // isolates nothing and passes.
  const end = /\r?\n\}\r?\n/.exec(rest);
  assert.ok(end != null, "the whitelist body could not be isolated, so the guard proved nothing");
  const whitelist = rest.slice(0, end.index);
  // The name alone is not enough: it also appears in the input type above this
  // function. What has to survive is the mapping that copies the option across.
  assert.match(
    whitelist,
    /userReactionNotices: options\.userReactionNotices/,
    "toGeneratedTurnPromptOptions is a whitelist: without this mapping the notices never reach the model",
  );
});