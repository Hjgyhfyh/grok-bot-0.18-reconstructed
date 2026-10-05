import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The agent wrote a file in its own workspace and could not open it.
 *
 * WHAT BROKE. `forever-box/extension.ts` hands the box one protected root:
 * `getSandRootDir()`. On this host the box workspace is laid out *inside* that
 * root — `C:\Users\user\AppData\Local\GrokBotLocalBox\box-workspace` under
 * `C:\Users\user\AppData\Local\GrokBotLocalBox` — so every file the agent
 * creates with Shell is, by construction, inside a "host-only" store, and
 * `LoopbackSandBox.assertFileReadAllowed` refuses to read it back.
 *
 * WHAT NOTHING NOTICED. The refusal names a path, so it reads like a security
 * decision, and the Shell tool keeps succeeding against the very same
 * directory. Nothing compared the two. In one journaled session the agent ran
 * `cd dash && ... os.listdir('.')` and got `c1.png .. c6.png` back, asked to
 * open `c1.png`, was refused, told the user it could not open the file, and
 * carried on. Five `read` calls were made that session. Five were refused. Not
 * one succeeded.
 *
 * The second failure mode is the one that makes it feel intermittent. The guard
 * resolves a relative path against the literal POSIX string `/workspace`, which
 * on Windows is `C:\workspace` — a directory that does not exist and is not the
 * one the exec daemon opens, since the daemon maps `/workspace` onto its own
 * `workspaceRoot`. So the guard's verdict depends on how the model spelled the
 * path, not on which file it named: the same `dash/c1.png` is refused when
 * spelled absolutely and waved through when spelled relative, and the guard
 * validated a path nobody opens.
 *
 * These tests pin that behaviour as measured. They do not widen anything:
 * `protectedBoxPaths` is supplied by the test, exactly as production supplies
 * it, and the protected root is left alone. Letting the agent read its own
 * workspace is a decision about what those roots protect, and it belongs to the
 * user, not to a test.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxRoot = path.join(repoRoot, "source");

async function loadGuard() {
  const entry = path.join(sandboxRoot, "host", "box", "protected-path-guard.ts");
  const outdir = mkdtempSync(path.join(tmpdir(), "grok-readguard-"));
  try {
    await build({
      entryPoints: [entry],
      outfile: path.join(outdir, "guard.mjs"),
      format: "esm",
      platform: "node",
      target: "node22",
      bundle: true,
    });
    return await import(pathToFileURL(path.join(outdir, "guard.mjs")).href + "?t=" + Date.now());
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

/** The production call site, read rather than restated. */
function productionBaseDir() {
  const text = readFileSync(path.join(sandboxRoot, "host", "box", "loopback-sand-box.ts"), "utf8");
  const match = /assertPathOutsideProtectedRoots\(this\.protectedBoxPaths,\s*\w+,\s*"([^"]+)"\)/.exec(text);
  assert.notEqual(match, null, "the read guard call site was not found in loopback-sand-box.ts");
  return match[1];
}

/** The workspace layout measured on this host, from the journal paths. */
function makeHostLayout() {
  const sandRoot = mkdtempSync(path.join(tmpdir(), "grok-sandroot-"));
  const workspaceRoot = path.join(sandRoot, "box-workspace");
  mkdirSync(path.join(workspaceRoot, "dash"), { recursive: true });
  const png = path.join(workspaceRoot, "dash", "c1.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { sandRoot, workspaceRoot, png, cleanup: () => rmSync(sandRoot, { recursive: true, force: true }) };
}

test("the file the Shell tool just wrote is refused by the very next Read", async () => {
  const { assertPathOutsideProtectedRoots } = await loadGuard();
  const host = makeHostLayout();
  try {
    // Shell listed the directory and the file was there.
    assert.ok(host.png.startsWith(host.sandRoot), "the fixture must reproduce the measured layout: workspace inside the sand root");

    // This is exactly how production calls it: the roots `forever-box/extension.ts`
    // passes, the path the model named, and the base dir the call site hardcodes.
    await assert.rejects(
      () => assertPathOutsideProtectedRoots([host.sandRoot], host.png, productionBaseDir()),
      /protected host-only store and was refused/,
      "a file the agent wrote in its own workspace must be refused, because the workspace sits inside the protected root",
    );
  } finally {
    host.cleanup();
  }
});

test("the guard's verdict follows the spelling of the path, not the file it names", async () => {
  const { assertPathOutsideProtectedRoots } = await loadGuard();
  const host = makeHostLayout();
  try {
    const baseDir = productionBaseDir();

    // Absolute, the spelling the model actually used three times in that session.
    await assert.rejects(
      () => assertPathOutsideProtectedRoots([host.sandRoot], host.png, baseDir),
      /protected host-only store/,
      "the absolute spelling of a workspace file is refused",
    );

    // Relative, the same file named without a root.
    await assert.doesNotReject(
      () => assertPathOutsideProtectedRoots([host.sandRoot], "dash/c1.png", baseDir),
      "the relative spelling of the same file passes, because the guard checks a path that is never opened",
    );
  } finally {
    host.cleanup();
  }
});

test("the base dir the guard resolves against is a POSIX path on a Windows host", async () => {
  const baseDir = productionBaseDir();
  assert.equal(baseDir, "/workspace", "the call site must still hardcode this string for the next assertion to mean anything");
  assert.equal(
    path.win32.resolve("C:\\", baseDir),
    "C:\\workspace",
    "on Windows `/workspace` resolves to C:\\workspace, which is not the box's workspaceRoot and is not created by anything",
  );
  assert.equal(
    path.win32.join("C:\\workspace", "dash", "c1.png"),
    "C:\\workspace\\dash\\c1.png",
    "the path the guard checks for a relative spelling is this one",
  );
  assert.notEqual(
    path.win32.join(hostWorkspaceProbe(), "dash", "c1.png"),
    path.win32.join("C:\\workspace", "dash", "c1.png"),
    "and it is not the path the exec daemon opens, which is under the box's own workspaceRoot",
  );
});

function hostWorkspaceProbe() {
  return "C:\\Users\\user\\AppData\\Local\\GrokBotLocalBox\\box-workspace";
}
