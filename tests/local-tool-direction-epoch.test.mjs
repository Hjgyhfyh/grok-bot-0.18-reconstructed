/**
 * A local-tool permission epoch never moved, and nothing in the product said so.
 *
 * `SAND_LOCAL_TOOLS_ABANDONED_MESSAGE` tells the model that a request the user already declined
 * "will not run and will not be asked again for this task", and the only thing in the tree that
 * could ever end that task was the direction epoch: `refusalFor` compares the epoch a refusal was
 * remembered under against the epoch the request is made in, so one turn opening a new direction is
 * what retires it. Two holes held that from happening, and both failed silently — no throw, no log,
 * no red state:
 *
 *  1. `turn-run-shell.ts` declares `beginLocalToolPermissionTurn?(conversationId)` and calls it once
 *     per turn, and NO object in `source/` implemented it. The optional call on a missing method is
 *     a no-op, so `directionEpochs` stayed empty, `directionEpoch(agentId)` answered 0 forever, and
 *     every remembered refusal stayed stamped with 0 — which the `>=` comparison keeps matching.
 *  2. Nothing in `source/` ever wrote `sandTurnDirectionEpochKey` into a turn context.
 *     `withLocalToolScope` reads it on every scoped tool call, so the scope carried no epoch and the
 *     controller fell back to its own live number — the same 0.
 *
 * Together they made "this task never ends" true for the life of the process.
 *
 * These tests drive the REAL path: `SandAgentRunner.run` → `createProductionTurnRunShellAdapter` →
 * `createTurnRunShell` → `createTurnAgentStreamStart` → `createStreamAttempt`, with the real
 * `SandLocalToolPermissionController` behind it and only the model Agent replaced by a deterministic
 * seam. The falsification at the bottom answers the two product files from `git show HEAD:…` through
 * esbuild's `onLoad` and answers two further builds from single-line source mutations — the tree is
 * never written to. Each one shows the obligation failing against exactly the code that breaks it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The baseline these tests read the defect from. It is a fixed commit, not HEAD:
// reading HEAD only proves anything while the fix is uncommitted, and once it is
// committed HEAD holds the fixed code and every falsification inverts.
const DEFECT_BASELINE = "18fe9fc";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

/** The four files the direction-epoch change lives in, relative to the repository root. */
const PRODUCT_FILES = [
  "source/host/runner/production-turn-run-shell-adapter.ts",
  "source/host/runner/sand-agent-runner.ts",
  "source/host/runner-production-bridge.ts",
  "source/host/runner/tools/turn-toolset.ts",
];

/** One export per line of the bundle entry, so a missing name is a build error, not `undefined`. */
const ENTRY_LINES = [
  ["SandAgentRunner", ["host", "runner", "sand-agent-runner.ts"]],
  ["createProductionTurnRunShellAdapter", ["host", "runner", "production-turn-run-shell-adapter.ts"]],
  ["withLocalToolScope", ["host", "runner", "tools", "turn-toolset.ts"]],
  ["SandLocalToolPermissionController", ["host", "extensions", "local-tool-permission", "local-tool-permission-controller.ts"]],
  ["createContext", ["packages", "context", "core.js"]],
  ["PrivacyMode", ["packages", "redaction", "privacy-mode.js"]],
  ["PrivacyCapability", ["packages", "redaction", "classification.js"]],
  ["fromRedactedConversationStateStructure", ["packages", "redacted-protos", "generated", "agent", "v1", "agent_redacted.js"]],
  [
    "ConversationAction, ConversationStateStructure, ConversationStep, ConversationTurnStructure, AgentConversationTurnStructure, AssistantMessage, UserMessage, UserMessageAction",
    ["packages", "proto", "generated", "agent", "v1", "agent_pb.js"],
  ],
];

/**
 * Every module under test goes into ONE bundle: `sandTurnDirectionEpochKey` carries a `Symbol`, and
 * two bundles would be two different symbols, so a context written by the adapter would read back
 * `undefined` in the toolset.
 */
function entrySource() {
  const machine = JSON.stringify(path.join(sourceRoot, "shared", "local-tool-permission-machinery.js"));
  return [
    ...ENTRY_LINES.map(
      ([names, segments]) =>
        `export { ${names} } from ${JSON.stringify(path.join(sourceRoot, ...segments))};`,
    ),
    // One import, many names, so the key is a single symbol in this bundle.
    `import { sandTurnDirectionEpochKey, sandLocalToolScopeKey, authorizeLocalToolAction, SAND_LOCAL_TOOLS_ABANDONED_MESSAGE, SAND_LOCAL_TOOLS_DENIED_MESSAGE } from ${machine};`,
    "export { sandTurnDirectionEpochKey, sandLocalToolScopeKey, authorizeLocalToolAction, SAND_LOCAL_TOOLS_ABANDONED_MESSAGE, SAND_LOCAL_TOOLS_DENIED_MESSAGE };",
  ].join("\n");
}

/**
 * Rewrites ONE file on its way into esbuild. The tree stays untouched, and the test that must fail
 * fails against exactly the mutated source. A `before` that matches zero or several times is itself
 * a failure: it means the anchor is stale, and a stale anchor proves nothing.
 */
function mutationOn(relativePath, before, after) {
  const target = path.resolve(repoRoot, relativePath);
  return {
    name: "direction-epoch-mutation",
    setup(loadBuild) {
      loadBuild.onLoad({ filter: /\.ts$/ }, async (args) => {
        if (path.resolve(args.path) !== target) return undefined;
        const text = readFileSync(args.path, "utf8");
        const occurrences = text.split(before).length - 1;
        if (occurrences !== 1) {
          throw new TypeError(
            `the mutation must match exactly once in ${relativePath}, matched ${occurrences}`,
          );
        }
        return { contents: text.replace(before, after), loader: "ts" };
      });
    },
  };
}

/** Answers the listed files from the committed blob instead of the working tree. */
function gitHeadOn(relatives) {
  const targets = new Set(relatives.map((relative) => path.resolve(repoRoot, relative)));
  return {
    name: "direction-epoch-git-head",
    setup(loadBuild) {
      loadBuild.onLoad({ filter: /\.ts$/ }, (args) => {
        if (!targets.has(path.resolve(args.path))) return undefined;
        const relative = path.relative(repoRoot, args.path).split(path.sep).join("/");
        const env = { ...process.env };
        delete env.GIT_CONFIG_COUNT;
        return {
          contents: execFileSync("git", ["show", `${DEFECT_BASELINE}:${relative}`], {
            cwd: repoRoot,
            encoding: "utf8",
            env,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
          }),
          loader: "ts",
        };
      });
    },
  };
}

async function load(plugins = []) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-direction-epoch-"));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(entry, entrySource(), "utf8");
  const outfile = path.join(directory, "entry.cjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // The toolset pulls in CommonJS dependencies (`mime-types` and its internal relative requires),
    // which esbuild can only wire up inside a CommonJS output — the same shape
    // `scripts/lib/clean-build.mjs` builds.
    format: "cjs",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    external: ["prom-client"],
    logLevel: "silent",
    plugins,
  });
  const require = createRequire(import.meta.url);
  return {
    loaded: require(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const { loaded, dispose } = await load();
// Only names that carry no `Symbol` identity are destructured here. The epoch key, the scope key,
// the runner, the controller and the scope wrapper are reached through the `bundle` argument of the
// fixtures, because every falsification below builds its OWN copy of them: two bundles are two
// different `Symbol`s, and a fixture that crossed them would read `undefined` out of a perfectly
// good context.
const {
  SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
  SAND_LOCAL_TOOLS_DENIED_MESSAGE,
  PrivacyMode,
  PrivacyCapability,
  fromRedactedConversationStateStructure,
  ConversationAction,
  ConversationStateStructure,
  ConversationStep,
  ConversationTurnStructure,
  AgentConversationTurnStructure,
  AssistantMessage,
  UserMessage,
  UserMessageAction,
} = loaded;
test.after(() => dispose());

// Nothing below may wait forever. An ask the fixture forgets to settle holds a referenced timer,
// so the ceiling is short enough to notice and long enough not to race the assertions.
const ASK_TTL_MS = 2_000;

const encode = (value) => new TextEncoder().encode(value);

function conversationStep(text) {
  return new ConversationStep({
    step: { case: "assistantMessage", value: new AssistantMessage({ content: encode(text) }) },
  }).toBinary();
}

function stateWithSteps(userMessage, stepCount) {
  return new ConversationStateStructure({
    turns: [
      new ConversationTurnStructure({
        turn: {
          case: "agentConversationTurn",
          value: new AgentConversationTurnStructure({
            userMessage: encode(userMessage),
            steps: Array.from({ length: stepCount }, (_, index) =>
              conversationStep(`step-${index}`),
            ),
          }),
        },
      }).toBinary(),
    ],
    summaryArchives: [],
    turnTimings: [],
  });
}

/** How many steps the model Agent really sees, read back through the redaction projection. */
function observedStepCount(redactedState) {
  const restored = fromRedactedConversationStateStructure(
    redactedState,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  );
  assert.equal(restored.turns.length, 1, "the fixture must hand the stream exactly one turn");
  const turn = ConversationTurnStructure.fromBinary(restored.turns[0]);
  assert.equal(turn.turn.case, "agentConversationTurn", "the fixture must hold an agent turn");
  return turn.turn.value.steps.length;
}

/** Empty args stream, the shape a tool call that takes no arguments receives. */
async function* noArgs() {
  // A tool with no arguments still gets a stream; an empty one is the truth.
}

/**
 * The real controller behind an instrumented pair, so a test can count how many times a direction
 * was opened and how many times a number was read. Counting is the point: "the epoch was written"
 * is invisible without it.
 */
function instrumentedController(bundle, options = {}) {
  const controller = new bundle.SandLocalToolPermissionController({
    getPermission: () => options.permission ?? "ask",
    setPermission: () => {},
    canAsk: () => true,
    hasLiveComputer: () => true,
    askTtlMs: ASK_TTL_MS,
    now: () => 1_000,
    randomId: (() => {
      let next = 0;
      return () => `ask-${(next += 1)}`;
    })(),
  });
  const opened = [];
  const read = [];
  return {
    controller,
    opened,
    read,
    /** The narrow projection the runner and the adapter actually receive. */
    projection: {
      beginTurn(agentId) {
        opened.push(agentId);
        controller.beginTurn(agentId);
      },
      directionEpoch(agentId) {
        read.push(agentId);
        return controller.directionEpoch(agentId);
      },
    },
  };
}

/**
 * One production runner whose turn stops at the model: the context that reaches the Agent owner, the
 * run input and the stream is captured, which is the only place the direction epoch can be observed
 * from outside.
 *
 * `bundle` is a parameter so a falsification bundle can drive its OWN build of every module through
 * the very same fixture — and, more importantly, so the fixture reads the epoch with the SAME
 * `sandTurnDirectionEpochKey` that bundle writes it with. Two bundles are two different `Symbol`s, and
 * a fixture that crossed them would see `undefined` everywhere and "prove" the defect for the wrong
 * reason.
 */
function productionRunner(
  bundle,
  { agentId, observation, localToolPermission, inheritedDirectionEpoch, isSubagent = false },
) {
  const { SandAgentRunner, sandTurnDirectionEpochKey } = bundle;
  const epochs = { owner: [], runInput: [], stream: [] };
  let streamContext;
  const owner = {
    built: {
      agent: {
        async runStream(ctx, state, action, mcpTools, persistCheckpoint) {
          epochs.stream.push(ctx.get(sandTurnDirectionEpochKey));
          streamContext = ctx;
          const stepsOnArrival = observedStepCount(state);
          assert.equal(
            action.action.case,
            "userMessageAction",
            "the fixture must hand the stream a real user message action",
          );
          assert.deepEqual(mcpTools, [], "the fixture declares no MCP servers");
          const produced = stateWithSteps("do the work", stepsOnArrival + 1);
          await persistCheckpoint(ctx, produced);
          return produced;
        },
      },
    },
    runContext: {
      privacyMode: PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
      commitDiskPressureReminder() {},
      dispose() {},
      scope: { cancelThisRun() {} },
    },
    buildInput: {},
    dispose() {},
  };
  const runner = new SandAgentRunner({
    conversationId: agentId,
    isSubagent,
    transport: { onUpdate() {} },
    productionTurnRunShell: {
      async createOwner({ context }) {
        epochs.owner.push(context.get(sandTurnDirectionEpochKey));
        return owner;
      },
      async createRunInput({ runContext }) {
        epochs.runInput.push(runContext.get(sandTurnDirectionEpochKey));
        return {
          action: new ConversationAction({
            action: {
              case: "userMessageAction",
              value: new UserMessageAction({
                userMessage: new UserMessage({ text: encode("do the work") }),
              }),
            },
          }),
          baseState: stateWithSteps("do the work", 0),
          mcpTools: [],
        };
      },
      promptOptions: () => ({}),
      createSession: () => ({ getModelId: () => "test-model" }),
      context: () => bundle.createContext(),
      createSettleHost: () => ({
        conversationId: agentId,
        profilePromptSnapshots: {},
        isSubagentRunner: isSubagent,
        isRunSuperseded: () => false,
        ownsRunner: () => true,
        latestPromptMessages: () => [],
        agentStore: () => null,
        setLocalState() {},
      }),
      profilePromptSnapshots: () => ({}),
      cancelThisRun() {},
      ...(localToolPermission === undefined ? {} : { localToolPermission }),
      ...(inheritedDirectionEpoch === undefined ? {} : { inheritedDirectionEpoch }),
    },
  });
  // The turn's observation is taken the moment the turn settles.
  //
  // `onRunUnwind` is not an option on `SandAgentRunnerOptions` — the runner owns that callback and
  // passes its own to the adapter — so a fixture that sets it there is silently ignored and every
  // assertion below then reads an empty array. Wrapping the one method the fixture already calls
  // is the honest place to snapshot, and it cannot change what the turn does.
  //
  // The arrays are COPIED, never aliased: the recorder is reused for the next turn, and clearing it
  // in place would empty the previous turn's reading too.
  const runTurnUnderTest = runner.run.bind(runner);
  runner.run = async (prompt, runOptions) => {
    epochs.owner.length = 0;
    epochs.runInput.length = 0;
    epochs.stream.length = 0;
    streamContext = undefined;
    const result = await runTurnUnderTest(prompt, runOptions);
    observation.push({
      owner: [...epochs.owner],
      runInput: [...epochs.runInput],
      stream: [...epochs.stream],
      streamContext,
    });
    return result;
  };
  return runner;
}

async function runTurn(runner) {
  const result = await runner.run("do the work");
  assert.equal(
    result?.aborted,
    false,
    "the fixture turn must settle normally, or the epoch assertions below mean nothing",
  );
  return result;
}

/**
 * The real scoped tool wrapper around the real gate: the epoch is read out of the run context by
 * `withLocalToolScope` and reaches `authorizeLocalToolAction` exactly the way the production toolset
 * host passes it. Same `bundle` rule as the runner — the scope key is a `Symbol` too.
 */
function scopedRunCommand(bundle, permission, agentId, observations) {
  const {
    withLocalToolScope,
    sandLocalToolScopeKey,
    sandTurnDirectionEpochKey,
    authorizeLocalToolAction,
  } = bundle;
  return withLocalToolScope(
    {
      name: "ExternalShell",
      toolIdentifier: "EXTERNAL_SHELL",
      async execute(context) {
        const scope = context.get(sandLocalToolScopeKey);
        observations.push({ scope, epoch: context.get(sandTurnDirectionEpochKey) });
        const approvalId = await authorizeLocalToolAction(permission, scope, {
          action: "run-command",
          target: "npm test",
        });
        return { toJson: () => ({ approvalId }) };
      },
    },
    agentId,
    permission,
    "run-command",
  );
}

/** A rejection reason, or `"allowed"` — the shape every denial assertion reads. */
async function outcomeOf(promise) {
  return promise.then(() => "allowed", (error) => error?.message ?? String(error));
}

const AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD_ID = "bbbbbbbb-0000-4000-8000-000000000002";

// --- Obligations -----------------------------------------------------------

test("a turn opens one direction and puts exactly that number into the turn context", async () => {
  const { projection, opened, read } = instrumentedController(loaded);
  const observed = [];
  const runner = productionRunner(loaded, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });

  await runTurn(runner);

  assert.deepEqual(
    opened,
    [AGENT_ID],
    "nothing opened a direction, so the controller kept epoch 0 and every remembered refusal stayed stamped with 0",
  );
  assert.deepEqual(
    read,
    [AGENT_ID],
    `the epoch must be read exactly once per turn, not once per tool call; observed ${JSON.stringify(read)}`,
  );
  assert.deepEqual(
    observed.at(-1).stream,
    [1],
    "the number the turn runs under must reach the stream; a context that never received it reads back undefined",
  );
  assert.deepEqual(
    observed.at(-1).owner,
    [1],
    "the Agent owner and the run input are built from the same context, so all three must agree",
  );
  assert.deepEqual(
    observed.at(-1).runInput,
    [1],
    "the generated action is assembled from the run context, so it must carry the same number",
  );
  assert.equal(
    projection.directionEpoch(AGENT_ID),
    1,
    "reading the epoch must not advance it: one turn opened exactly one direction",
  );
});

test("the second turn of one conversation runs under the next direction, not the first", async () => {
  const { projection, opened } = instrumentedController(loaded);
  const observed = [];
  const runner = productionRunner(loaded, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });

  await runTurn(runner);
  await runTurn(runner);

  assert.deepEqual(
    opened,
    [AGENT_ID, AGENT_ID],
    "the second turn reused the first direction, so the controller's `>=` comparison kept matching the first refusal forever",
  );
  assert.deepEqual(
    observed.map((turn) => turn.stream),
    [[1], [2]],
    "both turns must see the same context, or the epoch is being read at a different point than it is written",
  );
});

test("a refusal remembered in one direction stops shadowing the request in the next", async () => {
  const { projection, controller } = instrumentedController(loaded);
  const observed = [];
  const runner = productionRunner(loaded, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });
  const tool = scopedRunCommand(loaded, controller, AGENT_ID, []);

  await runTurn(runner);
  const firstTurnContext = observed.at(-1).streamContext;

  const declined = tool.execute(firstTurnContext, undefined, noArgs(), {
    toolCallId: "call-1",
  });
  const pending = controller.getPendingRequestForAgent(AGENT_ID);
  assert.equal(pending?.action, "run-command", "the fixture must actually open an ask");
  controller.resolveRequest(pending.id, "deny");
  assert.match(
    await outcomeOf(declined),
    /declined this action/,
    "the fixture's own denial must reach the caller",
  );

  assert.equal(
    await outcomeOf(
      tool.execute(firstTurnContext, undefined, noArgs(), { toolCallId: "call-2" }),
    ),
    SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
    "inside one direction the refusal must not be asked a second time; that is the promise the message makes",
  );

  await runTurn(runner);
  const secondTurnContext = observed.at(-1).streamContext;

  const askedAgain = tool.execute(secondTurnContext, undefined, noArgs(), {
    toolCallId: "call-3",
  });
  const reopened = controller.getPendingRequestForAgent(AGENT_ID);
  assert.equal(
    reopened?.status,
    "pending",
    "a new user message is a new direction, so the same request must be askable again; otherwise \"for this task\" never ends",
  );
  controller.resolveRequest(reopened.id, "allow-once");
  const granted = await askedAgain;
  assert.equal(
    granted.toJson().approvalId,
    reopened.id,
    "the user's answer must be the thing that reaches the tool, not a cached decision from the earlier turn",
  );
  assert.notEqual(
    SAND_LOCAL_TOOLS_DENIED_MESSAGE,
    SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
    "the fixture's two refusals must be different answers, or the assertions cannot tell them apart",
  );
});

test("a subagent inherits its parent's direction and never opens one of its own", async () => {
  const { projection, opened } = instrumentedController(loaded);
  const observed = [];
  const parent = productionRunner(loaded, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });
  await runTurn(parent);
  await runTurn(parent);
  const parentEpoch = projection.directionEpoch(AGENT_ID);

  const child = productionRunner(loaded, {
    agentId: CHILD_ID,
    observation: observed,
    localToolPermission: projection,
    inheritedDirectionEpoch: parentEpoch,
    isSubagent: true,
  });
  await runTurn(child);

  assert.equal(parentEpoch, 2, "the fixture must reach a direction worth inheriting");
  assert.deepEqual(
    [observed.at(-1).owner, observed.at(-1).runInput, observed.at(-1).stream],
    [[parentEpoch], [parentEpoch], [parentEpoch]],
    "a subagent that reads its own number runs under 0, because its agent id was never in the controller's map; the epoch it must carry is the parent's",
  );
  assert.deepEqual(
    opened,
    [AGENT_ID, AGENT_ID],
    "a subagent opened a direction of its own, so it stopped sharing the task its refusal memory belongs to",
  );
});

test("a subagent's refusal is retired by the parent's next direction", async () => {
  const { projection, controller } = instrumentedController(loaded);
  const observed = [];
  const parent = productionRunner(loaded, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });
  await runTurn(parent);
  await runTurn(parent);

  const child = productionRunner(loaded, {
    agentId: CHILD_ID,
    observation: observed,
    localToolPermission: projection,
    inheritedDirectionEpoch: projection.directionEpoch(AGENT_ID),
    isSubagent: true,
  });
  const tool = scopedRunCommand(loaded, controller, CHILD_ID, []);
  await runTurn(child);

  const declined = tool.execute(observed.at(-1).streamContext, undefined, noArgs(), {
    toolCallId: "child-call-1",
  });
  const pending = controller.getPendingRequestForAgent(CHILD_ID);
  assert.equal(pending?.action, "run-command", "the fixture must actually open an ask");
  controller.resolveRequest(pending.id, "deny");
  assert.match(
    await outcomeOf(declined),
    /declined this action/,
    "the fixture's own denial must reach the caller",
  );

  assert.equal(
    await outcomeOf(
      tool.execute(observed.at(-1).streamContext, undefined, noArgs(), {
        toolCallId: "child-call-2",
      }),
    ),
    SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
    "inside one direction the child must not ask a second time",
  );

  await runTurn(parent);
  const nextChild = productionRunner(loaded, {
    agentId: CHILD_ID,
    observation: observed,
    localToolPermission: projection,
    inheritedDirectionEpoch: projection.directionEpoch(AGENT_ID),
    isSubagent: true,
  });
  const nextTool = scopedRunCommand(loaded, controller, CHILD_ID, []);
  await runTurn(nextChild);

  const askedAgain = nextTool.execute(observed.at(-1).streamContext, undefined, noArgs(), {
    toolCallId: "child-call-3",
  });
  const reopened = controller.getPendingRequestById("ask-2");
  assert.equal(
    reopened?.status,
    "pending",
    "the parent's next direction must retire the child's refusal too; the child works inside the parent's task, not one of its own",
  );
  controller.resolveRequest("ask-2", "allow-once");
  await askedAgain;
});

test("an agent whose host bound no permission controller still runs its turn", async () => {
  const observed = [];
  const runner = productionRunner(loaded, {
    agentId: AGENT_ID,
    observation: observed,
  });

  const result = await runTurn(runner);

  assert.equal(result.aborted, false, "a missing permission extension must not fail the turn");
  assert.deepEqual(
    [observed.at(-1).owner, observed.at(-1).runInput, observed.at(-1).stream],
    [[undefined], [undefined], [undefined]],
    "with no controller the context must keep the key's own undefined, which is what the scoped tool call already handled",
  );
});

test("a subagent with no controller and nothing to inherit still runs its turn", async () => {
  const observed = [];
  const runner = productionRunner(loaded, {
    agentId: CHILD_ID,
    observation: observed,
    isSubagent: true,
  });

  await runTurn(runner);

  assert.deepEqual(
    [observed.at(-1).owner, observed.at(-1).runInput, observed.at(-1).stream],
    [[undefined], [undefined], [undefined]],
    "inheriting from nothing must be the same quiet absence, not a thrown TypeError in the middle of a turn",
  );
});

// --- Falsification ---------------------------------------------------------
//
// Each obligation below is measured by the SAME probe against a build whose product files are
// different, and the test asserts that the obligation is broken there. A test that cannot fail on
// the code it claims to describe proves nothing. The repository is never written to; only esbuild's
// view of it changes.

/**
 * One parent of two turns, then a subagent that inherits, then one scoped tool call in the
 * subagent's turn. Returns plain data so one probe can measure every build.
 */
async function probeEpochs(bundle) {
  const { projection, controller, opened } = instrumentedController(bundle);
  const observed = [];
  const parent = productionRunner(bundle, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });
  await runTurn(parent);
  await runTurn(parent);
  const inherited = projection.directionEpoch(AGENT_ID);

  const child = productionRunner(bundle, {
    agentId: CHILD_ID,
    observation: observed,
    localToolPermission: projection,
    inheritedDirectionEpoch: inherited,
    isSubagent: true,
  });
  await runTurn(child);

  const scopeReads = [];
  const tool = scopedRunCommand(bundle, controller, CHILD_ID, scopeReads);
  const answered = tool.execute(observed.at(-1).streamContext, undefined, noArgs(), {
    toolCallId: "probe-call",
  });
  const pending = controller.getPendingRequestForAgent(CHILD_ID);
  assert.ok(pending, "the fixture must actually open an ask, or it measures nothing");
  controller.resolveRequest(pending.id, "deny");
  await outcomeOf(answered);

  return {
    opened: [...opened],
    parentStream: observed.slice(0, 2).map((turn) => turn.stream),
    childStream: observed.at(-1).stream,
    controllerEpoch: inherited,
    // What `authorizeLocalToolAction` would compare a remembered refusal against.
    childScopeEpoch: scopeReads[0].scope.directionEpoch,
  };
}

/** The promise `SAND_LOCAL_TOOLS_ABANDONED_MESSAGE` makes, measured as a yes or a no. */
async function probeRefusal(bundle) {
  const { projection, controller } = instrumentedController(bundle);
  const observed = [];
  const runner = productionRunner(bundle, {
    agentId: AGENT_ID,
    observation: observed,
    localToolPermission: projection,
  });
  const tool = scopedRunCommand(bundle, controller, AGENT_ID, []);

  await runTurn(runner);
  const firstTurnContext = observed.at(-1).streamContext;

  const declined = tool.execute(firstTurnContext, undefined, noArgs(), {
    toolCallId: "call-1",
  });
  const pending = controller.getPendingRequestForAgent(AGENT_ID);
  assert.ok(pending, "the fixture must actually open an ask, or it measures nothing");
  controller.resolveRequest(pending.id, "deny");
  await outcomeOf(declined);

  const insideOneDirection = await outcomeOf(
    tool.execute(firstTurnContext, undefined, noArgs(), { toolCallId: "call-2" }),
  );

  await runTurn(runner);
  const askedAgain = tool.execute(observed.at(-1).streamContext, undefined, noArgs(), {
    toolCallId: "call-3",
  });
  const reopened = controller.getPendingRequestForAgent(AGENT_ID);
  const askedInNewDirection = reopened !== undefined;
  if (askedInNewDirection) controller.resolveRequest(reopened.id, "allow-once");
  const afterNewDirection = await outcomeOf(askedAgain);

  return { insideOneDirection, askedInNewDirection, afterNewDirection };
}

test("the committed product files never open a direction, never write the epoch, and never end a task", async () => {
  const head = await load([gitHeadOn(PRODUCT_FILES)]);
  try {
    const measured = await probeEpochs(head.loaded);
    assert.deepEqual(
      measured.opened,
      [],
      "the committed runner bound no beginLocalToolPermissionTurn, so the shell's optional call was a no-op",
    );
    assert.deepEqual(
      measured.parentStream,
      [[undefined], [undefined]],
      "the committed adapter wrote no epoch into the turn context, so every read came back as the key's own undefined",
    );
    assert.equal(
      measured.controllerEpoch,
      0,
      "with nothing opening a direction the controller's own number is 0 for the life of the process",
    );
    assert.equal(
      measured.childScopeEpoch,
      undefined,
      "so the scoped tool call carries no epoch and the controller falls back to that same 0",
    );

    const refusal = await probeRefusal(head.loaded);
    assert.equal(
      refusal.insideOneDirection,
      SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
      "the promise inside one direction is pre-existing behaviour and must survive",
    );
    assert.equal(
      refusal.askedInNewDirection,
      false,
      "this is the defect: a new user message did not end the task, so the request was never askable again",
    );
    assert.equal(
      refusal.afterNewDirection,
      SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
      "and the message the model gets in the second turn is the same permanent refusal as in the first",
    );
  } finally {
    head.dispose();
  }
});

test("the working tree is what separates the two: the same probe passes against it", async () => {
  const measured = await probeEpochs(loaded);
  assert.deepEqual(measured.opened, [AGENT_ID, AGENT_ID], "the fixture must open one direction per parent turn");
  assert.deepEqual(measured.parentStream, [[1], [2]], "each parent turn must carry its own number");
  assert.deepEqual(measured.childStream, [2], "the subagent must carry the parent's number");
  assert.equal(measured.childScopeEpoch, 2, "the scoped tool call must compare refusals under the inherited number");

  const refusal = await probeRefusal(loaded);
  assert.equal(refusal.askedInNewDirection, true, "a new direction must make the same request askable again");
  assert.equal(refusal.afterNewDirection, "allowed", "the user's fresh answer must reach the tool");
});

test("the turn shell stops advancing the epoch when beginTurn is wired to a no-op", async () => {
  const mutated = await load([
    mutationOn(
      "source/host/runner/sand-agent-runner.ts",
      "this.localToolPermission?.beginTurn(this.getConversationId())",
      "void this.localToolPermission",
    ),
  ]);
  try {
    const measured = await probeEpochs(mutated.loaded);
    assert.deepEqual(
      measured.opened,
      [],
      "the stub was never wired to the controller, so this mutation must stop it entirely",
    );
    assert.deepEqual(
      measured.parentStream,
      [[0], [0]],
      "this is the failure the stub causes: the shell still calls the hook and the context still gets a number, but the number never moves — every turn is stamped with 0",
    );
    assert.equal(
      measured.controllerEpoch,
      0,
      "the controller's own number is frozen at 0 as well, so a refusal stamped 0 outranks every later turn",
    );

    const refusal = await probeRefusal(mutated.loaded);
    assert.equal(
      refusal.askedInNewDirection,
      false,
      "the epoch is written but never moves, so a new user message still does not end the task",
    );
  } finally {
    mutated.dispose();
  }
});

test("the turn's epoch disappears when the single context write is removed", async () => {
  const mutated = await load([
    mutationOn(
      "source/host/runner/production-turn-run-shell-adapter.ts",
      "input.context().with(sandTurnDirectionEpochKey, directionEpoch)",
      "input.context()",
    ),
  ]);
  try {
    const measured = await probeEpochs(mutated.loaded);
    assert.deepEqual(
      measured.opened,
      [AGENT_ID, AGENT_ID],
      "the directions still opened, so only the write into the context is missing here",
    );
    assert.deepEqual(
      measured.parentStream,
      [[undefined], [undefined]],
      "without the write the turn context never receives the number it resolved",
    );
    assert.equal(
      measured.controllerEpoch,
      2,
      "the directions still opened, so the controller's own number is unaffected by the missing write",
    );
    assert.equal(
      measured.childScopeEpoch,
      undefined,
      "this is the failure the missing write causes: the scoped tool call carries no epoch, so the child falls back to its own 0 instead of the parent's direction",
    );
  } finally {
    mutated.dispose();
  }
});
