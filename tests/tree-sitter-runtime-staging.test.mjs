import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  FORBIDDEN_STAGED_TREE_SITTER_FILES,
  LONGEST_SUPPORTED_CHECKOUT_PATH,
  MAX_STAGED_NODE_DEPS_PATH_LENGTH,
  STAGED_PATH_PREFIX,
  WINDOWS_MAX_PATH,
  assertStagedTreeSitterInventory,
  collectStagedTreeSitterFiles,
  stageNodeTreeSitterRuntimeFromCache,
} from "../scripts/build-tree-sitter-node.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const prebuildDirectory = `${process.platform}-${process.arch}`;

// The strings a vendor build machine writes into its own intermediates. They are
// what makes two Windows builds of one commit differ, so no staged file may
// contain them.
const VENDOR_MACHINE_MARKERS = [
  "SAND-RELEASE-CACHE\\019F88A3-1F3E-4B2C-9E1D-77A5C0B9D441\\SCRATCH",
  "C:\\Users\\buildkite-agent",
];

// The exact payload `dist/node-deps` must hold. The two resolution packages are
// staged under `node_modules/` because that is where
// `createRequire(<node-deps>/<package>)` looks for their imports.
const STAGED = [
  "node_modules/node-addon-api/index.js",
  "node_modules/node-addon-api/package.json",
  "node_modules/node-gyp-build/index.js",
  "node_modules/node-gyp-build/node-gyp-build.js",
  "node_modules/node-gyp-build/package.json",
  "tree-sitter-bash/bindings/node/index.js",
  "tree-sitter-bash/package.json",
  `tree-sitter-bash/prebuilds/${prebuildDirectory}/tree-sitter-bash.node`,
  "tree-sitter-bash/src/node-types.json",
  "tree-sitter/build/Release/tree_sitter_runtime_binding.node",
  "tree-sitter/index.js",
  "tree-sitter/package.json",
];

// The cache root itself is flat: every package sits at its own top level.
const ALLOWLISTED = STAGED.map(relative => relative.replace(/^node_modules\//, ""));

// The MSVC intermediates, gyp configuration, test trees and shims that a
// whole-cache copy used to carry. The two deep entries reproduce the nesting of
// the live cache, whose longest member is 123 characters.
const CACHE_ONLY = [
  "tree-sitter/build/Release/obj/tree_sitter_runtime_binding/src/lookaheaditerator.nativecodeanalysis.xml",
  "tree-sitter/build/Release/obj/tree_sitter_runtime_binding/tree_sit.E0CE0B96.tlog/link.secondary.1.tlog",
  "tree-sitter/build/Release/obj/tree_sitter/tree_sitter.lastbuildstate",
  "tree-sitter/build/Release/tree_sitter.lib",
  "tree-sitter/build/Release/tree_sitter_runtime_binding.exp",
  "tree-sitter/build/Release/tree_sitter_runtime_binding.iobj",
  "tree-sitter/build/Release/tree_sitter_runtime_binding.ipdb",
  "tree-sitter/build/config.gypi",
  "tree-sitter/build/tree_sitter.vcxproj",
  "tree-sitter/jest-tests/test.test.js",
  "tree-sitter/node_modules/.bin/node-gyp-build.CMD",
  "tree-sitter/test/parser_test.js",
  "tree-sitter/vendor/tree-sitter/lib/src/parser.c",
  "tree-sitter-bash/grammar.js",
  "node-addon-api/napi.h",
  "node-gyp-build/build-test.js",
];

async function writeFixtureFile(rootDirectory, relative, contents) {
  const target = path.join(rootDirectory, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function createCacheFixture(cacheRoot) {
  for (const relative of ALLOWLISTED) {
    await writeFixtureFile(cacheRoot, relative, `allowlisted:${relative}\n`);
  }
  for (const relative of CACHE_ONLY) {
    const machineState = relative.includes("tlog") || relative.endsWith("config.gypi")
      ? VENDOR_MACHINE_MARKERS.join("\n")
      : `build-machine-state:${relative}\n`;
    await writeFixtureFile(cacheRoot, relative, machineState);
  }
  return cacheRoot;
}

async function inventoryTree(rootDirectory) {
  const found = [];
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) found.push(path.relative(rootDirectory, target).split(path.sep).join("/"));
    }
  };
  await walk(rootDirectory);
  return found.sort();
}

async function fingerprintTree(rootDirectory) {
  const fingerprint = new Map();
  for (const relative of await inventoryTree(rootDirectory)) {
    fingerprint.set(relative, createHash("sha256").update(await readFile(path.join(rootDirectory, ...relative.split("/")))).digest("hex"));
  }
  return fingerprint;
}

async function withTemporaryDirectory(body) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bot-tree-sitter-"));
  try {
    return await body(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("the staged path budget is the stated MAX_PATH arithmetic", () => {
  assert.equal(WINDOWS_MAX_PATH, 260);
  assert.equal(
    MAX_STAGED_NODE_DEPS_PATH_LENGTH,
    WINDOWS_MAX_PATH - 1 - LONGEST_SUPPORTED_CHECKOUT_PATH - STAGED_PATH_PREFIX.length,
  );
  assert.equal(MAX_STAGED_NODE_DEPS_PATH_LENGTH, 94);
  // A checkout at the longest supported root plus the fixed build prefix plus
  // one staged entry still fits inside `MAX_PATH`.
  const worstCase = LONGEST_SUPPORTED_CHECKOUT_PATH + STAGED_PATH_PREFIX.length + MAX_STAGED_NODE_DEPS_PATH_LENGTH;
  assert.ok(worstCase < WINDOWS_MAX_PATH, `${worstCase} >= ${WINDOWS_MAX_PATH}`);
});

test("a whole-cache copy would ship MSVC intermediates and break the path budget", async () => {
  await withTemporaryDirectory(async temporary => {
    const cacheRoot = await createCacheFixture(path.join(temporary, "cache"));

    const cacheInventory = await inventoryTree(cacheRoot);
    assert.ok(cacheInventory.length > ALLOWLISTED.length);
    assert.ok(
      cacheInventory.some(relative => FORBIDDEN_STAGED_TREE_SITTER_FILES.some(pattern => pattern.test(relative))),
      "the fixture cache must contain entries the staging has to drop",
    );
    assert.ok(
      cacheInventory.some(relative => relative.length > MAX_STAGED_NODE_DEPS_PATH_LENGTH),
      "the fixture cache must contain a path over the staged budget",
    );
    // Both of those fail closed if the staging ever widens back to the cache.
    await assert.rejects(
      assertStagedTreeSitterInventory(cacheRoot),
      /path budget|build intermediates/,
    );
  });
});

test("staging copies only the native objects, manifests and entry points", async () => {
  await withTemporaryDirectory(async temporary => {
    const cacheRoot = await createCacheFixture(path.join(temporary, "cache"));
    const destination = path.join(temporary, "output", "dist", "node-deps");
    await stageNodeTreeSitterRuntimeFromCache(cacheRoot, destination);

    const staged = (await assertStagedTreeSitterInventory(destination)).sort();
    assert.deepEqual(staged, [...STAGED].sort());
    for (const relative of staged) {
      assert.ok(relative.length <= MAX_STAGED_NODE_DEPS_PATH_LENGTH, `${relative} is ${relative.length} characters`);
      assert.ok(
        !FORBIDDEN_STAGED_TREE_SITTER_FILES.some(pattern => pattern.test(relative)),
        `${relative} is a build intermediate`,
      );
      const contents = await readFile(path.join(destination, ...relative.split("/")), "utf8");
      for (const marker of VENDOR_MACHINE_MARKERS) {
        assert.ok(!contents.includes(marker), `${relative} still names the vendor build machine`);
      }
    }
    // `scripts/verify.mjs` resolves these two manifests by name.
    await stat(path.join(destination, "node_modules", "node-addon-api", "package.json"));
    await stat(path.join(destination, "node_modules", "node-gyp-build", "package.json"));
  });
});

test("staging the same cache twice is byte-identical", async () => {
  await withTemporaryDirectory(async temporary => {
    const cacheRoot = await createCacheFixture(path.join(temporary, "cache"));
    const first = path.join(temporary, "first");
    const second = path.join(temporary, "second");
    await stageNodeTreeSitterRuntimeFromCache(cacheRoot, first);
    await stageNodeTreeSitterRuntimeFromCache(cacheRoot, second);
    assert.deepEqual(await fingerprintTree(first), await fingerprintTree(second));
  });
});

test("a cache missing an entry point or a native object is refused", async () => {
  await withTemporaryDirectory(async temporary => {
    const withoutEntryPoint = await createCacheFixture(path.join(temporary, "no-entry"));
    await rm(path.join(withoutEntryPoint, "tree-sitter", "index.js"));
    await assert.rejects(
      stageNodeTreeSitterRuntimeFromCache(withoutEntryPoint, path.join(temporary, "out-a")),
      /missing tree-sitter\/index\.js/,
    );

    const withoutBinary = await createCacheFixture(path.join(temporary, "no-binary"));
    await rm(path.join(withoutBinary, "tree-sitter", "build", "Release", "tree_sitter_runtime_binding.node"));
    await assert.rejects(
      stageNodeTreeSitterRuntimeFromCache(withoutBinary, path.join(temporary, "out-b")),
      /no native binary for tree-sitter/,
    );

    const collected = await collectStagedTreeSitterFiles(await createCacheFixture(path.join(temporary, "collect")));
    assert.equal(collected.length, ALLOWLISTED.length);
  });
});

test("the live tree-sitter cache stages into a compliant, loadable payload", async t => {
  const cacheRoot = path.join(root, ".cache", "tree-sitter-node", process.versions.modules, prebuildDirectory);
  let present = true;
  try {
    await stat(cacheRoot);
  } catch {
    present = false;
  }
  if (!present) {
    t.skip(`no built tree-sitter cache at ${cacheRoot}`);
    return;
  }

  await withTemporaryDirectory(async temporary => {
    const destination = path.join(temporary, "dist", "node-deps");
    await stageNodeTreeSitterRuntimeFromCache(cacheRoot, destination);
    const staged = await assertStagedTreeSitterInventory(destination);
    assert.ok(staged.length > 0);
    for (const relative of staged) assert.ok(relative.length <= MAX_STAGED_NODE_DEPS_PATH_LENGTH, relative);

    // A child process is the only place that can load the mapped object, so the
    // allowlist is proved against the real loader rather than a file listing.
    const script = `
      const { createRequire } = require("node:module");
      const path = require("node:path");
      const root = process.argv[1];
      const from = createRequire(path.join(root, "tree-sitter", "index.js"));
      const parser = new (from(path.join(root, "tree-sitter")))();
      parser.setLanguage(from(path.join(root, "tree-sitter-bash")));
      process.stdout.write(parser.parse("echo hi && ls -la").rootNode.toString());
    `;
    const { stdout } = await run(process.execPath, ["-e", script, destination], { maxBuffer: 8 * 1024 * 1024 });
    assert.match(stdout, /\(program/);
    assert.match(stdout, /command_name/);
  });
});