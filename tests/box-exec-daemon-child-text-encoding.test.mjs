import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Python wrote CP1251 into a UTF-8 pipeline, so the agent's own output came back
 * as mojibake — and its non-Latin output killed the program outright.
 *
 * The box already speaks UTF-8 on the wire. `cmd.exe /c chcp` answers `65001` on
 * this machine, `node -e "console.log('日本語')"` round-trips through the box
 * perfectly, and `shell-output-text.ts` was written specifically to read that
 * stream: strict UTF-8 first, the console code page only as the fallback for a
 * stream that is not UTF-8.
 *
 * Python was the one program in the loop that never agreed. Nothing set
 * `PYTHONIOENCODING`, so CPython fell back to `locale.getpreferredencoding()`,
 * which on Windows is the ANSI code page — CP1251 here. Measured through the box
 * exec daemon on this machine, with the interpreter and the route held fixed:
 *
 *   `python -c "import sys;print(sys.stdout.encoding)"` -> `cp1251`
 *   `python -c "print('Привет мир')"`                   -> `╧ЁштхЄ ьшЁ`, exit 0
 *   `python -c "print('日本語')"`                       -> exit 1,
 *                                       `UnicodeEncodeError` in cp1251.py
 *   `echo Привет & python -c "print('日本語')"`          -> `Привет ` then exit 1
 *
 * That first line is the one that costs the agent a turn. The text is already
 * Unicode, the program already holds it in memory, and the failure is raised by
 * `print` while writing to a pipe — so a command that reads a UTF-8 file and
 * prints one word of it dies on its own output. The transcript journal of one
 * user session is full of `python -c` calls; none of them can print a CJK
 * character or an emoji, and none of them can print Russian text and be read.
 *
 * WHY IT WAS NOT ALREADY FIXED. `shell-env.ts` already had the hook —
 * `buildShellEnv` fills in `HOME` and `SHELL` for exactly this reason — but the
 * box exec daemon does not use `buildShellEnv`. It builds its own environment
 * block in `spawnShell` and passed `this.#environment` straight through, so the
 * fill-in never ran on the surface the agent actually runs commands on. The
 * decoder had been fixed from the reading side; nothing had touched the writing
 * side.
 *
 * The fix is `PYTHONIOENCODING=utf-8` and not `PYTHONUTF8=1`. Only stdout, stderr
 * and stdin move that way; `PYTHONUTF8` would also repoint `open()`'s default
 * encoding, which changes what an existing script reads off disk and is not what
 * was measured here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

/** The baseline these tests read the defect from: a fixed commit, not the working tree. */
const DEFECT_BASELINE = "ace01c9";

const SHIM_SOURCE = `
export { startBoxExecDaemon } from "./box-exec-daemon/server.js";
export { createClient } from "@connectrpc/connect";
export { createConnectTransport } from "@connectrpc/connect-node";
export { ExecService } from "./packages/proto/generated/agent/v1/exec_service_connect.js";
export { ExecServerMessage } from "./packages/proto/generated/agent/v1/exec_pb.js";
export { ShellArgs } from "./packages/proto/generated/agent/v1/shell_exec_pb.js";
`;

/** Serves one file from the committed blob, so the working tree is never touched. */
function fromGitHead(relative) {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  const contents = execFileSync("git", ["show", `${DEFECT_BASELINE}:${relative}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    name: `${relative}-from-git-head`,
    setup(bundler) {
      bundler.onLoad({ filter: new RegExp(`${relative.replace(/[\\/.]/g, "[\\\\/.$]")}$`) }, (args) => ({
        contents,
        loader: "ts",
        resolveDir: path.dirname(args.path),
      }));
    },
  };
}

async function bundleShim(plugins = []) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-text-"));
  const outfile = path.join(directory, "box-text-shim.cjs");
  await build({
    stdin: { contents: SHIM_SOURCE, resolveDir: path.join(repoRoot, "source"), sourcefile: "box-text-shim.ts", loader: "ts" },
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    ...(plugins.length === 0 ? {} : { plugins }),
  });
  return {
    shim: createRequire(import.meta.url)(outfile),
    dispose: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

function pythonOnPath() {
  const probe = spawnSync("python", ["-c", "pass"], { windowsHide: true, timeout: 15_000 });
  return probe.error === undefined && probe.status === 0;
}

const skip = !pythonOnPath()
  ? "python is not installed on this host, so the encoding this file measures cannot be exercised here"
  : !isWindows
    ? "CPython picks its stdout encoding from the ANSI code page on Windows only; a POSIX host has no second legacy encoding to collide with"
    : false;

const AUTH_TOKEN = "u".repeat(43);

async function withDaemon(plugins, body) {
  const { shim, dispose } = await bundleShim(plugins);
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-box-text-workspace-"));
  const terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-box-text-terminals-"));
  const handle = await shim.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: AUTH_TOKEN, port: 0 });
  const transport = shim.createConnectTransport({
    baseUrl: handle.url,
    httpVersion: "1.1",
    interceptors: [(next) => async (request) => {
      request.header.set("authorization", `Bearer ${AUTH_TOKEN}`);
      return await next(request);
    }],
  });
  const exec = shim.createClient(shim.ExecService, transport, { transport });
  let nextId = 1;
  const run = async (command, deadlineMs = 30_000) => {
    const id = nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const frames = [];
    try {
      const stream = exec.exec(new shim.ExecServerMessage({ id, execId: `exec-${id}`, message: { case: "shellArgs", value: new shim.ShellArgs({ command, workingDirectory: workspaceRoot, timeout: 20_000 }) } }), { signal: controller.signal });
      for await (const element of stream) {
        if (element.element.case === "execClientMessage") frames.push(element.element.value.message);
      }
    } finally {
      clearTimeout(timer);
    }
    const first = frames[0];
    if (first?.case !== "shellResult") return { kind: "no result frame" };
    const result = first.value.result;
    if (result.case !== "success" && result.case !== "failure") return { kind: result.case };
    return { exitCode: result.value.exitCode, stdout: result.value.stdout, stderr: result.value.stderr };
  };
  try {
    return await body(run);
  } finally {
    await handle.stop();
    for (const directory of [workspaceRoot, terminalsDirectory]) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    dispose();
  }
}

test("a Python program on the box can print the text it is holding", { skip }, async () => {
  await withDaemon([], async (run) => {
    const encoding = await run("python -c \"import sys;print(sys.stdout.encoding)\"");
    const cyrillic = await run("python -c \"print('Привет мир')\"");
    const cjk = await run("python -c \"print('日本語')\"");

    assert.equal(encoding.stdout.trim(), "utf-8", `the child must write UTF-8 into a pipeline cmd.exe already writes UTF-8 into; it reported ${JSON.stringify(encoding.stdout)}`);
    assert.equal(cyrillic.exitCode, 0, `printing Russian must not fail; stderr was ${JSON.stringify(cyrillic.stderr.slice(0, 200))}`);
    assert.ok(cyrillic.stdout.includes("Привет мир"), `the Russian text came back as ${JSON.stringify(cyrillic.stdout)}, which is what CP1251 bytes read as UTF-8 look like`);
    assert.equal(cjk.exitCode, 0, `printing CJK must not fail on a UTF-8 console; stderr was ${JSON.stringify(cjk.stderr.slice(0, 200))}`);
    assert.ok(cjk.stdout.includes("日本語"), `the CJK text came back as ${JSON.stringify(cjk.stdout)}`);
  });
});

test("a pipeline that mixes cmd.exe and Python keeps both readable", { skip }, async () => {
  await withDaemon([], async (run) => {
    // Both orders, and in bulk: the decoder decides per stream, so the order is
    // not a detail — whichever program speaks first settles it for the rest.
    const cmdFirst = await run("echo Привет & python -c \"print('日本語')\"");
    const pythonFirst = await run("python -c \"print('日本語')\" & echo Привет");
    const bulk = await run("for /L %i in (1,1,20) do @echo Привет & python -c \"print('日本語')\"");

    for (const [name, result] of [["cmd first", cmdFirst], ["python first", pythonFirst], ["bulk", bulk]]) {
      assert.equal(result.exitCode, 0, `${name}: the mixed pipeline failed with ${JSON.stringify(result.stderr.slice(0, 200))}`);
      assert.ok(result.stdout.includes("Привет"), `${name}: the Cyrillic cmd.exe wrote came back as ${JSON.stringify(result.stdout.slice(0, 120))}`);
      assert.ok(result.stdout.includes("日本語"), `${name}: the CJK Python wrote came back as ${JSON.stringify(result.stdout.slice(0, 120))}`);
    }
  });
});

test("the committed code writes CP1251 into the same pipeline", { skip }, async () => {
  await withDaemon([fromGitHead("source/box-exec-daemon/server.ts")], async (run) => {
    const encoding = await run("python -c \"import sys;print(sys.stdout.encoding)\"");
    const cjk = await run("python -c \"print('日本語')\"");

    assert.equal(encoding.stdout.trim(), "cp1251", `the committed code must fail this check, or HEAD already has the fix and this file measures nothing; it reported ${JSON.stringify(encoding.stdout)}`);
    assert.notEqual(cjk.exitCode, 0, `the committed code must make Python die on its own output, which is the defect; it exited ${cjk.exitCode} with ${JSON.stringify(cjk.stdout)}`);
  });
});

test("a host that set the encoding itself keeps its own value", async () => {
  // The fill-in must never overwrite a name the caller put there, on either
  // casing: Windows environment names are case-insensitive and a `pythonioencoding`
  // from the host is still the host's.
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-shell-text-env-"));
  const outfile = path.join(directory, "shell-env.mjs");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "source", "packages", "shell-exec", "shell-env.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const module = await import(pathToFileURL(outfile).href);

    const filled = module.buildShellEnv({ base: {}, shell: "cmd.exe" });
    assert.equal(filled.PYTHONIOENCODING, "utf-8", "an environment that says nothing about the encoding must get the default, or every child program picks its own");

    const kept = module.buildShellEnv({ base: { PYTHONIOENCODING: "cp1252" }, shell: "cmd.exe" });
    assert.equal(kept.PYTHONIOENCODING, "cp1252", "a value the caller set is the caller's, and overwriting it would be a silent change to their program");

    const keptLowerCase = module.buildShellEnv({ base: { pythonioencoding: "cp1252" }, shell: "cmd.exe" });
    assert.equal(module.readEnvName(keptLowerCase, "PYTHONIOENCODING"), "cp1252", `on a case-insensitive platform the host's spelling is the one that counts, so the default must not be added beside it; it found ${JSON.stringify(module.readEnvName(keptLowerCase, "PYTHONIOENCODING"))}`);
    assert.equal(Object.keys(keptLowerCase).filter((key) => key.toLowerCase() === "pythonioencoding").length, 1, "the two spellings of one name must not both reach the child block, because which one wins is a UTF-16 sort artefact");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});