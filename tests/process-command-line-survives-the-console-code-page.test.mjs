import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// A process command line read as UTF-8 lost every character outside ASCII, so the
// host could no longer answer "is that pid mine?" for anything installed under a
// non-ASCII path - and this repository is installed under one.
//
// Windows answers "whose pid is this?" with CIM, and the reader was
// `execFileSync("powershell.exe", [...], { encoding: "utf8" })`. Windows PowerShell
// 5.1 does not write a redirected pipeline in UTF-8: it writes it in whatever
// `[Console]::OutputEncoding` says, which it initialises from the console OEM code
// page. Measured here, from inside a redirected child spawned by node:
//
//   ConsoleOutCodePage=866   ConsoleOutWebName=cp866
//   $OutputEncoding=20127    [System.Text.Encoding]::Default=1251
//
// so the value was already the right string inside PowerShell and was destroyed on
// the way out. Twelve identical queries for one real command line under
// `D:\ТЕСТЫ\...`, at that code page: 12 mangled, 0 clean. The bytes were
// `5c 92 85 91 92 9b` - `\ТЕСТЫ` in cp866 - which UTF-8 turns into five U+FFFD.
//
// Nothing threw. A comparison against mangled text is still a comparison, and it
// answers the same wrong way every time, which is why 409 restarts of local-exec
// all logged "started" and none logged a failure.
//
// The fix moves the encoding decision inside PowerShell, where the value is
// already correct UTF-16: the expression is evaluated, cast to string, encoded to
// UTF-8 bytes and printed as base64. What crosses the pipe is ASCII, so the console
// code page is not consulted at all.
//
// WHY THESE TESTS FORCE THE CODE PAGE. The defect only appears while the console is
// on a legacy page, and the console code page is ambient state that anything can
// change - a `pwsh` session that sets `[Console]::OutputEncoding` to UTF-8 moves it
// to 65001 for everything that shares the console. Measured here: the same query,
// unchanged, answered correctly on one run and mangled on the next, purely because
// the page moved between them. A test that inherits that state is a test of
// whatever ran last, so the two tests that compare readers pin the page themselves
// with `[Console]::OutputEncoding=GetEncoding(866)` inside the child. They then mean
// the same thing on every machine, in any order, forever.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.platform;
/** The Cyrillic word is the whole point; an ASCII fixture would pass through both readers. */
const NON_ASCII = "ТЕСТЫ";
/** The legacy console page this box actually runs on, and the one the defect needs. */
const LEGACY_CODE_PAGE = 866;

/** Runs a PowerShell expression with the console output encoding pinned to `codePage`. */
function powershell(expression, codePage) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(${codePage}); ${expression}`,
    ],
    { timeout: 20_000, windowsHide: true, maxBuffer: 8 << 20 },
  );
}

async function bundle(entry) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-codepage-"));
  const outfile = path.join(directory, `${path.basename(entry).replace(/\.ts$/, "")}-${Date.now()}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source", ...entry.split("/"))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return {
    loaded: await import(pathToFileURL(outfile).href),
    dispose: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

/**
 * One live process started from a non-ASCII path, and whatever a reader makes of it.
 *
 * The CIM provider needs a moment after spawn before it answers at all, so the read
 * is polled. The attempt count is the loop ceiling: an uncapped poll is a test that
 * hangs instead of failing.
 */
async function withNonAsciiChild(read) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-codepage-child-"));
  const nested = path.join(directory, NON_ASCII);
  mkdirSync(nested, { recursive: true });
  const scriptPath = path.join(nested, "daemon-main.cjs");
  writeFileSync(scriptPath, "setInterval(() => {}, 1 << 30);\n");

  const child = spawn(process.execPath, [scriptPath], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    const startedAt = Date.now();
    const ceiling = 100;
    let attempts = 0;
    let command = null;
    for (; attempts < ceiling; attempts += 1) {
      command = read(child.pid);
      if (command != null) break;
      if (Date.now() - startedAt > 20_000) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { scriptPath, command, attempts };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const win32Only = PLATFORM === "win32"
  ? false
  : "the reader under test is the Windows CIM path; a POSIX host has no console OEM code page and no PowerShell to write one";

const tree = await bundle("host/host-lock.ts");
test.after(() => tree.dispose());
const fixedReader = tree.loaded.readProcessCommand;

const daemon = await bundle("host/box/exec-daemon-process.ts");
test.after(() => daemon.dispose());
const { commandCarriesBoxExecDaemonEntry } = daemon.loaded;

const query = await bundle("shared/node/powershell-utf8.ts");
test.after(() => query.dispose());
const { queryPowerShellUtf8, encodePowerShellUtf8Query, decodePowerShellUtf8Output } = query.loaded;

test(`reading a legacy console page as UTF-8 destroys the command line on ${PLATFORM}`, { skip: win32Only }, async () => {
  // The defect, pinned. The code page is set INSIDE the child, so this answers the
  // same on a box whose console is on 65001 and on one that is on 866.
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-codepage-victim-"));
  const nested = path.join(directory, NON_ASCII);
  mkdirSync(nested, { recursive: true });
  const victim = path.join(nested, "daemon-main.cjs");
  writeFileSync(victim, "setInterval(() => {}, 1 << 30);\n");
  const child = spawn(process.execPath, [victim], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let raw;
  try {
    const startedAt = Date.now();
    const ceiling = 100;
    for (let i = 0; i < ceiling; i += 1) {
      raw = powershell(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}').CommandLine`, LEGACY_CODE_PAGE);
      if (raw.length > 0) break;
      if (Date.now() - startedAt > 20_000) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // `execFileSync(..., { encoding: "utf8" })` decodes exactly like this.
    const asTheOldReaderSawIt = raw.toString("utf8");

    assert.ok(raw.length > 0, "the query returned nothing at all, so there is no value left to lose");
    assert.ok(
      raw.some(byte => byte >= 0x80),
      `the pipe carried only ASCII, so pinning the console to code page ${LEGACY_CODE_PAGE} did not take effect and this test measures nothing`,
    );
    assert.ok(
      asTheOldReaderSawIt.includes("�"),
      `the legacy bytes decoded as ${JSON.stringify(asTheOldReaderSawIt.slice(-90))} with no replacement characters, so this fixture no longer reproduces the defect`,
    );
    assert.equal(
      asTheOldReaderSawIt.includes(victim),
      false,
      `the legacy bytes decoded as ${JSON.stringify(asTheOldReaderSawIt.slice(-90))}, which DOES carry the path. The defect this file measures is not present in these bytes.`,
    );
    // The same bytes read with the right code page are exact, so nothing was wrong
    // with the value - only with the decoder.
    assert.equal(
      new TextDecoder(`cp${LEGACY_CODE_PAGE}`).decode(raw).includes(victim),
      true,
      `code page ${LEGACY_CODE_PAGE} did not recover the path from ${JSON.stringify(raw.toString("latin1").slice(-90))}, so the bytes on the pipe are not the ones this file claims they are`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test(`the shipped reader returns the same value with the console on a legacy code page on ${PLATFORM}`, { skip: win32Only }, () => {
  // The fix, pinned the same way. Same child, same pinned code page, and the answer
  // is still exact - because nothing but ASCII crosses the pipe.
  const expression = `'${NON_ASCII}'`;
  const raw = powershell(encodePowerShellUtf8Query(expression), LEGACY_CODE_PAGE)
    .toString("utf8")
    .trim();

  assert.ok(raw.length > 0, "PowerShell answered nothing at all, so there is no wire format left to inspect");
  assert.equal(
    /^[\x20-\x7e]+$/.test(raw),
    true,
    `the pipe carried ${raw.length} bytes of which ${[...raw].filter(c => c.charCodeAt(0) >= 0x80).length} are outside ASCII, so the value still depends on the console code page this fix exists to ignore`,
  );
  assert.equal(
    decodePowerShellUtf8Output(raw),
    NON_ASCII,
    "a Cyrillic literal did not survive the real PowerShell round trip with the console on a legacy code page, so every command-line comparison on this host is still decided by mangled text",
  );
});

test(`a live process started from a non-ASCII path reports its own command line on ${PLATFORM}`, { skip: win32Only }, async () => {
  const { scriptPath, command, attempts } = await withNonAsciiChild(pid => fixedReader(pid));

  assert.notEqual(command, null, `the command line of a live child could not be read at all in ${attempts} attempts on ${PLATFORM}, so this test cannot tell a fixed reader from a missing one`);
  assert.ok(
    command.includes(scriptPath),
    `the reader returned ${JSON.stringify(command)}, which does not carry the path ${scriptPath}. Every owner check built on this answer says "not mine" for an install under a non-ASCII drive path.`,
  );
  assert.ok(
    !command.includes("�"),
    `the reader returned replacement characters: ${JSON.stringify(command)}. The value was decoded with the wrong code page, so the damage is silent rather than loud.`,
  );
});

test(`the owner check that reclaims an orphaned exec daemon answers for the live process on ${PLATFORM}`, { skip: win32Only }, async () => {
  // The consequence, not the mechanism. This predicate decides whether a killed
  // host's own daemon is stopped and its port reclaimed; against a mangled command
  // line it answers no forever, which is the restart loop on 1337.
  const { scriptPath, command } = await withNonAsciiChild(pid => fixedReader(pid));

  assert.notEqual(command, null, "the fixture must produce a readable command line for this test to mean anything");
  assert.equal(
    commandCarriesBoxExecDaemonEntry(command, scriptPath),
    true,
    `the reader produced a command line that does not contain its own entry path: ${JSON.stringify(command)}. An orphan running this host's own entry could never be recognised, so the port stays bound forever.`,
  );
  assert.equal(
    commandCarriesBoxExecDaemonEntry(command.replaceAll(NON_ASCII, "?"), scriptPath),
    false,
    "the same predicate on mangled text must answer no, which is exactly why the reader had to be fixed rather than the comparison",
  );
});

test("the decoder answers for a Cyrillic literal with no runner at all, and says cannot-tell for nothing", () => {
  // Pure: no PowerShell, no platform. A test that needs the right code page
  // installed proves the installer, not the fix.
  assert.equal(
    queryPowerShellUtf8(`'${NON_ASCII}'`, { run: () => Buffer.from(NON_ASCII, "utf8").toString("base64") }),
    NON_ASCII,
    "a base64 UTF-8 payload must decode to the exact string, which is what makes the comparison independent of any code page",
  );
  assert.equal(
    decodePowerShellUtf8Output(""),
    "",
    "an empty answer must decode to an empty string, because every caller reads that as 'cannot tell' rather than as a value",
  );
  assert.equal(
    decodePowerShellUtf8Output("not base64 at all"),
    "not base64 at all",
    "a caller that supplied its own runner may hand back something that was never encoded, and turning its value into replacement characters would be a new corruption",
  );
});