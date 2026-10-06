import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * `ls` was wired into the daemon and could only ever throw.
 *
 * WHAT BROKE. `LocalLsExecutor` takes its directory traversal as a fourth
 * constructor argument and throws `MissingLsTraversalBindingError` when that
 * argument is absent (`source/packages/local-exec/ls.ts:20`).
 * `createDefaultProductionLocalExecExecutor` registered `lsExecutorResource`
 * and then built the executor with three arguments:
 *
 *   const lsExecutor = new LocalLsExecutor(permissionsService, ignoreService, root);
 *
 * so the resource answered the network and the only thing it could answer with
 * was a `MissingLsTraversalBindingError`.
 *
 * WHAT NOTHING NOTICED. The failure is invisible at two separate layers, which
 * is why it survived. First, `ls.ts:18` stats the path and returns a real
 * `LsError` when it does not exist, so `ls` on a missing path produced a
 * perfectly readable "Path does not exist" and looked like a working tool.
 * Second, `MissingLsTraversalBindingError` called `super("")`, and protobuf omits
 * empty string fields, so the `ExecClientThrow` that reached the client carried
 * no `error` member at all. Measured on the unfixed graph:
 *
 *   lsArgs { path: "does-not-exist" } -> lsResult.error "Path does not exist: ..."
 *   lsArgs { path: "dir" }            -> ExecClientThrow, 'error' in payload === false
 *
 * An agent listing a directory therefore got silence, while listing a typo got
 * a sentence. Nothing in a transcript distinguishes "the tool is broken" from
 * "the tool refused".
 *
 * These tests drive the real production factory, not the executor class in
 * isolation, because the defect is in the wiring: the class behaved correctly
 * for the argument it was given.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Bundles the production executor together with the generated protobuf classes.
 *
 * The entry is virtual so no stray source file is added to the repository, and
 * the framing goes through the real `ExecServerMessage` rather than a
 * hand-written JSON guess — a guessed oneof name decodes to `case: undefined`
 * and every assertion below would then pass or fail for the wrong reason.
 */
async function bundleExecutor() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-ls-exec-"));
  const outfile = path.join(directory, "production-executor.cjs");
  await build({
    stdin: {
      contents: [
        'export * from "./source/local-exec-daemon/production-executor";',
        'export * from "./source/packages/local-exec/ls";',
        'export { ExecServerMessage } from "./source/packages/proto/generated/agent/v1/exec_pb";',
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "ls-probe-entry.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return { module: createRequire(import.meta.url)(outfile), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

async function ls(executor, module, target) {
  const framed = new module.ExecServerMessage({ id: 1, message: { case: "lsArgs", value: { path: target } } });
  const decoded = executor.decodeServerMessage(framed.toJson());
  const frames = [];
  for await (const frame of executor.execute(decoded, new AbortController().signal)) frames.push(frame);
  return frames;
}

function thrownError(frames) {
  const frame = frames.find((f) => f.kind === "control" && f.message.throw !== undefined);
  return frame?.message.throw;
}

function clientPayload(frames, key) {
  const frame = frames.find((f) => f.kind === "client");
  return frame?.message?.[key];
}

function collectNames(node, out = []) {
  if (node == null) return out;
  for (const file of node.childrenFiles ?? []) out.push(file.name);
  for (const dir of node.childrenDirs ?? []) collectNames(dir, out);
  return out;
}

test("the production local-exec graph lists a directory that exists instead of throwing", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-ls-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "dash"), { recursive: true });
  writeFileSync(path.join(root, "dash", "c1.txt"), "one\n");
  writeFileSync(path.join(root, "dash", "c2.txt"), "two\n");
  writeFileSync(path.join(root, "top.txt"), "top\n");

  const executor = module.createDefaultProductionLocalExecExecutor({ root });
  const frames = await ls(executor, module, "dash");

  assert.equal(
    thrownError(frames),
    undefined,
    "the traversal runtime is the fourth LocalLsExecutor argument and the production wiring omitted it, so every existing directory threw MissingLsTraversalBindingError",
  );

  const result = clientPayload(frames, "lsResult");
  assert.ok(result != null, `the client frame carried no lsResult: ${JSON.stringify(frames).slice(0, 300)}`);
  assert.equal(
    result.success !== undefined ? "success" : Object.keys(result)[0],
    "success",
    `ls on an existing directory inside the root must succeed, and answered ${JSON.stringify(result).slice(0, 300)}`,
  );

  const names = collectNames(result.success.directoryTreeRoot);
  assert.deepEqual(
    [...names].sort(),
    ["c1.txt", "c2.txt"],
    "the listing must name the two files that are in the directory it was asked about",
  );
});

test("a missing path and an existing path no longer disagree about whether ls works", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-ls-compare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "here"), { recursive: true });

  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  const missing = clientPayload(await ls(executor, module, "not-here"), "lsResult");
  assert.equal(
    missing.error !== undefined ? "error" : Object.keys(missing)[0],
    "error",
    "a path that does not exist must still answer with a readable LsError",
  );
  assert.match(String(missing.error?.error ?? ""), /does not exist/i, "and that error has to name what went wrong");

  const existing = thrownError(await ls(executor, module, "here"));
  assert.equal(
    existing,
    undefined,
    "before the fix an existing directory threw while a missing one answered with a sentence, so the tool looked alive for exactly the calls that could not succeed",
  );
});

test("any error the ls path can raise names itself instead of arriving blank", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-ls-msg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "here"), { recursive: true });

  // The unbound executor is still constructible and is the one shape that can
  // reach `MissingLsTraversalBindingError`, so the message is asserted here
  // rather than through the factory that no longer produces it.
  const bare = new module.LocalLsExecutor({ shouldBlockRead: async () => false }, {
    listCursorIgnoreFilesByRoot: async () => [],
    getRepoBlockExcludeGlobs: async () => [],
    isRepoBlocked: async () => false,
  }, root);

  let raised;
  try {
    await bare.execute({ signal: new AbortController().signal, withTimeout: (ms) => ({ signal: new AbortController().signal }) }, { path: "here" });
  } catch (error) { raised = error; }

  assert.ok(raised != null, "constructing LocalLsExecutor without a traversal must still raise, or this class lost its own guard");
  assert.equal(raised.name, "MissingLsTraversalBindingError", "the raised error has to be the traversal one for the assertion to mean anything");
  assert.ok(
    String(raised.message).trim().length > 0,
    `MissingLsTraversalBindingError called super(""), and protobuf omits empty string fields, so the client received an ExecClientThrow with no 'error' member at all: ${JSON.stringify(raised.message)}`,
  );
});

test("the ls listing still stops at the root boundary", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-ls-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-ls-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "elsewhere.txt"), "not yours\n");
  mkdirSync(path.join(root, "inside"), { recursive: true });
  writeFileSync(path.join(root, "inside", "mine.txt"), "mine\n");

  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  for (const target of [outside, `../${path.basename(outside)}`]) {
    const error = thrownError(await ls(executor, module, target));
    assert.ok(error != null, `ls outside the root (${target}) must be refused, and it listed the directory instead`);
    assert.match(String(error.error), /outside the allowed local-exec root/, "the refusal has to name the root boundary");
  }

  const ok = clientPayload(await ls(executor, module, "inside"), "lsResult");
  const names = collectNames(ok.success?.directoryTreeRoot);
  assert.deepEqual(names, ["mine.txt"], "the ordinary listing inside the root must keep working after the fix");
  assert.ok(
    !names.includes("elsewhere.txt"),
    "a listing must never name a file that lives outside the local-exec root",
  );
});