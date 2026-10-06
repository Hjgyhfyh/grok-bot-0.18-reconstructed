import { execFileSync } from "node:child_process";

/**
 * Reads a string out of Windows PowerShell without trusting the console codepage.
 *
 * Windows PowerShell 5.1 writes a redirected pipeline in the OEM codepage of the
 * console it inherited, and `execFileSync` reads it back as UTF-8. Every
 * character outside ASCII is therefore lost before the JSON is even parsed.
 * Measured on this host, whose install path is `D:\ТЕСТЫ\...`:
 *
 *   expected  D:\ТЕСТЫ\DeepSeek-Harness\...\main.cjs
 *   read as utf-8        D:\????\DeepSeek-Harness\...\main.cjs   (U+FFFD)
 *   read as windows-1251 D:\’…‘’›\DeepSeek-Harness\...\main.cjs (mojibake)
 *
 * Neither reader recovers the name, so every comparison built on the result -
 * "is this my own exec daemon?", "is this a box host?" - answers no for a
 * process launched from a path that is not pure ASCII, and answers it
 * CONSISTENTLY, which is what makes the failure so hard to see.
 *
 * The fix moves the encoding decision inside PowerShell, where the string is
 * already correct UTF-16: the expression is evaluated, cast to string, encoded
 * to UTF-8 bytes and printed as base64. What crosses the pipe is ASCII, so the
 * console codepage is irrelevant and no `[Console]::OutputEncoding` setting -
 * which only takes effect for output produced after it runs - is involved.
 */
export const POWERSHELL_UTF8_QUERY_HEAD = "$__grokOut = $(";
export const POWERSHELL_UTF8_QUERY_TAIL = "); [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$__grokOut))";

/** Wraps a PowerShell expression so its value crosses the pipe as base64 UTF-8. */
export function encodePowerShellUtf8Query(expression: string): string {
  // The `$( )` matters as much as the base64: an expression like
  // `... ; if ($null -ne $p) { ... }` writes its own value to stdout as it
  // runs, so without the subexpression the pipe carries the mojibake line AND
  // the base64 line, and the decoder reads the two concatenated.
  return `${POWERSHELL_UTF8_QUERY_HEAD}${expression}${POWERSHELL_UTF8_QUERY_TAIL}`;
}

/**
 * Decodes what `encodePowerShellUtf8Query` printed.
 *
 * An empty answer means the expression produced nothing - the process does not
 * exist, or the provider refused - and callers must read that as "cannot tell",
 * never as a value.
 */
export function decodePowerShellUtf8Output(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  // A caller that supplied its own runner may hand back something that was
  // never encoded. Passing it through keeps that caller's contract intact
  // instead of turning its value into replacement characters.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf8");
}

/** Runs one encoded expression and returns its decoded string. */
export function queryPowerShellUtf8(
  expression: string,
  options: { readonly timeoutMs?: number; readonly run?: typeof execFileSync } = {},
): string {
  const run = options.run ?? execFileSync;
  const output = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", encodePowerShellUtf8Query(expression)], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 5_000,
    windowsHide: true,
  });
  return decodePowerShellUtf8Output(String(output));
}