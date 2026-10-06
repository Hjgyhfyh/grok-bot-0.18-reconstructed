import { existsSync } from "node:fs";
import { win32 } from "node:path";

import { SHELL_ENV_OVERRIDES } from "./types.js";

/**
 * Windows environment variable names are case-insensitive, but a JavaScript
 * object key is not. `{ ...process.env, PATH: "x" }` on Windows keeps BOTH the
 * parent's `Path` and the caller's `PATH`, and `child_process` then decides
 * which one the child receives by sorting the keys and taking the first spelling
 * it sees per upper-cased name. That ordering is a UTF-16 artefact, not
 * precedence: `PATH` beats `Path`, but the caller's `path` silently loses to the
 * parent's `Path`. A caller that narrows `PATH` for a child shell therefore
 * gets the full inherited `PATH` instead, with no error anywhere.
 *
 * `mergeShellEnv` makes precedence explicit instead. Later sources win, and the
 * first spelling seen for a name is the one kept, so `Path` stays `Path` while
 * still receiving the caller's value.
 */

function findExistingNameKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === wanted);
}

/** Reads an environment variable by case-insensitive name on Windows. */
export function readEnvName(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  const key = findExistingNameKey(env, name);
  return key === undefined ? undefined : env[key];
}

export function mergeShellEnv(...sources: readonly (NodeJS.ProcessEnv | undefined)[]): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  if (process.platform !== "win32") {
    for (const source of sources) Object.assign(merged, source);
    return merged;
  }
  // Windows only: one key per name, last writer wins, first spelling kept.
  const spelling = new Map<string, string>();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const key of Object.keys(source)) {
      const normalized = key.toLowerCase();
      const seen = spelling.get(normalized);
      const target = seen ?? key;
      if (seen === undefined) spelling.set(normalized, key);
      const value = source[key];
      if (value === undefined) delete merged[target];
      else merged[target] = value;
    }
  }
  return merged;
}

/**
 * Fills in the one environment value a child program needs before its own text
 * can be read back, when nothing in the environment already says otherwise.
 *
 * WHAT CHANGED. Nothing set `PYTHONIOENCODING`, so Python chose its own stdout
 * encoding the way CPython does on Windows: `locale.getpreferredencoding()`, which
 * is the ANSI code page. On this box that is CP1251 while `cmd.exe` writes the
 * console code page, measured as 65001, so a single shell pipeline carried two
 * different legacy encodings. Measured through the box exec daemon, same command
 * twice, the only difference being this one variable:
 *
 *   without it                                          with it
 *   -------------------------------                    ---------------------
 *   `python -c "print('Привет мир')"`  ->  `╧ЁштхЄ ьшЁ`      `Привет мир`
 *   `python -c "print('日本語')"`      ->  exit 1,          `日本語`, exit 0
 *                                       UnicodeEncodeError
 *
 * The second is the one that costs the agent its turn: the program the agent
 * runs most, on a machine whose console is already UTF-8, dies on its own output.
 * `shell-output-text.ts` already names the same hazard from the reading side —
 * "a child program such as Python writes its own ANSI code page (CP1251 on the
 * same machine, measured), so one command can produce two different legacy
 * encodings at once" — and this is the writing side of that sentence.
 *
 * `PYTHONIOENCODING` and not `PYTHONUTF8`. Only stdout, stderr and stdin move.
 * `PYTHONUTF8=1` would also repoint `open()`'s default encoding, which changes
 * what an existing script reads off disk; this is the narrow value that fixes
 * what was measured and nothing else.
 *
 * Filled in only when absent, so a host that sets it deliberately keeps its own
 * choice, and removed never: a name the caller put there stays the caller's.
 * This adds no capability a command did not already have — it changes how text is
 * encoded on the way out of a process, not what that process may reach.
 */
export const SHELL_TEXT_ENV_DEFAULTS = { PYTHONIOENCODING: "utf-8" } as const;

/** Copies `env` and fills in any shell text default it does not already carry. */
export function withShellTextEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(SHELL_TEXT_ENV_DEFAULTS) as (keyof typeof SHELL_TEXT_ENV_DEFAULTS)[]) {
    if (readEnvName(merged, key) === undefined) merged[key] = SHELL_TEXT_ENV_DEFAULTS[key];
  }
  return merged;
}

/**
 * Builds the child environment for a shell process. `HOME` and `SHELL` are
 * absent from a stock Windows environment block even though POSIX-shaped tooling
 * reads both, so they are filled in from `USERPROFILE` and the resolved shell.
 */
export function buildShellEnv(options: {
  readonly base?: NodeJS.ProcessEnv | undefined;
  readonly overrides?: NodeJS.ProcessEnv | undefined;
  readonly shell?: string | undefined;
}): NodeJS.ProcessEnv {
  const env = withShellTextEnv(mergeShellEnv(
    options.base ?? process.env,
    SHELL_ENV_OVERRIDES,
    options.overrides,
  ));
  if (process.platform !== "win32") return env;

  const userProfile = readEnvName(env, "USERPROFILE");
  if (userProfile !== undefined && readEnvName(env, "HOME") === undefined) env.HOME = userProfile;

  const shell = options.shell;
  if (shell !== undefined && readEnvName(env, "SHELL") === undefined && !isWindowsCommandInterpreter(shell)) {
    env.SHELL = shell;
  }
  return env;
}

export function isWindowsCommandInterpreter(shellPath: string): boolean {
  const base = win32.basename(shellPath.replace(/[\\/]+$/, "")).toLowerCase();
  return base === "cmd" || base === "cmd.exe";
}

/**
 * A `SHELL` value inherited on Windows is frequently a POSIX path (`/bin/bash`)
 * left over from a WSL or Git Bash profile. Node cannot spawn it, so the naive
 * executor would fail with ENOENT on a value that looks perfectly valid.
 */
export function isSpawnableShellOnThisHost(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (process.platform !== "win32") return true;
  if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\") || candidate.includes("\\")) {
    return existsSync(candidate);
  }
  if (candidate.includes("/")) return false;
  return true;
}

export const WINDOWS_COMMAND_INTERPRETER_FALLBACK = "cmd.exe";
export const POSIX_COMMAND_INTERPRETER_FALLBACK = "/bin/sh";

/**
 * Resolves the executable used to run a one-shot `-c` command. An explicit hint
 * always wins. Otherwise `SHELL` is honoured only when this host can actually
 * spawn it, and Windows falls back to `ComSpec` rather than to `/bin/sh`.
 */
export function resolveSpawnShell(hint?: string): string {
  const explicit = hint?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && isSpawnableShellOnThisHost(fromEnv)) return fromEnv;
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec?.trim();
    return comSpec !== undefined && comSpec.length > 0 ? comSpec : WINDOWS_COMMAND_INTERPRETER_FALLBACK;
  }
  return POSIX_COMMAND_INTERPRETER_FALLBACK;
}

/**
 * `sh`, `bash`, `zsh`, `pwsh` and `powershell` all take `-c`; `cmd.exe` takes
 * `/c`. Only Windows reaches the `cmd.exe` branch, so macOS and Linux keep
 * their existing argv exactly.
 */
export function buildShellCommandArgs(
  shellPath: string,
  configuredShellArgs: readonly string[] | undefined,
  command: string,
): readonly string[] {
  const prefix = configuredShellArgs ?? [];
  return process.platform === "win32" && isWindowsCommandInterpreter(shellPath)
    ? [...prefix, "/c", command]
    : [...prefix, "-c", command];
}