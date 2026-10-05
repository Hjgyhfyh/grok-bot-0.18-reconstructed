import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The agent could not see the user's own machine, and the two reasons were both
 * in how this daemon hands a command to `cmd.exe`.
 *
 * 1. `spawnShell` did not set `windowsVerbatimArguments`. Node builds a Windows
 *    command line out of `argv` and escapes the arguments, so the agent's command
 *    string — full of the double quotes it wrote — was escaped a second time on
 *    its way to `cmd.exe /c`, and the interpreter then split it again. Measured
 *    on this machine with the interpreter and the flag held fixed:
 *
 *      `python -c "print(123)"`             exited 0 and printed nothing
 *      `python -c "import sys;print(1+1)"`  exited 1, Python saw `"import`
 *      `echo "q1" > q1.txt`                 wrote `\"q1\"`
 *
 *    The first of those is the worst shape a failure can have: it reported
 *    success, produced no output, and left the model reading a machine that had
 *    quietly done nothing. One user session's transcript journal carries 18 such
 *    Python SyntaxErrors and 7 silently empty successes out of 154 shell calls,
 *    and the model described the box as "breaking quotes" and then as losing
 *    access to the computer.
 *
 * 2. Both `shellStream` and `run` captured child output with `String(chunk)`,
 *    which is `Buffer.toString("utf8")`. `cmd.exe` writes its console code page
 *    — CP866 on a Russian Windows, measured — so every Russian system message
 *    arrived as U+FFFD. 35 of the same 154 results carried replacement
 *    characters, 195 168 of them in total, including every "не является
 *    внутренней или внешней командой" and every "Не удается найти указанный
 *    файл". The agent could not read why a command failed, and reported a
 *    refusal that never happened.
 *
 * The tests below start the daemon from source and drive it through the same
 * Connect routes and protobuf messages the host uses. No transport is mocked and
 * no child is stubbed: the output asserted on is produced by a `cmd.exe` this
 * machine started. The decoding tests feed the decoder real code-page bytes, so
 * they mean the same thing on a box whose console is not Russian.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const SHIM_SOURCE = `
export { startBoxExecDaemon, resolveShellInvocation } from "./box-exec-daemon/server.js";
export { createShellOutputDecoder, codePageLabel, resolveConsoleCodePageLabel } from "./box-exec-daemon/shell-output-text.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { ShellArgs } from "./packages/proto/generated/agent/v1/shell_exec_pb.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-cmdline-"));
  const outfile = path.join(directory, "box-cmdline-shim.cjs");
  await build({
    stdin: {
      contents: SHIM_SOURCE,
      resolveDir: path.join(repoRoot, "source"),
      sourcefile: "box-cmdline-shim.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return {
    shim: createRequire(import.meta.url)(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

const AUTH_TOKEN = "c".repeat(43);

let shim;
let disposeShim;
let handle;
let exec;
let workspaceRoot;
let terminalsDirectory;
let nextId = 1;

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-box-cmdline-workspace-"));
  terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-box-cmdline-terminals-"));
  handle = await shim.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: AUTH_TOKEN, port: 0 });
  const transport = shim.createConnectTransport({
    baseUrl: handle.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  exec = shim.createClient(shim.ExecService, transport, { transport });
});

test.after(async () => {
  await handle?.stop();
  for (const directory of [workspaceRoot, terminalsDirectory]) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  disposeShim?.();
});

/** The deadline is the safety ceiling: a daemon that cannot start a process would otherwise hang this file. */
async function drive(message, deadlineMs = 30_000) {
  const id = nextId++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const frames = [];
  try {
    const stream = exec.exec(new shim.ExecServerMessage({ id, execId: `exec-${id}`, message }), { signal: controller.signal });
    for await (const element of stream) {
      if (element.element.case === "execClientMessage") {
        frames.push({ kind: "result", case: element.element.value.message.case, value: element.element.value.message.value });
      } else if (element.element.case === "execClientControlMessage" && element.element.value.message.case === "throw") {
        frames.push({ kind: "throw", value: element.element.value.message.value });
      }
    }
  } catch (error) {
    frames.push({ kind: "throw", value: { error: `the daemon never finished the request (${deadlineMs} ms): ${error instanceof Error ? error.message : String(error)}` } });
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

const shellArgs = (command, timeout = 30_000) => ({
  case: "shellArgs",
  value: new shim.ShellArgs({ command, workingDirectory: workspaceRoot, timeout }),
});

function oneShot(command, timeout = 30_000) {
  return async () => {
    const frames = await drive(shellArgs(command, timeout));
    const throwFrame = frames.find(frame => frame.kind === "throw");
    assert.equal(throwFrame, undefined, `the daemon refused to run the command: ${throwFrame?.value.error ?? ""}`);
    const frame = frames[0];
    assert.equal(frame.case, "shellResult", `the daemon answered the wrong message arm: ${frame.case}`);
    assert.equal(frame.value.result.case, "success", `the command did not run: ${JSON.stringify(frame.value.result)}`);
    const { stdout, stderr, exitCode } = frame.value.result.value;
    assert.equal(exitCode, 0, `the command reported a failure: ${stderr}`);
    return { stdout, stderr, exitCode };
  };
}

// ---------------------------------------------------------------------------
// The command reaches the interpreter as the agent wrote it.
// ---------------------------------------------------------------------------

test("a double-quoted argument with no space in it still reaches the program", { skip: !isWindows }, async () => {
  // Before the fix this exited 0 with empty stdout: Python received the literal
  // text `"print(123)"`, a string that evaluates and prints nothing, so the model
  // was told the command succeeded and was given no result at all.
  const run = await oneShot(`python -c "print(123)"`)();
  assert.match(run.stdout, /\b123\b/,
    `a quoted argument came back empty, so the model is told the machine did nothing when it did something: ${JSON.stringify(run)}`);
});

test("a double-quoted argument containing spaces arrives as one argument", { skip: !isWindows }, async () => {
  // Before the fix the interpreter split the argument at the first space and
  // Python reported `unterminated string literal` on the fragment `"import`.
  const run = await oneShot(`python -c "import sys;print(sys.maxsize > 0 and 2 or 0)"`)();
  assert.match(run.stdout, /\b2\b/,
    `the quoted argument was split by the interpreter, so a correct command failed: ${JSON.stringify(run)}`);
  assert.doesNotMatch(run.stderr, /SyntaxError/,
    `a correct command reached Python broken, which the model reads as its own mistake: ${JSON.stringify(run)}`);
});

test("a quoted word reaches a redirected file without a backslash in front of the quote", { skip: !isWindows }, async () => {
  // Before the fix the file contained `\"q1\"`. Every file the agent wrote through
  // a quoted echo carried those backslashes, so the text it had produced was not
  // the text it had asked for.
  const run = await oneShot(`python -c "print('x')"`)();
  assert.match(run.stdout, /x/, `the control command failed, so the file assertion below would pass for the wrong reason: ${JSON.stringify(run)}`);
  await oneShot(`echo "q1" > quoted.txt`)();
  const written = readFileSync(path.join(workspaceRoot, "quoted.txt"), "latin1");
  assert.match(written, /"q1"/,
    `the quote the agent wrote is not the quote that reached the file: ${JSON.stringify(written)}`);
  assert.doesNotMatch(written, /\\"/,
    `a backslash was inserted before the quote, so the file the agent wrote is not the file it asked for: ${JSON.stringify(written)}`);
});

test("an unquoted command that always worked still works, unchanged", { skip: !isWindows }, async () => {
  // The fix must not have cost anything it did not repair. These four were
  // measured identical before and after.
  const chains = await oneShot(`echo alpha & echo beta`)();
  assert.match(chains.stdout, /alpha[\s\S]*beta/,
    `a command that worked before the change no longer works: ${JSON.stringify(chains)}`);
  const spaced = await oneShot(`echo one two three`)();
  assert.match(spaced.stdout, /one two three/,
    `a command with unquoted spaces was broken by the fix: ${JSON.stringify(spaced)}`);
  const redirected = await oneShot(`echo tail > tail.txt & type tail.txt`)();
  assert.match(redirected.stdout, /tail/,
    `redirection and chaining stopped working: ${JSON.stringify(redirected)}`);
  const invocation = shim.resolveShellInvocation("win32", "echo hi");
  assert.equal(invocation.args[0], "/c",
    `the interpreter flag changed, and a cmd.exe that does not understand its flag runs nothing: ${JSON.stringify(invocation.args)}`);
});

// ---------------------------------------------------------------------------
// What the command printed is readable.
// ---------------------------------------------------------------------------

test("the decoder reads a legacy code page instead of producing replacement characters", () => {
  // `Привет` as a CP866 console actually wrote it. These bytes were measured off
  // this machine's `cmd.exe`, not derived: `Buffer.from(text, "binary")` cannot
  // produce them, because it truncates each UTF-16 unit to one byte and every
  // Cyrillic letter here is below 0x80 once truncated.
  const cyrillic = "Привет";
  // Listed byte by byte on purpose: `Buffer.from("8f e0 …", "hex")` stops at the
  // first space and silently returns a one-byte buffer, which would make this test
  // pass for the wrong reason.
  const cp866 = Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]);
  assert.equal(cp866.length, 6,
    "the fixture is supposed to be the six bytes of one word, so a shorter parse would prove nothing");
  assert.ok(cp866.some(byte => byte >= 0x80),
    "the fixture is supposed to contain bytes UTF-8 does not define, so the test would prove nothing");
  const asUtf8 = cp866.toString("utf8");
  assert.match(asUtf8, /�/,
    `the fixture decodes cleanly as UTF-8, so it cannot demonstrate the defect: ${JSON.stringify(asUtf8)}`);
  const decoder = shim.createShellOutputDecoder("cp866");
  const text = decoder.push(cp866) + decoder.flush();
  assert.equal(text, cyrillic,
    `a code-page string was not read back as itself: ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /�/,
    `a character neither the model nor the user can read reached the result: ${JSON.stringify(text)}`);
});

test("the decoder leaves a stream that is already UTF-8 byte-for-byte alone", () => {
  const sample = "готово — ✓ done\nsecond line\n";
  const decoder = shim.createShellOutputDecoder("cp866");
  const text = decoder.push(Buffer.from(sample, "utf8")) + decoder.flush();
  assert.equal(text, sample,
    `output that was already UTF-8 was decoded through a legacy code page, which corrupts it: ${JSON.stringify(text)}`);
});

test("the decoder rejoins a character the operating system split across two chunks", () => {
  const bytes = Buffer.from("ы", "utf8");
  assert.equal(bytes.length, 2, "the fixture is supposed to be a two-byte character");
  const decoder = shim.createShellOutputDecoder("cp866");
  const text = decoder.push(bytes.subarray(0, 1)) + decoder.push(bytes.subarray(1)) + decoder.flush();
  assert.equal(text, "ы",
    `a character delivered in two pieces came back as something else: ${JSON.stringify(text)}`);
});

test("a box that cannot name its code page behaves as it did before, rather than throwing", () => {
  const decoder = shim.createShellOutputDecoder(undefined);
  const text = decoder.push(Buffer.from("plain ascii\r\n", "utf8")) + decoder.flush();
  assert.equal(text, "plain ascii\r\n",
    `the fallback path changed text it should have passed through: ${JSON.stringify(text)}`);
  assert.equal(shim.codePageLabel(65001), "utf-8",
    "a box already on UTF-8 must not be handed a CP65001 decoder, which Node does not have");
  assert.equal(shim.codePageLabel(999999), undefined,
    "an undecodable code page must be reported as undecodable, not passed to a constructor that throws");
});

test("the interpreter's own output arrives readable on this box", { skip: !isWindows }, async () => {
  const label = await shim.resolveConsoleCodePageLabel();
  assert.ok(label !== undefined,
    "the daemon could not ask this box which code page it writes in, so it cannot read its own output");
  const run = await oneShot(`chcp`)();
  assert.doesNotMatch(run.stdout, /�/,
    `the interpreter reported its own state in characters nobody can read: ${JSON.stringify(run.stdout)}`);
  // `chcp` prints the number in ASCII, so the number survives either code page
  // and proves the surrounding text did not come out mangled.
  const number = label === "utf-8" ? "65001" : label.replace(/^cp/, "");
  assert.match(run.stdout, new RegExp(number),
    `the code page the daemon recorded is not the one the interpreter reports: recorded ${label}, got ${JSON.stringify(run.stdout)}`);
});

test("no replacement character survives a real command that writes in the console code page", { skip: !isWindows }, async () => {
  // `dir` prints volume and column headers, which are in the console code page
  // on a localised Windows. Whatever this machine's language is, the assertion
  // is the property that matters: the result contains no character that reads as
  // corruption.
  const run = await oneShot(`dir`)();
  assert.doesNotMatch(run.stdout, /�/,
    `a directory listing came back with replacement characters in it, which is what the user sees as a broken box: ${JSON.stringify(run.stdout.slice(0, 200))}`);
  assert.match(run.stdout, /[.]/,
    `the listing is empty, so the assertion above would pass without a command having run: ${JSON.stringify(run.stdout)}`);
});