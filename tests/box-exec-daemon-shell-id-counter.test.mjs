import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The agent's command counter was reported as handing out identifier 0 on the
 * first background shell instead of 1. That was wrong on the substance too, not
 * just on the pointer: the report named `source/box-exec-daemon/server.ts:224`
 * as the site, and line 224 of that file is `signal.removeEventListener("abort",
 * abort)` inside `run()`'s `finally` — a listener removal, not a counter. The
 * file holds exactly one command counter, `BoxExecRuntime.#nextShellId`, and it
 * was already `= 1` with a pre-increment read, so the first background shell of
 * a fresh daemon was already number 1.
 *
 * Nothing noticed because the number was never read by anything except the file
 * name it builds. There is no limit compared against it and no statistic built
 * from it, so an off-by-one there could not surface as a refusal or a wrong
 * count — it could only surface as two background shells of the same agent
 * sharing one terminal file, which is why these tests drive a real daemon and
 * read the identifiers back over the same Connect route the host uses.
 *
 * WHAT THE COUNTER ACTUALLY MEANS. It is a monotonic identifier allocator for
 * background terminal transcripts, not a limit and not a statistic. The
 * transcript path is `${shellId}.txt`, so the only consequence an off-by-one
 * could have is two commands sharing one file, and the only thing that makes the
 * numbers meaningful is that they never repeat — including after a shell exits,
 * because `spawnBackground` removes the entry from `#background` on `close` and
 * never returns the number to the counter.
 *
 * These tests now prove the boundary with numbers: the first call, the second
 * call, the calls after that, the transcript files on disk, and the fact that a
 * second daemon starts the numbering again rather than inheriting it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One bundle carrying the daemon plus the generated Connect client and messages.
 *
 * CommonJS on purpose, like `tests/box-exec-daemon-shell-interpreter.test.mjs`:
 * Connect and the protobuf runtime reach for Node built-ins through `require`,
 * which an ESM bundle cannot serve. No transport is mocked and no child is
 * stubbed — the identifiers asserted below are the ones a real daemon returned
 * over a real socket.
 */
const SHIM_SOURCE = `
export { startBoxExecDaemon } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { BackgroundShellSpawnArgs } from "./packages/proto/generated/agent/v1/background_shell_exec_pb.js";
`;

async function bundleShim() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-shellid-"));
  const outfile = path.join(directory, "box-shellid-shim.cjs");
  await build({
    stdin: {
      contents: SHIM_SOURCE,
      resolveDir: path.join(repoRoot, "source"),
      sourcefile: "box-shellid-shim.ts",
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
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const AUTH_TOKEN = "c".repeat(43);
const SHELLS_IN_THE_RUN = 4;

let shim;
let disposeShim;

/** Starts a daemon on an ephemeral port over its own throwaway directories. */
async function startDaemon() {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-box-shellid-workspace-"));
  const terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-box-shellid-terminals-"));
  const handle = await shim.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: AUTH_TOKEN, port: 0 });
  const transport = shim.createConnectTransport({
    baseUrl: handle.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  return {
    handle,
    terminalsDirectory,
    workspaceRoot,
    // `createClient` hands back a promise, so the caller that does not await it
    // gets a thenable with no `exec` on it and every request fails on a TypeError
    // that says nothing about the daemon. The property is named `client` and not
    // `exec` because the RPC method on it is `client.exec`: naming the wrapper
    // property `exec` makes `daemon.exec(...)` call the client object itself.
    client: await shim.createClient(shim.ExecService, transport, { transport }),
    stop: async () => {
      await handle.stop();
      // `stop()` kills the children and returns without awaiting the per-process
      // write queue, so a queued `appendFile` can still be in flight here. A
      // leftover temporary directory is the operating system's business, not a
      // product defect, so removal is retried and then given up on rather than
      // turned into a failure of the assertion this file is about.
      for (const directory of [workspaceRoot, terminalsDirectory]) {
        try {
          rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {}
      }
    },
  };
}

/**
 * Waits for one terminal transcript to carry its exit footer.
 *
 * `spawnBackground` answers `success` as soon as `spawn` fires, and the
 * transcript is written by a promise chain behind it, so an assertion made the
 * instant the spawn returns races the daemon's own first write. The deadline is
 * the safety ceiling.
 */
async function waitForTranscript(daemon, shellId, deadlineMs = 30_000) {
  const transcriptPath = path.join(daemon.terminalsDirectory, `${shellId}.txt`);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      if (/exit_code: \d+/.test(readFileSync(transcriptPath, "utf8"))) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`no transcript was completed for background shell ${shellId} within ${deadlineMs} ms`);
}

/**
 * Sends one background spawn and returns the identifier the daemon answered with.
 *
 * The deadline is the safety ceiling: a daemon that never answers would hang the
 * file instead of failing one assertion, so the wait is bounded and the timeout
 * is reported as the failure it is.
 */
async function spawnBackgroundShell(daemon, command, deadlineMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const stream = daemon.client.exec(new shim.ExecServerMessage({
      id: 1,
      execId: `exec-${command}`,
      message: {
        case: "backgroundShellSpawnArgs",
        value: new shim.BackgroundShellSpawnArgs({ command, workingDirectory: daemon.workspaceRoot }),
      },
    }), { signal: controller.signal });
    for await (const element of stream) {
      const message = element.element;
      if (message.case !== "execClientMessage") continue;
      if (message.value.message.case !== "backgroundShellSpawnResult") continue;
      const result = message.value.message.value.result;
      if (result.case !== "success") {
        throw new Error(`the daemon refused to start the background shell: ${result.case} ${result.value?.error ?? ""}`);
      }
      await waitForTranscript(daemon, result.value.shellId, deadlineMs);
      return result.value.shellId;
    }
    throw new Error(`the daemon never answered the background spawn (${deadlineMs} ms)`);
  } finally {
    clearTimeout(timer);
  }
}

test.before(async () => {
  ({ shim, dispose: disposeShim } = await bundleShim());
});

test.after(() => {
  disposeShim?.();
});

test("the first background shell of a fresh daemon is number 1 and the second is number 2", async (t) => {
  const daemon = await startDaemon();
  t.after(daemon.stop);

  const first = await spawnBackgroundShell(daemon, "echo FIRST");
  const second = await spawnBackgroundShell(daemon, "echo SECOND");

  assert.equal(first, 1,
    `the first background shell was given identifier ${first}, so its transcript is 0.txt and a second shell starting at 1 could collide with it`);
  assert.equal(second, 2,
    `the second background shell was given identifier ${second}, so the first shell is not counted and the numbering skips a transcript`);
});

test("every background shell gets its own number and its own transcript file", async (t) => {
  const daemon = await startDaemon();
  t.after(daemon.stop);

  const identifiers = [];
  for (let index = 0; index < SHELLS_IN_THE_RUN; index += 1) {
    identifiers.push(await spawnBackgroundShell(daemon, `echo SHELL_${index}`));
  }

  assert.deepEqual(identifiers, [1, 2, 3, 4],
    `the identifiers handed out in one run were ${JSON.stringify(identifiers)}, which is the boundary the counter is supposed to hold`);
  assert.equal(new Set(identifiers).size, identifiers.length,
    `two background shells shared an identifier: ${JSON.stringify(identifiers)}, so one of them overwrites the other's transcript`);
  assert.equal(identifiers.includes(0), false,
    "identifier 0 was handed out, so no transcript file named 0.txt exists to be found later");

  for (const identifier of identifiers) {
    const transcript = path.join(daemon.terminalsDirectory, `${identifier}.txt`);
    assert.ok(existsSync(transcript),
      `no transcript was written for background shell ${identifier}, so the identifier does not name a file and the numbering proves nothing`);
  }
  assert.equal(existsSync(path.join(daemon.terminalsDirectory, "0.txt")), false,
    "a 0.txt transcript exists, so some shell was numbered from zero after all");
});

test("a second daemon numbers its own shells from 1 again", async (t) => {
  // The counter belongs to one runtime, so it is an allocator rather than a
  // process-wide total: a daemon that inherited its predecessor's last number
  // would leave a gap nothing on disk can explain.
  const firstDaemon = await startDaemon();
  t.after(firstDaemon.stop);
  await spawnBackgroundShell(firstDaemon, "echo FIRST_DAEMON");
  const carriedOver = await spawnBackgroundShell(firstDaemon, "echo FIRST_DAEMON_SECOND");

  const secondDaemon = await startDaemon();
  t.after(secondDaemon.stop);
  const restarted = await spawnBackgroundShell(secondDaemon, "echo SECOND_DAEMON");

  assert.equal(carriedOver, 2, "the first daemon did not number its second shell 2, so the run above proved nothing");
  assert.equal(restarted, 1,
    `a fresh daemon started at ${restarted}, so the counter is process-wide state rather than a per-runtime allocator`);
});

test("the counter is an allocator: nothing is refused and the numbering simply keeps going", async (t) => {
  // The report read this counter as a limit whose ceiling would be reached one
  // call early. It is not compared against anything, so the observable
  // consequence of running out is the one thing that must never happen — a
  // reused identifier — and not a refusal.
  const daemon = await startDaemon();
  t.after(daemon.stop);

  const identifiers = [];
  for (let index = 0; index < SHELLS_IN_THE_RUN; index += 1) {
    const identifier = await spawnBackgroundShell(daemon, `echo BOUND_${index}`);
    assert.equal(typeof identifier, "number",
      `background shell ${index} was refused with ${JSON.stringify(identifier)}, which is the ceiling the report expected and this daemon does not have`);
    identifiers.push(identifier);
  }

  for (let index = 1; index < identifiers.length; index += 1) {
    assert.ok(identifiers[index] > identifiers[index - 1],
      `identifier ${identifiers[index]} did not exceed the one before it (${identifiers[index - 1]}), so a number was handed out twice`);
  }
});