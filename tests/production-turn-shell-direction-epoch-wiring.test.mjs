/**
 * The direction epoch was fixed in the turn shell and never reached the app.
 *
 * `SAND_LOCAL_TOOLS_ABANDONED_MESSAGE` tells the model that a request the user already declined
 * "will not run and will not be asked again for this task", and the only thing in the tree that
 * can end that task is the direction epoch: `refusalFor` compares the epoch a refusal was
 * remembered under against the epoch the request is made in. Four files made that number move —
 * `production-turn-run-shell-adapter.ts` resolves it once per turn and writes it into the turn
 * context, `sand-agent-runner.ts` opens one direction per turn and reads the number back, and the
 * toolset reads it out of the context on every scoped call. All four were correct and all four were
 * unreachable, because the object that finally assembles a production turn shell never handed them
 * a controller: `createProductionTurnRunShellHostInput` in `host-runner-composition.ts` was called
 * without `localToolPermission`, so `SandAgentRunner` read `undefined` at
 * `sand-agent-runner.ts:377`, left the shell's `beginLocalToolPermissionTurn` hook unbound, and
 * `resolveTurnDirectionEpoch` returned `undefined` on every turn of the life of the process. There
 * was no throw, no log and no red state — only a controller nobody had told about, and a number
 * that stayed 0.
 *
 * The obvious repair passes the wrong object. The file already had a projection of the same
 * controller for the toolset host, `asLocalToolPermissionProjection`, and it keeps exactly
 * `{awaitDesktopStandingDecision, completeScope}` — both methods a turn needs are dropped, so the
 * field looks present, the type still narrows, and the epoch silently stays 0 again. These tests
 * are built to catch that: the shell's controller must answer with the LIVE controller's own
 * numbers, which a projection cannot do because it has no `directionEpoch` to call.
 *
 * These tests drive the production composition itself — `createHostRunnerComposition` →
 * `createRunner` → `buildProductionTurnRunShellInput` → `createProductionTurnRunShellHostInput` →
 * `runnerOptions.productionTurnRunShell` → `new SandAgentRunner(options)` — with the real
 * `SandLocalToolPermissionController` behind it and only the model Agent replaced by a seam. Both
 * production call sites are measured: the parent's own shell (the assignment near the end of
 * `createRunner`) and the shell of a `Task` subagent, which the composition builds inside a turn
 * from its own scope. The falsifications at the bottom answer `host-runner-composition.ts` from
 * `git show HEAD:…` and from two single-line source mutations — the tree is never written to — and
 * each one shows the same probe against exactly the code that breaks it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

/** The one production file this defect lives in. */
const COMPOSITION_RELATIVE = "source/host/host-runner-composition.ts";
const COMPOSITION = path.join(repoRoot, COMPOSITION_RELATIVE);

/**
 * The module that builds the real Agent owner. It is the only file the fixture rewrites, and only
 * so owner construction STOPS once the composition has handed over its per-turn resource
 * projection — that input is the object the composition uses to dispatch a `Task` subagent, and
 * nothing else in the tree exposes it. Everything the assertions read is built by untouched
 * composition code before this seam is reached.
 */
const OWNER_MODULE = path.join(
  sourceRoot,
  "host",
  "runner",
  "production-turn-agent-owner.ts",
);
const OWNER_INPUTS = "fixtureTurnOwnerInputs";
const SEAM_MESSAGE = "the fixture stops owner construction right after the projection input";

/** One export per line of the bundle entry, so a missing name is a build error, not `undefined`. */
const ENTRY_LINES = [
  ["createHostRunnerComposition", ["host", "host-runner-composition.ts"]],
  ["SandAgentRunner", ["host", "runner", "sand-agent-runner.ts"]],
  [
    "SandAutoReviewController, SAND_AUTO_REVIEW_MODES_OFF",
    ["host", "runner", "sand-auto-review.ts"],
  ],
  [
    "SandLocalToolPermissionController",
    ["host", "extensions", "local-tool-permission", "local-tool-permission-controller.ts"],
  ],
  ["createContext", ["packages", "context", "core.js"]],
  ["PrivacyMode", ["packages", "redaction", "privacy-mode.js"]],
  ["ConversationStateStructure", ["packages", "proto", "generated", "agent", "v1", "agent_pb.js"]],
];

/**
 * Stops `createProductionTurnAgentOwner` before it builds a model Agent, and keeps the input the
 * composition produced.
 *
 * The seam sits at the first statement of the function: everything the composition builds — the
 * owner input, its projection builder, and both `buildProductionTurnRunShellInput` results — is
 * already constructed by then. The anchor must match exactly once; a stale anchor is itself a
 * failure, because it would mean the fixture quietly stopped proving anything.
 */
function ownerSeam() {
  return {
    name: "direction-epoch-owner-seam",
    setup(loadBuild) {
      loadBuild.onLoad({ filter: /\.ts$/ }, args => {
        if (path.resolve(args.path) !== OWNER_MODULE) return undefined;
        const text = readFileSync(args.path, "utf8");
        const anchor = "  const runContext = await createTurnAgentRunContext({";
        const occurrences = text.split(anchor).length - 1;
        if (occurrences !== 1) {
          throw new TypeError(
            `the seam anchor must match exactly once in production-turn-agent-owner.ts, matched ${occurrences}`,
          );
        }
        return {
          contents: [
            `export const ${OWNER_INPUTS}: ProductionTurnAgentOwnerInput[] = [];`,
            "",
            text,
            "",
          ].join("\n").replace(
            anchor,
            `  ${OWNER_INPUTS}.push(input);\n  throw new Error(${JSON.stringify(SEAM_MESSAGE)});\n${anchor}`,
          ),
          loader: "ts",
        };
      });
    },
  };
}

/**
 * Rewrites ONE line on its way into esbuild, so the obligation can be measured against exactly the
 * code that breaks it. The repository is never written to.
 */
function mutationOn(relativePath, before, after) {
  const target = path.resolve(repoRoot, relativePath);
  return {
    name: "direction-epoch-wiring-mutation",
    setup(loadBuild) {
      loadBuild.onLoad({ filter: /\.ts$/ }, args => {
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
  const targets = new Set(relatives.map(relative => path.resolve(repoRoot, relative)));
  return {
    name: "direction-epoch-wiring-git-head",
    setup(loadBuild) {
      loadBuild.onLoad({ filter: /\.ts$/ }, args => {
        if (!targets.has(path.resolve(args.path))) return undefined;
        const relative = path.relative(repoRoot, args.path).split(path.sep).join("/");
        const env = { ...process.env };
        delete env.GIT_CONFIG_COUNT;
        return {
          contents: execFileSync("git", ["show", `HEAD:${relative}`], {
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-epoch-wiring-"));
  const entry = path.join(directory, "entry.ts");
  writeFileSync(
    entry,
    [
      ...ENTRY_LINES.map(
        ([names, segments]) =>
          `export { ${names} } from ${JSON.stringify(path.join(sourceRoot, ...segments))};`,
      ),
      `export { ${OWNER_INPUTS} } from ${JSON.stringify(OWNER_MODULE)};`,
    ].join("\n"),
    "utf8",
  );
  const outfile = path.join(directory, "entry.cjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // The host pulls in CommonJS dependencies, which esbuild can only wire up
    // inside a CommonJS output — the same shape `scripts/lib/clean-build.mjs`
    // builds.
    format: "cjs",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    external: ["prom-client"],
    logLevel: "silent",
    plugins: [ownerSeam(), ...plugins],
  });
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  return {
    loaded: require(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const { loaded, dispose } = await load();
test.after(() => dispose());

const AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const FIRST_CHILD_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const SECOND_CHILD_ID = "cccccccc-0000-4000-8000-000000000003";

/** The real controller, so "the shell is bound to it" is a question with a readable answer. */
function liveController(bundle) {
  return new bundle.SandLocalToolPermissionController({
    getPermission: () => "ask",
    setPermission: () => {},
    canAsk: () => true,
    hasLiveComputer: () => true,
    askTtlMs: 2_000,
    now: () => 1_000,
    randomId: (() => {
      let next = 0;
      return () => `ask-${(next += 1)}`;
    })(),
  });
}

/** A monotonic id source, so a fixture failure is readable in the assertion message. */
function countedIds(prefix) {
  let next = 0;
  return () => `${prefix}-${(next += 1)}`;
}

/**
 * Every extension port the composition reads while it assembles a runner. Nothing here is used by
 * the assertions; each one exists because the composition refuses to build a shell without it, and
 * a refusal would hide the wiring under a `TypeError` about an unrelated port.
 */
function extensionApis(bundle, { withPermissionExtension }) {
  return {
    ...(withPermissionExtension
      ? { "local-tool-permission": liveController(bundle) }
      : {}),
    "local-exec": {
      box: { downloadFile() {}, uploadFile() {} },
      userComputers: { resolve: () => undefined, list: () => [] },
    },
    "forever-box": {
      box: {
        downloadFile() {},
        uploadFile() {},
        isAvailable: () => true,
        ensureReady: async () => ({ remoteAccessor: undefined }),
      },
    },
    // `asSandAutoReviewController` is an `instanceof` check, so this controller has to come from
    // THIS bundle. A hand-rolled look-alike would leave `autoReviewGate` undefined and no shell at
    // all would be built — a green test about nothing.
    "auto-review": {
      bindRunner: ({ agentId }) => ({
        autoReviewController: new bundle.SandAutoReviewController({
          agentId,
          hostGeneration: "fixture",
          now: () => 1_000,
          randomId: countedIds("review"),
        }),
        autoReviewModes: bundle.SAND_AUTO_REVIEW_MODES_OFF,
        getAutoReviewModes: () => bundle.SAND_AUTO_REVIEW_MODES_OFF,
      }),
    },
    "action-audit": { record() {} },
    inference: {
      port: {
        createSession: () => ({ getExecutor: () => ({}), getModelId: () => "fixture-model" }),
        resolvePrivacyMode: async () => bundle.PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED,
      },
    },
  };
}

/**
 * Builds one production runner through the real composition and keeps everything it handed out.
 *
 * The runner itself is the real `SandAgentRunner`: the defect is not "the shell lacks a field" but
 * "the object the app constructs reads `undefined` off it", and only the real constructor reads
 * `productionTurnRunShell.localToolPermission`.
 */
async function productionHost(bundle, { withPermissionExtension = true } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-epoch-wiring-agent-"));
  const runnerOptions = [];
  const composition = bundle.createHostRunnerComposition({
    extensions: { api: id => extensionApis(bundle, { withPermissionExtension })[id] ?? {} },
    ctx: bundle.createContext(),
    emitGatewayEvent() {},
    buildRunner(options) {
      runnerOptions.push(options);
      return new bundle.SandAgentRunner(options);
    },
    createRequestContext: () => ({
      resolve: () => ({ timeZone: "UTC" }),
      resolveRules: async () => [],
    }),
  });
  const runner = composition.createRunner(
    {
      id: AGENT_ID,
      dbPath: path.join(directory, "agent", "store.db"),
      agentStore: {
        getBlobStore: () => ({
          getBlob: async () => undefined,
          setBlob: async () => {},
        }),
        getConversationStateStructure: () =>
          new bundle.ConversationStateStructure({
            turns: [],
            summaryArchives: [],
            turnTimings: [],
          }),
        getMetadata: () => undefined,
      },
    },
    { transport: { onUpdate() {} } },
  );
  const parentShell = runnerOptions[0].productionTurnRunShell;
  assert.ok(
    parentShell !== undefined,
    "the composition must hand the runner a production turn shell, or the wiring below is unmeasurable",
  );

  /**
   * Dispatches a `Task` subagent the way a turn does: through the owner input the composition
   * produced, which is the only place its `createSubagentRunner` lives.
   */
  async function dispatchSubagent(childId) {
    // The seam's capture array belongs to THIS bundle, so emptying it here
    // also proves each dispatch produced exactly one owner input of its own.
    bundle[OWNER_INPUTS].length = 0;
    await assert.rejects(
      () =>
        parentShell.createOwner({
          requestId: `request-${childId}`,
          runOptions: {},
          context: bundle.createContext(),
          cancelThisRun() {},
          emitUpdate() {},
        }),
      new RegExp(SEAM_MESSAGE),
      "the fixture seam is the only thing allowed to stop owner construction",
    );
    assert.equal(
      bundle[OWNER_INPUTS].length,
      1,
      "the dispatch must reach the composition's owner input exactly once",
    );
    const ownerInput = bundle[OWNER_INPUTS][0];
    const projection = ownerInput.createTurnLocalResourceProjectionInput({
      get: () => undefined,
    });
    projection.createSubagentRunner(childId, { subagentType: "generalPurpose" });
    const childOptions = runnerOptions.at(-1);
    assert.equal(
      childOptions.conversationId,
      childId,
      "the composition must build the child runner for the child's own id",
    );
    return childOptions;
  }

  return {
    composition,
    runner,
    runnerOptions,
    parentShell,
    dispatchSubagent,
    async dispose() {
      await composition.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** What a controller-like object answers, without letting a missing method throw past the test. */
function describeEpochApi(candidate, agentId = AGENT_ID) {
  if (candidate === undefined || candidate === null) {
    return { present: false, methods: [], reads: undefined, error: undefined };
  }
  const methods = ["beginTurn", "directionEpoch"].filter(
    name => typeof candidate[name] === "function",
  );
  let reads;
  let error;
  try {
    reads = candidate.directionEpoch(agentId);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  return { present: true, methods, reads, error };
}

/**
 * One measurement of the whole seam, taken against a bundle and returned as plain data so every
 * falsification can be compared with the same probe.
 *
 * `bundle` is a parameter because each falsification builds its OWN copy of the composition, and a
 * fixture that crossed two bundles would be measuring a different application than the one under
 * test.
 */
async function probeWiring(bundle, options = {}) {
  const host = await productionHost(bundle, options);
  try {
    const parentController = describeEpochApi(host.parentShell.localToolPermission);
    const parentRunner = describeEpochApi(host.runner.localToolPermission);

    // What `SandAgentRunner` does once per turn through the shell's optional hook
    // (`sand-agent-runner.ts:508`), done here by hand because no turn is run.
    const beginTurn = host.parentShell.localToolPermission?.beginTurn;
    if (typeof beginTurn === "function") beginTurn.call(host.parentShell.localToolPermission, AGENT_ID);
    const epochAfterFirstTurn = describeEpochApi(host.parentShell.localToolPermission).reads;

    const firstChild = await host.dispatchSubagent(FIRST_CHILD_ID);
    if (typeof beginTurn === "function") beginTurn.call(host.parentShell.localToolPermission, AGENT_ID);
    const epochAfterSecondTurn = describeEpochApi(host.parentShell.localToolPermission).reads;
    const secondChild = await host.dispatchSubagent(SECOND_CHILD_ID);

    const readChild = (childOptions, childId) => ({
      controller: describeEpochApi(childOptions.productionTurnRunShell.localToolPermission, childId),
      isSubagentRunner: childOptions.productionTurnRunShell.isSubagentRunner,
      inheritedDirectionEpoch: childOptions.productionTurnRunShell.inheritedDirectionEpoch,
      // The child id is NOT in the controller's map; this is the number the
      // child would fall back to if it read its own id.
      ownEpoch: childOptions.productionTurnRunShell.localToolPermission?.directionEpoch?.(childId),
      conversationId: childId,
    });

    return {
      parent: {
        controller: parentController,
        runnerController: parentRunner,
        runnerInherited: host.runner.inheritedDirectionEpoch,
        isSubagentRunner: host.parentShell.isSubagentRunner,
      },
      epochAfterFirstTurn,
      epochAfterSecondTurn,
      firstChild: readChild(firstChild, FIRST_CHILD_ID),
      secondChild: readChild(secondChild, SECOND_CHILD_ID),
    };
  } finally {
    await host.dispose();
  }
}

// --- Obligations -----------------------------------------------------------

test("the parent's production turn shell carries the live permission controller", async () => {
  const measured = await probeWiring(loaded);

  assert.deepEqual(
    measured.parent.controller.methods,
    ["beginTurn", "directionEpoch"],
    "the shell must carry the live controller's own two methods; a field that is absent, or a projection that keeps only awaitDesktopStandingDecision/completeScope, leaves every turn running under epoch 0 with nothing failing",
  );
  assert.equal(
    measured.parent.controller.error,
    undefined,
    "reading the epoch through the shell's controller must not throw, or `resolveTurnDirectionEpoch` fails inside the turn",
  );
  assert.equal(
    measured.epochAfterFirstTurn,
    1,
    "the shell's controller must be the LIVE one, so a direction opened through it is the direction the turn reads",
  );
  assert.equal(
    measured.epochAfterSecondTurn,
    2,
    "a second turn must open a second direction; a snapshot of the controller would stay at 1 and keep every refusal stamped with the first turn's number",
  );
  assert.equal(
    measured.parent.isSubagentRunner,
    false,
    "the fixture must be measuring the parent's own shell, the one `createRunner` assigns at the end of its own body",
  );
  assert.equal(
    measured.parent.runnerInherited,
    undefined,
    "a parent opens its own direction, so it must not carry an inherited one",
  );
});

test("the runner the app really constructs reads that controller off the shell", async () => {
  const measured = await probeWiring(loaded);

  assert.deepEqual(
    measured.parent.runnerController.methods,
    ["beginTurn", "directionEpoch"],
    "`SandAgentRunner` reads `productionTurnRunShell.localToolPermission` in its constructor; a shell the composition did not fill leaves the runner with nothing to call and no hook to bind",
  );
});

test("a Task subagent's shell carries the same controller and the parent's direction", async () => {
  const measured = await probeWiring(loaded);

  assert.deepEqual(
    measured.firstChild.controller.methods,
    ["beginTurn", "directionEpoch"],
    "a subagent's shell is built by the same production builder, so the controller must reach it too — a `Task` child with no controller is the defect one level down",
  );
  assert.equal(
    measured.firstChild.isSubagentRunner,
    true,
    "the fixture must be measuring the shell built inside the turn, not the parent's own shell a second time",
  );
  assert.equal(
    measured.firstChild.inheritedDirectionEpoch,
    1,
    "a subagent's own id is not in the controller's map, so without the inherited number it runs under 0 and compares its refusals against the wrong direction",
  );
  assert.equal(
    measured.firstChild.ownEpoch,
    0,
    "the child id must genuinely be unknown to the controller, or this test would pass for the wrong reason",
  );
});

test("the inherited direction follows the parent's next turn, not the first one", async () => {
  const measured = await probeWiring(loaded);

  assert.equal(
    measured.secondChild.inheritedDirectionEpoch,
    2,
    "the epoch must be read at dispatch; a value captured when the parent's shell was built would retire the child's refusal one turn late",
  );
});

test("a host with no permission extension builds a shell that opens no direction", async () => {
  const measured = await probeWiring(loaded, { withPermissionExtension: false });

  assert.equal(
    measured.parent.controller.present,
    false,
    "an absent permission extension must leave the field absent, not hand the shell an object with no methods",
  );
  assert.equal(
    measured.firstChild.inheritedDirectionEpoch,
    undefined,
    "with no controller there is no direction to inherit, and the turn must carry the context's own undefined rather than a fabricated 0",
  );
});

// --- Falsification ---------------------------------------------------------
//
// Each obligation is measured by the SAME probe against a build whose composition is different, and
// the test asserts that the obligation is broken there. A test that cannot fail on the code it
// claims to describe proves nothing. The repository is never written to; only esbuild's view of it
// changes.

test("the committed composition builds both shells with no controller at all", async () => {
  const head = await load([gitHeadOn([COMPOSITION_RELATIVE])]);
  try {
    const measured = await probeWiring(head.loaded);

    assert.equal(
      measured.parent.controller.present,
      false,
      "this is the defect: `createProductionTurnRunShellHostInput` is called without `localToolPermission`, so `SandAgentRunner.localToolPermission` is undefined and every turn runs under epoch 0",
    );
    assert.equal(
      measured.parent.runnerController.present,
      false,
      "the runner reads the same absent field, so the shell's `beginLocalToolPermissionTurn` hook is never bound and no direction is ever opened",
    );
    assert.equal(
      measured.epochAfterFirstTurn,
      undefined,
      "with nothing bound the fixture cannot even open a direction, which is the silence this defect hid behind",
    );
    assert.equal(
      measured.firstChild.inheritedDirectionEpoch,
      undefined,
      "and the subagent has neither a controller nor a direction to inherit",
    );
  } finally {
    head.dispose();
  }
});

test("passing the toolset projection is caught: it has neither method a turn calls", async () => {
  const mutated = await load([
    mutationOn(
      COMPOSITION_RELATIVE,
      ": { localToolPermission: turnLocalToolPermission }),",
      ": { localToolPermission: projectedLocalToolPermission }),",
    ),
  ]);
  try {
    const measured = await probeWiring(mutated.loaded);

    assert.deepEqual(
      measured.parent.controller.methods,
      [],
      "`asLocalToolPermissionProjection` keeps only awaitDesktopStandingDecision and completeScope, so a shell built from it answers with no direction method at all — this is the repair that looks right and leaves the epoch at 0",
    );
    assert.equal(
      measured.parent.controller.error,
      "candidate.directionEpoch is not a function",
      "reading the epoch through the projection must fail loudly here, where it would have failed silently inside a live turn",
    );
    assert.equal(
      measured.epochAfterFirstTurn,
      undefined,
      "no direction can be opened through a projection, so every turn would keep running under epoch 0",
    );
  } finally {
    mutated.dispose();
  }
});

test("dropping only the inherited epoch is caught: the child runs under its own 0", async () => {
  const mutated = await load([
    mutationOn(
      COMPOSITION_RELATIVE,
      "...(scope.inheritedDirectionEpoch === undefined",
      "...(true",
    ),
  ]);
  try {
    const measured = await probeWiring(mutated.loaded);

    assert.deepEqual(
      measured.parent.controller.methods,
      ["beginTurn", "directionEpoch"],
      "the parent keeps the controller in this build, so only the inherited number is missing",
    );
    assert.equal(
      measured.firstChild.inheritedDirectionEpoch,
      undefined,
      "this is the second half of the defect: a wired controller still leaves a subagent reading its own id, which the controller has never seen and answers with 0",
    );
    assert.equal(
      measured.firstChild.ownEpoch,
      0,
      "so the child's refusal memory would be compared against 0 and never retired by the parent's next direction",
    );
  } finally {
    mutated.dispose();
  }
});
