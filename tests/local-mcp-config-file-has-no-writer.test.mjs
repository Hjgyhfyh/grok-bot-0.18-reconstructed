import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

/**
 * `%LOCALAPPDATA%\GrokBotLocalBox\mcp-servers.json` is the only thing standing
 * between a local MCP entry and arbitrary code execution as the signed-in user.
 * A local entry is a `command` plus optional `args`, the box runs it as a child
 * process (`box-exec-daemon/server.ts:1103-1128`), and no path guard applies to
 * a process the daemon starts on purpose — `resolvePath` and
 * `PathRejectedError` constrain the `Shell` and `Read` tools and nothing else.
 * So the model may never write that file, and the whole argument rests on the
 * absence of a writer.
 *
 * The guard that exists, `local-mcp-config-source.test.mjs:478`, proves one
 * module cannot write it: `local-mcp-config-provider.ts` is read and scanned, and
 * it names no write-capable filesystem API. That is the module the path comes
 * from, and it is not the only place a writer could appear. `localMcpConfigPath`
 * is exported, so any module anywhere can ask for the path and write whatever the
 * existing guard never looks at. A new `writeFileSync(localMcpConfigPath())`
 * would pass that test and hand the model `{"command":"cmd","args":["/c",…]}`
 * the next morning.
 *
 * These tests ask the question of the whole shipped tree instead of one file.
 *
 * WHY THE SCAN READS CODE AND NOT PROSE. A first version scanned raw text and
 * reported two offenders, both of them false: `server.ts` writes terminal files
 * and spawns MCP servers, and names the configuration only inside a comment
 * explaining that nobody writes it; `local-mcp-config-provider.ts` contains the
 * word "unlink" in the sentence that promises there is no unlink. A guard that
 * cannot tell a comment from a call is not a guard, so every candidate is passed
 * through esbuild first and only the emitted code is searched. The daemon
 * legitimately writes — it is the only process that may — so the claim being
 * tested is the narrow one: no module that KNOWS this path can write it.
 *
 * Three rules keep the result honest, and all three are tests: a counter that
 * proves the scan found something, a positive assertion that the reader is still
 * reading, and a positive assertion that the reader still imports `node:fs` at
 * all, so neither guard can pass by the module quietly shrinking away.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Shipped runtime source. `src/app/dist` is the payload, asserted about apart. */
const SCANNED_ROOTS = [
  path.join(repoRoot, "source", "shared"),
  path.join(repoRoot, "source", "host"),
  path.join(repoRoot, "source", "electron-main"),
  path.join(repoRoot, "source", "node-agent-coordinator"),
  path.join(repoRoot, "source", "box-exec-daemon"),
  path.join(repoRoot, "local-mcp"),
  path.join(repoRoot, "frontend", "src"),
];

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".build", ".cache", "dist", "coverage"]);

/** Every way to change a file, so the guard cannot be walked around with an unusual one. */
const WRITE_APIS = [
  "writeFileSync", "writeFile", "appendFileSync", "appendFile",
  "createWriteStream", "createWriteStreamSync", "openSync", "open",
  "truncateSync", "truncate", "ftruncate", "ftruncateSync",
  "unlinkSync", "unlink", "rmSync", "rm", "rmdirSync", "rmdir",
  "renameSync", "rename", "copyFileSync", "copyFile",
  "mkdirSync", "mkdir", "chmodSync", "chmod", "chownSync", "utimesSync",
];

/**
 * Anything that names the file, or can produce its path.
 *
 * `localMcpConfigPath` is matched on a word boundary so `localMcpConfigPathView`
 * — a getter that returns a path for a refusal message, not a handle — is not
 * dragged in. `GrokBotLocalBox` is matched so a module that rebuilds the path
 * from `LOCALAPPDATA` by hand is caught even though it never saw the provider.
 */
const PATH_TOKENS = [
  /mcp-servers\.json/,
  /\blocalMcpConfigPath\b/,
  /\bLOCAL_MCP_CONFIG_FILE\b/,
  /\bLOCAL_MCP_CONFIG_DIRECTORY\b/,
  /GrokBotLocalBox/,
];

function sourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(full);
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

const scanned = SCANNED_ROOTS.flatMap(sourceFiles).map((file) => ({
  file,
  relative: path.relative(repoRoot, file),
  text: readFileSync(file, "utf8"),
}));

/** Files that name the configuration at all, comment included. */
const named = scanned.filter(entry => PATH_TOKENS.some(token => token.test(entry.text)));

/**
 * Every file that names the configuration at all, comment included, as emitted
 * code. `code` is what the guard searches; `raw` is kept so a test can prove a
 * claim rests on prose rather than on a call.
 */
const evaluated = [];
for (const entry of named) {
  const loader = entry.file.endsWith(".ts") ? "ts" : "js";
  const code = (await transform(entry.text, { loader, format: "esm", target: "node22", legalComments: "none" })).code;
  evaluated.push({ relative: entry.relative, raw: entry.text, code, namesInCode: PATH_TOKENS.some(token => token.test(code)) });
}

/**
 * The files whose CODE still names the path. The filter is the point of the whole
 * exercise: the box daemon discusses the file in a comment and legitimately
 * writes files, and a list built from raw text would report it as a writer for a
 * sentence explaining that nobody writes it.
 */
const aware = evaluated.filter(entry => entry.namesInCode);

const offenders = aware
  .map(entry => ({ relative: entry.relative, apis: WRITE_APIS.filter(api => new RegExp(`\\b${api}\\b`).test(entry.code)) }))
  .filter(entry => entry.apis.length > 0);

test("the scan really looked at the configuration and found the modules that know it", () => {
  assert.ok(scanned.length > 100,
    `only ${scanned.length} files were scanned, so the guard below would be measuring almost nothing`);
  assert.ok(named.length > 0,
    "no file in the shipped tree names the local MCP configuration, so the writer guard below would pass by finding nothing");
  assert.ok(aware.length > 0,
    "no module's CODE names the local MCP configuration, so the writer guard below would pass by finding nothing");
  assert.ok(aware.some(entry => entry.relative.endsWith(path.join("mcp", "local-mcp-config-provider.ts"))),
    `the module that defines the path is not among the ${aware.length} files whose code knows it, so the scan is looking in the wrong places`);
  assert.equal(aware.some(entry => entry.relative.endsWith(path.join("box-exec-daemon", "server.ts"))), false,
    "the box daemon builds the configuration path itself, so it could read or write the user's file instead of taking what the host pushes");
});

test("no module that knows the local MCP configuration can write it", () => {
  assert.deepEqual(offenders, [],
    `these modules know where %LOCALAPPDATA%\\GrokBotLocalBox\\mcp-servers.json is and can also change files: ` +
    `${offenders.map(entry => `${entry.relative} [${entry.apis.join(", ")}]`).join("; ")}`);
});

test("the module that owns the path still reads it, so the guard above cannot pass by the reader disappearing", () => {
  const provider = aware.find(entry => entry.relative.endsWith(path.join("mcp", "local-mcp-config-provider.ts")));
  assert.ok(provider, "the module that owns the local MCP configuration path is gone from the tree");
  assert.ok(/\breadFileSync\b/.test(provider.code),
    "the module that owns the path no longer reads it, so 'nothing writes it' would be true because nothing reaches it");
});

test("the box daemon is handed the configuration, never told where the file is", () => {
  const daemon = evaluated.find(entry => entry.relative.endsWith(path.join("box-exec-daemon", "server.ts")));
  assert.ok(daemon,
    "the box daemon no longer mentions the configuration at all, so the comment explaining it has been deleted or moved");
  assert.ok(PATH_TOKENS.some(token => token.test(daemon.raw)),
    "the daemon's own account of the configuration is gone, so this test is asserting about a comment that is not there");
  assert.equal(daemon.namesInCode, false,
    "the daemon names the configuration in code, so it can act on it instead of only being told about it");
  // The daemon writes — terminal files, and whatever an MCP server writes. The
  // claim is only that it cannot name the one file that must stay the user's.
  assert.ok(WRITE_APIS.some(api => new RegExp(`\\b${api}\\b`).test(daemon.code)),
    "the daemon names no write-capable API, so the exclusion above is resting on a daemon that does nothing at all");
});

test("the module that owns the path imports nothing from node:fs that can change a file", () => {
  const provider = aware.find(entry => entry.relative.endsWith(path.join("mcp", "local-mcp-config-provider.ts")));
  const imported = [...provider.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs["']/g)]
    .flatMap(match => match[1].split(",").map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  assert.deepEqual([...new Set(imported)].sort(), ["readFileSync"],
    `the module imports ${imported.join(", ")} from node:fs, so the absence of a write API proves nothing about what it imported`);
});