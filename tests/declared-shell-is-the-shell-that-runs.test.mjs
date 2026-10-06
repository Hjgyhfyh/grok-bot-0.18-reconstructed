import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A host that named its interpreter got a different one, and the tool description
 * was built from the name.
 *
 * `prompts/shell-dialect.ts` resolves what to tell the model in this order: the
 * `shellType` a host declares, otherwise `resolveSpawnShell()` — `SHELL` when this
 * host can spawn it, otherwise `ComSpec` on Windows. That answer is `cmd.exe` on a
 * stock Windows box, and it is the same answer `NaiveTerminalExecutor` spawns,
 * because both read `shell-env.ts`.
 *
 * The shell that actually ran commands on the "this computer" surface was chosen
 * somewhere else entirely. `local-exec-daemon/production-executor.ts` calls
 * `createDefaultTerminalExecutor({ env })` — no `shell` — and that function called
 * `getSuggestedShell(userTerminalHint)`. On Windows `getSuggestedShell` ends in
 * `if (commandExists("pwsh") || commandExists("powershell")) return PowerShell`.
 * So the moment `powershell.exe` exists, PowerShell 5.1 runs every command, while
 * the description the model was handed said, in bold:
 *
 *   "The shell is `cmd.exe`, the Windows command interpreter. It is not bash, zsh
 *    or sh, and POSIX shell syntax does not apply to it."
 *
 * The `shell` option that would have reconciled the two was read by
 * `NaiveTerminalExecutor` and by nothing above it. Measured on this machine, every
 * one of these ran Windows PowerShell 5.1:
 *
 *   createDefaultTerminalExecutor({})                                         -> powershell
 *   createDefaultTerminalExecutor({ shell: "C:\\Windows\\system32\\cmd.exe" }) -> powershell
 *   createDefaultTerminalExecutor({ shell: "cmd.exe" })                        -> powershell
 *   createDefaultTerminalExecutor({ shell: "...\\Git\\bin\\bash.exe" })        -> powershell
 *
 * The consequences are not stylistic. Measured through this executor with the
 * description's own claims as the input:
 *
 *   `echo a && echo b`          cmd.exe runs both.  PowerShell 5.1: exit 1,
 *                               "The token '&&' is not a valid statement separator".
 *   `echo a; echo b`            cmd.exe prints `a; echo b`.  PowerShell: prints `a` then `b`.
 *   `echo $(echo nested)`       cmd.exe prints it literally.  PowerShell: prints `nested`.
 *   `echo 'a b'`                cmd.exe prints `'a b'`.  PowerShell: prints `a b`.
 *   `echo 1 ^> 2`               cmd.exe prints `1 > 2`.  PowerShell: three lines.
 *   `echo %CD%`                 cmd.exe prints the directory.  PowerShell: prints `%CD%`.
 *   `python -c "print(123)"`    cmd.exe prints `123`.  PowerShell also prints `123`.
 *
 * Every one of the first six is a sentence the model was explicitly told to rely
 * on. `ShellDialectOptions` already documented the option that was being ignored:
 * "A shell the host declares for this surface. It wins over environment
 * resolution."
 *
 * THE INSTRUMENT. `echo %CD%` is the discriminator, because it means two different
 * things to two shells on one machine: `cmd.exe` expands it to the working
 * directory, and PowerShell, zsh and bash all print it back verbatim. So the
 * output names the interpreter that actually ran, without naming it in the test.
 *
 * Nothing is stubbed: the `cmd.exe` and the `powershell.exe` that answer are the
 * ones this machine has.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

/**
 * The baseline these tests read the defect from: a fixed commit, not the working
 * tree. Reading HEAD only proves anything while the fix is uncommitted, and once
 * it is committed HEAD holds the fixed code and every falsification inverts.
 */
const DEFECT_BASELINE = "ace01c9";

const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

const isWindows = process.platform === "win32";

/** Serves `naive.ts` from the committed blob, so the working tree is never touched. */
function naiveFromGitHead() {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  const relative = "source/packages/shell-exec/naive.ts";
  const contents = execFileSync("git", ["show", `${DEFECT_BASELINE}:${relative}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    name: "naive-from-git-head",
    setup(bundler) {
      bundler.onLoad({ filter: /packages[\\/]shell-exec[\\/]naive\.ts$/ }, (args) => ({
        contents,
        loader: "ts",
        resolveDir: path.dirname(args.path),
      }));
    },
  };
}

async function bundle({ fromGitHead = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-declared-shell-"));
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "shell-exec", "naive.ts"),
      path.join(sourceRoot, "packages", "shell-exec", "shell-env.ts"),
      path.join(sourceRoot, "packages", "local-exec", "shell-core.ts"),
      path.join(sourceRoot, "packages", "context", "core.ts"),
    ],
    outdir: directory,
    outbase: sourceRoot,
    entryNames: "[dir]/[name]",
    chunkNames: "chunks/[hash]",
    outExtension: { ".js": ".mjs" },
    banner: REQUIRE_BANNER,
    mainFields: ["module", "main"],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    ...(fromGitHead ? { plugins: [naiveFromGitHead()] } : {}),
  });
  const load = (relative) => import(pathToFileURL(path.join(directory, `${relative}.mjs`)).href);
  return {
    load,
    createDefaultTerminalExecutor: (await load("packages/shell-exec/naive")).createDefaultTerminalExecutor,
    resolveSpawnShell: (await load("packages/shell-exec/shell-env")).resolveSpawnShell,
    BaseShellCoreExecutor: (await load("packages/local-exec/shell-core")).BaseShellCoreExecutor,
    createContext: (await load("packages/context/core")).createContext,
    dispose: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

const working = await bundle();
test.after(() => working.dispose());

/**
 * Runs one command through `BaseShellCoreExecutor` and returns what came out of
 * it. The ceiling is the safety limit: an executor that cannot start a shell would
 * otherwise hang this file instead of failing one assertion.
 */
async function runShell(bundled, options, command, cwd) {
  const core = new bundled.BaseShellCoreExecutor(bundled.createDefaultTerminalExecutor(options));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let stdout = "";
  let stderr = "";
  let exit = null;
  try {
    for await (const event of core.execute(bundled.createContext(), { command, workingDirectory: cwd, signal: controller.signal })) {
      if (event.type === "stdout") stdout += event.data.toString("utf8");
      else if (event.type === "stderr") stderr += event.data.toString("utf8");
      else if (event.type === "exit") exit = event.code;
    }
  } finally {
    clearTimeout(timer);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim().slice(0, 160), exit };
}

/** True when `cmd.exe` ran the command, false when something else printed `%CD%` back. */
function isCmdEcho(stdout, cwd) {
  return stdout.length > 0 && stdout !== "%CD%" && stdout.includes(cwd);
}

const skip = isWindows
  ? false
  : "the declared shells this file compares are Windows ones, and the `%CD%` expansion that separates cmd.exe from PowerShell has no counterpart on a POSIX host";

test("a shell the host declared is the shell that runs the command", { skip }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-declared-cwd-"));
  const declared = working.resolveSpawnShell();
  try {
    const declaredRun = await runShell(working, { shell: declared }, "echo %CD%", cwd);
    const bareNameRun = await runShell(working, { shell: "cmd.exe" }, "echo %CD%", cwd);

    assert.equal(isCmdEcho(declaredRun.stdout, cwd), true, `declaring shell: "${declared}" must run cmd.exe; it produced stdout ${JSON.stringify(declaredRun.stdout)} and stderr ${JSON.stringify(declaredRun.stderr)}`);
    assert.equal(isCmdEcho(bareNameRun.stdout, cwd), true, `declaring the bare name "cmd.exe" must run cmd.exe too; it produced stdout ${JSON.stringify(bareNameRun.stdout)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("the command a cmd.exe-declared surface runs is the one the description promises", { skip }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-declared-cwd-"));
  const declared = working.resolveSpawnShell();
  try {
    // Both sentences are quoted from `cmdSection()` in prompts/shell-dialect.ts.
    const andAlso = await runShell(working, { shell: declared }, "echo a && echo b", cwd);
    const semicolon = await runShell(working, { shell: declared }, "echo a; echo b", cwd);
    const singleQuoted = await runShell(working, { shell: declared }, "echo 'a b'", cwd);
    const subshell = await runShell(working, { shell: declared }, "echo $(echo nested)", cwd);

    // `echo NAME` emits a trailing space in cmd.exe ("a "), so the lines are
    // compared trimmed: this asserts which two words were printed, not the
    // whitespace the interpreter happens to pad with.
    assert.deepEqual(andAlso.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0), ["a", "b"], "the description says `&&` separates commands, and only the shell it names does that");
    assert.equal(semicolon.stdout, "a; echo b", "the description says `;` is a literal character here, not a separator");
    assert.equal(singleQuoted.stdout, "'a b'", "the description says the single quotes are printed, quotes included");
    assert.equal(subshell.stdout, "$(echo nested)", "the description says `$(...)` is ordinary text here, not a substitution");
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a caller that declares no shell still gets the suggestion, so nothing that relied on the old path moved", { skip }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-declared-cwd-"));
  try {
    // This is the exact call `local-exec-daemon/production-executor.ts` makes.
    const production = await runShell(working, { env: { CURSOR_AGENT: "1", SAND_AGENT: "1" } }, "echo %CD%", cwd);
    const empty = await runShell(working, {}, "echo %CD%", cwd);

    assert.equal(production.stdout, empty.stdout, "passing env and passing nothing must not reach two different interpreters, and they produced different output");
    assert.equal(production.stdout, "%CD%", `with nothing declared the suggestion still decides, and on this Windows box that is PowerShell, which prints %CD% back; it produced ${JSON.stringify(production.stdout)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// Falsification: the committed code fails the same instrument.
// ---------------------------------------------------------------------------

let head;
try {
  head = await bundle({ fromGitHead: true });
  test.after(() => head.dispose());
} catch {
  head = undefined;
}

test("the committed code ignores the declared shell, which is the defect this file closes", { skip: head === undefined && "git could not answer for the baseline commit" }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-declared-cwd-"));
  const declared = working.resolveSpawnShell();
  try {
    const committed = await runShell(head, { shell: declared }, "echo %CD%", cwd);
    const repaired = await runShell(working, { shell: declared }, "echo %CD%", cwd);

    assert.equal(isCmdEcho(committed.stdout, cwd), false, `the committed code must fail this check, or HEAD already has the fix and this file measures nothing; it produced stdout ${JSON.stringify(committed.stdout)}`);
    assert.equal(isCmdEcho(repaired.stdout, cwd), true, "the working tree is the side under repair and it has to satisfy the same instrument");
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});