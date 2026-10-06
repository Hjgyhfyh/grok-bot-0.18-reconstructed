import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The agent's own workspace has to stay readable while the token beside it stays unreachable.
 *
 * WHAT THIS PINS. `resolveLocalExecRoot` used to fall back to the user's whole
 * home directory, so the root boundary contained nothing: the agent could read
 * `AppData\Local\GrokBotLocalBox\gateway.json`, which carries the loopback
 * gateway bearer token, plus `launcher-secrets.txt`, `launcher-gateway-token.txt`
 * and `.ssh`. Moving the default root to the box workspace closed that and, in
 * the same change, made the agent's own working directory — where Shell already
 * writes — the one place its file tools are allowed to reach.
 *
 * The two halves pull in opposite directions and that is the point: a fix that
 * made the store unreachable by also making the workspace unreachable would
 * pass a token test and leave the agent unable to read a file it had just
 * written. So this drives the real production executor, not the resolver, over
 * the layout measured on this host — workspace laid out *inside* the sand root,
 * siblings and all — and asserts both halves in the same run.
 *
 * `ls` is included rather than left out because it is the tool whose wiring was
 * incomplete: an executor can have a correct root and a correct guard and still
 * be unable to list, which is invisible to every test that stops at the guard.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleExecutor() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-ownworkspace-"));
  const outfile = path.join(directory, "production-executor.cjs");
  await build({
    stdin: {
      contents: [
        'export * from "./source/local-exec-daemon/production-executor";',
        'export { resolveLocalExecRoot } from "./source/host/local-exec/local-exec-machine";',
        'export { ExecServerMessage } from "./source/packages/proto/generated/agent/v1/exec_pb";',
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "own-workspace-entry.ts",
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

async function drive(executor, module, arm, value) {
  const framed = new module.ExecServerMessage({ id: 1, message: { case: arm, value } });
  const decoded = executor.decodeServerMessage(framed.toJson());
  const frames = [];
  for await (const frame of executor.execute(decoded, new AbortController().signal)) frames.push(frame);
  const thrown = frames.find((f) => f.kind === "control" && f.message.throw)?.message.throw;
  if (thrown !== undefined) return { refused: true, error: String(thrown.error ?? "") };
  const key = arm === "readArgs" ? "readResult" : arm === "lsArgs" ? "lsResult" : "writeResult";
  return { refused: false, result: frames.find((f) => f.kind === "client")?.message?.[key] };
}

/** The layout measured on this host: the workspace is a child of the sand root. */
function makeMeasuredLayout(t) {
  const sandRoot = mkdtempSync(path.join(os.tmpdir(), "grok-sandroot-"));
  t.after(() => rmSync(sandRoot, { recursive: true, force: true }));
  const root = path.join(sandRoot, "box-workspace");
  mkdirSync(path.join(root, "dash"), { recursive: true });
  writeFileSync(path.join(root, "dash", "c1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(root, "notes.md"), "workspace notes\n");
  // The host-only store the root now excludes, laid out beside the workspace.
  writeFileSync(path.join(sandRoot, "gateway.json"), '{"token":"a-token-the-agent-must-never-see"}\n');
  writeFileSync(path.join(sandRoot, "launcher-gateway-token.txt"), "a-token-the-agent-must-never-see\n");
  writeFileSync(path.join(sandRoot, "launcher-secrets.txt"), "launcher secrets\n");
  mkdirSync(path.join(os.homedir(), ".ssh"), { recursive: true });
  return { sandRoot, root };
}

test("the default local-exec root is the box workspace nested inside the sand root", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);

  const sandRoot = mkdtempSync(path.join(os.tmpdir(), "grok-resolve-"));
  t.after(() => rmSync(sandRoot, { recursive: true, force: true }));

  const root = module.resolveLocalExecRoot({ SAND_DATA_ROOT: sandRoot });
  assert.equal(
    root,
    path.join(sandRoot, "box-workspace"),
    "the default root has to be the workspace the agent works in, inside the same sand root the daemon is given",
  );
  assert.notEqual(
    root,
    os.homedir(),
    "a root equal to the home directory contains gateway.json, .ssh and every other file the account owns",
  );
});

test("read, ls and edit all work inside the agent's own workspace", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);
  const { root } = makeMeasuredLayout(t);
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  const read = await drive(executor, module, "readArgs", { path: path.join(root, "notes.md") });
  assert.equal(read.refused, false, "the file the agent's own Shell wrote has to be readable, or it cannot check its own work");
  assert.equal(
    read.result?.success?.content,
    "workspace notes\n",
    "the read has to return the bytes that are on disk",
  );

  const relative = await drive(executor, module, "readArgs", { path: "notes.md" });
  assert.equal(relative.refused, false, "the same file named relative to the workspace has to read identically");
  assert.equal(relative.result?.success?.content, "workspace notes\n", "relative and absolute must agree inside the root");

  const listed = await drive(executor, module, "lsArgs", { path: "dash" });
  assert.equal(listed.refused, false, "ls inside the agent's own workspace must work");
  assert.ok(listed.result?.success !== undefined, `ls must succeed on an existing directory, and answered ${JSON.stringify(listed.result).slice(0, 200)}`);

  const written = await drive(executor, module, "writeArgs", { path: path.join(root, "dash", "written.txt"), fileText: "written\n" });
  assert.equal(written.refused, false, "Edit must be able to create a file in the agent's own workspace");
  assert.equal(
    readFileSync(path.join(root, "dash", "written.txt"), "utf8"),
    "written\n",
    "the edit has to land on disk",
  );
});

test("the token file beside the workspace stays unreachable through every spelling", async (t) => {
  const { module, dispose } = await bundleExecutor();
  t.after(dispose);
  const { sandRoot, root } = makeMeasuredLayout(t);
  const executor = module.createDefaultProductionLocalExecExecutor({ root });

  const targets = [
    path.join(sandRoot, "gateway.json"),
    path.join(sandRoot, "launcher-gateway-token.txt"),
    path.join(sandRoot, "launcher-secrets.txt"),
    path.join(root, "..", "gateway.json"),
    `../${path.basename(sandRoot)}/gateway.json`,
    sandRoot,
    path.join(os.homedir(), ".ssh"),
    "\\\\127.0.0.1\\c$\\Users\\Public\\gateway.json",
  ];

  for (const target of targets) {
    const read = await drive(executor, module, "readArgs", { path: target });
    assert.equal(
      read.refused,
      true,
      `reading ${target} must be refused, and it succeeded — this is how the loopback gateway bearer token leaves the box`,
    );
    assert.match(
      read.error,
      /outside the allowed local-exec root/,
      `the refusal for ${target} has to name the root boundary, and said: ${read.error}`,
    );

    const listed = await drive(executor, module, "lsArgs", { path: target });
    assert.equal(listed.refused, true, `ls on ${target} must be refused too, or the store can be enumerated`);
  }
});