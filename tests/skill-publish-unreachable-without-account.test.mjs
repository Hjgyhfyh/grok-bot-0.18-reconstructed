/**
 * Skill publishing is account-backed, the build under test has no account, and
 * every door into it has to say so.
 *
 * The obligation is narrow and adversarial: not "publishing is broken", but "there
 * is no argument, no stale file, no carried-over identity and no empty reply that
 * makes a publish look like it happened, or makes someone else's plugin look like
 * yours to resync or unpublish".
 *
 * The paths that matter, and what each one is supposed to do when `GetTeams`,
 * `PublishPlugin` and `UnpublishPlugin` cannot be answered:
 *   - `listTargets` must return no teams AND a non-null `unavailableReason`, so the
 *     renderer has nothing to render a picker from;
 *   - `publish` must refuse before it writes anything when the target is not a real
 *     team id, and must not reach the network with an empty description;
 *   - `publish` must keep the library copy when the upload does not land;
 *   - `resync` / `unpublish` must refuse a skill whose publisher is not the signed-in
 *     user, including when the index has no idea who that is;
 *   - nothing above may leave a half-finished side effect behind when it fails.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BANNER = {
  js: 'import { createRequire as __grokCreateRequire } from "node:module"; const require = __grokCreateRequire(import.meta.url);',
};
const EXTERNAL = ["gray-matter", "jsonc-parser"];

async function bundle(entries) {
  const directory = mkdtempSync(path.join(repoRoot, ".tmp-skill-publish-"));
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
  ["host", "extensions", "mcp", "skill-publish.ts"],
  ["host", "extensions", "mcp", "plugin-skills-cache.ts"],
  ["packages", "cursor-plugins", "skill-plugin-synthesizer.ts"],
]);
const { SandSkillPublishService, publishableTeams, skillsRootRelativePath } = loaded["skill-publish.mjs"];
const { synthesizeSkillPluginDir } = loaded["skill-plugin-synthesizer.mjs"];
const { getPluginSkillsCachePath, getPluginSkillsDir } = loaded["plugin-skills-cache.mjs"];

test.after(() => dispose());

const PLUGIN_ID = "6161";
const OTHER_USER = 4242;

/** A sandbox with one local library skill and one installed plugin skill. */
function fixture(currentUserId) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-skill-publish-"));
  const sandRoot = path.join(root, "sand");
  const libraryDir = path.join(sandRoot, "workflows");
  const localSkill = path.join(libraryDir, "my-skill");
  mkdirSync(localSkill, { recursive: true });
  writeFileSync(
    path.join(localSkill, "SKILL.md"),
    "---\nname: My skill\ndescription: A skill that lives in the local library.\n---\n\nDo the thing.\n",
  );

  const installPath = path.join(sandRoot, "plugins", "cache", "cursor-public", PLUGIN_ID, "v1");
  const pluginSkillFile = path.join(installPath, "skills", "borrowed", "SKILL.md");
  mkdirSync(path.dirname(pluginSkillFile), { recursive: true });
  writeFileSync(path.join(installPath, "plugin.json"), JSON.stringify({ name: "borrowed-plugin" }));
  writeFileSync(
    pluginSkillFile,
    "---\nname: Borrowed\ndescription: A skill from a plugin another account published.\n---\n\nBorrowed body.\n",
  );

  const skillsDir = getPluginSkillsDir(sandRoot);
  mkdirSync(skillsDir, { recursive: true });
  const cacheJson = getPluginSkillsCachePath(skillsDir);
  writeFileSync(
    cacheJson,
    `${JSON.stringify(
      {
        fetchedAt: 1_700_000_000_000,
        currentUserId,
        skills: [
          {
            id: "plugin-6161-borrowed",
            pluginId: PLUGIN_ID,
            pluginName: "borrowed-plugin",
            name: "Borrowed",
            description: "A skill from a plugin another account published.",
            filePath: pluginSkillFile,
            pluginVersion: "v1",
            installPath,
            skillRelativePath: "skills/borrowed/SKILL.md",
            publisherUserId: OTHER_USER,
            marketplaceTeamId: 9,
          },
        ],
        authBlocked: [],
      },
      null,
      2,
    )}\n`,
  );

  return { root, sandRoot, cacheJson, pluginSkillFile, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** The client a signed-out build has: every account RPC rejects. */
function signedOutClient(calls) {
  return {
    getTeams: async () => {
      calls.push("getTeams");
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    },
    publishPlugin: async () => {
      calls.push("publishPlugin");
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    },
    unpublishPlugin: async () => {
      calls.push("unpublishPlugin");
      throw new Error("16 UNAUTHENTICATED: no signed-in account");
    },
  };
}

function serviceFor(box, client) {
  const logs = [];
  const edgeFailures = [];
  return {
    logs,
    edgeFailures,
    service: new SandSkillPublishService({
      sandRootDir: box.sandRoot,
      client,
      pluginSkills: {
        currentIndex: () => JSON.parse(readFileSync(box.cacheJson, "utf8")),
        sync: async () => [],
      },
      log: (message) => logs.push(message),
      reportEdgeFailed: (event) => edgeFailures.push(event),
    }),
  };
}

test("with no account, listTargets offers no teams and says why", async () => {
  const box = fixture(null);
  try {
    const calls = [];
    const { service, edgeFailures } = serviceFor(box, signedOutClient(calls));
    const result = await service.listTargets();
    assert.deepEqual(result.teams, [], "a dead GetTeams must not yield a team the user can pick");
    assert.notEqual(
      result.unavailableReason,
      null,
      "the reply carries no reason, so the renderer cannot tell 'you have no team' from 'Cursor is unreachable' and offers a dead picker",
    );
    assert.match(result.unavailableReason, /Cursor/, "the reason has to name the thing that could not be reached");
    assert.deepEqual(
      edgeFailures.map((event) => event.stage),
      ["list_targets"],
      "the failed lookup was not reported, so the only evidence it failed is one line of host log text",
    );
  } finally {
    box.dispose();
  }
});

test("with no account, publish refuses and keeps the library copy", async () => {
  const box = fixture(null);
  try {
    const calls = [];
    const { service } = serviceFor(box, signedOutClient(calls));
    await assert.rejects(
      () => service.publish({ workflowId: "my-skill", teamId: 9 }),
      "the publish resolved on a build with no account",
    );
    assert.deepEqual(
      readdirSync(path.join(box.sandRoot, "workflows")),
      ["my-skill"],
      "the local library copy was removed even though nothing was published; the skill is now in neither place",
    );
  } finally {
    box.dispose();
  }
});

test("publish refuses a target that is not a team id, before it packs anything", async () => {
  const box = fixture(null);
  try {
    for (const teamId of [0, -1, 1.5, Number.NaN, "9", null, undefined]) {
      const calls = [];
      const { service } = serviceFor(box, signedOutClient(calls));
      await assert.rejects(
        () => service.publish({ workflowId: "my-skill", teamId }),
        `the publish accepted teamId ${JSON.stringify(teamId)} as a real team`,
      );
      assert.deepEqual(calls, [], `teamId ${JSON.stringify(teamId)} still reached the account RPC`);
    }
  } finally {
    box.dispose();
  }
});

test("publish refuses a workflow id that names nothing in the library", async () => {
  const box = fixture(null);
  try {
    const calls = [];
    const { service } = serviceFor(box, signedOutClient(calls));
    for (const workflowId of ["", "no-such-skill", "plugin-6161-borrowed", undefined, null]) {
      await assert.rejects(
        () => service.publish({ workflowId, teamId: 9 }),
        `the publish accepted workflowId ${JSON.stringify(workflowId)}`,
      );
    }
    assert.deepEqual(calls, [], "an unknown workflow id still reached the account RPC");
  } finally {
    box.dispose();
  }
});

test("resync and unpublish refuse a skill published by another account", async () => {
  const box = fixture(null);
  try {
    const calls = [];
    const { service } = serviceFor(box, signedOutClient(calls));
    await assert.rejects(
      () => service.resync({ workflowId: "plugin-6161-borrowed" }),
      "resync accepted a skill from a plugin the signed-in account did not publish",
    );
    await assert.rejects(
      () => service.unpublish({ workflowId: "plugin-6161-borrowed" }),
      "unpublish accepted a skill from a plugin the signed-in account did not publish",
    );
    assert.deepEqual(
      calls,
      [],
      "a skill owned by another account still reached an account RPC; the ownership check is the only thing between a stale index and someone else's marketplace",
    );
  } finally {
    box.dispose();
  }
});

test("resync and unpublish refuse when the index does not know who is signed in", () => {
  // This is the state a pass that could not answer "who am I" leaves behind, and it
  // is the only thing standing between a failed GetMe and this build claiming
  // someone else's plugin. The record still carries its real publisher id; the index
  // simply has no identity to compare it against.
  //
  // Note the index is never allowed to reach this state with a stale id in it —
  // `SandPluginSkillsService.runPass` writes `loaded.currentUserId ?? null`, proved
  // in tests/plugin-skills-current-user-id-carried-over.test.mjs.
  const box = fixture(null);
  try {
    const service = serviceFor(box, signedOutClient([])).service;
    assert.equal(
      service.options.pluginSkills.currentIndex().currentUserId,
      null,
      "the fixture must carry no identity, or this proves nothing",
    );
    // Called through `service`, not destructured off it: a detached method has no
    // `this` and throws `Cannot read properties of undefined (reading 'options')`,
    // which satisfies `assert.throws` for entirely the wrong reason.
    assert.throws(
      () => service.requirePublishedPluginSkill("plugin-6161-borrowed"),
      "with no identity in the index, a plugin published by user 4242 was accepted as this build's own, so `unpublish` would have offered to remove it from someone else's team marketplace",
    );
    assert.throws(
      () => service.requirePublishedPluginSkill("plugin-6161-borrowed"),
      "the second call took a different path, so the refusal is not stable across repeats",
    );
  } finally {
    box.dispose();
  }
});

test("no repack path escapes the skills root, whatever the plugin put in the index", async () => {
  const box = fixture(null);
  try {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "grok-repack-"));
    try {
      // The path helper itself is NOT a guard. `skillsRootRelativePath` is a pure
      // string transform: it strips a leading `skills/`, and `path.dirname("SKILL.md")`
      // is `"."`, so a skill sitting at the plugin root comes back as `"."`. The
      // safety property therefore belongs to `synthesizeSkillPluginDir`, which is
      // where every repack actually goes.
      assert.equal(
        skillsRootRelativePath("skills/foo/SKILL.md"),
        "foo",
        "the helper stopped stripping the leading skills/ segment, so every repack would nest one level too deep",
      );
      assert.equal(
        skillsRootRelativePath("SKILL.md"),
        ".",
        "the helper now rejects a plugin-root skill on its own, which is fine either way — this test pins what it actually does, not what it should do",
      );
      assert.throws(
        () => skillsRootRelativePath("skills/SKILL.md"),
        "a skill directly under the skills root produced a path the packer cannot use",
      );

      const source = path.join(workDir, "source-skill");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "SKILL.md"), "---\nname: X\n---\n\nbody\n");

      for (const relativePath of ["..", "../..", "../../evil", "a/../../b", "."]) {
        await assert.rejects(
          () => synthesizeSkillPluginDir({ skills: [{ dir: source, relativePath }], targetDir: path.join(workDir, `out-${relativePath.replace(/\W/g, "_")}`), pluginName: "p" }),
          `the packer accepted the repack path ${JSON.stringify(relativePath)}, which resolves outside the plugin's own skills directory`,
        );
      }
      await assert.rejects(
        () => synthesizeSkillPluginDir({ skills: [{ dir: source, relativePath: "C:\\Windows\\System32" }], targetDir: path.join(workDir, "out-abs"), pluginName: "p" }),
        "the packer accepted an absolute repack path",
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    box.dispose();
  }
});

test("publishableTeams drops teams the account is not a direct member of", () => {
  const teams = publishableTeams({
    teams: [
      { id: 1, isDirectMember: true, name: "Mine" },
      { id: 2, isDirectMember: false, name: "Someone else's" },
      { id: 0, isDirectMember: true, name: "Zero id" },
      { id: -3, isDirectMember: true, name: "Negative id" },
    ],
  });
  assert.deepEqual(
    teams,
    [{ teamId: 1, name: "Mine" }],
    "a team the account is not a direct member of, or whose id is not positive, was offered as a publish target",
  );
});

test("a failed publish does not leave staged plugin directories behind", async () => {
  const box = fixture(null);
  try {
    const before = readdirSync(os.tmpdir()).filter((name) => name.startsWith("sand-publish-skill-")).length;
    const calls = [];
    const { service } = serviceFor(box, signedOutClient(calls));
    await service.publish({ workflowId: "my-skill", teamId: 9 }).catch(() => {});
    const after = readdirSync(os.tmpdir()).filter((name) => name.startsWith("sand-publish-skill-")).length;
    assert.equal(
      after,
      before,
      "the staging directory for a publish that failed was left in the temp folder, carrying a full copy of the skill",
    );
    assert.equal(existsSync(box.pluginSkillFile), true, "the fixture's installed plugin file was disturbed by an unrelated publish attempt");
  } finally {
    box.dispose();
  }
});
