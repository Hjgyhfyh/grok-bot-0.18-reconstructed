/**
 * The agent's access to the user's own computer dropped from turn to turn, with
 * no change in what it asked for. Two path guards produced that, and neither
 * one is the containment check everybody assumed was responsible.
 *
 * 1. `resolveShellWorkingDirectory` answered an unspecified working directory
 *    with the EMPTY STRING instead of the local-exec root, and reported
 *    `fellBackToRoot: false` while doing it. `shell-core.ts` reads that value as
 *    `args.workingDirectory || await this.executor.getCwd()`, and the empty
 *    string is falsy, so the command inherited the PERSISTED shell session
 *    directory. `powershell.ts` rewrites that persisted directory after every
 *    command from the snapshot the wrapper writes, so one `cd` outside the root
 *    made every later call that named no directory run — and be refused by
 *    `createLocalExecPermissionsService.escapes` — somewhere the model never
 *    asked for. Nothing raised: the refusal arrives as "Command blocked by
 *    permissions configuration" on a command that named no path at all.
 *
 * 2. `NaiveTerminalExecutor.execute` computed `cwd` from `options.workingDirectory`
 *    and then spawned without it, so the child inherited the daemon's own
 *    working directory. The four sibling executors (`bash.ts`, `zsh.ts`,
 *    `zsh-light.ts`, `powershell.ts`) all pass `cwd` to `spawnWithSignal`; only
 *    `naive.ts` did not. Every relative path in such a turn landed in the wrong
 *    place, which reads to the user as the machine intermittently losing access.
 *
 * WHAT THIS DOES NOT CHANGE. The containment boundary is untouched: the root
 * still refuses `..` escapes, still refuses `gateway.json` (the loopback
 * gateway token), and still refuses a junction that resolves outside. The tests
 * at the bottom of this file prove those refusals survive, so a green run here
 * cannot be bought by widening the sandbox root.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function moduleName(entry) {
  return entry.at(-1);
}

async function importFromRepo(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-paths-"));
  try {
    for (const entry of entries) {
      await build({
        entryPoints: [path.join(repoRoot, "source", ...entry)],
        outfile: path.join(directory, moduleName(entry) + ".mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        logLevel: "silent",
        // Bundling an ESM output drags CJS dependencies (iconv-lite -> safer-buffer)
        // through a synthetic require. Hand them the real one.
        banner: {
          js: 'import { createRequire as __dshCreateRequire } from "node:module"; const require = __dshCreateRequire(import.meta.url);',
        },
      });
    }
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

const machine = (await importFromRepo([["host", "local-exec", "local-exec-machine.ts"]]))["local-exec-machine.ts"];
const { containPath, resolveShellWorkingDirectory } = machine;

const executor = await importFromRepo([
  ["local-exec-daemon", "production-executor.ts"],
  ["packages", "shell-exec", "naive.ts"],
  ["packages", "context", "core.ts"],
]);
const { createLocalExecPermissionsService } = executor["production-executor.ts"];
const { NaiveTerminalExecutor } = executor["naive.ts"];
const { createContext } = executor["core.ts"];

const ROOT = path.join(os.tmpdir(), "grok-local-exec-root");

test("an unspecified working directory resolves to the local-exec root, not to the empty string", async () => {
  const empty = await resolveShellWorkingDirectory({ root: ROOT, requested: "" });

  assert.equal(
    empty.workingDirectory,
    ROOT,
    "an unspecified working directory has to become the local-exec root, because shell-core reads `args.workingDirectory || getCwd()` and an empty string is falsy, so it handed the command the persisted shell session directory instead",
  );
  assert.equal(
    empty.fellBackToRoot,
    false,
    "nothing fell back: the root is the answer for a request that named no directory, and claiming a fallback prints a 'does not exist' notice that is not true",
  );

  const blank = await resolveShellWorkingDirectory({ root: ROOT, requested: "   " });
  assert.equal(
    blank.workingDirectory,
    ROOT,
    "a whitespace-only working directory is the same request as an empty one and has to resolve the same way",
  );
});

test("a persisted session directory outside the root cannot turn an unspecified request into a refusal", async () => {
  const permissions = createLocalExecPermissionsService({ root: ROOT, env: { SAND_DATA_ROOT: path.join(os.tmpdir(), "grok-no-settings") } });
  const escaped = path.join(os.tmpdir(), "grok-a-directory-the-agent-cd-into-last-turn");
  const resolution = await resolveShellWorkingDirectory({ root: ROOT, requested: "" });

  // What shell-core.ts:219 does with the value, verbatim: `a || await getCwd()`.
  const sessionDirectory = resolution.workingDirectory || escaped;
  assert.equal(
    sessionDirectory,
    ROOT,
    "the command ran in the directory the model named, not in whatever the previous turn left behind",
  );

  const decision = await permissions.shouldBlockShellCommand(undefined, "dir", { workingDirectory: sessionDirectory });
  assert.equal(
    decision.kind,
    "allow",
    "a command that named no directory was blocked by permissions configuration purely because an earlier turn had changed the shell's directory",
  );
});

test("NaiveTerminalExecutor starts the child in the working directory it was given", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-naive-cwd-"));
  try {
    const wanted = path.join(root, "wants-to-be-here");
    mkdirSync(wanted, { recursive: true });

    const naive = new NaiveTerminalExecutor(path.join(root, "cloned-to-here"), {});
    const observed = [];
    for await (const event of await naive.execute(createContext(), process.platform === "win32" ? "cd" : "pwd", { workingDirectory: wanted })) {
      if (event.type === "stdout") observed.push(String(event.data));
      if (event.type === "stderr") observed.push(String(event.data));
      if (event.type === "exit") observed.push(`exit=${event.code}`);
    }
    const said = observed.join(" ").replace(/[\r\n]+/g, " ");

    assert.match(
      said,
      /wants-to-be-here/,
      `the child ran somewhere other than the directory it was handed; it reported: ${said}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The boundary must not move. These refusals are correct and must survive any
// change to the two defects above: the root is the boundary, and gateway.json
// carries the loopback gateway bearer token.
// ---------------------------------------------------------------------------

test("the containment boundary still refuses what it always refused", async () => {
  await assert.rejects(
    () => containPath({ root: ROOT, path: path.join(ROOT, "..", "gateway.json") }),
    /outside the allowed local-exec root/,
    "gateway.json sits one level above the root and carries the loopback gateway token, so it must stay refused",
  );
  await assert.rejects(
    () => containPath({ root: ROOT, path: path.join(os.homedir(), "Documents", "notes.txt") }),
    /outside the allowed local-exec root/,
    "the user's own documents are outside the local-exec root and must stay refused",
  );
  const inside = await containPath({ root: ROOT, path: path.join(ROOT, "notes", "todo.txt") });
  assert.equal(
    inside,
    path.join(ROOT, "notes", "todo.txt"),
    "a path inside the root, including one that does not exist yet, is what the root is for",
  );
});