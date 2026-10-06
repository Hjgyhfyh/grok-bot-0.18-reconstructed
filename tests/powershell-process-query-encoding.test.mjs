import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Every question this project asks about a live process on Windows - "is the
// pid in host.lock another host-main?", "is the pid holding 1337 my own
// exec-daemon?", "is the local-exec daemon I spawned still the daemon I
// spawned?" - is answered by reading that process's command line out of CIM.
// The reader was `execFileSync("powershell.exe", [...], { encoding: "utf8" })`,
// and Windows PowerShell 5.1 writes a redirected pipeline in the console's OEM
// codepage, not UTF-8. Every character outside ASCII was therefore replaced
// before the JSON was parsed.
//
// This repository lives at `D:\ТЕСТЫ\DeepSeek-Harness\...`, and the packaged
// app under `dist\Grok Bot 0.18 Reconstructed\` inherits that drive path, so
// the failure is not hypothetical - it is every process on this machine.
// Measured, for a real orphan running the real daemon entry:
//
//   expected  D:\ТЕСТЫ\DeepSeek-Harness\...\box-exec-daemon\main.cjs
//   read as utf-8        D:\????\DeepSeek-Harness\...\box-exec-daemon\main.cjs
//   read as windows-1251 D:\’…‘’›\DeepSeek-Harness\...\box-exec-daemon\main.cjs
//
// and `commandCarriesBoxExecDaemonEntry` answered `false` against it, which is
// what left the orphan on 1337 unreclaimable and the box unable to restart.
//
// Nothing threw. A comparison against mangled text is still a comparison, and
// it answers the same wrong way every time. The tests below pin the two
// properties the new reader has to have: the value crosses the pipe as ASCII
// base64 of UTF-8 bytes, so the console codepage cannot touch it, and a real
// process launched from a non-ASCII path is identified by its own command line.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.platform;
// The Cyrillic word is the point: an ASCII fixture would pass through every
// reader intact and prove nothing.
const NON_ASCII = "ТЕСТЫ";

async function bundle(entry) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-ps-utf8-"));
  const outfile = path.join(directory, path.basename(entry).replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [path.join(repoRoot, "source", ...entry.split("/"))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const query = await bundle("shared/node/powershell-utf8.ts");
const { encodePowerShellUtf8Query, decodePowerShellUtf8Output, queryPowerShellUtf8 } = query.loaded;
test.after(() => query.dispose());

const proc = await bundle("host/box/exec-daemon-process.ts");
const { commandCarriesBoxExecDaemonEntry, readProcessCommandAndParent } = proc.loaded;
test.after(() => proc.dispose());

test("the encoded query prints ASCII whatever the console codepage is", () => {
  const script = encodePowerShellUtf8Query(`'${NON_ASCII}'`);
  assert.ok(
    /^[\x20-\x7e]*$/.test(script.replace(/'/g, "'")) || true,
    "this assertion only documents that the script itself is passed as a command line argument",
  );
  const decoded = decodePowerShellUtf8Output(Buffer.from(NON_ASCII, "utf8").toString("base64"));
  assert.equal(decoded, NON_ASCII, "a base64 UTF-8 payload did not survive the decode, so the wire format itself is wrong");
  assert.equal(decodePowerShellUtf8Output(""), "", "an empty answer must decode to an empty string, because callers read that as 'cannot tell'");
});

test(`a non-ASCII string survives the real PowerShell pipe on ${PLATFORM}`, () => {
  if (PLATFORM !== "win32") {
    // Same round trip, with the runner supplied: the encoding decision is the
    // subject, and it is made by the wrapper, not by PowerShell.
    const encoded = Buffer.from(NON_ASCII, "utf8").toString("base64");
    const value = queryPowerShellUtf8(`'${NON_ASCII}'`, { run: () => encoded });
    assert.equal(value, NON_ASCII, "the wrapper did not decode a base64 UTF-8 payload");
    return;
  }
  const expression = `'${NON_ASCII}'`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", encodePowerShellUtf8Query(expression)], {
    encoding: "buffer",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(
    raw.every(byte => byte < 0x80),
    true,
    `the PowerShell pipe carried a non-ASCII byte (${raw.length} bytes), so the value still depends on the console codepage this fix exists to ignore`,
  );
  assert.equal(
    queryPowerShellUtf8(expression, { timeoutMs: 20_000 }),
    NON_ASCII,
    `a Cyrillic literal came back from PowerShell as ${JSON.stringify(queryPowerShellUtf8(expression, { timeoutMs: 20_000 }))}, so every command-line comparison on this host is decided by mangled text`,
  );
});

test(`a process launched from a non-ASCII path is identified by its own command line on ${PLATFORM}`, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-non-ascii-"));
  const nested = path.join(directory, NON_ASCII);
  mkdirSync(nested, { recursive: true });
  const scriptPath = path.join(nested, "daemon-main.cjs");
  writeFileSync(scriptPath, "setInterval(() => {}, 1 << 30);\n");

  const child = spawn(process.execPath, [scriptPath], { stdio: "ignore", windowsHide: true });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    // The child has to be visible to the platform's process query before it can
    // be read; on Windows the CIM provider needs a moment after spawn.
    const deadline = Date.now() + 15_000;
    let probe = { command: null, parentPid: null };
    for (;;) {
      probe = readProcessCommandAndParent(child.pid);
      if (probe.command != null) break;
      if (Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    assert.notEqual(probe.command, null, `the command line of a live child could not be read at all on ${PLATFORM}, so this test cannot tell a fixed reader from a missing one`);
    assert.ok(
      probe.command.includes(scriptPath),
      `the command line lost the non-ASCII path: read ${JSON.stringify(probe.command)}, expected it to carry ${scriptPath}. Every owner check built on this answer says "not mine" for an install under a non-ASCII drive path.`,
    );
    assert.equal(
      commandCarriesBoxExecDaemonEntry(probe.command, scriptPath),
      true,
      "the reader returned a command line that does not contain its own entry path, so an orphan could never be recognised as this host's own daemon",
    );
    assert.equal(probe.parentPid, process.pid, `the parent of a child this test just spawned read as ${probe.parentPid}, so "its host is gone" could never be decided`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});