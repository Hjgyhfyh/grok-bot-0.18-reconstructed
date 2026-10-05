import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The baseline these tests read the defect from. It is a fixed commit, not HEAD:
// reading HEAD only proves anything while the fix is uncommitted, and once it is
// committed HEAD holds the fixed code and every falsification inverts.
const DEFECT_BASELINE = "18fe9fc";


// A shell that was cancelled left its descendants running on the user's machine.
//
// Every command the agent runs goes through `cmd.exe /c <command>`, so `python`
// is not a child of the agent — it is a *grandchild*, one level below the
// process `shell-exec` holds a handle on. Cancelling asked `child.kill()`, which
// on Windows is a `TerminateProcess` on one pid. `cmd.exe` died; the `python` it
// had started did not. Ten minutes of an agent retrying a command that kept
// timing out left seven of them behind, each still writing files and holding
// memory, and nothing anywhere named them.
//
// Nothing threw and nothing looked wrong. The tool result said the command was
// aborted, the exit code was reported, and every test in the suite was green —
// the leak is a process the test process no longer has a handle on, so no
// assertion in this repository could ever have seen it. `process.kill(-pid)`,
// which is the POSIX answer to exactly this, was already in the tree in
// `shell-exec/core.ts:38`, and on Windows it fails with `ESRCH` and kills
// nothing, so the branch that looked like it was handling this was dead on the
// platform the bug was measured on.
//
// There is a second, quieter part. Starting `taskkill /T /F` alongside the
// direct kill does not work either, and that is why this fix moves the direct
// kill rather than adding to it: `taskkill /T` learns the tree by walking down
// from a process that is *still alive*, and the direct kill removes the parent
// in microseconds. Measured, with a real `cmd.exe` and a real long-lived
// grandchild: async `taskkill` started first still left the grandchild running.
// Only the synchronous call, issued before the direct kill, killed it.
//
// These tests spawn a real `cmd.exe` and a real grandchild, cancel the real
// chain, and then ask the operating system whether the grandchild is still
// there. The last test builds `shell-core` out of `git HEAD` through an
// esbuild `onLoad` hook and runs the same scenario against it, so the defect is
// demonstrated against the old code rather than asserted from memory.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

const SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
/** Every long-lived process this file starts, so none of them outlives the suite. */
const strays = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Last-resort cleanup. A test that leaves a grandchild behind is worse than a failing test. */
function forceKill(pid) {
  if (!isAlive(pid)) return;
  strays.add(pid);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Nothing more to try; the suite reports the failure that led here.
  }
}

/** Polls instead of sleeping blind, and cannot hang: without a ceiling this would hang the suite. */
async function waitFor(predicate, what, ceilingMs = 30_000) {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() > deadline) assert.fail(`${what} never happened within ${ceilingMs}ms`);
    await sleep(25);
  }
}

async function waitUntilDead(pid, what, ceilingMs = 10_000) {
  return waitFor(async () => (isAlive(pid) ? false : true), `${what} (pid ${pid} is still running)`, ceilingMs);
}

test.after(() => {
  for (const pid of strays) forceKill(pid);
  strays.clear();
});

/**
 * A directory holding a launcher that starts a process far outliving its
 * parent, plus the command that runs it.
 *
 * The command is a bare name, and it is put on `PATH` rather than written as a
 * path, for one measured reason that has nothing to do with process trees.
 * `NaiveTerminalExecutor` used to compute a working directory and never pass it
 * to `spawn` (`source/packages/shell-exec/naive.ts:66` against `:72`), so
 * nothing in the command could be resolved relative to it. That is fixed — the
 * executor now hands `cwd` to the spawn like its four siblings do, proven by
 * `tests/local-exec-working-directory-drift.test.mjs` — and a bare name still
 * works either way, because `PATH` lookup does not consult the working
 * directory. What is still true, and the reason the command stays a bare name,
 * is `buildShellCommandArgs`: it hands the whole command to `cmd.exe` as one
 * argv element, which Node quotes for the Win32 C runtime — so a `"` in the
 * command arrives at `cmd.exe` as `\"` and is not a quote. A command that has to
 * quote a path cannot be run through this executor at all, which is worth
 * knowing and is not what this file is about. A bare name has neither problem.
 */
function makeTree(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `grok-tree-${label}-`));
  const pidFile = path.join(dir, "grandchild.pid");
  const sleeper = path.join(dir, "sleeper.mjs");
  writeFileSync(
    sleeper,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setTimeout(() => {}, 600_000);",
      "",
    ].join("\n"),
  );
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, "sleeper.cmd"), `@echo off\r\n"${process.execPath}" "${sleeper}"\r\n`);
  } else {
    const launcher = path.join(dir, "sleeper");
    writeFileSync(launcher, `#!/bin/sh\n"${process.execPath}" "${sleeper}"\n`);
    chmodSync(launcher, 0o755);
  }
  // Windows environment variable names are case-insensitive and object keys are
  // not: splicing into a `PATH` key while the host spells it `Path` would leave
  // both in place and leave the parent value winning.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const separator = process.platform === "win32" ? ";" : ":";
  const previousPath = process.env[pathKey];
  process.env[pathKey] = [dir, previousPath].filter((value) => value !== undefined && value !== "").join(separator);
  return {
    dir,
    command: "sleeper",
    async grandchildPid() {
      return waitFor(() => {
        if (!existsSync(pidFile)) return undefined;
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
      }, `the grandchild under ${SHELL} to start`);
    },
    dispose() {
      if (previousPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = previousPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function bundle(overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-process-tree-"));
  const plugins = overrides.shellCoreSource === undefined
    ? []
    : [
      {
        name: "shell-core-from-git",
        setup(b) {
          b.onLoad({ filter: /packages[\\/]local-exec[\\/]shell-core\.ts$/ }, (args) => ({
            contents: overrides.shellCoreSource,
            loader: "ts",
            resolveDir: path.dirname(args.path),
          }));
        },
      },
    ];
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "local-exec", "shell-core.ts"),
      path.join(sourceRoot, "packages", "local-exec", "process-tree.ts"),
      path.join(sourceRoot, "packages", "local-exec", "background-shell.ts"),
      path.join(sourceRoot, "packages", "shell-exec", "naive.ts"),
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
    plugins,
  });
  const load = (relative) => import(pathToFileURL(path.join(directory, `${relative}.mjs`)).href);
  return { load, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const built = await bundle();
test.after(() => built.dispose());

const { BaseShellCoreExecutor } = await built.load("packages/local-exec/shell-core");
const { CoreShellFactory } = await built.load("packages/local-exec/background-shell");
const { createNaiveTerminalExecutor } = await built.load("packages/shell-exec/naive");
const { createContext } = await built.load("packages/context/core");
const { killProcessTree, readProcessGroupFromProc, readProcessGroupFromPs } = await built.load("packages/local-exec/process-tree");

function terminalFor(dir) {
  return createNaiveTerminalExecutor({ shell: SHELL });
}

async function drain(core, args) {
  const events = [];
  for await (const event of core.execute(createContext(), args)) events.push(event);
  return events;
}

test("a cancelled command takes its grandchild with it", async () => {
  const tree = makeTree("cancel");
  const controller = new AbortController();
  const core = new BaseShellCoreExecutor(terminalFor(tree.dir));
  let grandchild;
  try {
    const running = drain(core, { command: tree.command, workingDirectory: tree.dir, signal: controller.signal });
    grandchild = await tree.grandchildPid();
    strays.add(grandchild);
    assert.equal(isAlive(grandchild), true, "the grandchild has to be running before the cancel, or this proves nothing");

    controller.abort();
    const events = await running;

    await waitUntilDead(grandchild, "the grandchild of a cancelled command to be gone");
    const exit = events.find((event) => event.type === "exit");
    assert.equal(exit?.aborted, true, "the shell reported a clean exit rather than a cancel, so the tree may never have been killed at all");
  } finally {
    forceKill(grandchild);
    tree.dispose();
  }
});

test("the same command on git HEAD leaves the grandchild running, which is what this file closes", async () => {
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) if (/^GIT_CONFIG_COUNT$/i.test(key)) delete gitEnv[key];
  let headSource;
  try {
    headSource = execFileSync("git", ["show", `${DEFECT_BASELINE}:source/packages/local-exec/shell-core.ts`], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return; // No git, or a checkout with no HEAD. The first test still holds.
  }
  const worktreeSource = readFileSync(path.join(sourceRoot, "packages", "local-exec", "shell-core.ts"), "utf8");
  const headIsFixed = headSource === worktreeSource;

  const old = await bundle({ shellCoreSource: headSource });
  const tree = makeTree("head");
  const controller = new AbortController();
  const { BaseShellCoreExecutor: HeadShellCore } = await old.load("packages/local-exec/shell-core");
  let grandchild;
  try {
    const running = drain(new HeadShellCore(terminalFor(tree.dir)), {
      command: tree.command,
      workingDirectory: tree.dir,
      signal: controller.signal,
    });
    grandchild = await tree.grandchildPid();
    strays.add(grandchild);

    controller.abort();
    const events = await running;

    const exit = events.find((event) => event.type === "exit");
    assert.equal(exit?.aborted, true, "git HEAD has to cancel too, or this is comparing two different situations");

    if (headIsFixed) return; // HEAD already carries the fix; there is no old behaviour left to show.
    assert.equal(
      isAlive(grandchild),
      true,
      "git HEAD is supposed to leave the grandchild running, and if it does not then the defect was never the defect this test names",
    );
  } finally {
    forceKill(grandchild);
    tree.dispose();
    old.dispose();
  }
});

test("a short command still returns its output and its exit code", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-tree-short-"));
  try {
    const core = new BaseShellCoreExecutor(terminalFor(dir));
    const events = await drain(core, { command: "echo short-command-marker", workingDirectory: dir });

    const stdout = events.filter((event) => event.type === "stdout").map((event) => event.data).join("");
    assert.match(stdout, /short-command-marker/, "the text the command printed is the whole point of the tool, and a tree kill must not cost it");
    const exit = events.find((event) => event.type === "exit");
    assert.equal(exit?.code, 0, "a command that ran to completion has to report that it did");
    assert.equal(exit?.aborted, false, "nothing cancelled this command, so reporting it as aborted would be a new lie");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command backgrounded on purpose keeps its own process, and loses it when it is aborted", async () => {
  // The other half. `background: true` means the agent asked for the work to
  // outlive the tool call, so the tree must not be swept up in the moment the
  // call returns. The tree is only ever taken when something actually cancels.
  const tree = makeTree("background");
  const factory = new CoreShellFactory();
  let shell;
  let grandchild;
  try {
    shell = await factory.spawn(
      { ctx: createContext(), shellId: 987_654, command: tree.command, workingDirectory: tree.dir },
      new BaseShellCoreExecutor(terminalFor(tree.dir)),
    );
    grandchild = await tree.grandchildPid();
    strays.add(grandchild);

    await sleep(500);
    assert.equal(isAlive(grandchild), true, "a backgrounded command was asked to outlive the call, so killing its process on the way out defeats the feature it exists for");

    shell.abort();
    await waitUntilDead(grandchild, "the grandchild of an aborted background command to be gone");
  } finally {
    shell?.dispose?.();
    forceKill(grandchild);
    tree.dispose();
  }
});

test("the Windows tree kill asks for the whole tree, and only the whole tree", async () => {
  const calls = [];
  const result = killProcessTree(4321, {
    platform: "win32",
    spawnSync: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
    kill: () => { throw new Error("no fallback may run when taskkill succeeded"); },
  });

  assert.deepEqual(calls, [["taskkill", ["/T", "/F", "/PID", "4321"]]], "without /T taskkill stops at the shell and the grandchild is exactly what survives");
  assert.equal(result.method, "taskkill-tree", "the result has to say which way the tree was killed, because the fallback is not the same guarantee");
});

test("the Windows tree kill falls back to the one process it can name when taskkill is unusable", async () => {
  const signalled = [];
  const result = killProcessTree(4321, {
    platform: "win32",
    spawnSync: () => ({ error: Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" }),
    kill: (pid, signal) => { signalled.push([pid, signal]); },
    forceKillAfterMs: 60_000,
  });

  assert.deepEqual(signalled[0], [4321, "SIGTERM"], "the fallback may only ever name the shell itself; a negative pid on Windows is ESRCH and kills nothing");
  assert.equal(result.method, "direct", "saying 'taskkill-tree' after a fallback would report a guarantee the host did not give");
});

test("a POSIX group signal is aimed only at a process that leads its own group", async () => {
  // `kill(-pid)` for a process that inherited this test's group would aim at the
  // test runner itself. The leadership check is what keeps that from being a
  // foot-gun, so it is asserted rather than assumed.
  const signalled = [];
  const leader = killProcessTree(4321, { platform: "linux", readProcessGroup: () => 4321, kill: (pid, signal) => signalled.push([pid, signal]), forceKillAfterMs: 60_000 });
  const follower = killProcessTree(4321, { platform: "linux", readProcessGroup: () => 4321 + 1, kill: (pid, signal) => signalled.push([pid, signal]), forceKillAfterMs: 60_000 });
  const unknown = killProcessTree(4321, { platform: "linux", readProcessGroup: () => undefined, kill: (pid, signal) => signalled.push([pid, signal]), forceKillAfterMs: 60_000 });

  assert.deepEqual([leader.method, follower.method, unknown.method], ["posix-group", "direct", "direct"], "only a process that leads its group may be signalled by negative pid; the other two must fall back rather than guess");
  assert.deepEqual(signalled, [[-4321, "SIGTERM"], [4321, "SIGTERM"], [4321, "SIGTERM"]], "the negative pid appears exactly once, for the leader, and never with the caller's own pid");
});

test("the process group is read past an executable name that contains a closing parenthesis", async () => {
  const stat = "4321 (od)d (weird) name) S 4200 4321 4321 0 -1 4194560";
  assert.equal(readProcessGroupFromProc(4321, () => stat), 4321, "counting fields from the start of the line reads the ppid here, and a shell launched as `od` would then never be recognised as its own group leader");
  assert.equal(readProcessGroupFromProc(4321, () => { throw new Error("no /proc on this host"); }), undefined, "a host that cannot answer must report that it cannot, not guess a group");
});

test("macOS has no /proc, so the group answer comes from ps there", async () => {
  // Without this the POSIX branch could never run on macOS, and `kill(-pid)`
  // would stay unreachable on the one POSIX platform where the box actually
  // runs. It is asserted here rather than on a macOS host.
  const calls = [];
  const leader = readProcessGroupFromPs(4321, (file, args) => {
    calls.push([file, args]);
    return "  4321\n";
  });
  assert.deepEqual(calls, [["ps", ["-o", "pgid=", "-p", "4321"]]], "ps is asked for the process group of exactly that pid; a wider query could name another process's group");
  assert.equal(leader, 4321, "the padded single-column output is what ps prints, and reading it as a number has to survive the padding");
  assert.equal(readProcessGroupFromPs(4321, () => ""), undefined, "an empty answer is a process that is gone, and it must not be read as group zero");
  assert.equal(readProcessGroupFromPs(4321, () => { throw new Error("no ps on this host"); }), undefined, "a host with neither source must still fall back to killing one process, exactly as it did before");
});