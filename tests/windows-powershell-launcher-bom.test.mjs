import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `scripts/start-grokbot.ps1` was saved as UTF-8 with no byte order mark, so
// nothing in it declared how it must be decoded. Windows PowerShell 5.1 -- the
// shell the launcher's own usage banner names, `powershell -ExecutionPolicy
// Bypass -File scripts\start-grokbot.ps1` -- reads a BOM-less `.ps1` as ANSI,
// through the machine's legacy code page. This checkout lives under
// `D:\ТЕСТЫ\...`, so the path the launcher derives from `$PSScriptRoot` is
// Cyrillic. The reported symptom was `MODULE_NOT_FOUND host-main.cjs` in
// `%LOCALAPPDATA%\GrokBotLocalBox\box.log`, which reads as "the box died on its
// own" and sends you looking at the host instead of at the encoding.
//
// The mechanism tests below are what keep this from being a guess: they run the
// SAME Cyrillic path literal through the SAME Windows PowerShell 5.1 binary
// twice, once in a BOM-less script and once in a BOM-marked one. The BOM-less
// run must come back corrupted and the BOM run must come back exact. If the
// first one ever stops corrupting, the machine's ANSI code page has become UTF-8
// and the comparison would prove nothing -- so that case fails rather than passes.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(repoRoot, "scripts", "start-grokbot.ps1");
const POWERSHELL_51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// A path literal with Cyrillic in its first segment, spelled so the corruption
// is unmistakable and independent of whatever checkout this suite runs from.
const CYRILLIC_PATH_LITERAL = "D:\\ТЕСТЫ\\DeepSeek-Harness\\grok-bot-0.18-reconstructed";
const CORRUPTED_MARKER = "РўР•РЎРўР«";

const directory = mkdtempSync(path.join(os.tmpdir(), "grok-launcher-bom-"));
test.after(() => rmSync(directory, { recursive: true, force: true }));

/** Writes the same UTF-8 source twice, differing only by the three BOM bytes. */
function writeProbe(name, source, withBom) {
  const file = path.join(directory, name);
  const bytes = Buffer.from(source, "utf8");
  writeFileSync(file, withBom ? Buffer.concat([UTF8_BOM, bytes]) : bytes);
  return file;
}

function runPowerShell(script) {
  return execFileSync(
    POWERSHELL_51,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function runProbe(name, source, withBom) {
  const file = writeProbe(name, source, withBom);
  // `[Console]::OutputEncoding` is set because a child PowerShell writing to a
  // pipe emits its console code page, which would mojibake a correct answer on
  // the way back out and make a working fix look broken.
  return runPowerShell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${file}'`);
}

/** True when the launcher itself declares UTF-8, which is what the fix sets. */
function launcherDeclaresUtf8() {
  return readFileSync(launcherPath).subarray(0, 3).equals(UTF8_BOM);
}

const literalProbe = `$p = '${CYRILLIC_PATH_LITERAL}'\nWrite-Output ("P=" + $p)\n`;

test("the launcher script carries a UTF-8 byte order mark", () => {
  const bytes = readFileSync(launcherPath);
  assert.ok(bytes.length > 3, "the launcher file is empty, so this test proves nothing");
  assert.deepEqual(
    [...bytes.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    "scripts/start-grokbot.ps1 has no UTF-8 BOM, so Windows PowerShell 5.1 decodes it as ANSI and any Cyrillic in it becomes mojibake",
  );
});

test("the launcher script is valid UTF-8 from the first byte to the last", () => {
  const bytes = readFileSync(launcherPath);
  // fatal:true rejects malformed sequences and lone surrogates instead of
  // substituting U+FFFD, which a lenient decode would hide. ignoreBOM:true
  // keeps the marker in the output; without it TextDecoder eats the BOM and the
  // round-trip below cannot reproduce the file.
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assert.ok(
    decoded.charCodeAt(0) === 0xfeff,
    "the decoded text must open with the BOM, otherwise the file is not the UTF-8 the marker claims",
  );
  assert.equal(
    Buffer.from(decoded, "utf8").equals(bytes),
    true,
    "re-encoding the decoded text did not reproduce the file byte for byte, so the file is not cleanly decodable as UTF-8",
  );
  assert.ok(decoded.includes("Grok Bot"), "the file decoded to something that is not the launcher at all");
});

test("adding the BOM changed the encoding and nothing else", () => {
  const text = readFileSync(launcherPath, "utf8").replace(/^﻿/, "");
  assert.ok(text.startsWith("#Requires -Version 5.1"), "the #Requires line moved, so more than the encoding changed");
  assert.ok(
    text.includes("Start-Process -FilePath $ExePath") && text.includes("New-LocalBoxGatewayToken"),
    "the launcher lost its launch step or its token minting, so the BOM was not the only edit",
  );
  const parseErrors = runPowerShell(
    `$errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${launcherPath}', [ref]$null, [ref]$errors); $errors.Count`,
  );
  assert.equal(parseErrors, "0", "Windows PowerShell 5.1 reports parse errors in the launcher after the encoding change");
});

test("Windows PowerShell 5.1 corrupts a BOM-less Cyrillic literal and reads a BOM-marked one exactly", () => {
  const withoutBom = runProbe("control.ps1", literalProbe, false);
  const withBom = runProbe("marked.ps1", literalProbe, true);

  assert.equal(
    withBom,
    `P=${CYRILLIC_PATH_LITERAL}`,
    "even with a BOM, Windows PowerShell 5.1 did not read the Cyrillic path back exactly, so the fix does not work",
  );
  assert.notEqual(
    withoutBom,
    `P=${CYRILLIC_PATH_LITERAL}`,
    "the BOM-less control came back intact, so this machine's ANSI code page is already UTF-8 and this comparison can no longer demonstrate that the BOM is what fixes the decode",
  );
  assert.ok(
    withoutBom.includes(CORRUPTED_MARKER),
    `the BOM-less control decoded to ${withoutBom} rather than to the known mojibake, so the failure mode on show is not the one this fix closes`,
  );
});

test("this Cyrillic repository root survives under the encoding the launcher itself declares", () => {
  assert.ok(
    /[^\x00-\x7f]/.test(repoRoot),
    `this checkout is at ${repoRoot}, which has no non-ASCII in it, so it cannot demonstrate the defect this fix closes`,
  );
  // The launcher derives every path it touches from $PSScriptRoot. Resolving
  // $repoRoot the same way, in a script carrying the launcher's own encoding,
  // is the read this defect corrupts.
  const source = `$repoRoot = Split-Path -Parent (Split-Path -Parent '${launcherPath}')\nWrite-Output ("R=" + $repoRoot)\n`;
  const asLauncherIs = runProbe("root-as-declared.ps1", source, launcherDeclaresUtf8());
  const withoutBom = runProbe("root-control.ps1", source, false);

  assert.equal(
    asLauncherIs,
    `R=${repoRoot}`,
    "under the encoding scripts/start-grokbot.ps1 itself declares, Windows PowerShell 5.1 cannot read this Cyrillic checkout root back exactly",
  );
  assert.ok(
    withoutBom.includes(CORRUPTED_MARKER),
    `the BOM-less control decoded to ${withoutBom} rather than to the known mojibake, so the launcher path was never at risk on this machine and this test proves nothing`,
  );
});
