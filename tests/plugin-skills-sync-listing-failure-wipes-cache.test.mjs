/**
 * A sync that could not reach the account reported success, emptied the skill
 * index, and deleted every installed plugin from disk.
 *
 * WHAT BROKE. `loadFromMarketplaceSource` catches whatever
 * `client.listEnabledPlugins` throws, logs it, and returns
 * `{ plugins: [], failures: [], sourceUnavailable: true }`
 * (`source/packages/cursor-plugins/loader.ts:113`). It has no other way to say
 * "I do not know what is installed".
 *
 * `createSharedInstalledPluginsLoader` drops `sourceUnavailable` on the floor: the
 * `LoadedPlugins` it returns has no such field, so the caller receives
 * `plugins: []`, `listedPluginIds: []`, `listedCacheKeys: []` — byte for byte what
 * a signed-in account with nothing installed produces.
 *
 * `SandPluginSkillsService.runPass` cannot tell those apart, and treats both as
 * truth:
 *   - `records` is rebuilt from `loaded.plugins`, so it is `[]`;
 *   - the carry-over line keeps a previous record only when
 *     `listed.has(record.pluginId)`, and `listed` is empty, so every previously
 *     indexed skill is dropped;
 *   - `writePluginSkillsCache` then overwrites `cache.json` with the empty list;
 *   - `pruneUninstalledPluginDirs(cacheRoot, [], [])` computes `keep = new Set([])`
 *     and `rmSync`s every `<cacheRoot>/<marketplace>/<plugin>` directory.
 *   - `reportSync` is called with `outcome: "ok"`.
 *
 * The net effect of one unreachable network is that the user's installed plugins
 * are gone from the agent's skill list AND gone from disk, and every log line and
 * telemetry event says the sync worked.
 *
 * THE USER HAS NO ACCOUNT, so this is not hypothetical here: `getEffectiveUserPlugins`
 * cannot succeed, and the very first `syncPluginSkills` a signed-out build runs
 * takes this path.
 *
 * WHAT THESE TESTS PROVE. With a real `SandPluginSkillsService` over a real
 * `createSharedInstalledPluginsLoader`, a listing that rejects must leave the
 * on-disk index and the on-disk plugin cache exactly as they were, must not report
 * `outcome: "ok"`, and must not resolve as if it had synced.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Two CommonJS packages reach their own sibling files with a bare `require`.
 * `gray-matter` does it from its module body; `jsonc-parser` does it from a UMD
 * factory whose `require` is a *parameter*, which esbuild cannot rewrite, so the
 * call escapes to the real `require` and resolves against the bundle's own folder:
 * "Cannot find module './impl/format'".
 *
 * Both are therefore left external, and the bundle is written INSIDE the repo so
 * Node's bare-specifier resolution walks up to `repoRoot/node_modules` and loads
 * the real packages with their real internal layout. The directory is removed by
 * `test.after`.
 */
const BANNER = {
  js: 'import { createRequire as __grokCreateRequire } from "node:module"; const require = __grokCreateRequire(import.meta.url);',
};
const EXTERNAL = ["gray-matter", "jsonc-parser"];

async function bundle(entries) {
  const directory = mkdtempSync(path.join(repoRoot, ".tmp-plugin-sync-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      banner: BANNER,
      external: EXTERNAL,
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names)
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "mcp", "plugin-skills.ts"],
  ["host", "extensions", "mcp", "plugin-skills-cache.ts"],
]);
const {
  SandPluginSkillsService,
  createSharedInstalledPluginsLoader,
  pluginAuthBlocksFromFailures,
} = loaded["plugin-skills.mjs"];
const { getPluginSkillsCachePath, getPluginSkillsDir } = loaded["plugin-skills-cache.mjs"];

test.after(() => dispose());

const PLUGIN_ID = "4242";
const SLUG = "cursor-public";
const VERSION = "9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";

/**
 * A sand root holding one fully installed plugin: its files on disk under
 * `<sandRoot>/plugins/cache/<slug>/<id>/<version>/`, and the matching record in
 * `<sandRoot>/plugin-skills/cache.json`.
 */
function installedPluginFixture() {
  const sandRoot = mkdtempSync(path.join(os.tmpdir(), "grok-plugin-sync-root-"));
  const installPath = path.join(sandRoot, "plugins", "cache", SLUG, PLUGIN_ID, VERSION);
  const skillDir = path.join(installPath, "skills", "alpha-one");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(installPath, "plugin.json"), JSON.stringify({ name: "alpha" }));
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: Alpha one\ndescription: The first skill of the alpha plugin.\n---\n\nDo the alpha thing.\n",
  );

  const record = {
    id: `plugin-${PLUGIN_ID}-alpha-one`,
    pluginId: PLUGIN_ID,
    pluginName: "alpha",
    name: "Alpha one",
    description: "The first skill of the alpha plugin.",
    filePath: path.join(skillDir, "SKILL.md"),
    pluginVersion: VERSION,
    installPath,
    skillRelativePath: "skills/alpha-one/SKILL.md",
    publisherUserId: 77,
    marketplaceTeamId: 88,
  };
  const skillsDir = getPluginSkillsDir(sandRoot);
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    getPluginSkillsCachePath(skillsDir),
    `${JSON.stringify({ fetchedAt: 1_700_000_000_000, currentUserId: 77, skills: [record], authBlocked: [] }, null, 2)}\n`,
  );

  return {
    sandRoot,
    installPath,
    skillFile: record.filePath,
    cacheJson: getPluginSkillsCachePath(skillsDir),
    dispose: () => rmSync(sandRoot, { recursive: true, force: true }),
  };
}

/**
 * The real production loader, with the account RPC standing in for a signed-out
 * build: `getEffectiveUserPlugins` is exactly the call that cannot answer.
 */
function loaderFor(sandRoot, listing) {
  const logLines = [];
  const load = createSharedInstalledPluginsLoader({
    sandRootDir: sandRoot,
    auth: {
      getAccessToken: async () => {
        throw new Error("16 UNAUTHENTICATED: no signed-in account");
      },
      getMachineId: async () => "machine-under-test",
      peekAccessToken: () => null,
    },
    isSparsePluginClonesEnabled: () => false,
    dashboardForTesting: {
      getEffectiveUserPlugins: listing,
      getMe: async () => {
        throw new Error("16 UNAUTHENTICATED: no signed-in account");
      },
    },
    log: (message) => logLines.push(message),
  });
  return { load, logLines };
}

function readCacheJson(cacheJson) {
  return JSON.parse(readFileSync(cacheJson, "utf8").replace(/^\uFEFF/, ""));
}

test("a sync whose account listing failed must not resolve as a successful empty sync", async () => {
  const box = installedPluginFixture();
  try {
    const events = [];
    const { load } = loaderFor(box.sandRoot, async () => {
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    });
    const service = new SandPluginSkillsService({
      sandRootDir: box.sandRoot,
      load,
      reportSync: (event) => events.push(event),
    });

    let resolved = null;
    let rejected = null;
    try {
      resolved = await service.sync("test");
    } catch (error) {
      rejected = error;
    }

    assert.notEqual(
      rejected,
      null,
      "the sync resolved instead of reporting that it could not reach the account; `syncPluginSkills` answers 200 with an empty list and the caller has no way to tell that from 'you have no plugins'",
    );
    assert.deepEqual(
      resolved ?? null,
      null,
      "the sync resolved with a value, so a caller awaiting it sees a normal result rather than a failure",
    );
  } finally {
    box.dispose();
  }
});

test("a sync whose account listing failed must not report outcome ok", async () => {
  const box = installedPluginFixture();
  try {
    const events = [];
    const { load } = loaderFor(box.sandRoot, async () => {
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    });
    const service = new SandPluginSkillsService({
      sandRootDir: box.sandRoot,
      load,
      reportSync: (event) => events.push(event),
    });
    await service.sync("test").catch(() => {});
    const ok = events.filter((event) => event.outcome === "ok");
    assert.deepEqual(
      ok.map((event) => ({ ...event, durationMs: 0 })),
      [],
      "the failed sync reported `outcome: \"ok\"` to telemetry, which is the only record the product keeps of what happened",
    );
  } finally {
    box.dispose();
  }
});

test("a sync whose account listing failed must leave the on-disk skill index alone", async () => {
  const box = installedPluginFixture();
  try {
    const before = readCacheJson(box.cacheJson);
    assert.equal(before.skills.length, 1, "the fixture must start with one indexed plugin skill");

    const { load } = loaderFor(box.sandRoot, async () => {
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    });
    await new SandPluginSkillsService({ sandRootDir: box.sandRoot, load }).sync("test").catch(() => {});

    const after = readCacheJson(box.cacheJson);
    assert.equal(
      after.skills.length,
      1,
      `the failed sync rewrote cache.json down to ${after.skills.length} skills, so the user's installed plugin skill disappeared from every agent's skill list`,
    );
    assert.equal(
      after.skills[0].filePath,
      before.skills[0].filePath,
      "the surviving record points somewhere else, so this is not the original record left untouched",
    );
  } finally {
    box.dispose();
  }
});

test("a sync whose account listing failed must not delete installed plugin directories from disk", async () => {
  const box = installedPluginFixture();
  try {
    assert.equal(existsSync(box.skillFile), true, "the fixture must start with the plugin skill file on disk");

    const { load } = loaderFor(box.sandRoot, async () => {
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    });
    await new SandPluginSkillsService({ sandRootDir: box.sandRoot, load }).sync("test").catch(() => {});

    assert.equal(
      existsSync(box.skillFile),
      true,
      "the failed sync deleted the installed plugin's files from disk; a later successful sync has to re-clone the whole plugin from the network to get them back",
    );
    assert.equal(
      existsSync(box.installPath),
      true,
      "the whole plugin install directory was removed, not just the skill file",
    );
  } finally {
    box.dispose();
  }
});

test("a listing that fails must leave a different index behind than an account with nothing installed", async () => {
  const failing = [];
  const empty = [];
  const failedRoot = installedPluginFixture();
  const emptyRoot = installedPluginFixture();
  try {
    const a = new SandPluginSkillsService({
      sandRootDir: failedRoot.sandRoot,
      load: loaderFor(failedRoot.sandRoot, async () => {
        throw new Error("16 UNAUTHENTICATED: no signed-in account");
      }).load,
      reportSync: (event) => failing.push(event),
    });
    const b = new SandPluginSkillsService({
      sandRootDir: emptyRoot.sandRoot,
      load: loaderFor(emptyRoot.sandRoot, async () => ({ plugins: [] })).load,
      reportSync: (event) => empty.push(event),
    });
    await a.sync("test").catch(() => {});
    await b.sync("test").catch(() => {});

    const afterFailure = readCacheJson(failedRoot.cacheJson);
    const afterEmptyAccount = readCacheJson(emptyRoot.cacheJson);

    assert.equal(
      afterFailure.skills.length,
      1,
      "the failed listing kept the last known index, so the plugin skill is still in the agent's list while the account cannot be reached",
    );
    assert.equal(
      afterEmptyAccount.skills.length,
      0,
      "a listing that genuinely succeeded with nothing installed is still allowed to empty the index; that is the honest answer for that account",
    );
    assert.equal(
      existsSync(failedRoot.skillFile),
      true,
      "the failed listing left the installed plugin on disk",
    );
    assert.equal(
      existsSync(emptyRoot.skillFile),
      false,
      "an account with nothing installed prunes the cache, which is what makes the two states distinguishable afterwards",
    );
    assert.deepEqual(
      failing.map((event) => event.outcome),
      ["failed"],
      "the failed pass is recorded as a failure in telemetry, so the product keeps a record of what actually happened",
    );
    assert.deepEqual(
      empty.map((event) => event.outcome),
      ["ok"],
      "the empty account is recorded as a success, because that is what it was",
    );
  } finally {
    failedRoot.dispose();
    emptyRoot.dispose();
  }
});

test("the sync status says whether the listing was unreachable or merely empty", async () => {
  const box = installedPluginFixture();
  try {
    const { load } = loaderFor(box.sandRoot, async () => {
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    });
    const service = new SandPluginSkillsService({ sandRootDir: box.sandRoot, load });
    assert.equal(
      service.sourceUnavailable(),
      false,
      "before any pass has run there is nothing to report as unreachable",
    );
    await service.sync("test").catch(() => {});
    assert.equal(
      service.sourceUnavailable(),
      true,
      "after a pass that could not read the account, `getPluginSyncStatus` still answers `{authBlocked: []}` — the same record a healthy empty account produces — so the caller cannot tell a dead backend from a synced-and-empty one",
    );
    assert.equal(
      service.currentAuthBlocked().length,
      0,
      "the last known authBlocked list survives the failed pass, which is what the renderer reads to decide whether to show the credential prompt",
    );
  } finally {
    box.dispose();
  }
});

test("authBlocked cannot stand in for the failure, because the loader reports zero failures", () => {
  const blocks = pluginAuthBlocksFromFailures([]);
  assert.deepEqual(
    blocks,
    [],
    "the loader hands back an empty failure list on a dead backend, so there is nothing left for the auth-block surface to report either",
  );
});
