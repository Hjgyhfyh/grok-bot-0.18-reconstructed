import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Shell was the only tool in this product that writes a file: there is no
// Write, no Edit and no ApplyPatch. Auto-review ran its verdict through
// `classifySandAutoReview`, a cloud RPC on `aiserver.v1.DashboardService` that
// needs an access token, so on an account-less build it failed every time.
// `runShellSmartModeClassifier` reported that failure as `unreviewed`, and the
// consumer turned `unreviewed` into `ShellToolRejectedError` whenever no
// approval provider was bound — so enforce mode without an account rejected
// every shell command forever and the agent could not create, change or save a
// single file. Nothing caught it: shadow mode is fire-and-forget, the enforce
// path is only reachable with a Cursor account, and the suite had no host with
// neither account nor approval card. These tests drive the real classifier and
// the real command-acceptance path through esbuild, and they now prove that a
// classifier nobody could consult blocks nothing while a real `block` still
// blocks.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

// The bundle reaches a CommonJS dependency (`jsonc-parser`), and esbuild's ESM
// output has no `require` to give it. The shim is anchored on this file, which
// sits next to the repository's `node_modules`, because the bundle itself lives
// in a temp directory that has none.
const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

// One esbuild invocation with code splitting keeps a single module instance per
// source file, so the `symbol` on each Resource here is the same object the
// bundled shell tool compares against. Two separate bundles would silently
// produce two identities and every lookup would miss.
async function bundleShellTool() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-shell-auto-review-"));
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "create-shell-tool.ts"),
      path.join(sourceRoot, "packages", "agent-exec", "smart-mode-classifier.ts"),
      path.join(sourceRoot, "packages", "agent-exec", "shell-stream.ts"),
      path.join(sourceRoot, "packages", "proto", "generated", "agent", "v1", "shell_exec_pb.ts"),
      path.join(sourceRoot, "packages", "proto", "generated", "agent", "v1", "smart_mode_classifier_exec_pb.ts"),
      path.join(sourceRoot, "packages", "context", "core.ts"),
      path.join(sourceRoot, "host", "extensions", "auto-review", "auto-review-service.ts"),
    ],
    outdir: directory,
    // The entries span several packages, so esbuild would otherwise nest each
    // output under its path relative to `source`. Flattening keeps the loader
    // below a single directory while splitting still shares one module
    // instance per source file.
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    // `outdir` alone emits `.js`, which Node reads as CommonJS because the
    // temp directory has no package.json. Without this every import fails with
    // ERR_REQUIRE_ESM before a single assertion runs.
    outExtension: { ".js": ".mjs" },
    banner: REQUIRE_BANNER,
    // `jsonc-parser` ships a UMD build whose factory calls a dynamic
    // `require("./impl/format")`; esbuild cannot resolve that from a bundle
    // sitting in a temp directory. Preferring `module` picks the ESM build
    // instead, which is what a bundler-style resolution does.
    mainFields: ["module", "main"],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const load = (name) => import(pathToFileURL(path.join(directory, `${name}.mjs`)).href);
  return {
    shellTool: await load("create-shell-tool"),
    classifierResource: await load("smart-mode-classifier"),
    streamResource: await load("shell-stream"),
    shellExec: await load("shell_exec_pb"),
    classifierProto: await load("smart_mode_classifier_exec_pb"),
    context: await load("core"),
    serviceDir: directory,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const built = await bundleShellTool();
test.after(() => built.dispose());

const { createShellTool, ShellToolRejectedError } = built.shellTool;
const { shellStreamExecutorResource } = built.streamResource;
const { smartModeClassifierExecutorResource } = built.classifierResource;
const { ShellStream, ShellStreamExit } = built.shellExec;
const { SmartModeClassifierResult, SmartModeClassifierDecision } = built.classifierProto;
const { createContext } = built.context;

const ENFORCE_ENV = { smartModeClassifierAutoModeEnabled: true };

/**
 * Runs one shell command through the real tool and reports whether it reached
 * the executor, which is the only place a command can actually run.
 *
 * `classifier` is the real executor resource implementation the tool fetches by
 * symbol, so a throw here is the exact "no token, RPC failed" shape of an
 * account-less build.
 */
async function runCommand({ classifierMode, classifier, approvalProvider }) {
  const state = { commandRan: false, approvalRequests: 0, error: undefined };
  const streamExecutor = {
    async *execute(_ctx, args) {
      state.commandRan = true;
      yield new ShellStream({
        event: { case: "exit", value: new ShellStreamExit({ code: 0, aborted: false, localExecutionTimeMs: 1 }) },
      });
      void args;
    },
  };
  const classifierExecutor = {
    execute: async (_ctx, args) => {
      if (typeof classifier === "function") return await classifier(args);
      return classifier;
    },
  };
  const bySymbol = new Map([
    [shellStreamExecutorResource.symbol, streamExecutor],
    [smartModeClassifierExecutorResource.symbol, classifierExecutor],
  ]);
  const resourceAccessor = {
    get(resource) {
      const implementation = bySymbol.get(resource.symbol);
      if (implementation === undefined) throw new Error("the tool asked for a resource this host does not provide");
      return implementation;
    },
  };
  const provider = approvalProvider === undefined ? undefined : {
    async requestApproval() {
      state.approvalRequests += 1;
      return await approvalProvider();
    },
  };
  const tool = createShellTool(resourceAccessor, {
    ...(classifierMode === "off" ? {} : { smartModeClassifierMode: classifierMode === "enforce" }),
    ...(classifierMode === "shadow" ? { smartModeClassifierShadowMode: true } : {}),
    ...(classifierMode === "enforce" ? { requestContext: { env: ENFORCE_ENV }, smartModeClassifierMaxAttempts: 1 } : {}),
    ...(provider === undefined ? {} : { smartModeApprovalProvider: provider }),
  });
  const abort = new AbortController();
  const interaction = {
    getAbortSignal: () => abort.signal,
    emitPartialToolCall: async () => {},
    executeToolCall: async (ctx, _call, _id, execute) => await execute(ctx),
  };
  try {
    await tool.execute(createContext(), interaction, (async function* () { yield JSON.stringify({ command: "echo grok" }); })(), { toolCallId: "tool-call-1", workspacePaths: [] });
  } catch (error) {
    state.error = error;
  }
  return state;
}

/** The failure an account-less build produces: the RPC has no token to send. */
async function classifierUnavailable() {
  throw Object.assign(new Error("unauthenticated"), { code: "UNAUTHENTICATED" });
}

function allowDecision() {
  return new SmartModeClassifierResult({ result: { case: "success", value: { decision: SmartModeClassifierDecision.ALLOW } } });
}

function blockDecision() {
  return new SmartModeClassifierResult({ result: { case: "success", value: { decision: SmartModeClassifierDecision.BLOCK, blockReason: "exfiltrates a credential" } } });
}

test("a classifier that never ran cannot reject a command when no human can be asked", async () => {
  const enforced = await runCommand({ classifierMode: "enforce", classifier: classifierUnavailable });
  assert.equal(enforced.commandRan, true, "an unreviewed command must run when no approval provider exists, because refusing it strands the agent with no way to write a file");
  assert.equal(enforced.approvalRequests, 0, "nothing can be asked when no approval provider is bound");
  assert.equal(enforced.error, undefined, "the tool must not reject a command it never reviewed");
});

test("a real block still stops the command when no approval provider exists", async () => {
  const blocked = await runCommand({ classifierMode: "enforce", classifier: blockDecision });
  assert.equal(blocked.commandRan, false, "a block decision is a verdict, so it must keep rejecting");
  assert.ok(blocked.error instanceof ShellToolRejectedError, "the block must surface as ShellToolRejectedError so the model sees why");
  assert.match(String(blocked.error.reason), /exfiltrates a credential/, "the classifier's own reason must reach the model");
});

test("an unreviewed command still asks the human when an approval provider is bound", async () => {
  const denied = await runCommand({
    classifierMode: "enforce",
    classifier: classifierUnavailable,
    approvalProvider: async () => ({ approved: false, reason: "not now" }),
  });
  assert.equal(denied.approvalRequests, 1, "the human must still be asked once when a provider can ask");
  assert.equal(denied.commandRan, false, "a human who says no must be obeyed");
});

test("an unreviewed command runs once the human approves it", async () => {
  const approved = await runCommand({
    classifierMode: "enforce",
    classifier: classifierUnavailable,
    approvalProvider: async () => ({ approved: true }),
  });
  assert.equal(approved.commandRan, true, "an approved command must reach the executor");
});

test("an allowed verdict still runs with no approval provider bound", async () => {
  const allowed = await runCommand({ classifierMode: "enforce", classifier: allowDecision });
  assert.equal(allowed.commandRan, true, "an ALLOW verdict must not need an approval card");
});

test("a dead classifier in shadow mode never stops anything", async () => {
  const shadow = await runCommand({ classifierMode: "shadow", classifier: classifierUnavailable });
  assert.equal(shadow.commandRan, true, "shadow mode is fire-and-forget and must not block");
});

test("auto-review switched off runs the command without consulting anything", async () => {
  const off = await runCommand({
    classifierMode: "off",
    classifier: () => { throw new Error("the classifier must not be consulted when auto-review is off"); },
  });
  assert.equal(off.commandRan, true, "an off host must not gate the command at all");
});

/**
 * The shell tool refuses nothing now, so the other half of the fix has to hold:
 * a host with no account must never resolve Auto-review to a mode at all.
 * Enforcing there makes every classifier call throw, which is how the permanent
 * block was reached in the first place.
 */
async function resolveServiceModes({ experiments, auth }) {
  const { AutoReviewService } = await import(pathToFileURL(path.join(built.serviceDir, "auto-review-service.mjs")).href);
  const service = new AutoReviewService({
    auth,
    experiments,
    settings: { getAutoReviewInstructions: () => ({ isEnabled: true, allowInstructions: [], blockInstructions: [] }) },
    telemetry: { reportAutoReviewDisplayRecheckFailed: () => {}, reportAutoReviewApproval: () => {} },
    awaitingSink: { clearForTab: () => {} },
    transcript: { settleStaleAutoReviewCard: async () => false },
    hostGeneration: "test",
    createClassifierExecutor: () => ({}),
  });
  return service.bindRunner({ agentId: "agent-1", onUpdate: () => {} }).autoReviewModes;
}

test("a host with an access token resolves Auto-review to enforce", async () => {
  const modes = await resolveServiceModes({
    experiments: { checkFeatureGate: () => true, hasAuthenticatedStatsigBootstrap: () => true },
    auth: { peekAccessToken: () => "token-present" },
  });
  assert.equal(modes.hostShell, "enforce", "a signed-in host must keep its enforce mode, or the safety feature is silently gone for real users");
});

test("a host without an access token resolves Auto-review to off", async () => {
  const modes = await resolveServiceModes({
    experiments: { checkFeatureGate: () => true, hasAuthenticatedStatsigBootstrap: () => false },
    auth: { peekAccessToken: () => null },
  });
  assert.equal(modes.hostShell, "off", "a host that cannot reach classifySandAutoReview must not resolve to a mode that keeps calling it");
});

test("a host whose bootstrap never authenticated resolves Auto-review to off even with the gate on", async () => {
  const modes = await resolveServiceModes({
    experiments: { checkFeatureGate: () => true, hasAuthenticatedStatsigBootstrap: () => false },
    auth: {},
  });
  assert.equal(modes.hostShell, "off", "a feature gate with no authenticated bootstrap behind it is not evidence that Auto-review can run");
});