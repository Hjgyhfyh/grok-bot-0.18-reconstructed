import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { isWindowsRuntimeHost, repoRoot, runtimeUnpackedPath } from "./lib/config.mjs";
import { resolveRuntimeApp } from "./lib/runtime.mjs";

const packages = ["tree-sitter", "tree-sitter-bash"];
const dependencies = ["node-addon-api", "node-gyp-build"];

// node-gyp-build resolves a node-gyp `build/Release` object and a prebuildify
// `prebuilds/<platform>-<arch>` archive alike, so either spelling satisfies a
// package. The pinned Windows runtime ships tree-sitter as a `build/Release`
// object and tree-sitter-bash as a prebuild; the macOS source build produces
// `build/Release` objects for both.
const nativeBinaries = new Map([
  ["tree-sitter", ["build/Release/tree_sitter_runtime_binding.node"]],
  ["tree-sitter-bash", [
    "build/Release/tree_sitter_bash_binding.node",
    `prebuilds/${process.platform}-${process.arch}/tree-sitter-bash.node`,
  ]],
]);

function nodeRuntimeCacheRoot() {
  return path.join(repoRoot, ".cache", "tree-sitter-node", process.versions.modules, `${process.platform}-${process.arch}`);
}

/**
 * Windows rejects any path longer than `MAX_PATH` unless long-path support is
 * enabled, and nothing here enables it. The staged tree therefore carries an
 * explicit budget instead of inheriting the vendor's directory nesting:
 * `MAX_PATH` minus the terminating NUL, minus the longest repository checkout
 * this project claims to support, minus the fixed build prefix that sits above
 * `dist/node-deps`. `MAX_PATH` alone would only reject the old whole-cache copy
 * at an implausibly long checkout root; this budget rejects it everywhere.
 */
export const WINDOWS_MAX_PATH = 260;
export const LONGEST_SUPPORTED_CHECKOUT_PATH = 120;
export const STAGED_PATH_PREFIX = ".build/fidelity-clean-runtime/dist/node-deps/";
export const MAX_STAGED_NODE_DEPS_PATH_LENGTH =
  WINDOWS_MAX_PATH - 1 - LONGEST_SUPPORTED_CHECKOUT_PATH - STAGED_PATH_PREFIX.length;

function runNodeGyp(target) {
  // node-gyp ships a `.cmd` shim on Windows, which spawn() refuses with EINVAL
  // unless a command interpreter is involved. Running its JavaScript entry
  // point with the current Node executable is equivalent and platform-neutral.
  const entry = path.join(repoRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
  const environment = { ...process.env };
  for (const key of ["npm_config_runtime", "npm_config_target", "npm_config_disturl", "npm_config_nodedir"]) delete environment[key];
  environment.npm_config_build_from_source = "true";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "rebuild", "--directory", target, "--release"], {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`node-gyp exited with ${code} for ${path.basename(target)}`)));
  });
}

async function readableFile(target) {
  try { await readFile(target); return true; }
  catch { return false; }
}

async function hasNodeRuntimeBinaries(root) {
  for (const [packageName, relatives] of nativeBinaries) {
    const present = await Promise.all(relatives.map(relative => readableFile(path.join(root, packageName, relative))));
    if (!present.includes(true)) return false;
  }
  return true;
}

async function copyPackage(sourceRoot, destinationRoot, packageName) {
  await cp(path.join(sourceRoot, packageName), path.join(destinationRoot, packageName), { recursive: true, dereference: true });
}

// A missing source is reported rather than thrown so each caller can decide
// whether the package was optional or a reason to abandon the whole attempt.
async function tryCopyPackage(sourceRoot, destinationRoot, packageName) {
  try {
    await copyPackage(sourceRoot, destinationRoot, packageName);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// The checksum-pinned runtime already carries ABI-matched native binaries for
// this platform, and reusing them follows the same rule the packaged Electron
// dependencies use. Both packages are N-API bindings compiled with
// `NAPI_VERSION=<(napi_build_version)`, so one binary serves the local-exec
// daemon's plain Node and the Electron process alike. On Windows this is also
// the only way to obtain them: node-gyp folds Node's own build variables
// (`enable_thin_lto`, `lto_jobs`) into gyp, and Node 26.7.0's common.gypi then
// emits `/opt:lldltojobs=2`, which the installed MSVC link.exe rejects with
// LNK1117 — so linking removes the VS Build Tools prerequisite entirely.
// Returns whether the cache root now holds a usable runtime.
async function stageFromPinnedRuntime(cacheRoot) {
  let runtimeApp;
  try {
    runtimeApp = await resolveRuntimeApp();
  } catch {
    return false; // no validated runtime to borrow from; the source build stands in
  }
  const runtimeDeps = path.join(runtimeUnpackedPath(runtimeApp), "dist", "deps");
  const temporaryRoot = await mkdtemp(path.join(repoRoot, ".tmp-tree-sitter-node-"));
  try {
    const packageRoot = path.join(temporaryRoot, "node_modules");
    await mkdir(packageRoot, { recursive: true });
    for (const packageName of packages) {
      if (!(await tryCopyPackage(runtimeDeps, packageRoot, packageName))) return false;
    }
    if (!(await hasNodeRuntimeBinaries(packageRoot))) return false;
    // The loader and the C++ wrapper headers are platform-neutral, so the
    // runtime's copies stand in for the node_modules ones when it ships them.
    for (const packageName of dependencies) {
      if (!(await tryCopyPackage(runtimeDeps, packageRoot, packageName))
        && !(await tryCopyPackage(path.join(repoRoot, "node_modules"), packageRoot, packageName))) return false;
    }
    await rm(cacheRoot, { recursive: true, force: true });
    await mkdir(path.dirname(cacheRoot), { recursive: true });
    await cp(packageRoot, cacheRoot, { recursive: true, dereference: true });
    return true;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function buildFromSource(cacheRoot) {
  const temporaryRoot = await mkdtemp(path.join(repoRoot, ".tmp-tree-sitter-node-"));
  try {
    const packageRoot = path.join(temporaryRoot, "node_modules");
    await mkdir(packageRoot, { recursive: true });
    for (const packageName of [...packages, ...dependencies]) await copyPackage(path.join(repoRoot, "node_modules"), packageRoot, packageName);
    for (const packageName of packages) await runNodeGyp(path.join(packageRoot, packageName));
    await rm(cacheRoot, { recursive: true, force: true });
    await mkdir(path.dirname(cacheRoot), { recursive: true });
    await cp(packageRoot, cacheRoot, { recursive: true, dereference: true });
    return cacheRoot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function ensureNodeTreeSitterRuntime() {
  const cacheRoot = nodeRuntimeCacheRoot();
  if (await hasNodeRuntimeBinaries(cacheRoot)) return cacheRoot;
  if (isWindowsRuntimeHost && await stageFromPinnedRuntime(cacheRoot)) return cacheRoot;
  return await buildFromSource(cacheRoot);
}

// Everything the packaged local-exec daemon evaluates is the ABI-matched
// `.node` object plus the JavaScript that loads it and the manifest that names
// the entry point. A tree-sitter cache holds far more, and most of the rest is
// the vendor's build machine rather than this project's payload: the MSVC
// intermediates under `build/Release/obj` name the machine that produced them
// — `.tlog` files embed `C:\B\SAND-RELEASE-CACHE\<fresh build UUID>\SCRATCH\…`
// and `build/config.gypi` records the vendor's `nodedir` — while
// `jest-tests/`, `test/`, `vendor/` and the `node_modules/.bin` shims are never
// loaded at all. Copying the cache whole shipped that state into
// `dist/node-deps`, into the per-file `dist/reconstruction-build.json` inventory
// and into `app.asar.unpacked`, so two Windows builds of one commit could never
// agree byte for byte and the asar digest followed the compiling machine
// instead of the source. It also carried the staging tree past `MAX_PATH`.
const packageEntryPoints = new Map([
  // `index.js` is the `main` the shell parser loads; it calls `node-gyp-build`
  // and nothing else.
  ["tree-sitter", ["package.json", "index.js"]],
  // `bindings/node/index.js` loads the native grammar and then reads the
  // generated `node-types.json`, which supplies the field accessors on parser
  // nodes; dropping it would silently degrade every typed field lookup.
  ["tree-sitter-bash", ["package.json", "bindings/node/index.js", "src/node-types.json"]],
  // `node-addon-api` is a build-time dependency of the native modules. Nothing
  // loads its headers at run time, but `scripts/verify.mjs` asserts its staged
  // manifest, so the allowlist keeps the same file under its real name.
  ["node-addon-api", ["package.json", "index.js"]],
  // `node-gyp-build` is the loader both grammar packages call. `index.js`
  // prefers `require.addon` and otherwise falls back to `node-gyp-build.js`.
  ["node-gyp-build", ["package.json", "index.js", "node-gyp-build.js"]],
]);

// `dist/node-deps/<package>` is what
// `source/packages/shell-exec/shell-parser.ts` loads with
// `createRequire(<node-deps>/<package>)`, and that resolution walks
// `<node-deps>/node_modules` for the `node-gyp-build` import.
const stagedGrammarPackages = Object.freeze([...packages]);
const stagedResolutionPackages = Object.freeze([...dependencies]);

async function readableBinary(cacheRoot, packageName, spellings) {
  const present = [];
  for (const spelling of spellings) {
    if (await readableFile(path.join(cacheRoot, packageName, ...spelling.split("/")))) present.push(spelling);
  }
  return present.sort();
}

/**
 * The deterministic, complete list of files this project stages for one cache
 * root. Every entry must exist: a missing manifest, entry point or native
 * object is a reason to abandon the attempt rather than ship a partial parser.
 */
export async function collectStagedTreeSitterFiles(cacheRoot) {
  const staged = [];
  for (const [packageName, relatives] of packageEntryPoints) {
    for (const relative of relatives) {
      if (!(await readableFile(path.join(cacheRoot, packageName, ...relative.split("/"))))) {
        throw new Error(`Tree-sitter runtime cache is missing ${packageName}/${relative}: ${cacheRoot}`);
      }
      staged.push({ packageName, relative });
    }
  }
  for (const [packageName, spellings] of nativeBinaries) {
    const present = await readableBinary(cacheRoot, packageName, spellings);
    if (present.length === 0) {
      throw new Error(`Tree-sitter runtime cache has no native binary for ${packageName} in ${cacheRoot}`);
    }
    for (const relative of present) staged.push({ packageName, relative });
  }
  return staged;
}

async function copyStagedFile(cacheRoot, packageName, relative, destinationRoot, stagedPrefix) {
  const target = path.join(destinationRoot, ...stagedPrefix, packageName, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(cacheRoot, packageName, ...relative.split("/")), target);
  return `${[...stagedPrefix, packageName, ...relative.split("/")].join("/")}`;
}

/**
 * Stage the allowlisted payload of a tree-sitter cache, and nothing else.
 * Exported so the staged inventory can be asserted without building anything.
 */
export async function stageNodeTreeSitterRuntimeFromCache(cacheRoot, destination) {
  const staged = await collectStagedTreeSitterFiles(cacheRoot);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const stagedPaths = [];
  for (const packageName of stagedGrammarPackages) {
    for (const { relative } of staged.filter(entry => entry.packageName === packageName)) {
      stagedPaths.push(await copyStagedFile(cacheRoot, packageName, relative, destination, []));
    }
  }
  for (const packageName of stagedResolutionPackages) {
    for (const { relative } of staged.filter(entry => entry.packageName === packageName)) {
      stagedPaths.push(await copyStagedFile(cacheRoot, packageName, relative, destination, ["node_modules"]));
    }
  }
  for (const relative of stagedPaths) {
    if (relative.length > MAX_STAGED_NODE_DEPS_PATH_LENGTH) {
      throw new Error(
        `Staged tree-sitter path is ${relative.length} characters, over the ${MAX_STAGED_NODE_DEPS_PATH_LENGTH}-character budget: ${relative}`,
      );
    }
  }
  return destination;
}

/**
 * Nothing matching these shapes may appear in `dist/node-deps`. They are the
 * build-machine residue the allowlist exists to keep out: MSVC intermediates,
 * the gyp configuration that records the compiler's `nodedir`, and the test
 * trees and shims no packaged code path evaluates.
 */
export const FORBIDDEN_STAGED_TREE_SITTER_FILES = Object.freeze([
  /(^|\/)build\/Release\/obj\//,
  /\.tlog(\/|$)/,
  /\.ipdb$/,
  /\.iobj$/,
  /\.lib$/,
  /\.exp$/,
  /\.recipe$/,
  /\.nativecodeanalysis\.xml$/,
  /\.lastbuildstate$/,
  /\.vcxproj(\.filters)?$/,
  /(^|\/)config\.gypi$/,
  /(^|\/)jest-tests\//,
  /(^|\/)test\//,
  /(^|\/)node_modules\/\.bin\//,
]);

/**
 * Fail closed on a staged tree that the allowlist did not produce, so a future
 * editor that widens the staging back to a whole-cache copy cannot ship the
 * vendor's build intermediates without this failing first.
 */
export async function assertStagedTreeSitterInventory(destination) {
  const longest = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) longest.push(path.relative(destination, target).split(path.sep).join("/"));
    }
  };
  await walk(destination);
  longest.sort((left, right) => right.length - left.length || left.localeCompare(right));
  const overBudget = longest.filter(relative => relative.length > MAX_STAGED_NODE_DEPS_PATH_LENGTH);
  if (overBudget.length > 0) {
    throw new Error(
      `Staged tree-sitter inventory exceeds the ${MAX_STAGED_NODE_DEPS_PATH_LENGTH}-character path budget: ${overBudget[0]}`,
    );
  }
  const forbidden = longest.filter(relative => FORBIDDEN_STAGED_TREE_SITTER_FILES.some(pattern => pattern.test(relative)));
  if (forbidden.length > 0) {
    throw new Error(`Staged tree-sitter inventory contains build intermediates: ${forbidden.join(", ")}`);
  }
  return longest;
}

export async function stageNodeTreeSitterRuntime(outputRoot) {
  const cacheRoot = await ensureNodeTreeSitterRuntime();
  const destination = path.join(outputRoot, "dist", "node-deps");
  await stageNodeTreeSitterRuntimeFromCache(cacheRoot, destination);
  await assertStagedTreeSitterInventory(destination);
  return destination;
}

// `import.meta.url` is a file:// URL on every platform, so comparing it against
// a raw Windows path never matches; pathToFileURL normalises the entry point.
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ node: process.version, modules: process.versions.modules, output: await ensureNodeTreeSitterRuntime() }, null, 2));
}
