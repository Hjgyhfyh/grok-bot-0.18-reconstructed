import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The shipped local-exec daemon built its whole permission graph out of
// `MockPermissionsService` and `MockIgnoreService`, imported from
// `../packages/local-exec/tests/common.js`. That mock answers `allow` to every
// `shouldBlock*` question before it looks at the request, so the daemon had no
// permission check at all: a shell call with a working directory outside the
// root, or a read of `%USERPROFILE%\.ssh\id_rsa`, ran unchecked. Worse, a
// production bundle took a hard dependency on a file inside a `tests/`
// directory, so "the tests" and "the product" shipped the same object. The test
// now proves the production graph refuses a target outside
// `SAND_LOCAL_EXEC_ROOT`, and that no production file reaches into `tests/`.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleExecutor() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-exec-perms-"));
  const outfile = path.join(directory, "production-executor.cjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "local-exec-daemon", "production-executor.ts")],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  // CommonJS output on purpose: the executor pulls in protobuf and shell-parser
  // packages that reach for Node built-ins through `require`, which an ESM
  // bundle turns into "Dynamic require of ... is not supported".
  return { module: createRequire(import.meta.url)(outfile), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("the production local-exec graph refuses a shell target outside the local-exec root", async (t) => {
  const { module: executorModule, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-local-exec-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-local-exec-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const permissions = executorModule.createLocalExecPermissionsService({ root });
  assert.equal(
    typeof permissions.shouldBlockShellCommand,
    "function",
    "production wiring kept the mock, which answers allow without inspecting the request",
  );

  const inside = await permissions.shouldBlockShellCommand(
    { signal: new AbortController().signal },
    "node build.js",
    { workingDirectory: root },
    undefined,
  );
  assert.equal(inside.kind, "allow", "a command inside the local-exec root is the ordinary case and must stay usable");

  const escape = await permissions.shouldBlockShellCommand(
    { signal: new AbortController().signal },
    'type %USERPROFILE%\\.ssh\\id_rsa',
    { workingDirectory: outside },
    undefined,
  );
  assert.equal(
    escape.kind,
    "block",
    "a shell working directory outside SAND_LOCAL_EXEC_ROOT reached the machine unchecked, because the mock never inspected it",
  );
  assert.equal(
    escape.reason.type,
    "permissionsConfig",
    "the refusal has to surface as a permissions refusal so the shell stream reports permissionDenied instead of stdout",
  );

  const invariant = await permissions.shouldEnforceShellInvariantBlocks(
    { signal: new AbortController().signal },
    { workingDirectory: outside, command: "whoami" },
    undefined,
  );
  assert.equal(
    invariant.kind,
    "block",
    "the invariant gate runs before the command and has to refuse the escape as well, or the mock is still the only gate",
  );
});

test("the production local-exec graph refuses a file read outside the local-exec root", async (t) => {
  const { module: executorModule, dispose } = await bundleExecutor();
  t.after(dispose);

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-local-exec-read-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const permissions = executorModule.createLocalExecPermissionsService({ root });

  const inside = await permissions.shouldBlockRead(path.join(root, "notes.md"));
  assert.equal(inside, false, "reading a file inside the root is the ordinary case and must stay usable");

  const escape = await permissions.shouldBlockRead(path.join(os.homedir(), ".ssh", "id_rsa"));
  assert.equal(
    escape,
    true,
    "an agent could read ~/.ssh/id_rsa because the mock answered false for every path, including paths outside the root",
  );

  const traversal = await permissions.shouldBlockRead(path.join(root, "..", ".ssh", "id_rsa"));
  assert.equal(
    traversal,
    true,
    "a path that only escapes the root after normalisation is the same escape and has to be refused too",
  );
});

test("no production file imports the local-exec test doubles", () => {
  const production = readFileSync(
    path.join(repoRoot, "source", "local-exec-daemon", "production-executor.ts"),
    "utf8",
  );
  const importLines = production.split("\n").filter((line) => line.trimStart().startsWith("import "));
  assert.ok(importLines.length > 0, "the static guard found no imports at all, so it is not looking at the real module");
  const fromTestDirectory = importLines.filter((line) => /from\s+"[^"]*\/tests\//.test(line));
  assert.deepEqual(
    fromTestDirectory,
    [],
    "a production bundle imported its permission checks from a tests/ directory, so the product and the suite shared one allow-everything object",
  );
  // The prose is allowed to name the defect; the code is not allowed to use it.
  const code = production.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\S\n]*\/\/.*$/gm, "");
  assert.equal(
    /MockPermissionsService|MockIgnoreService/.test(code),
    false,
    "the allow-everything mocks were still constructed in the production graph",
  );
});
