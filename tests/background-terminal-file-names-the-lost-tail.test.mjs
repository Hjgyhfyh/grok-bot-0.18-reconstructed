import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The tail of a long backgrounded command vanished from the record without a
// word, and the record said the command was fine.
//
// `shell-core` caps each channel at MAX_BUFFER_SIZE. Once a channel crosses it,
// `BaseShellCoreExecutor` stops yielding that channel and emits a single
// `stdout_trimmed` / `stderr_trimmed` event instead. Nothing is written to a
// spill file, so the bytes past the cap are simply gone from every window the
// agent has.
//
// The foreground stream already handled this: the loop in `shell-stream.ts`
// turns the event into `shellOutputTruncatedNotice(...)` and puts it in front of
// the model. The background path did not, and it could not. Once a command is
// backgrounded, `terminals/<shellId>.txt` is the only place a model can look.
// `FileLoggingShellFactory` writes `stdout`, `stderr`, `stdin_ready` and `exit`
// to that file and matches neither trimmed event, so the log stopped growing
// mid-run with no explanation while the frontmatter kept saying `status: running`
// — and later `status: succeeded`. The model read a chopped log as the whole log
// and drew conclusions from the part that arrived.
//
// Nothing threw. The command ran, the file was written, the frontmatter was
// rewritten every five seconds, and the completion notification reported success
// from a real exit code 0. The suite was green.
//
// These tests drive the real chain — `shell-core` deciding on real bytes,
// `BackgroundShellManager` adopting the stream, `FileLoggingShellFactory`
// writing the file — and then read the file a model would read.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "source");

const REQUIRE_BANNER = {
  js: `import { createRequire as __dshCreateRequire } from "node:module";\nconst require = __dshCreateRequire(${JSON.stringify(import.meta.url)});`,
};

async function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-background-tail-"));
  await build({
    entryPoints: [
      path.join(sourceRoot, "packages", "local-exec", "background-shell.ts"),
      path.join(sourceRoot, "packages", "local-exec", "background-shell-observability.ts"),
      path.join(sourceRoot, "packages", "local-exec", "shell-core.ts"),
      path.join(sourceRoot, "packages", "context", "core.ts"),
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
  });
  const load = (relative) => import(pathToFileURL(path.join(directory, `${relative}.mjs`)).href);
  return { load, directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const built = await bundle();
test.after(() => built.dispose());

const { LocalBackgroundShellExecutor } = await built.load("packages/local-exec/background-shell");
const { FileLoggingShellFactory } = await built.load("packages/local-exec/background-shell-observability");
const { BaseShellCoreExecutor } = await built.load("packages/local-exec/shell-core");
const { createContext } = await built.load("packages/context/core");

// The sandbox escape hatch is read once from the environment and cached, so an
// inherited value would swap this chain for a real sandbox.
delete process.env.CURSOR_FORCED_SHELL_EGRESS;

const MAX_BUFFER_SIZE = 1_048_576;
const TAIL_LINE = "tail-line-that-should-be-gone\n";

const ALLOW = { shouldEnforceShellInvariantBlocks: async () => ({ kind: "allow" }), shouldBlockShellCommand: async () => ({ kind: "allow" }) };
const IGNORE = { getCursorIgnoreMapping: async () => ({}) };

function makeProjectDir(label) {
  return mkdtempSync(path.join(os.tmpdir(), `grok-background-tail-${label}-`));
}

function terminalFile(projectDir, shellId) {
  return readFileSync(path.join(projectDir, "terminals", `${shellId}.txt`), "utf8");
}

/** Polls instead of sleeping blind, and cannot hang: without a ceiling this would hang the suite. */
async function waitFor(predicate, what, ceilingMs = 20_000) {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`${what} never happened within ${ceilingMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The events `shell-core` produces once a channel is cut: output, the cut, then
 * the exit. It emits nothing more on that channel after the cut — that is the
 * contract, and it is why the tail is gone rather than merely late. These two
 * tests hand the events over by hand, so they cannot prove the discard; the
 * real-bytes test below lets `shell-core` make the decision itself and does.
 */
async function* cutChannelEvents(channel) {
  yield { type: channel, data: "first-line-of-the-log\n" };
  yield { type: `${channel}_trimmed`, keptBytes: MAX_BUFFER_SIZE, limitBytes: MAX_BUFFER_SIZE };
  yield { type: "exit", code: 0, aborted: false, localExecutionTimeMs: 5 };
}

test("a channel cut in a spawned background command is named in the log a model reads", async () => {
  const projectDir = makeProjectDir("spawn");
  const executor = new LocalBackgroundShellExecutor(ALLOW, { getCwd: async () => projectDir, async *execute() { yield* cutChannelEvents("stdout"); } }, IGNORE, projectDir);

  const spawn = await executor.execute(createContext(), { command: "node build.js", skipApproval: true });
  const shellId = spawn.result.value.shellId;
  await waitFor(() => !executor.getManager().isRunning(shellId), "the backgrounded command to settle");

  const text = terminalFile(projectDir, shellId);
  assert.match(text, /first-line-of-the-log/, "the output that did arrive still has to be in the file, or the fix has thrown the log away instead of describing it");
  assert.match(text, /keeps at most 1048576 bytes of stdout/, "the model reads this file, so this file has to say the channel was cut and how much of it crossed the line");
  assert.match(text, /discarded/, "saying only that the output stopped would still leave the model assuming the command went quiet rather than lost bytes");
  assert.match(text, /status: succeeded/, "the command really did exit 0, and the record saying so is correct — it is the missing tail report next to it that made the record a lie");
});

test("a cut stderr channel is reported on stderr, in a spawned background command too", async () => {
  const projectDir = makeProjectDir("spawn-stderr");
  const executor = new LocalBackgroundShellExecutor(ALLOW, { getCwd: async () => projectDir, async *execute() { yield* cutChannelEvents("stderr"); } }, IGNORE, projectDir);

  const spawn = await executor.execute(createContext(), { command: "node build.js", skipApproval: true });
  const shellId = spawn.result.value.shellId;
  await waitFor(() => !executor.getManager().isRunning(shellId), "the backgrounded command to settle");

  const text = terminalFile(projectDir, shellId);
  assert.match(text, /keeps at most 1048576 bytes of stderr/, "a reader cannot tell which stream ended early if the notice names the wrong channel");
  assert.doesNotMatch(text, /keeps at most 1048576 bytes of stdout/, "stdout was not the channel that was cut, so saying so would be a different false statement about the command");
});

test("a channel cut after the call was backgrounded is named in the log too", async () => {
  // This is the path a `block_until_ms` backgrounded shell actually takes:
  // `LocalShellStreamExecutor` calls `background.adopt(...)` and hands the live
  // iterator over, so everything after the cut is written by the adopted
  // iterator rather than by the spawn loop. A fix that only covered `spawn`
  // would leave the shipped path still silent.
  const projectDir = makeProjectDir("adopt");
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });

  const inner = {
    async spawn() { throw new Error("this path adopts, it does not spawn"); },
    async adopt(state) {
      void (async () => {
        for (let result = await state.eventIterator.next(); !result.done; result = await state.eventIterator.next()) { /* drain, like CoreShellFactory.consumeShellEvents */ }
        finished();
      })();
      return { id: state.shellId, signal: state.abortController.signal, abort() {}, dispose() {} };
    },
  };
  const factory = new FileLoggingShellFactory(inner, projectDir);

  await factory.adopt({
    ctx: createContext(),
    shellId: 4_242,
    command: "node build.js",
    workingDirectory: projectDir,
    initialOutput: "output-collected-before-backgrounding\n",
    eventIterator: cutChannelEvents("stdout")[Symbol.asyncIterator](),
    startTime: Date.now(),
    showElapsedTime: true,
    abortController: new AbortController(),
  });
  await done;

  const text = terminalFile(projectDir, 4_242);
  assert.match(text, /output-collected-before-backgrounding/, "what the model was already given in the tool result has to be in the file too");
  assert.match(text, /keeps at most 1048576 bytes of stdout/, "after backgrounding this file is the only window left, so the cut has to be reported here as well");
});

test("a real megabyte of output is cut by shell-core and the cut still reaches the file", async () => {
  // The two tests above hand `FileLoggingShellFactory` the events by hand. This
  // one lets the real `shell-core` decide: a terminal that writes past
  // MAX_BUFFER_SIZE, through the real executor, into the real terminal file. It
  // is the only one of the three that could fail because `shell-core` changed
  // the event it emits.
  const projectDir = makeProjectDir("real-bytes");
  const megabyte = "x".repeat(400 * 1024);
  const terminal = {
    getCwd: async () => projectDir,
    clone() { return terminal; },
    async *execute() {
      for (let index = 0; index < 4; index += 1) yield { type: "stdout", data: Buffer.from(megabyte) };
      yield { type: "stdout", data: Buffer.from(TAIL_LINE) };
      yield { type: "exit", code: 0, data: "", aborted: false };
    },
  };
  const core = new BaseShellCoreExecutor(terminal);
  const executor = new LocalBackgroundShellExecutor(ALLOW, core, IGNORE, projectDir);
  const shellId = executor.getManager().generateShellId();

  await executor.getManager().adopt({
    ctx: createContext(),
    shellId,
    command: "node build.js",
    workingDirectory: projectDir,
    initialOutput: "",
    eventIterator: core.execute(createContext(), { command: "node build.js", workingDirectory: projectDir, showElapsedTime: true })[Symbol.asyncIterator](),
    startTime: Date.now(),
    showElapsedTime: true,
    abortController: new AbortController(),
  });
  await waitFor(() => !executor.getManager().isRunning(shellId), "the backgrounded command to settle");

  const text = terminalFile(projectDir, shellId);
  assert.equal(text.includes(TAIL_LINE), false, "the line the command wrote after the cap is dropped by shell-core, so nothing anywhere holds it and the log has to say so");
  assert.match(text, /keeps at most 1048576 bytes of stdout/, "the cut has to be reported in the file when shell-core is the one that made it");
  assert.match(text, /no output file was written/, "nothing spills to disk, so the model has to be told that the rest cannot be read back from anywhere");
  assert.match(text, /status: succeeded/, "the exit code really was 0, and this file is the record a model reads to decide what happened");
});