import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The baseline these tests read the defect from. It is a fixed commit, not HEAD:
// reading HEAD only proves anything while the fix is uncommitted, and once it is
// committed HEAD holds the fixed code and every falsification inverts.
const DEFECT_BASELINE = "18fe9fc";


/**
 * The shell tool described a command language, and it was not the one the
 * commands were written in.
 *
 * Nothing in the tool description said which interpreter the executor spawns.
 * Grepping `prompts/dsv3.ts`, `prompts/sandbox-description.ts`,
 * `prompts/sandbox-shared.ts` and `create-shell-tool.ts` for
 * `cmd.exe|PowerShell|Windows|bash|/bin/sh` returned zero matches, while
 * `shell-env.ts` already knew all of it and used it only to pick the binary.
 * The model was therefore left to guess, and a POSIX-trained model always
 * guesses bash.
 *
 * The guess was not a small one. On the live box 48 shell calls produced 20
 * failures against a shell that was working: `ls -la /workspace 2>/dev/null |
 * head -50` died on a syntax error, `(echo one & echo two)> m.txt` needed
 * bash-only grouping, and `python -c print("a b")` reached Python as
 * `print("a` because the line was split. After the first refusals the model
 * invented a cause it could not test — "the wrapper counts `>` characters" —
 * and spent ten minutes on workarounds for a shell that was fine.
 *
 * These tests read the description the model actually receives and hold three
 * obligations against it:
 *
 *   1. it names the interpreter this host really spawns, and does not claim
 *      bash where nothing will spawn bash;
 *   2. the POSIX forms this shell lacks are named as unavailable, and the
 *      guidelines above them no longer contradict that;
 *   3. the file-write example it hands over is a command that runs. That one is
 *      executed, through the same `resolveSpawnShell` + `buildShellCommandArgs`
 *      path the executor uses, and the file it claims to write is read back.
 *
 * The platform is an argument, never a skip: the same assertions run against a
 * build where `process.platform` has been replaced with `linux` and with
 * `win32`, so a POSIX developer gets the POSIX proof and a Windows developer
 * gets the cmd.exe proof from the same file.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

/**
 * Builds the prompt module. `platform` rewrites `process.platform` in the
 * bundle, so `resolveShellDialect` resolves the shell for a host that is not
 * this one — the same seam the shipping code reads the fact through.
 * `fromGitHead` answers the prompt file from the committed blob instead of the
 * working tree, so one file differs and the tree is never touched.
 */
function promptPlugin({ fromGitHead }) {
  return {
    name: "grok-shell-dialect-probe",
    setup(bundler) {
      if (fromGitHead === true) {
        bundler.onLoad({ filter: /prompts[\\/]dsv3\.ts$/ }, (args) => {
          const relative = path.relative(repoRoot, args.path).split(path.sep).join("/");
          const env = { ...process.env };
          delete env.GIT_CONFIG_COUNT;
          const contents = execFileSync("git", ["show", `${DEFECT_BASELINE}:${relative}`], {
            cwd: repoRoot,
            encoding: "utf8",
            env,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
          });
          return { contents, loader: "ts" };
        });
      }
    },
  };
}

async function bundlePrompts({ platform, fromGitHead } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-shell-dialect-"));
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "prompts", "dsv3.ts"),
      path.join(sourceRoot, "packages", "agent", "tools", "core", "shell", "prompts", "shell-dialect.ts"),
      path.join(sourceRoot, "packages", "shell-exec", "shell-env.ts"),
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
    ...(platform === undefined ? {} : { define: { "process.platform": JSON.stringify(platform) } }),
    plugins: [promptPlugin({ fromGitHead })],
  });
  const load = (relative) => import(pathToFileURL(path.join(directory, `${relative}.mjs`)).href);
  return {
    load,
    getDescriptionDsv3: (await load("packages/agent/tools/core/shell/prompts/dsv3")).getDescriptionDsv3,
    resolveShellDialect: (await load("packages/agent/tools/core/shell/prompts/shell-dialect")).resolveShellDialect,
    resolveSpawnShell: (await load("packages/shell-exec/shell-env")).resolveSpawnShell,
    buildShellCommandArgs: (await load("packages/shell-exec/shell-env")).buildShellCommandArgs,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const native = await bundlePrompts();
test.after(() => native.dispose());

/** The section the model reads first, or `""` when the description has none. */
function dialectSection(description) {
  const match = /<shell-dialect>[\s\S]*?<\/shell-dialect>/.exec(description);
  return match === null ? "" : match[0];
}

/**
 * The obligation under test, as one predicate so the working tree and the
 * committed blob can be measured by the same instrument. Flip this and both
 * sides of the comparison move at once — that is what makes the falsification
 * below a real control rather than a second opinion.
 */
function namesTheShellCorrectly(description, expectedShellName, expectedKind) {
  const section = dialectSection(description);
  if (section === "") return false;
  if (!section.includes(expectedShellName)) return false;
  if (/The shell is `cmd\.exe`/.test(section) && expectedKind !== "cmd") return false;
  if (expectedKind === "cmd") {
    if (!/not bash/.test(section)) return false;
    if (!/2>\/dev\/null/.test(section)) return false;
    if (!/python -c /.test(section)) return false;
    return true;
  }
  if (expectedKind === "posix") {
    if (!/POSIX syntax applies/.test(section)) return false;
    return /python -c /.test(section);
  }
  return !/The shell is `cmd\.exe`/.test(section) && /python -c /.test(section);
}

// ---------------------------------------------------------------------------
// 1. The description names the interpreter this host really spawns.
// ---------------------------------------------------------------------------

test("the description names the interpreter the executor really spawns", () => {
  const facts = native.resolveShellDialect({});
  const description = native.getDescriptionDsv3(false, "dsv3-1205", {});

  assert.ok(facts.shellName.length > 0, "the shell has to resolve to something before a description can name it");
  assert.equal(facts.platform, process.platform, "the dialect facts are read from this host, which is what makes them a fact rather than a constant");
  assert.ok(description.startsWith("<shell-dialect>"), `the shell identity has to come before the guidelines that assume POSIX, and the description starts with "${description.slice(0, 80)}"`);
  assert.ok(description.includes(facts.shellName), `the model has to be told which shell it is writing for, and nothing in the description names ${facts.shellName}`);
  assert.doesNotMatch(description, /the shell is `bash`/, `claiming bash where nothing spawns bash is the defect itself (description: ${description.slice(0, 200)})`);
});

test("a host that declares its own shell is believed over environment sniffing", () => {
  const description = native.getDescriptionDsv3(false, "dsv3-1205", { shellType: "powershell.exe" });

  assert.ok(description.includes("powershell.exe"), `an explicitly configured shell is the host's own statement about the surface and has to reach the model (description: ${description.slice(0, 200)})`);
  assert.match(description, /\$env:NAME/, `PowerShell expands variables as \`$env:NAME\`, and telling the model to use \`%NAME%\` here is the same defect in a new place`);
  assert.doesNotMatch(description, /the shell is `cmd\.exe`/, "an explicitly configured shell must not be overridden by what the environment happens to resolve to");
});

test("the separator guideline above the section no longer contradicts it", () => {
  const facts = native.resolveShellDialect({});
  const description = native.getDescriptionDsv3(false, "dsv3-1205", {});

  assert.doesNotMatch(description, /use the ';' or '&&' operator/, `that sentence names a POSIX separator for every shell, and on this one \`;\` is a literal character (shell: ${facts.shellName})`);
  if (facts.kind === "cmd") {
    assert.match(description, /use `&` or `&&` to separate them/, `on this shell \`&\` and \`&&\` are the separators, so the guideline has to name the ones that work`);
  } else {
    assert.match(description, /use `;` or `&&` to separate them/, "a POSIX shell keeps its POSIX separators");
  }
});

test("the minimal harness description carries the same dialect", () => {
  const facts = native.resolveShellDialect({});
  const description = native.getDescriptionDsv3(false, "dsv3-1205", { useMinimalHarness: true });

  assert.ok(description.includes(facts.shellName), `the minimal harness is a second surface for the same tool, and it has to name the shell too (shell: ${facts.shellName})`);
  assert.doesNotMatch(description, /Make liberal use of `&&`, `;`/, "the hardcoded POSIX separator list is the same defect in the minimal harness");
});

// ---------------------------------------------------------------------------
// 2. The example in the description is a command that runs.
// ---------------------------------------------------------------------------

function pythonOnPath() {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, ["python"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/** Code spans inside one line of backticks, which is where the examples live. */
function codeSpans(line) {
  return line.split("`").filter((_, index) => index % 2 === 1);
}

test("the file-write example the description offers writes the file it claims", { skip: !pythonOnPath() && "python is not installed on this host, so the example cannot be executed here" }, () => {
  const description = native.getDescriptionDsv3(false, "dsv3-1205", {});
  const line = description.split("\n").find((candidate) => candidate.includes("Working file write:"));

  assert.ok(line !== undefined, `the description has to offer a working write, and no line offers one (section: ${dialectSection(description)})`);
  const examples = codeSpans(line).filter((span) => span.startsWith("python -c "));
  assert.ok(examples.length > 0, `the example must be given as a runnable command, not described in prose (line: ${line})`);

  const shell = native.resolveSpawnShell();
  for (const example of examples) {
    const work = mkdtempSync(path.join(os.tmpdir(), "grok-dialect-example-"));
    try {
      const run = spawnSync(shell, native.buildShellCommandArgs(shell, undefined, example), {
        cwd: work,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(run.status, 0, `the description hands the model a command that fails: ${example}\n${run.stdout}${run.stderr}`);
      const written = path.join(work, "notes.txt");
      assert.ok(existsSync(written), `the description promises this command writes notes.txt and it wrote nothing: ${example}\n${run.stdout}${run.stderr}`);
      assert.ok(readFileSync(written, "utf8").trim().length > 0, `notes.txt was created but stayed empty: ${example}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("the example is written for the shell this host spawns, not for the other one", () => {
  const facts = native.resolveShellDialect({});
  const description = native.getDescriptionDsv3(false, "dsv3-1205", {});
  const line = description.split("\n").find((candidate) => candidate.includes("Working file write:"));
  const examples = codeSpans(line ?? "").filter((span) => span.startsWith("python -c "));

  assert.ok(examples.length > 0, `there has to be an example to inspect, and a description with no example line makes this test pass for the wrong reason (description: ${description.slice(0, 120)})`);
  for (const example of examples) {
    const program = example.slice("python -c ".length).replace(/^"|"$/g, "");
    if (facts.kind === "cmd") {
      assert.equal(program.includes(" "), false, `cmd.exe splits the line on spaces and hands Python only the first word, so this example cannot work: ${example}`);
      assert.equal(program.includes('"'), false, `a double quote does not survive the trip through cmd.exe, so this example cannot work: ${example}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The same text has to stay true on a different platform.
// ---------------------------------------------------------------------------

const linux = await bundlePrompts({ platform: "linux" });
const forcedWindows = await bundlePrompts({ platform: "win32" });
test.after(() => { linux.dispose(); forcedWindows.dispose(); });

test("rebuilding for Linux produces a description that is true for Linux", () => {
  const facts = linux.resolveShellDialect({});
  const description = linux.getDescriptionDsv3(false, "dsv3-1205", {});

  assert.equal(facts.platform, "linux", "the platform substitution has to reach the module that reads it, or this proves nothing");
  assert.equal(facts.kind, "posix", `a Linux host resolves a POSIX interpreter, and the description has to be built from that fact (got ${facts.kind} for ${facts.shellName})`);
  assert.ok(description.includes(facts.shellName), `the POSIX build has to name its own interpreter, and nothing names ${facts.shellName}`);
  assert.doesNotMatch(description, /The shell is `cmd\.exe`/, `Windows advice in a Linux description is the same defect running backwards: a POSIX model reading \`^\` escaping advice will break its commands`);
  assert.doesNotMatch(description, /%USERPROFILE%/, "`%NAME%` is a Windows variable expansion; telling a Linux model to use it wastes a turn");
  assert.doesNotMatch(description, /use `&` or `&&` to separate them/, "`&` backgrounds a command in a POSIX shell, so the cmd.exe separator rule must not leak into the POSIX text");
  assert.match(description, /use `;` or `&&` to separate them/, "a POSIX shell keeps the POSIX separators");
});

test("rebuilding for Windows produces a different description that is still true", () => {
  const linuxDescription = linux.getDescriptionDsv3(false, "dsv3-1205", {});
  const windowsDescription = forcedWindows.getDescriptionDsv3(false, "dsv3-1205", {});
  const facts = forcedWindows.resolveShellDialect({});

  assert.equal(facts.platform, "win32", "the platform substitution has to reach the module that reads it");
  assert.notEqual(windowsDescription, linuxDescription, "a platform that changes nothing about the description is a hardcoded string wearing a platform switch");
  assert.ok(windowsDescription.includes(facts.shellName), `the Windows build has to name its interpreter, and nothing names ${facts.shellName}`);
  assert.match(windowsDescription, /not bash/, "on Windows the model has to be told this is not bash");
  assert.doesNotMatch(windowsDescription, /Platform: Linux/, "the platform label has to follow the platform");
  assert.doesNotMatch(windowsDescription, /There is no cmd\.exe here/, "the POSIX branch must not describe a Windows host");
});

// ---------------------------------------------------------------------------
// 4. Falsification: the committed description has none of this.
// ---------------------------------------------------------------------------

const head = await bundlePrompts({ fromGitHead: true });
test.after(() => head.dispose());

test("the committed description has no shell section, which is the defect this file closes", () => {
  const committed = head.getDescriptionDsv3(false, "dsv3-1205", {});
  const working = native.getDescriptionDsv3(false, "dsv3-1205", {});
  const facts = native.resolveShellDialect({});

  assert.equal(namedShellCorrectlyForThisHost(committed), false, "the committed description cannot name a shell it does not mention; if this now passes, HEAD has the fix and this file is measuring nothing");
  assert.equal(namedShellCorrectlyForThisHost(working), true, `the working tree is the side under repair, and it has to satisfy the same instrument (description: ${working.slice(0, 200)})`);
  assert.equal(facts.shellName.length > 0, true, "the resolver has to produce a name for either side to be judged against");
});

function namedShellCorrectlyForThisHost(description) {
  const facts = native.resolveShellDialect({});
  return namesTheShellCorrectly(description, facts.shellName, facts.kind);
}

// ---------------------------------------------------------------------------
// 5. The findings this edit must not undo.
// ---------------------------------------------------------------------------

test("adding the shell section did not disturb the honest wait, the binary output rules or the sandbox text", () => {
  const description = native.getDescriptionDsv3(true, "dsv3-1205", { enableBlockUntilMs: true, defaultBlockUntilMs: 45_000, enableJobCompletionNotifications: true, readToolName: "Read" });

  assert.match(description, /block_until_ms/, "the backgrounded-wait guidance from an earlier wave is still part of this description");
  assert.match(description, /Read/, "the read-tool section is still appended after the dialect section");
  assert.match(description, /full_network/, "the sandbox section is still rendered when the sandbox is on");
  assert.match(description, /30000ms/, "the default command timeout is still stated");
  assert.ok(description.includes("<shell-dialect>"), "a description with no shell section is the committed state this file exists to change");
  assert.ok(description.indexOf("<shell-dialect>") < description.indexOf("Executes a given command"), "the shell identity must precede the guidelines, or the model reads the POSIX assumption first");
});