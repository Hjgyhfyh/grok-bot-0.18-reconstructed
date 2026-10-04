import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// "subagent_type generalPurpose у меня не существует, доступен только executor" —
// the first Task call of a live run was refused. `sand_multitask` defaults to
// true (`experiment-config.gen.ts:135`), so `buildSandSubagentConfigsForRun` ran
// its multitask branch on every turn, and that branch used
// `configs.splice(generalPurposeIndex, 1, executor)` — it REPLACED generalPurpose
// instead of adding next to it. The doc comment above the function already said
// "generalPurpose alone, plus executor when multitask is on"; the code did the
// other thing. So the registry held exactly one entry, `executor`, while
// `task-tool-schema.ts` still promised `generalPurpose` in its default and in its
// `enum`. Nothing noticed because the schema is generated from a list and the
// failure only shows up on dispatch.
//
// The second half of the same live run died with
// `TranscriptJournalCorruptionError: durable agent steps moved backwards`. That
// check fires whenever the active turn reports fewer steps than the durable one.
// A resumed turn does exactly that: `stream-attempt.ts:85` restarts the stream
// from the last accepted checkpoint, and
// `production-turn-run-shell-adapter.ts:321` drops `resumeFrom`, so the retry
// rebuilds the turn from its base state and its step list is shorter than the one
// already committed. The journal already models this for the step CONTENT through
// `deferredStep` — an open turn keeps a cursor for its trailing assistant step and
// the next derivation rewinds to it — but never for the step COUNT, so a
// legitimate resumption was reported as data loss and killed the run.
//
// This file drives the closed loop end to end against a REAL FileTranscriptMirror
// on a real temporary directory: Task is called, the subagent is created by the
// real client-side dispatch, the subagent persists its own turn through the real
// journal while that turn is resumed once, and the result comes back to the
// parent. No checkpoint is mocked.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-task-roundtrip-"));
  // One entry, one module graph. `CombinedResourceAccessor` looks a resource up by
  // the `Symbol()` `createResource` minted, so `task.ts` and `subagent.ts` have to
  // leave the SAME bundle: two bundles mean two symbols and a silent miss on every
  // resource lookup, which reads as "the subagent was never dispatched".
  const source = relative => JSON.stringify(path.join(repoRoot, "source", ...relative));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, [
    `export { createTaskTool } from ${source(["packages", "agent", "tools", "task.ts"])};`,
    `export { subagentExecutorResource } from ${source(["packages", "agent-exec", "subagent.ts"])};`,
    `export { CombinedResourceAccessor } from ${source(["packages", "agent-exec", "resource-provider.ts"])};`,
    `export { createContext } from ${source(["packages", "context", "core.ts"])};`,
    `export { buildSandSubagentConfigsForRun } from ${source(["host", "runner", "turn-agent-composition.ts"])};`,
    `export { getSubagentTypeName } from ${source(["packages", "agent", "tools", "core", "subagent", "subagent-config.ts"])};`,
    `export { FileTranscriptMirror } from ${source(["host", "transcript-mirror", "transcript-mirror.ts"])};`,
    `export { createTranscriptOccurrenceDeriver } from ${source(["host", "transcript-mirror", "transcript-occurrence-deriver.ts"])};`,
    `export { createGeneratedTranscriptOccurrenceCodec } from ${source(["host", "transcript-mirror", "generated-occurrence-codec.ts"])};`,
    `export { AgentConversationTurnStructure, AssistantMessage, ConversationStateStructure, ConversationStep, ConversationTurnStructure, UserMessage } from ${source(["packages", "proto", "generated", "agent", "v1", "agent_pb.ts"])};`,
    `export { SubagentResult, SubagentSuccess } from ${source(["packages", "proto", "generated", "agent", "v1", "subagent_exec_pb.ts"])};`,
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
    // The composition root reaches CommonJS (`mime-types` and its own relative
    // requires) through esbuild's `__require` shim, which refuses to run without
    // a real `require` in scope.
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
  buildSandSubagentConfigsForRun,
  createTaskTool,
  getSubagentTypeName,
  FileTranscriptMirror,
  createTranscriptOccurrenceDeriver,
  createGeneratedTranscriptOccurrenceCodec,
  AgentConversationTurnStructure,
  AssistantMessage,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
  SubagentResult,
  SubagentSuccess,
  CombinedResourceAccessor,
  subagentExecutorResource,
  createContext,
} = loaded;
test.after(() => dispose());

const PARENT_AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SUBAGENT_ID = "subagent-generalPurpose-call-0001";

/** Blob store keyed by the hex of its own payload, exactly as the agent store
 *  addresses a conversation blob. The deriver resolves turns, steps and user
 *  messages through it, so nothing here can be faked. */
function createBlobStore() {
  const blobs = new Map();
  const put = bytes => {
    const id = Buffer.from(bytes).toString("hex");
    blobs.set(id, Buffer.from(bytes));
    return new Uint8Array(Buffer.from(id, "hex"));
  };
  return { put, store: { async getBlob(_context, id) { return blobs.get(Buffer.from(id).toString("hex")); } } };
}

const assistantStep = blobs => blobs.put(new ConversationStep({
  message: { case: "assistantMessage", value: new AssistantMessage({ text: "" }) },
}).toBinary());

const agentTurn = (blobs, userText, stepTexts) => {
  const userMessage = blobs.put(new UserMessage({ text: userText }).toBinary());
  const steps = stepTexts.map(text => blobs.put(new ConversationStep({
    message: { case: "assistantMessage", value: new AssistantMessage({ text }) },
  }).toBinary()));
  return blobs.put(new ConversationTurnStructure({
    turn: { case: "agentConversationTurn", value: new AgentConversationTurnStructure({ userMessage, steps }) },
  }).toBinary());
};

const checkpointOf = (...turns) => ({ turns });

/** Every persistence call the host makes: prepare, then commit, through the real
 *  journal. `transcriptId` is the id the settle host reports, which for a subagent
 *  is the subagent's own agent id. */
function createJournal(transcriptsDir) {
  const blobs = createBlobStore();
  const deriver = createTranscriptOccurrenceDeriver(createGeneratedTranscriptOccurrenceCodec({
    ConversationTurnStructure,
    UserMessage,
    ConversationStep,
  }));
  const mirror = new FileTranscriptMirror(transcriptsDir, () => {}, deriver);
  const persist = async (transcriptId, checkpoint, finalize) => {
    await mirror.prepareCheckpoint(null, transcriptId, checkpoint, blobs.store, finalize);
    await mirror.commitCheckpoint(null, transcriptId);
  };
  return { blobs, mirror, persist, jsonlPathFor: id => mirror.jsonlPathFor(id) };
}

/**
 * A subagent executor wired to the real journal. It is the one place the test
 * supplies behaviour instead of importing it, and it supplies no shortcuts: the
 * subagent builds its own turn, persists every step through the real journal, and
 * is resumed once mid-turn exactly the way `stream-attempt.ts:85` resumes a
 * stream — the retry restarts from the base state, so the turn it writes is
 * SHORTER than the one already committed.
 */
function createJournalBackedSubagentExecutor(journal, dispatched) {
  const steps = [
    "read the failing module",
    "apply the fix",
    "run the tests",
    "report the result",
  ];
  return {
    async execute(_ctx, args) {
      dispatched.push({ subagentType: args.subagentType, prompt: args.prompt, modelId: args.modelId });
      const transcriptId = args.agentId ?? SUBAGENT_ID;
      const persistTurn = async (count, finalize) => {
        const turn = agentTurn(journal.blobs, args.prompt, steps.slice(0, count));
        await journal.persist(transcriptId, checkpointOf(turn), finalize);
      };

      // An open turn: each checkpoint leaves the journal a deferred cursor for its
      // trailing assistant step, which is exactly the evidence the deriver uses
      // to tell "still filling this turn" from "the state lost steps".
      await persistTurn(1, false);
      await persistTurn(2, false);
      await persistTurn(3, false);

      // The attempt died mid-turn and the stream restarted from the base state.
      // The same turn is now written with fewer steps than the durable one.
      // Before the fix this call threw "durable agent steps moved backwards" and
      // the Task call returned an error with no subagent output at all.
      await persistTurn(2, false);

      // The resumed attempt does the remaining work and finishes the turn.
      await persistTurn(3, false);
      await persistTurn(4, true);

      return new SubagentResult({
        result: {
          case: "success",
          value: new SubagentSuccess({
            agentId: SUBAGENT_ID,
            finalMessage: "fixed the transcript mirror and the subagent registry",
            toolCallCount: steps.length,
          }),
        },
      });
    },
  };
}

const NO_BOX = {
  isSubagentRunner: false,
  remoteBoxHasDesktop: false,
  remoteBoxAvailable: true,
  browserUseSubagentEnabled: false,
  isSystemPromptOverridden: false,
  isMultitaskEnabled: false,
};

function taskToolFor(subagentConfigs, resourceAccessor) {
  return createTaskTool(
    { get: resource => resourceAccessor.get(resource) },
    async () => ({}),
    { modelName: "test-model" },
    {
      turns: [],
      getPrivacyMode: () => "UNSPECIFIED",
      getBlobStore: () => undefined,
      persistSubagentState() {},
      restoreSubagentState: () => undefined,
      computeNewStructure: async () => new ConversationStateStructure(),
    },
    subagentConfigs,
    {
      allowCustomModelId: false,
      subagentModels: { modelsBySlug: new Map([["test-model", { slug: "test-model" }]]) },
      isModelBlocked: () => false,
      isModelValid: () => true,
      compareModelCosts: () => 0,
      useClientSideSubagent: true,
      subagentInheritGuidance: false,
    },
  );
}

async function* argsStream(value) {
  yield JSON.stringify(value);
}

test("a box with multitask on still offers generalPurpose, and the schema says so", () => {
  const configs = buildSandSubagentConfigsForRun({ ...NO_BOX, isMultitaskEnabled: true });
  const offered = configs.map(config => getSubagentTypeName(config.subagent_type));
  assert.ok(
    offered.includes("generalPurpose"),
    "splicing the executor over generalPurpose is what made a live Task call with subagent_type generalPurpose fail",
  );
  assert.deepEqual(
    offered[0],
    "generalPurpose",
    "task-subagent-preparation.ts:493 falls back to subagentConfigs[0], so the first entry stays the default a bare Task call resolves to",
  );
});

test("the Task schema enumerates every offered subagent type instead of inventing one", () => {
  const configs = buildSandSubagentConfigsForRun({ ...NO_BOX, isMultitaskEnabled: true });
  const tool = taskToolFor(configs, { get: () => undefined });
  const description = JSON.stringify(tool.parameters);
  assert.match(
    description,
    /Must be one of: generalPurpose, executor/,
    "an enumeration that lists a type nobody can dispatch is what made the schema promise generalPurpose while the registry held only executor",
  );
  const parsed = tool.parameters;
  assert.ok(
    typeof parsed === "object" && parsed !== null,
    "the model-facing parameters must stay a JSON schema object for this assertion to mean anything",
  );
});

test("an empty subagent registry does not advertise a type that cannot be dispatched", () => {
  const tool = taskToolFor([], { get: () => undefined });
  assert.doesNotMatch(
    JSON.stringify(tool.parameters),
    /Must be one of: generalPurpose/,
    "naming generalPurpose for an empty registry sends the call one layer down to 'No subagent types are available.'",
  );
  assert.match(
    JSON.stringify(tool.parameters),
    /No subagent type is available in this session/,
    "with nothing to dispatch, the schema has to say so rather than read 'Must be one of: .'",
  );
});

test("Task creates a subagent, the subagent works through the real journal across a resumed turn, and the result reaches the parent", async () => {
  const transcriptsDir = mkdtempSync(path.join(os.tmpdir(), "grok-task-transcripts-"));
  try {
    const journal = createJournal(transcriptsDir);
    const dispatched = [];
    const resourceAccessor = new CombinedResourceAccessor(
      { get: () => { throw new Error("no remote subagent executor in this test"); } },
      [[subagentExecutorResource, createJournalBackedSubagentExecutor(journal, dispatched)]],
    );
    const tool = taskToolFor(
      buildSandSubagentConfigsForRun({ ...NO_BOX, isMultitaskEnabled: true }),
      resourceAccessor,
    );

    // The parent's own open turn, checkpointed before the dispatch lands.
    const parentTurn = agentTurn(journal.blobs, "fix the subagent registry", ["looking"]);
    await journal.persist(PARENT_AGENT_ID, checkpointOf(parentTurn), false);

    const result = await tool.execute(
      createContext(),
      { emitPartialToolCall() {} },
      argsStream({ description: "fix the mirror", prompt: "repair the transcript journal", subagent_type: "generalPurpose" }),
      { toolCallId: "call-0001" },
    );

    assert.equal(
      result.result.case,
      "success",
      `the closed loop is Task -> subagent created -> subagent worked -> result returned; anything else means one link is missing. Dispatch error: ${result.result.case === "error" ? result.result.value.error : "none"}`,
    );
    assert.equal(
      dispatched.length,
      1,
      "no subagent ran, so nothing about the returned result describes a real dispatch",
    );
    assert.equal(
      dispatched[0].subagentType,
      "generalPurpose",
      "the type the caller asked for must reach the executor, otherwise the registry fix only moved the failure",
    );
    assert.equal(
      dispatched[0].prompt,
      "repair the transcript journal",
      "the dispatch prompt is the subagent's entire world and must arrive intact",
    );
    assert.equal(
      result.result.value.conversationSteps[0].message.value.text,
      "fixed the transcript mirror and the subagent registry",
      "the subagent's final message is what the parent resumes from, so an empty result means the loop never closed",
    );
    assert.equal(
      result.result.value.agentId,
      SUBAGENT_ID,
      "the parent needs the subagent id to resume it later",
    );

    const subagentTranscript = readFileSync(journal.jsonlPathFor(SUBAGENT_ID), "utf8");
    assert.match(
      subagentTranscript,
      /repair the transcript journal/,
      "the subagent's own transcript must hold the dispatch prompt it was given",
    );
    assert.match(
      subagentTranscript,
      /apply the fix/,
      "the resumed turn must reach the file, so the rewind did not silently drop the work the subagent did after it",
    );
    assert.match(
      readFileSync(journal.jsonlPathFor(PARENT_AGENT_ID), "utf8"),
      /fix the subagent registry/,
      "the parent keeps its own transcript while a subagent runs in the background",
    );
  } finally {
    rmSync(transcriptsDir, { recursive: true, force: true });
  }
});
