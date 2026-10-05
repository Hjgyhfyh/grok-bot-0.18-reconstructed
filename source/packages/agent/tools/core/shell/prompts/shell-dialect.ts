import { win32 } from "node:path";

import { isWindowsCommandInterpreter, resolveSpawnShell } from "../../../../../shell-exec/shell-env.js";

/**
 * Which command language the model is writing in.
 *
 * The shell tool never told the model which interpreter it was driving, so a
 * POSIX-trained model wrote POSIX. On Windows the command line is handed to
 * `cmd.exe`, where `2>/dev/null`, `;` as a separator, `$(...)` and `'` as a
 * quoting character all mean something other than what POSIX means, and the
 * shell rejects them before the requested program ever starts. The model then
 * invented a cause — "the wrapper counts `>` characters" — that it had no way
 * to test, and burned a whole turn on workarounds for a shell that was working.
 *
 * The facts below are read from the same resolution the executors use
 * (`resolveSpawnShell`, and `shellType` when a host declares one), so the text
 * cannot drift into describing a shell nothing will spawn.
 */
export type ShellDialectKind = "cmd" | "powershell" | "posix";

export interface ShellDialectFacts {
  /** The command language this shell speaks. */
  readonly kind: ShellDialectKind;
  /** `process.platform` of the host that runs the commands. */
  readonly platform: NodeJS.Platform;
  /** The interpreter name to show the model. */
  readonly shellName: string;
  /** True when the name came from an explicit `shellType`, not from resolution. */
  readonly declared: boolean;
}

export interface ShellDialectOptions {
  /** A shell the host declares for this surface. It wins over environment resolution. */
  readonly shellType?: string | undefined;
}

const POWERSHELL_NAME = /^(pwsh|powershell)(\.exe)?$/i;
const BASH_LIKE_NAME = /^(bash|zsh|sh|fish)(\.exe)?$/i;

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

/** `C:\Windows\system32\cmd.exe` is noise in a prompt; `cmd.exe` is the fact. */
export function shellDisplayName(shellPath: string): string {
  const trimmed = shellPath.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("\\") || trimmed.includes("/")) return win32.basename(trimmed);
  return trimmed;
}

function kindFor(name: string, platform: NodeJS.Platform): ShellDialectKind {
  const base = shellDisplayName(name);
  if (isWindowsCommandInterpreter(base)) return "cmd";
  if (POWERSHELL_NAME.test(base)) return "powershell";
  if (platform === "win32") return "cmd";
  if (BASH_LIKE_NAME.test(base)) return "posix";
  // An interpreter nobody recognises on a POSIX host still speaks POSIX in
  // every case this product can spawn; only Windows changes the language.
  return "posix";
}

/**
 * Reads the shell the way the executor reads it. `shellType` first, because a
 * host that knows the surface runs a specific interpreter is more authoritative
 * than environment sniffing; otherwise the same `resolveSpawnShell` the one-shot
 * executor calls, which never spawns a probe to answer this.
 */
export function resolveShellDialect(options: ShellDialectOptions = {}): ShellDialectFacts {
  const platform = process.platform;
  const declared = options.shellType?.trim();
  const shellName = declared !== undefined && declared.length > 0 ? declared : resolveSpawnShell();
  return {
    kind: kindFor(shellName, platform),
    platform,
    shellName: shellDisplayName(shellName),
    declared: declared !== undefined && declared.length > 0,
  };
}

function cmdSection(facts: ShellDialectFacts): string {
  const shell = facts.shellName;
  return [
    `<shell-dialect>`,
    `- Platform: ${platformLabel(facts.platform)}. The shell is \`${shell}\`, the Windows command interpreter. It is not bash, zsh or sh, and POSIX shell syntax does not apply to it.`,
    "- These do work here: \`&\` and \`&&\` separate commands, \`|\` pipes, \`(...)\` groups, \`>\` \`>>\` and \`2> file\` redirect. \`&&\` runs the next command only when the first succeeded.",
    "- These fail before your program starts: \`2>/dev/null\` or any \`/dev/null\` path (\`echo hi > /dev/null\` gives a syntax error), and \`export VAR=value\` (\`export\` is not a command here).",
    "- These are ordinary text here, not syntax: \`;\` as a command separator (\`echo a; echo b\` prints \`a; echo b\`), \`$(...)\` and backticks (printed as written), \`~\` for home, \`*\` and \`?\` glob expansion, and \`'\` as a quoting character — \`echo 'a b'\` prints \`'a b'\`, quotes included.",
    "- Escape a special character with a leading \`^\`: \`echo 1 ^> 2\` prints \`1 > 2\`. Inside double quotes \`< > & | ^\` are literal, but a double quote does not survive the trip to the program — see the \`python -c\` rule below.",
    "- \`%NAME%\` expands from the environment and \`%USERPROFILE%\` is the home directory, but the expansion happens when the line is read: \`set NAME=value & echo %NAME%\` still prints \`%NAME%\`. Set it on an earlier line.",
    "- \`dir\` lists, \`type NAME\` prints one file whole, \`md NAME\` creates a directory, \`cd\` changes directory, \`del NAME\` deletes. Paths use \`\\\` and a drive letter.",
    "- CRITICAL for \`python -c\`: everything after \`-c \` must be ONE word — no spaces and no double quotes — or cmd.exe splits the line and Python receives only the first word. \`python -c print('a b')\` reaches Python as \`print('a\` and raises \`SyntaxError: unterminated string literal\`. Use single quotes inside Python; double quotes are destroyed before Python sees them.",
    "- Working file write: \`python -c open('notes.txt','w').write('hello_world')\`. For text or bytes that contain spaces, base64-encode them and let Python decode, because base64 has no spaces: \`python -c __import__('pathlib').Path('notes.txt').write_bytes(__import__('base64').b64decode('aGVsbG8gd29ybGQ='))\` writes \`hello world\`. The same rule covers binary data — a \`b'...'\` literal is split exactly like a string with a space in it.",
  ].join("\n") + `\n</shell-dialect>`;
}

function powershellSection(facts: ShellDialectFacts): string {
  return [
    `<shell-dialect>`,
    `- Platform: ${platformLabel(facts.platform)}. The shell is \`${facts.shellName}\`. It is neither bash nor cmd.exe.`,
    "- \`;\` separates commands and \`|\` pipes. \`&&\` needs PowerShell 7 or later; on Windows PowerShell 5.1 use \`;\`. \`2>$null\` drops errors — \`2>/dev/null\` does not exist here.",
    "- Variables are \`$env:NAME\`, not \`%NAME%\`. A literal special character is escaped with a backtick, not with \`^\`.",
    "- \`Get-ChildItem\`, \`Get-Content\`, \`New-Item\` and \`Remove-Item\` have the aliases \`ls\`, \`cat\`, \`mkdir\` and \`rm\`. \`ls\` here lists like \`dir\`, not like POSIX \`ls\`.",
    "- Working file write: \`python -c \"open('notes.txt','w').write('hello world')\"\`. PowerShell passes the double-quoted text to Python as one argument, so spaces survive.",
  ].join("\n") + `\n</shell-dialect>`;
}

function posixSection(facts: ShellDialectFacts): string {
  return [
    `<shell-dialect>`,
    `- Platform: ${platformLabel(facts.platform)}. The shell is \`${facts.shellName}\`, a POSIX shell. POSIX syntax applies: \`|\`, \`&&\`, \`;\`, \`$(...)\`, backticks, \`(...)\` grouping, \`2>/dev/null\` and single-quoted strings all behave as written.`,
    "- There is no cmd.exe here. Do not use \`&\` as a command separator — it backgrounds a command instead. Do not escape characters with \`^\`. Do not use \`%NAME%\` for a variable; use \`$NAME\` or \`\${NAME}\`. There is no \`type\` command here; \`cat\` prints a file.",
    "- Working file write: \`python -c \"open('notes.txt','w').write('hello world')\"\`.",
  ].join("\n") + `\n</shell-dialect>`;
}

/**
 * The one-paragraph correction that names the shell, refuses the POSIX syntax
 * this shell does not have, and hands over a command that really runs.
 */
export function getShellDialectSectionText(facts: ShellDialectFacts): string {
  switch (facts.kind) {
    case "cmd": return cmdSection(facts);
    case "powershell": return powershellSection(facts);
    case "posix": return posixSection(facts);
  }
}

/**
 * How to chain commands in this shell, for the guideline lines that used to
 * hardcode POSIX separators. \`;\` is a separator in a POSIX shell and a literal
 * character in cmd.exe, so the same sentence cannot be right for both.
 */
export function shellSeparatorGuidance(facts: ShellDialectFacts): string {
  if (facts.kind === "cmd") return "use `&` or `&&` to separate them; `;` is a literal character in this shell, not a separator";
  if (facts.kind === "powershell") return "use `;` to separate them; `&&` needs PowerShell 7 or later";
  return "use `;` or `&&` to separate them";
}

/**
 * What to append to a command that would otherwise open a pager. \`cat\` is not
 * a cmd.exe builtin, so appending \`| cat\` there fails on the shell rather than
 * on the program.
 */
export function shellPagerGuidance(facts: ShellDialectFacts): string {
  if (facts.kind === "cmd") return "do not append `| cat`, because this shell has no `cat`; print a file with `| type` and avoid anything that pages (`more`, `less`)";
  return "append `| cat`";
}