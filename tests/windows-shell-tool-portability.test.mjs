import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The shell tool was written for macOS and Linux. Every defect below was
// invisible because no test executed these code paths on Windows: a module-load
// throw, an environment rebuild that drops the caller's `path`, a `/bin/sh`
// spawn target, folder ids Win32 cannot open, and a sandbox refusal that
// recommends a binary which cannot help on this platform.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function moduleName(entry) {
  return entry.at(-1);
}

function buildToDir(entry, directory) {
  return build({
    entryPoints: [path.join(repoRoot, "source", ...entry)],
    outfile: path.join(directory, moduleName(entry) + ".mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
}

async function importFromRepo(entries) {
  const directory = mkdtempSync(path.join(repoRoot, ".tmp-test-shell-"));
  try {
    for (const entry of entries) await buildToDir(entry, directory);
    const loaded = {};
    for (const entry of entries) {
      loaded[moduleName(entry)] = await import(
        pathToFileURL(path.join(directory, moduleName(entry) + ".mjs")).href
      );
    }
    return loaded;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const shellEnv = (await importFromRepo([["packages", "shell-exec", "shell-env.ts"]]))["shell-env.ts"];
const { buildShellEnv, mergeShellEnv, resolveSpawnShell, buildShellCommandArgs, isSpawnableShellOnThisHost } = shellEnv;

const folderId = (await importFromRepo([["host", "storage", "folder-id.ts"]]))["folder-id.ts"];
const { isSafeFolderId } = folderId;

const naive = (await importFromRepo([["packages", "shell-exec", "naive.ts"]]))["naive.ts"];
const { getSuggestedShell, setShellCommandProbe } = naive;

const { KnownShellExecutor } = (await importFromRepo([["packages", "shell-exec", "types.ts"]]))["types.ts"];

const sandbox = (await importFromRepo([["packages", "shell-exec", "sandbox", "sandbox.ts"]]))["sandbox.ts"];
const { sandboxUnsupportedMessage, spawnInSandbox } = sandbox;

// ---------------------------------------------------------------------------
// 1. `shell-parser.ts` raised at module load, which disabled the whole tool.
// ---------------------------------------------------------------------------

function bundleShellParser(outDirectory) {
  return build({
    entryPoints: [path.join(repoRoot, "source", "packages", "shell-exec", "shell-parser.ts")],
    outfile: path.join(outDirectory, "shell-parser.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    external: ["tree-sitter", "tree-sitter-bash"],
  });
}

function runShellParser({ directory, env }) {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(directory, "shell-parser.mjs")).href)});
    const analysis = m.analyzeShellCommand("ls -la > /dev/null");
    const error = typeof m.getShellParserRuntimeError === "function" ? m.getShellParserRuntimeError() : undefined;
    process.stdout.write(JSON.stringify({
      simpleCommands: analysis.legacy.simpleCommands,
      parsingFailed: analysis.structured.parsingFailed,
      runtimeErrorCode: error === undefined ? null : String(error.code),
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `importing shell-parser failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("shell-parser imports and degrades instead of throwing when the staged runtime is absent", async () => {
  const inside = mkdtempSync(path.join(repoRoot, ".tmp-test-parser-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "grok-test-parser-"));
  const emptyStaging = path.join(outside, "no-such-staging");
  mkdirSync(emptyStaging, { recursive: true });
  try {
    await bundleShellParser(inside);

    // A packaged runtime whose staging directory holds no tree-sitter. This is
    // the state that used to throw `SAND_TREE_SITTER_RUNTIME_UNAVAILABLE` out
    // of the import, taking `shell-stream`, `background-shell` and the shell
    // tool with it.
    const degraded = runShellParser({
      directory: inside,
      env: { SAND_PACKAGED: "1", SAND_TREE_SITTER_NODE_DEPS: emptyStaging },
    });
    assert.equal(degraded.parsingFailed, true);
    assert.equal(degraded.runtimeErrorCode, "SAND_TREE_SITTER_RUNTIME_UNAVAILABLE");

    // The same missing dependency outside a packaged runtime used to surface a
    // bare `Cannot find module 'tree-sitter'` instead of the described
    // fail-closed error, because `createRequire().resolve` raises directly.
    await bundleShellParser(outside);
    const developerPath = runShellParser({ directory: outside, env: { SAND_PACKAGED: undefined } });
    assert.equal(developerPath.parsingFailed, true);
    assert.equal(developerPath.runtimeErrorCode, "SAND_TREE_SITTER_RUNTIME_UNAVAILABLE");
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("shell-parser still parses commands when the runtime does load", async () => {
  const inside = mkdtempSync(path.join(repoRoot, ".tmp-test-parser-"));
  try {
    await bundleShellParser(inside);
    const healthy = runShellParser({ directory: inside, env: { SAND_PACKAGED: undefined } });
    // Degrading must not have cost the parser its capability.
    assert.equal(healthy.parsingFailed, false);
    assert.deepEqual(healthy.simpleCommands, ["ls"]);
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The child environment was rebuilt by spreading `process.env`.
// ---------------------------------------------------------------------------

test("a Windows env override survives the spread even when its casing differs", async () => {
  const merged = mergeShellEnv({ Path: "C:\\parent", Other: "kept" }, { path: "C:\\child" });
  const pathKeys = Object.keys(merged).filter((key) => key.toLowerCase() === "path");
  // Before the fix both `Path` and `path` survived, and Node picked the winner
  // by UTF-16 sort order — so a caller using lowercase `path` silently lost to
  // the inherited `Path`.
  assert.deepEqual(pathKeys, ["Path"]);
  assert.equal(merged.Path, "C:\\child");
  assert.equal(merged.Other, "kept");
});

test("a narrowed PATH really reaches the child process", { skip: !isWindows }, () => {
  const narrowed = "C:\\only-this-dir";
  const readPath = "process.stdout.write(String(process.env.PATH ?? process.env.Path ?? ''))";
  const childSees = (env) => {
    const result = spawnSync(process.execPath, ["-e", readPath], { env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  // Control: the construction this replaced. The parent block spells the name
  // `Path`, the caller spells it `path`, and Node resolves the collision by
  // UTF-16 sort order — so the parent's value wins and the caller's narrowing is
  // discarded with no error reported anywhere.
  const legacy = { ...process.env, path: narrowed };
  assert.equal(Object.keys(legacy).filter((key) => key.toLowerCase() === "path").length, 2);
  assert.notEqual(childSees(legacy), narrowed, "the legacy spread is expected to lose the override");

  assert.equal(childSees(mergeShellEnv({ ...process.env }, { path: narrowed })), narrowed);
});

test("Windows gains HOME and SHELL, POSIX keeps the inherited block untouched", async () => {
  const windowsEnv = buildShellEnv({
    base: { Path: "C:\\bin", USERPROFILE: "C:\\Users\\dev" },
    overrides: {},
    shell: "C:\\Program Files\\Git\\bin\\bash.exe",
  });
  assert.equal(windowsEnv.HOME, "C:\\Users\\dev");
  assert.equal(windowsEnv.SHELL, "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(windowsEnv.TERM, "dumb", "the shared shell overrides still apply");

  // Control: the construction this replaced. A stock Windows block has
  // `USERPROFILE` but no `HOME` and no `SHELL`, and the spread adds neither, so
  // every POSIX-shaped tool the shell tool spawns had to guess.
  const base = { Path: "C:\\bin", USERPROFILE: "C:\\Users\\dev" };
  const legacy = { ...base, TERM: "dumb" };
  assert.equal(legacy.HOME, undefined);
  assert.equal(legacy.SHELL, undefined);

  // `cmd.exe` is not a POSIX shell; publishing it as `SHELL` would mislead the
  // tools that read it.
  assert.equal(buildShellEnv({ base: { USERPROFILE: "C:\\U" }, shell: "C:\\Windows\\System32\\cmd.exe" }).SHELL, undefined);
  // An explicit `HOME` from the caller is never overwritten.
  assert.equal(buildShellEnv({ base: { USERPROFILE: "C:\\U", HOME: "/mnt/c/Users/dev" }, shell: "bash" }).HOME, "/mnt/c/Users/dev");
});

// ---------------------------------------------------------------------------
// 4. `/bin/sh` does not exist on Windows, and the probes were uncached.
// ---------------------------------------------------------------------------

test("the naive executor never resolves to a POSIX path on Windows", () => {
  assert.equal(isSpawnableShellOnThisHost("/bin/sh"), !isWindows);
  assert.equal(isSpawnableShellOnThisHost("/usr/bin/env"), !isWindows);
  assert.equal(isSpawnableShellOnThisHost("C:\\nope\\bash.exe"), false);
  assert.equal(isSpawnableShellOnThisHost("bash.exe"), true);

  // The spawn site must not hard-code a POSIX command interpreter. `spawnSync`
  // above already proved that on this host `process.env.SHELL` is unset, so the
  // old `|| "/bin/sh"` fallback was the value actually used on Windows.
  const naiveSource = readFileSync(path.join(repoRoot, "source", "packages", "shell-exec", "naive.ts"), "utf8");
  assert.doesNotMatch(naiveSource, /process\.env\.SHELL\s*\|\|\s*"\/bin\/sh"/);
  assert.match(naiveSource, /resolveSpawnShell/);

  // `process.env.SHELL` is unset on a stock Windows box, and a Git Bash or WSL
  // profile can leave a POSIX path in it. Neither may become the spawn target.
  const originalShell = process.env.SHELL;
  const originalComSpec = process.env.ComSpec;
  try {
    process.env.SHELL = "/bin/sh";
    assert.notEqual(resolveSpawnShell(), "/bin/sh");
    if (isWindows) assert.match(resolveSpawnShell(), /cmd\.exe$/i);

    process.env.SHELL = "";
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    assert.equal(resolveSpawnShell(), "C:\\Windows\\System32\\cmd.exe");

    // An explicit hint still wins over both.
    assert.equal(resolveSpawnShell("C:\\custom\\pwsh.exe"), "C:\\custom\\pwsh.exe");

    const shell = resolveSpawnShell();
    const args = buildShellCommandArgs(shell, undefined, "echo hi");
    // `cmd.exe` takes `/c`; every other shell this tool spawns takes `-c`.
    assert.equal(args.at(-1), "echo hi");
    assert.ok(args.includes(isWindows ? "/c" : "-c"), args.join(" "));
  } finally {
    if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell;
    if (originalComSpec === undefined) delete process.env.ComSpec; else process.env.ComSpec = originalComSpec;
  }
});

test("getSuggestedShell probes at most twice on Windows and caches the answer", () => {
  const probed = [];
  try {
    setShellCommandProbe((command) => { probed.push(command); return command === "pwsh"; });

    assert.equal(getSuggestedShell("", "win32", {}), KnownShellExecutor.PowerShell);
    assert.deepEqual(probed, ["pwsh"], "a present pwsh must not trigger further probes");
    const afterFirst = probed.length;

    // The second call must not spawn anything again.
    assert.equal(getSuggestedShell("", "win32", {}), KnownShellExecutor.PowerShell);
    assert.equal(probed.length, afterFirst);

    setShellCommandProbe((command) => { probed.push(command); return false; });
    const cold = probed.length;
    assert.equal(getSuggestedShell("", "win32", {}), KnownShellExecutor.Naive);
    const budget = probed.length - cold;
    assert.ok(budget <= 2, `windows probed ${budget} commands: ${probed.slice(cold).join(", ")}`);
    assert.ok(!probed.slice(cold).includes("zsh"), "zsh has no supported Windows build");
    assert.ok(!probed.slice(cold).includes("bash"), "a bare bash on Windows is WSL or a shim");
  } finally {
    setShellCommandProbe(null);
  }
});

// ---------------------------------------------------------------------------
// 5. Folder ids that Win32 cannot open.
// ---------------------------------------------------------------------------

test("folder ids are checked against the full Win32 name rules", () => {
  const rejected = [
    "", ".", "..", "a/b", "a\\b", "nul\0byte", "bell\u0007",
    "a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b",
    "a.", "a ", ".a.", "trailing  ",
    "CON", "con", "CON.txt", "PRN", "AUX", "NUL", "nul.json",
    "COM1", "COM9", "LPT1", "LPT9", "COM\u00b9", "LPT\u00b9",
  ];
  for (const id of rejected) {
    assert.equal(isSafeFolderId(id, "win32"), false, `win32 should reject ${JSON.stringify(id)}`);
  }
  for (const id of ["agents", ".cursor", "my-project_1", "проект", "a.b", "..a", "a..b", "com10", "lpt"]) {
    assert.equal(isSafeFolderId(id, "win32"), true, `win32 should accept ${JSON.stringify(id)}`);
  }

  // POSIX keeps the names it can list, so no capability is removed there.
  for (const id of ["my:project", "a.", "a ", "CON", "a*b"]) {
    assert.equal(isSafeFolderId(id, "linux"), true, `linux should accept ${JSON.stringify(id)}`);
  }
  for (const id of ["", ".", "..", "a/b", "a\\b", "nul\0byte"]) {
    assert.equal(isSafeFolderId(id, "linux"), false, `linux should reject ${JSON.stringify(id)}`);
  }
  assert.equal(isSafeFolderId(42, "win32"), false);
  assert.equal(isSafeFolderId(null, "win32"), false);
});

test("the trailing dot and space rejections match what PowerShell can actually see", { skip: !isWindows }, () => {
  // The policy rejects `a.` and `a ` outright, so the rule is only defensible if
  // they really are unopenable. Node writes them because it prefixes `\\?\`,
  // which disables Win32's trailing-dot stripping.
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-tail-"));
  try {
    for (const name of ["a.", "a ", "plain"]) mkdirSync(path.join(root, name));
    const script = `
      $root = ${JSON.stringify(root)}
      foreach ($name in @('a.', 'a ', 'plain')) {
        Write-Output ("{0}={1}" -f $name, (Test-Path -LiteralPath (Join-Path $root $name)))
      }
    `;
    const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const visibility = new Map(
      result.stdout.trim().split(/\r?\n/).map((line) => line.split("=")),
    );
    assert.equal(visibility.get("a."), "False");
    assert.equal(visibility.get("a "), "False");
    assert.equal(visibility.get("plain"), "True");
    // So the folder this tool creates really is invisible to a PowerShell-based
    // consumer, which is why `isSafeFolderId` refuses the name instead.
    assert.equal(isSafeFolderId("a.", "win32"), false);
    assert.equal(isSafeFolderId("a ", "win32"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The sandbox refusal on Windows.
// ---------------------------------------------------------------------------

test("the Windows sandbox refusal explains the platform and names the next step", () => {
  const message = sandboxUnsupportedMessage("workspace_readwrite", "helper missing", "win32");
  assert.match(message, /cannot be enforced on Windows/);
  assert.match(message, /the command was not run/);
  assert.match(message, /insecure_none/);
  // Before the fix every platform was told to install the helper binary, which
  // on Windows cannot isolate the filesystem at all.
  assert.doesNotMatch(message, /Ensure the sandbox helper binary is available/);

  const posix = sandboxUnsupportedMessage("workspace_readonly", "helper missing", "darwin");
  assert.match(posix, /not supported on this system/);
  assert.match(posix, /Ensure the sandbox helper binary is available/);
  assert.match(sandboxUnsupportedMessage("workspace_readwrite", null, "linux"), /Reason: unknown/);
});

test("an unenforceable policy is a catchable SandboxUnsupportedError, not a crash", { skip: !isWindows }, () => {
  // The host refuses to run the command rather than running it unconfined, and
  // the refusal is the typed error every caller already handles.
  assert.throws(
    () => spawnInSandbox(process.execPath, ["-e", ""], {}, { type: "workspace_readwrite" }),
    (error) => {
      assert.equal(error.name, "SandboxUnsupportedError");
      assert.match(error.message, /cannot be enforced on Windows/);
      assert.match(error.reason, /network proxy only/);
      return true;
    },
  );
  // `insecure_none` is the documented way out and must not raise.
  const child = spawnInSandbox(process.execPath, ["-e", ""], { stdio: "ignore" }, { type: "insecure_none" });
  assert.ok(child.pid !== undefined);
  child.kill();
});