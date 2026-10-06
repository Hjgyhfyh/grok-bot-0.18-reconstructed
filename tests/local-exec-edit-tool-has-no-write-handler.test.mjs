import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The Edit tool had no write handler in the production local-exec graph.
 *
 * WHAT BROKE. `createDefaultProductionLocalExecExecutor` registers four
 * resources — shellStream, backgroundShell, read and ls — and nothing else.
 * The agent's Edit tool resolves its writer through the accessor:
 *
 *   source/packages/agent/tools/core/edit/common.ts:98
 *     const writeExecutor: WriteExecutor = resourceAccessor.get(writeExecutorResource);
 *
 * `writeExecutorResource` was never registered, so `SimpleControlledExecManager`
 * fell through every handler and answered
 *
 *   ExecClientThrow "No handler found for server message of type writeArgs"
 *
 * on every single Edit. Writing a new file and changing an existing one were
 * equally impossible; nothing about the request was ever inspected.
 *
 * WHAT NOTHING NOTICED. The permission service built three lines above the
 * registry has always implemented `shouldBlockWrite`, and nothing in the tree
 * called it. That is the exact shape a missing registration leaves behind: a
 * check that exists, is correct, and is reachable from nowhere. It also means
 * the boundary this test re-asserts was never in doubt — the writer was
 * missing, not unguarded, and adding it back must not move the guard.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleExecutor() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-write-exec-"));
  const outfile = path.join(directory, "production-executor.cjs");
  await build({
    stdin: {
      contents: [
        'export * from "./source/local-exec-daemon/production-executor";',
        'export { ExecServerMessage } from "./source/packages/proto/generated/agent/v1/exec_pb";',
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "write-probe-entry.ts",
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

async function write(executor, module, value) {
  const framed = new module.ExecServerMessage({ id: 1, message: { case: "writeArgs", value } });
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

test("creating a new file with Edit writes it inside the root", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-write-new-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  const frames = await write(executor, module, { path: "created.txt", fileText: "first line\n" });

  assert.equal(
    thrownError(frames),
    undefined,
    "writeExecutorResource was never registered, so every Edit answered 'No handler found for server message of type writeArgs'",
  );
  const result = clientPayload(frames, "writeResult");
  assert.ok(result?.success !== undefined, `the write must report success, and answered ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(result.success.path, path.join(root, "created.txt"), "the result has to name the file that was written");
  assert.equal(
    readFileSync(path.join(root, "created.txt"), "utf8"),
    "first line\n",
    "the bytes the tool asked for have to be on disk, not just in the reply",
  );
});

test("modifying an existing file with Edit replaces its contents", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-write-modify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "existing.txt"), "old content\n");
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  const frames = await write(executor, module, { path: "existing.txt", fileText: "new content\n" });

  assert.equal(thrownError(frames), undefined, "modifying an existing file has to reach a handler");
  const result = clientPayload(frames, "writeResult");
  assert.ok(result?.success !== undefined, `the modification must report success, and answered ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(
    readFileSync(path.join(root, "existing.txt"), "utf8"),
    "new content\n",
    "a modified file must not keep the contents it had, which is the half of Edit that create-new could never prove",
  );
});

test("Edit creates the directories a new path needs", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-write-mkdir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  const frames = await write(executor, module, { path: path.join("a", "b", "deep.txt"), fileText: "deep\n" });
  assert.equal(thrownError(frames), undefined, "a nested new file must not be refused for the directory being absent");
  assert.equal(
    readFileSync(path.join(root, "a", "b", "deep.txt"), "utf8"),
    "deep\n",
    "the nested write has to land, because the daemon promises the agent it can create files",
  );
});

test("a write outside the root is refused and the file is not created", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-write-outside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-write-target-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, "planted.txt");
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  for (const candidate of [target, path.join(root, "..", path.basename(outside), "planted.txt")]) {
    const frames = await write(executor, module, { path: candidate, fileText: "planted\n" });
    const error = thrownError(frames);
    assert.ok(error != null, `a write to ${candidate} must be refused, and it succeeded`);
    assert.match(String(error.error), /outside the allowed local-exec root/, "the refusal has to name the root boundary");
  }

  assert.equal(existsSync(target), false, "registering the write handler must not have widened what a write may create");
});

test("a write through a symlink out of the root is refused", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-write-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-write-linkout-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  let linked = true;
  try { symlinkSync(outside, path.join(root, "escape"), "junction"); } catch { linked = false; }
  if (!linked) {
    t.skip("this host refused to create the directory link the assertion needs");
    return;
  }

  const frames = await write(executor, module, { path: path.join("escape", "planted.txt"), fileText: "planted\n" });
  const error = thrownError(frames);
  assert.ok(error != null, "a write that resolves through a symlink out of the root must be refused");
  assert.match(String(error.error), /symlink/, `the refusal has to name the symlink, and said: ${error.error}`);
  assert.equal(existsSync(path.join(outside, "planted.txt")), false, "nothing may land outside the root through a link");
});