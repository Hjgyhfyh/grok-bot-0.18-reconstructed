/**
 * A sync that could not resolve who the signed-in user is carried the PREVIOUS
 * user's id forward, and that id is what decides whether a plugin skill counts as
 * "published by you" — the flag that unlocks editing and unpublishing it.
 *
 * WHAT BROKE. `SandPluginSkillsService.runPass` writes
 * `currentUserId: loaded.currentUserId ?? previous?.currentUserId ?? null`
 * (`source/host/extensions/mcp/plugin-skills.ts`). `loaded.currentUserId` is null
 * whenever `resolveCurrentUserId` could not answer — which is the case for every
 * build with no account, and for a build whose `GetMe` call failed while
 * `GetEffectiveUserPlugins` succeeded. The `??` then substitutes the id of whoever
 * was signed in last.
 *
 * The publisher facts beside it are NOT stale: `publisherFacts` is rebuilt from the
 * listing on the same pass. So the written index pairs a FRESH ownership table
 * against a STALE identity, and
 * `FileWorkflowStore.pluginSkillToWorkflow` computes
 * `publishedByCurrentUser: record.publisherUserId === index.currentUserId` from
 * exactly that pair.
 *
 * Consequences measured below: `update()` on a plugin skill the current account
 * does not own stops refusing, and `FileWorkflowStore.updatePluginSkill` writes
 * into the other publisher's plugin install directory.
 *
 * WHAT THESE TESTS PROVE. A pass that cannot answer "who am I" writes no identity
 * at all, and a plugin skill is only ever offered for editing when the publisher
 * on the fresh listing matches an identity the pass actually established.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `gray-matter` and `jsonc-parser` are CommonJS and reach their own sibling files
 * with a bare `require`; `jsonc-parser` does it from a UMD factory whose `require`
 * is a parameter, which esbuild cannot rewrite, so the call escapes and resolves
 * against the bundle's own folder. Both stay external, and the bundle is written
 * inside the repo so Node finds the real packages in `repoRoot/node_modules`.
 */
const BANNER = {
  js: 'import { createRequire as __grokCreateRequire } from "node:module"; const require = __grokCreateRequire(import.meta.url);',
};
const EXTERNAL = ["gray-matter", "jsonc-parser"];

async function bundle(entries) {
  const directory = mkdtempSync(path.join(repoRoot, ".tmp-plugin-identity-"));
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
  ["host", "workflows", "workflow-store.ts"],
]);
const { SandPluginSkillsService } = loaded["plugin-skills.mjs"];
const { getPluginSkillsCachePath, getPluginSkillsDir } = loaded["plugin-skills-cache.mjs"];
const { FileWorkflowStore } = loaded["workflow-store.mjs"];

test.after(() => dispose());

const PLUGIN_ID = "5150";
const OWNER = 100;

/** One installed plugin on disk, published by user `OWNER`. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-plugin-identity-"));
  const sandRoot = path.join(root, "sand");
  const agentDir = path.join(sandRoot, "agents", "agent-1");
  const globalDir = path.join(sandRoot, "workflows");
  const installPath = path.join(sandRoot, "plugins", "cache", "cursor-public", PLUGIN_ID, "v1");
  const skillFile = path.join(installPath, "skills", "owned-by-someone-else", "SKILL.md");
  for (const dir of [agentDir, globalDir, installPath, path.dirname(skillFile)]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    skillFile,
    "---\nname: Owned by someone else\ndescription: A skill from a plugin another account published.\n---\n\nOriginal body.\n",
  );

  const skillsDir = getPluginSkillsDir(sandRoot);
  mkdirSync(skillsDir, { recursive: true });
  const cacheJson = getPluginSkillsCachePath(skillsDir);
  // The identity of whoever was signed in last time, with nothing indexed.
  writeFileSync(
    cacheJson,
    `${JSON.stringify({ fetchedAt: 1_700_000_000_000, currentUserId: OWNER, skills: [], authBlocked: [] }, null, 2)}\n`,
  );

  return {
    root,
    sandRoot,
    agentDir,
    globalDir,
    installPath,
    skillFile,
    cacheJson,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A loader whose listing succeeds but which cannot say who is signed in. */
function loaderWithoutIdentity(box) {
  return async () => ({
    plugins: [
      {
        identifier: {
          source: "cursor-first-party",
          sourceInfo: { name: "someone-elses-plugin", pluginDbId: PLUGIN_ID, version: "v1" },
        },
        displayName: "Someone else's plugin",
        installPath: box.installPath,
        loadError: null,
        skills: [
          {
            path: "skills/owned-by-someone-else/SKILL.md",
            name: "Owned by someone else",
            description: "A skill from a plugin another account published.",
          },
        ],
      },
    ],
    authBlocked: [],
    listedPluginIds: [PLUGIN_ID],
    listedCacheKeys: [{ marketplaceSlug: "cursor-public", pluginId: PLUGIN_ID }],
    publisherFacts: new Map([[PLUGIN_ID, { publisherUserId: OWNER, marketplaceTeamId: 7 }]]),
    currentUserId: null,
    sourceUnavailable: false,
  });
}

test("a pass that cannot resolve the signed-in user must not write an identity", async () => {
  const box = fixture();
  try {
    const before = JSON.parse(readFileSync(box.cacheJson, "utf8"));
    assert.equal(before.currentUserId, OWNER, "the fixture must start with the previous user's id in the index");

    const service = new SandPluginSkillsService({
      sandRootDir: box.sandRoot,
      load: loaderWithoutIdentity(box),
    });
    await service.sync("test").catch(() => {});

    const after = JSON.parse(readFileSync(box.cacheJson, "utf8"));
    assert.equal(
      after.currentUserId,
      null,
      `the pass carried the previous user's id (${after.currentUserId}) forward after failing to resolve the current one, so the index now answers "who am I" with the answer from an earlier session`,
    );
  } finally {
    box.dispose();
  }
});

test("a plugin skill stays read-only for the current account when its identity is unknown", async () => {
  const box = fixture();
  try {
    const service = new SandPluginSkillsService({
      sandRootDir: box.sandRoot,
      load: loaderWithoutIdentity(box),
    });
    await service.sync("test").catch(() => {});

    const store = new FileWorkflowStore(box.agentDir, box.globalDir);
    const workflow = store.pluginWorkflows()[0];
    assert.notEqual(
      workflow,
      undefined,
      "the fixture must produce a readable plugin workflow, or this test proves nothing about the ownership flag",
    );
    assert.equal(
      workflow.publishedByCurrentUser,
      false,
      `the plugin skill was marked as published by the current user because the index still carried user ${OWNER}'s id; that flag is the only thing standing between a failed GetMe and editing someone else's installed plugin`,
    );
  } finally {
    box.dispose();
  }
});

test("with no identity in the index, update refuses to rewrite the plugin's file", async () => {
  const box = fixture();
  try {
    const service = new SandPluginSkillsService({
      sandRootDir: box.sandRoot,
      load: loaderWithoutIdentity(box),
    });
    await service.sync("test").catch(() => {});

    const store = new FileWorkflowStore(box.agentDir, box.globalDir);
    const workflow = store.pluginWorkflows()[0];
    const updated = store.update(workflow.id, {
      name: "Renamed by the wrong account",
      description: "Rewritten.",
      body: "Replaced body written by an account that never published this plugin.",
      trigger: null,
    });
    assert.equal(
      updated,
      null,
      "`update` rewrote a skill inside another publisher's plugin install directory, which the renderer then serves to every agent as an editable local skill",
    );
    assert.match(
      readFileSync(box.skillFile, "utf8"),
      /Original body\./,
      "the installed plugin's SKILL.md on disk was modified even though the update was supposed to be refused",
    );
  } finally {
    box.dispose();
  }
});
