import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A subagent launch with no task in it skipped Auto-review and launched anyway.
 *
 * The Auto-review gate answers one question per surface: may this action run?
 * Every surface answers it the same way — an input the classifier cannot be
 * shown is a refusal, because a gate that cannot classify its input has no
 * verdict to report and must not invent one. Three surfaces did that. The
 * subagent launch did not.
 *
 * `buildSandSubagentLaunchReviewTarget` returns nothing for exactly one input: a
 * prompt that is empty once trimmed. The launch reviewer's branch for that was
 * `return { allowed: true, reason: "" }` — an unreviewable request read as a
 * reviewed one, with a reason field that said nothing so nothing downstream
 * could tell it apart from a real allow. `SandSubagentHostAdapter.runSession`
 * reads `review.allowed` as the whole gate and dispatches whenever it is true,
 * so the blank-prompt launch started a real subagent with a real tool surface,
 * a real session, and a classifier that had never seen it.
 *
 * Measured against the real reviewer at `git HEAD`, one blank prompt per mode:
 *
 *   mode=off      -> no reviewer at all (undefined): the gate is not installed,
 *                    which is a stated configuration and not a decision
 *   mode=shadow   -> allowed:true, no card, classifier never consulted
 *   mode=enforce  -> allowed:true, reason "", the adapter dispatches the launch
 *
 * The branch also sat above `input.autoReviewGate.assertNoPendingApproval()`, so
 * a blank prompt walked past the "another action is already waiting" check as
 * well as past the classifier. That part is not a separate test: the gate check
 * count is the same before and after the fix, so an assertion about it cannot
 * fail and would prove nothing. The behaviour that changed, and that a test can
 * falsify, is the decision itself.
 *
 * The blank prompt is also not a task. There is nothing in it for a subagent to
 * do, so refusing it costs the agent one turn of its own work and denies nothing
 * a person asked for.
 *
 * The control pass matters here more than in most files: this gate also returns
 * `allowed:true` legitimately, for `mode:"shadow"` and for `mode:"off"` where
 * there is no reviewer at all. A test that only asserted "blank prompt is not
 * allowed" would be satisfied by a gate that refuses everything, which is a
 * different broken product.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Falsification hook.
 *
 * With `GROK_SUBAGENT_LAUNCH_HEAD=1` the same assertions run against
 * `source/host/runner/turn-agent-composition.ts` as it is at `git HEAD`, served
 * to esbuild through an `onLoad` hook. The working tree is never read for that
 * file and never written; every other file under `source/` is the working tree.
 * `npm test` never sets it.
 */
const OWNED_FILES = ["source/host/runner/turn-agent-composition.ts"];
const useGitHead = process.env.GROK_SUBAGENT_LAUNCH_HEAD === "1";

function git(args) {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_KEY_")) delete env[key];
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

function gitHeadPlugin() {
  const atHead = new Map(OWNED_FILES.map((file) => [path.join(repoRoot, ...file.split("/")), git(["show", `HEAD:${file}`])]));
  return {
    name: "grok-subagent-launch-head",
    setup(build) {
      build.onLoad({ filter: /turn-agent-composition\.ts$/ }, (args) => {
        const contents = atHead.get(path.resolve(args.path));
        return contents === undefined ? null : { contents, loader: "ts" };
      });
    },
  };
}

/**
 * The bundle is written INSIDE the repository, under the gitignored `.cache/`,
 * not into the OS temp directory.
 *
 * `packages: "external"` below leaves every bare import to be resolved by Node
 * at run time, and Node resolves those against the importing file's own
 * location. A bundle in `%TEMP%` therefore dies with `Cannot find package
 * 'zod' imported from C:\Users\...\Temp\...`, which is a resolution failure and
 * not a result. `.cache/` is in `.gitignore` line 2 and `test.after` removes it.
 */
const directory = (mkdirSync(path.join(repoRoot, ".cache"), { recursive: true }), mkdtempSync(path.join(repoRoot, ".cache", "grok-subagent-launch-")));
await build({
  stdin: {
    contents: `export { createTurnSubagentLaunchReviewer, SAND_SUBAGENT_LAUNCH_UNREVIEWABLE_REASON } from "./source/host/runner/turn-agent-composition.js";`,
    resolveDir: repoRoot,
    sourcefile: "subagent-launch-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "subagent-launch.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
  // The composition module reaches CommonJS dependencies that call `require`
  // from inside function bodies, which esbuild cannot rewrite into an ESM
  // bundle. `createRequire` is the documented bridge; without it the bundle
  // fails at BUILD time with "Dynamic require of \"path\" is not supported",
  // which is a bundling failure and not a result. `packages: "external"` keeps
  // every bare import resolved by Node at run time, which is also what stops a
  // dependency's own internal `require("./impl/...")` from being inlined.
  banner: { js: `import { createRequire as __dshCreateRequire } from "module"; const require = __dshCreateRequire(import.meta.url);` },
  packages: "external",
  plugins: useGitHead ? [gitHeadPlugin()] : [],
});
const { createTurnSubagentLaunchReviewer } = await import(pathToFileURL(path.join(directory, "subagent-launch.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

/**
 * A turn context, which is what `isTurnContext` recognises.
 *
 * `resourceAccessor.get` THROWS on purpose. Every real launch asks the executor
 * for the Smart Mode classifier through it, so a reviewer that never reaches
 * that call for a given input is proving exactly what this file turns on.
 */
function harness(mode) {
  const pendingGateChecks = [];
  let classifierLookups = 0;
  const reviewer = createTurnSubagentLaunchReviewer({
    isSubagentRunner: false,
    mode,
    agentId: "11111111-1111-4111-8111-111111111111",
    autoReviewGate: { assertNoPendingApproval: () => { pendingGateChecks.push(true); } },
    resourceAccessor: { get: () => { classifierLookups += 1; throw new Error("no classifier in this build"); } },
  });
  const context = { signal: new AbortController().signal, get: () => undefined, withCancel: () => () => {} };
  return {
    reviewer,
    pendingGateChecks,
    classifierLookups: () => classifierLookups,
    review: (prompt) => reviewer(context, { prompt, toolCallId: "call-1", subagentType: "generalPurpose" }),
  };
}

const BLANK_PROMPTS = ["", "   ", "\n", "\t\n  "];

test("the harness measured the product and not a double", () => {
  assert.equal(typeof createTurnSubagentLaunchReviewer, "function",
    "the module exports no launch reviewer, so every assertion below would pass without reaching anything");
  const enforce = harness("enforce");
  assert.notEqual(enforce.reviewer, undefined,
    "the enforce-mode reviewer was not installed, so this file is measuring the configuration that does not gate anything");
  assert.equal(harness("off").reviewer, undefined,
    "mode=off installs a reviewer, so the 'no gate configured' control below would prove nothing");
});

test("a launch with no task in it is refused, not waved through", async () => {
  for (const prompt of BLANK_PROMPTS) {
    const h = harness("enforce");
    const answer = await h.review(prompt);
    assert.equal(answer.allowed, false,
      `a launch whose prompt is ${JSON.stringify(prompt)} was allowed, so a subagent starts with a tool surface and no classifier has seen it`);
    assert.equal(typeof answer.reason, "string",
      "the refusal carries no reason, so the agent is told nothing was allowed and not why");
    assert.equal(answer.reason.trim().length > 0, true,
      "the refusal reason is blank, so it is indistinguishable from a real allow to anything that logs it");
    assert.equal(h.classifierLookups(), 0,
      `a launch whose prompt is ${JSON.stringify(prompt)} reached the classifier, so the refusal above is not the branch this file is about`);
  }
});

test("a launch with a real task in it still goes through the gate", async () => {
  // The control pass. A gate that refuses everything would satisfy every
  // assertion above; this is the proof that the real path is untouched.
  const h = harness("enforce");
  const answer = await h.review("summarise the failing test in this repo");
  assert.deepEqual(h.pendingGateChecks.length, 1,
    "a real launch did not check for a pending approval, so the gate above is measuring a branch nothing reaches");
  assert.equal(h.classifierLookups(), 1,
    "a real launch never asked for the classifier, so this reviewer is not the gate the product ships");
  assert.equal(answer.allowed, false,
    `the classifier threw and the launch was allowed anyway, so a classifier fault is a consent: ${JSON.stringify(answer)}`);
  assert.match(answer.reason ?? "", /error occurred while reviewing/i,
    `a classifier fault was reported to the agent as something other than a fault: ${JSON.stringify(answer)}`);
});

test("shadow mode still allows what it always allowed", async () => {
  // The other legitimate `allowed:true`. Shadow reports and does not block, and
  // the fix above must not have turned it into a gate.
  const h = harness("shadow");
  const answer = await h.review("summarise the failing test in this repo");
  assert.equal(answer.allowed, true,
    `shadow mode refused a launch it is supposed to watch without blocking: ${JSON.stringify(answer)}`);
});