import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackage, uncacheAll } from "@electron/asar";

import {
  fidelityInstalledAppForAsarHash,
  fidelityOutputAppForAsarHash,
  isWindowsRuntimeHost,
  outputDir,
  runtimeAsarPath,
  runtimeExecutablePath,
  runtimeResourcesDir,
  runtimeUnpackedPath,
  upstreamVersion,
} from "../scripts/lib/config.mjs";
import {
  commitRuntimeTree,
  extractRuntimeTree,
  resolveValidatedCachedRuntime,
  validateRuntimeApp,
} from "../scripts/lib/runtime.mjs";
import { capture, run } from "../scripts/lib/process.mjs";

const root = path.resolve(import.meta.dirname, "..");
const CACHE_DIRECTORY_NAME = "Grok Bot";

const INFO_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "  <key>CFBundleShortVersionString</key>",
  `  <string>${upstreamVersion}</string>`,
  "</dict>",
  "</plist>",
  "",
].join("\n");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAt(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/** `@electron/asar` caches the parsed header per archive path, so a fixture
 * that reuses a path for different bytes — exactly what a cache rebuild does —
 * has to drop that cache first. This is a property of the reader, not of the
 * cache under test. */
async function createRuntimeFixture(appPath, marker) {
  const source = await mkdtemp(path.join(os.tmpdir(), "grok-bot-runtime-payload-"));
  try {
    await writeFileAt(
      path.join(source, "package.json"),
      `${JSON.stringify({ name: "grok-bot", version: upstreamVersion }, null, 2)}\n`,
    );
    await writeFileAt(path.join(source, "dist", "electron-main", "main.cjs"), `fixture:${marker}\n`);
    await mkdir(runtimeResourcesDir(appPath), { recursive: true });
    await mkdir(path.dirname(runtimeExecutablePath(appPath)), { recursive: true });
    await createPackage(source, runtimeAsarPath(appPath));
    await mkdir(runtimeUnpackedPath(appPath), { recursive: true });
    await writeFileAt(runtimeExecutablePath(appPath), `fixture-shell:${marker}\n`);
    if (!isWindowsRuntimeHost) {
      await writeFileAt(path.join(appPath, "Contents", "Info.plist"), INFO_PLIST);
    }
    uncacheAll();
    return appPath;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

async function fingerprintTree(directory) {
  const fingerprint = new Map();
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        fingerprint.set(
          path.relative(directory, target).split(path.sep).join("/"),
          createHash("sha256").update(await readFile(target)).digest("hex"),
        );
      }
    }
  };
  await walk(directory);
  return fingerprint;
}

async function withTemporaryDirectory(body) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bot-runtime-cache-"));
  try {
    return await body(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Every sibling the cache parent holds apart from the cache directory itself. */
async function cacheSiblings(parent) {
  return (await readdir(parent)).filter(entry => entry !== CACHE_DIRECTORY_NAME).sort();
}

test("an interrupted extraction never touches the cached runtime", async () => {
  await withTemporaryDirectory(async temporary => {
    const cachePath = path.join(temporary, CACHE_DIRECTORY_NAME);
    await createRuntimeFixture(cachePath, "original");
    const before = await fingerprintTree(cachePath);

    await assert.rejects(
      extractRuntimeTree(async staged => {
        // The exact shape an interrupted 7-Zip run leaves: part of the payload
        // written, then the process dies.
        await mkdir(runtimeResourcesDir(staged), { recursive: true });
        await mkdir(runtimeUnpackedPath(staged), { recursive: true });
        await writeFile(path.join(staged, "partial.bin"), "half a payload");
        throw new Error("7z terminated unexpectedly");
      }, cachePath),
      /7z terminated unexpectedly/,
    );

    assert.deepEqual(await fingerprintTree(cachePath), before);
    assert.deepEqual(await cacheSiblings(temporary), [], "the staging directory has to be cleaned up");
  });
});

test("an extraction that yields an incomplete tree is refused before it reaches the cache", async () => {
  await withTemporaryDirectory(async temporary => {
    const cachePath = path.join(temporary, CACHE_DIRECTORY_NAME);
    await createRuntimeFixture(cachePath, "original");
    const before = await fingerprintTree(cachePath);

    // The archive and the unpacked directory land, the executable does not —
    // the poison that used to wedge the build permanently.
    const error = await extractRuntimeTree(async staged => {
      const source = await mkdtemp(path.join(os.tmpdir(), "grok-bot-runtime-partial-"));
      try {
        await writeFileAt(path.join(source, "package.json"), `${JSON.stringify({ version: upstreamVersion })}\n`);
        await mkdir(runtimeResourcesDir(staged), { recursive: true });
        await createPackage(source, runtimeAsarPath(staged));
        await mkdir(runtimeUnpackedPath(staged), { recursive: true });
      } finally {
        await rm(source, { recursive: true, force: true });
      }
    }, cachePath).then(() => null, caught => caught);

    assert.ok(error instanceof Error, "an incomplete payload has to be rejected");
    assert.match(error.message, /Incomplete Grok Bot runtime at /);
    assert.ok(
      error.message.includes(path.basename(runtimeExecutablePath(cachePath))),
      `the message has to name the missing executable: ${error.message}`,
    );
    assert.deepEqual(await fingerprintTree(cachePath), before);
    assert.deepEqual(await cacheSiblings(temporary), []);
  });
});

test("a previously poisoned cache is discarded and rebuilt by the next bootstrap", async () => {
  await withTemporaryDirectory(async temporary => {
    const cachePath = path.join(temporary, CACHE_DIRECTORY_NAME);
    await createRuntimeFixture(cachePath, "poisoned");
    await rm(runtimeExecutablePath(cachePath));

    // Step 1: the reuse branch refuses it instead of accepting a partial tree.
    assert.equal(await resolveValidatedCachedRuntime(cachePath), null);
    assert.equal(await exists(cachePath), false, "the unusable cache must be removed so a rebuild can replace it");

    // Step 2: with no cache present, bootstrap takes the extraction branch again.
    await extractRuntimeTree(staged => createRuntimeFixture(staged, "rebuilt"), cachePath);

    // Step 3: the rebuilt cache validates and is reused.
    assert.equal(await resolveValidatedCachedRuntime(cachePath), cachePath);
    assert.equal(await validateRuntimeApp(cachePath), cachePath);
    assert.deepEqual(await cacheSiblings(temporary), []);
  });
});

test("a complete cache is reused as is, and an absent one is not an error", async () => {
  await withTemporaryDirectory(async temporary => {
    const cachePath = path.join(temporary, CACHE_DIRECTORY_NAME);
    assert.equal(await resolveValidatedCachedRuntime(cachePath), null);

    await createRuntimeFixture(cachePath, "intact");
    const before = await fingerprintTree(cachePath);
    assert.equal(await resolveValidatedCachedRuntime(cachePath), cachePath);
    assert.deepEqual(await fingerprintTree(cachePath), before);
    assert.deepEqual(await cacheSiblings(temporary), []);
  });
});

test("a failed commit puts the previous cache back", async () => {
  await withTemporaryDirectory(async temporary => {
    const cachePath = path.join(temporary, CACHE_DIRECTORY_NAME);
    await createRuntimeFixture(cachePath, "original");
    const before = await fingerprintTree(cachePath);

    await assert.rejects(commitRuntimeTree(path.join(temporary, "never-staged"), cachePath));
    assert.deepEqual(await fingerprintTree(cachePath), before);
  });
});

test("bootstrap never writes an archive straight into the cache path", async () => {
  const bootstrap = await readFile(path.join(root, "scripts", "bootstrap-runtime.mjs"), "utf8");
  // The Windows branch unpacks into a sibling staging directory that is
  // validated before it replaces the cache.
  assert.match(bootstrap, /extractRuntimeTree\(\s*\n?\s*staged => run\(sevenZip/);
  assert.doesNotMatch(bootstrap, /-o\$\{cachedRuntimeApp\}/);
  // The reuse branch goes through the validating, self-healing accessor.
  assert.match(bootstrap, /const cachedApp = await resolveValidatedCachedRuntime\(\)/);
  assert.doesNotMatch(bootstrap, /else if \(await exists\(cachedRuntimeApp\)\) \{/);
});

test("capture returns every byte the child wrote, not a truncated prefix", async () => {
  // Four megabytes is far past a pipe buffer, so a helper that settles on
  // `exit` sees only what the reader managed to pull in first. The child builds
  // the payload itself; passing it as an argument would exceed the Windows
  // command line limit instead.
  const captured = await capture(
    process.execPath,
    ["-e", "process.stdout.write('A'.repeat(4096).repeat(1024))"],
  );
  const expected = "A".repeat(4096).repeat(1024);
  assert.equal(captured.length, expected.length);
  assert.equal(captured, expected);
});

test("capture still reports a failing child's stderr with its exit code", async () => {
  const error = await capture(
    process.execPath,
    ["-e", "process.stderr.write('boom\\n'); process.exit(7)"],
  ).then(() => null, caught => caught);
  assert.ok(error instanceof Error);
  assert.match(error.message, /exited with 7/);
  assert.match(error.message, /boom/);
});

test("run keeps its exit-code semantics", async () => {
  await run(process.execPath, ["-e", "process.exit(0)"]);
  const error = await run(process.execPath, ["-e", "process.exit(3)"]).then(() => null, caught => caught);
  assert.ok(error instanceof Error);
  assert.match(error.message, /exited with 3$/);
});

test("the fidelity per-hash paths follow the host payload shape", () => {
  const asarHash = "a".repeat(64);
  const bundle = `Grok Bot 0.18 Fidelity-${asarHash.slice(0, 12)}`;
  const output = fidelityOutputAppForAsarHash(asarHash);
  const installed = fidelityInstalledAppForAsarHash(asarHash);

  assert.equal(path.dirname(output), outputDir);
  assert.equal(path.basename(output), isWindowsRuntimeHost ? bundle : `${bundle}.app`);
  assert.equal(path.basename(installed), path.basename(output));
  // `path.join("/Applications", …)` used to yield a drive-relative
  // `\Applications\…` here; both roots are now absolute.
  assert.ok(path.isAbsolute(installed), `${installed} must be absolute`);
  assert.ok(
    isWindowsRuntimeHost ? installed.startsWith("C:\\Program Files\\") : installed.startsWith("/Applications/"),
    `${installed} must name the host install root`,
  );
  assert.throws(() => fidelityOutputAppForAsarHash("NOTAHASH"), TypeError);
});

test("an incomplete runtime path is reported with the path, not a bare ENOENT", async () => {
  await withTemporaryDirectory(async temporary => {
    const cachePath = path.join(temporary, CACHE_DIRECTORY_NAME);
    // The message `validateRuntimeApp` intends to raise has to be reachable:
    // `stat` used to reject with its own `ENOENT` before the check ran.
    await createRuntimeFixture(cachePath, "no-exe");
    await rm(runtimeExecutablePath(cachePath));
    const escaped = cachePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await assert.rejects(
      validateRuntimeApp(cachePath),
      (error) => {
        assert.notEqual(error?.code, "ENOENT", `a bare ENOENT escaped: ${error?.code}`);
        assert.match(error.message, new RegExp(`Incomplete Grok Bot runtime at ${escaped}`));
        assert.ok(error.message.includes(path.basename(runtimeExecutablePath(cachePath))));
        return true;
      },
    );

    // The same holds for a missing unpacked directory.
    await createRuntimeFixture(cachePath, "no-unpacked");
    await rm(runtimeUnpackedPath(cachePath), { recursive: true, force: true });
    await assert.rejects(validateRuntimeApp(cachePath), /Incomplete Grok Bot runtime at /);
    await stat(cachePath);
  });
});