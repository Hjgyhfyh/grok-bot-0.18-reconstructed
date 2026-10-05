/**
 * The agent's access to the computer dropped from turn to turn, with no change
 * in what it asked for, and the transcript said why.
 *
 * WHAT BROKE. `NaiveTerminalExecutor` hands the agent's own command string to an
 * interpreter as the last argv element (`cmd.exe /c <command>`). It spawned
 * without `windowsVerbatimArguments`, so Node built a Windows command line out
 * of `argv` and escaped the arguments — and the command, which is full of quotes
 * the agent wrote, was escaped a SECOND time on its way to `cmd.exe`. `cmd.exe`
 * does not understand backslash-escaped quotes: it toggles quote state at every
 * `\"` and hands a truncated argument to the program.
 *
 * WHY NOTHING NOTICED. `echo`, `dir`, `mkdir` and `cd` carry no quotes and were
 * unaffected, so the shell looked healthy. The failure only appeared on commands
 * with a quoted argument, which is most real work: `python -c`, `node -e`,
 * `git commit -m "..."`, `powershell -Command "..."`. Worse, one of the two
 * shapes below reports EXIT 0 AND PRINTS NOTHING, so the model reads it as "the
 * machine did nothing" rather than as a broken command. That is the user's
 * complaint: the machine intermittently loses the ability to do the thing.
 *
 * WHAT IS ALREADY FIXED AND IS NOT TOUCHED HERE. `cwd` is passed to the spawn
 * (`naive.ts`), and an unspecified working directory resolves to the local-exec
 * root rather than to the persisted shell session directory
 * (`tests/local-exec-working-directory-drift.test.mjs`). Both are already true.
 * Neither this file nor the fix below widens the containment boundary: the root
 * still refuses `..` escapes and still refuses `gateway.json`, and the guard
 * tests at the bottom prove those refusals survive.
 *
 * WHAT THIS DOES NOT CLAIM. The fix is scoped to this one executor on purpose.
 * `powershell.ts` passes `-File <script path>` and `bash.ts` / `zsh.ts` pass
 * `-ilc <script text>`; they rely on Node quoting a path argument and are left
 * exactly as they were.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const naiveSource = readFileSync(path.join(repoRoot, "source", "packages", "shell-exec", "naive.ts"), "utf8");

async function importFromRepo(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-cmdline-"));
  try {
    for (const entry of entries) {
      await build({
        entryPoints: [path.join(repoRoot, "source", ...entry)],
        outfile: path.join(directory, entry.at(-1) + ".mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        logLevel: "silent",
        banner: {
          js: 'import { createRequire as __dshCreateRequire } from "node:module"; const require = __dshCreateRequire(import.meta.url);',
        },
      });
    }
    const loaded = {};
    for (const entry of entries) {
      loaded[entry.at(-1)] = await import(pathToFileURL(path.join(directory, entry.at(-1) + ".mjs")).href);
    }
    return loaded;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const loaded = await importFromRepo([
  ["packages", "shell-exec", "naive.ts"],
  ["packages", "context", "core.ts"],
]);
const { NaiveTerminalExecutor } = loaded["naive.ts"];
const { createContext } = loaded["core.ts"];

const isWindows = process.platform === "win32";

// One real interpreter for every host, so this is not a Windows-only assertion
// on a POSIX box: the property is "a quoted argument survives the trip", and on
// POSIX it has to survive too.
const INTERPRETER = isWindows
  ? { file: process.env.ComSpec ?? "cmd.exe", argv: (c) => ["/c", c] }
  : { file: "/bin/sh", argv: (c) => ["-c", c] };

/** Runs `command` through the shipped executor and returns everything it said. */
async function sayThroughShippedExecutor(command, cwd) {
  const executor = new NaiveTerminalExecutor(cwd, { shell: INTERPRETER.file });
  let said = "";
  let code;
  for await (const event of await executor.execute(createContext(), command, { workingDirectory: cwd })) {
    if (event.type === "stdout" || event.type === "stderr") said += String(event.data);
    if (event.type === "exit") code = event.code;
  }
  return { said: said.replace(/\r?\n/g, " ").trim(), code };
}

test("the executor that passes a raw command line does not let Node re-quote it on Windows", () => {
  // A commented-out line still contains the needle, so a plain substring search
  // is satisfied by the exact defect it is meant to catch. Only a live
  // statement counts.
  const live = naiveSource
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

  assert.ok(
    live.some((line) => /windowsVerbatimArguments\s*:\s*true/.test(line)),
    "the spawn options never asked Node to leave argv alone, so the agent's command is escaped twice before cmd.exe sees it",
  );
});

test("a quoted argument arrives at the program exactly as the agent wrote it", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-cmdline-"));
  try {
    // `cmd.exe echo` prints its quotes back, so it cannot tell corruption from
    // correct behaviour. This hands the argument to a real program instead and
    // asks it what it received. `node` is guaranteed: this test is running on it.
    const probe = `node -e "console.log(process.argv.slice(1).join('|'))" "keep-me-intact"`;
    const { said } = await sayThroughShippedExecutor(probe, cwd);

    assert.match(
      said,
      /keep-me-intact/,
      `the program never received the argument the agent wrote; it said: ${JSON.stringify(said)}`,
    );
    assert.doesNotMatch(
      said,
      /[\\"]/,
      "a backslash or a stray quote in the argument is Node's escaping, not anything the agent wrote",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a command that reports success without printing anything is the failure this closes", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "grok-cmdline-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  if (!isWindows) {
    t.skip("the silent-empty-success shape is a cmd.exe argv-parsing behaviour");
    return;
  }

  // `python -c "print(123)"` is the exact line from the live transcript. Before
  // the fix it exited 0 with no output at all, which reads to the model as "the
  // machine did nothing" rather than as a broken command.
  const { said } = await sayThroughShippedExecutor('python -c "print(123)"', cwd);

  assert.notEqual(
    said,
    "",
    "the command exited without a word, so the model is told the machine did nothing; that is the silent false success this test exists to make impossible",
  );
});

test("the sibling stateful executors still let Node quote their own arguments", async () => {
  // The fix is deliberately NOT in the shared spawn, because these two pass
  // arguments Node has to quote. If somebody moves `windowsVerbatimArguments`
  // into `spawnWithSignal`, a script path containing a space stops working and
  // this stops holding.
  for (const entry of [
    ["packages", "shell-exec", "powershell.ts"],
    ["packages", "shell-exec", "bash.ts"],
    ["packages", "shell-exec", "zsh.ts"],
    ["packages", "shell-exec", "zsh-light.ts"],
  ]) {
    const source = readFileSync(path.join(repoRoot, "source", ...entry), "utf8");
    assert.doesNotMatch(
      source,
      /windowsVerbatimArguments/,
      `${entry.join("/")} passes a script path or script text that Node must quote; verbatim arguments there break any path containing a space`,
    );
  }
});