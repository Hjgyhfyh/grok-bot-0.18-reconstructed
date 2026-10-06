/**
 * "Import local skills" is a one-shot port, but it re-imports every time it is
 * pressed, and every source lands as a brand-new SKILL folder.
 *
 * WHAT BROKE. `FileWorkflowStore.portLocalSkills` walks
 * `discoverLocalSkillFiles(homeDir, cwd)` and calls `importLiveSource` on each
 * hit. `importLiveSource` calls `library.create`, and `GlobalWorkflowLibrary.create`
 * allocates the folder id with `uniqueId(name)`, which appends `-2`, `-3`, … the
 * moment the base slug is taken. Nothing on the path compares the new record's
 * `sourceRef` against what is already in the library, so the second press of the
 * same button produces `claude-memory-2`, `agents-memory-2`, `rule-one-2`, and so
 * on — every entry a second, byte-identical live pointer at a file the user only
 * has one of.
 *
 * MEASURED, on this fixture of five local files under one working directory and
 * one home directory: one press left 5 library folders, two presses left 10,
 * thirty presses left 100 — which is `WORKFLOW_MAX_PER_AGENT`, the same cap
 * `create` consults. From that point on the user cannot add a skill of their own,
 * and `create` refuses silently by returning `null`.
 *
 * WHY NOTHING NOTICED. The first call answers
 * `{"imported":[…],"skipped":[]}`, which is exactly what a caller wants to see, so
 * the single-call path is indistinguishable from a correct one. The surface where
 * the duplicate becomes visible is `workflows`: the list comes back with twice the
 * rows, all with the same `name`, and nothing in the reply says "these were already
 * there".
 *
 * WHAT THESE TESTS PROVE. Calling the real `FileWorkflowStore.portLocalSkills`
 * against a real sandbox root twice leaves the library with one folder per source,
 * not two; the second pass reports the sources as already present rather than as
 * freshly imported; thirty presses stay at five; and a real skill the user writes
 * afterwards is still accepted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-port-local-skills-"));
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
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names)
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "workflows", "workflow-store.ts"],
]);
const { FileWorkflowStore, discoverLocalSkillFiles } = loaded["workflow-store.mjs"];

test.after(() => dispose());

/** A sandbox root with one agent, plus a working directory and a home directory. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-port-skills-root-"));
  const sandRoot = path.join(root, "sand");
  const agentDir = path.join(sandRoot, "agents", "agent-1");
  const globalDir = path.join(sandRoot, "workflows");
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  for (const dir of [agentDir, globalDir, home, cwd]) mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(cwd, "CLAUDE.md"), "# Project rules\n\nAlways use path.join.\n");
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Agent notes\n\nBe terse.\n");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  writeFileSync(path.join(cwd, ".claude", "CLAUDE.md"), "# Claude notes\n\nPrefer small diffs.\n");
  mkdirSync(path.join(cwd, ".cursor", "rules"), { recursive: true });
  writeFileSync(path.join(cwd, ".cursor", "rules", "style.mdc"), "Always run the tests.\n");
  writeFileSync(path.join(home, "CLAUDE.md"), "# Home rules\n\nNo secrets in code.\n");

  return {
    root,
    store: new FileWorkflowStore(agentDir, globalDir),
    home,
    cwd,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Identity of a library pass: id, display name and the file it points at. */
function shape(records) {
  return records
    .map((record) => [record.id, record.name, record.sourceRef].join("|"))
    .sort();
}

test("pressing 'import local skills' twice must not duplicate the library", () => {
  const box = fixture();
  try {
    const discovered = discoverLocalSkillFiles(box.home, box.cwd);
    assert.equal(
      discovered.length,
      5,
      "the fixture must present five distinct local skill files before any import happens",
    );

    const first = box.store.portLocalSkills(box.home, box.cwd);
    assert.equal(
      first.imported.length,
      5,
      "the first press should import every discovered local skill file",
    );
    assert.deepEqual(
      first.skipped,
      [],
      "nothing should be skipped on a first press when every source is readable",
    );

    const afterFirst = box.store.library.list();
    assert.equal(afterFirst.length, 5, "one library folder per local skill file after one press");

    box.store.portLocalSkills(box.home, box.cwd);

    const afterSecond = box.store.library.list();
    assert.equal(
      afterSecond.length,
      afterFirst.length,
      "a second press of 'import local skills' created extra library folders that point at the same files the first press already imported",
    );
    assert.deepEqual(
      shape(afterSecond),
      shape(afterFirst),
      "the second press changed the library at all: an id, a name or a source pointer that did not exist after the first press appeared after the second",
    );

    const sourceRefs = afterSecond.map((record) => record.sourceRef).sort();
    assert.equal(
      new Set(sourceRefs).size,
      sourceRefs.length,
      "two library folders point at the same source file, so editing the source silently updates both",
    );
  } finally {
    box.dispose();
  }
});

test("the second press must say the sources were already present instead of reporting them imported", () => {
  const box = fixture();
  try {
    box.store.portLocalSkills(box.home, box.cwd);
    const second = box.store.portLocalSkills(box.home, box.cwd);
    assert.equal(
      second.imported.length,
      0,
      "the second press told the user it imported skills it had already imported on the first press",
    );
    assert.equal(
      second.skipped.length,
      5,
      "every already-present source has to be accounted for, or the reply hides work it did not do",
    );
    assert.deepEqual(
      [...new Set(second.skipped.map((entry) => entry.reason))],
      ["already imported"],
      "a source that is merely a duplicate is reported as 'could not link', which tells the user their file is broken when the file is fine",
    );
  } finally {
    box.dispose();
  }
});

test("repeated presses must stay bounded instead of walking into WORKFLOW_MAX_PER_AGENT", () => {
  const box = fixture();
  try {
    for (let pass = 0; pass < 30; pass += 1) box.store.portLocalSkills(box.home, box.cwd);
    const grown = box.store.library.list();
    assert.equal(
      grown.length,
      5,
      `thirty presses of the same button grew the library to ${grown.length} folders; every one of them is a live pointer at one of five files`,
    );
  } finally {
    box.dispose();
  }
});

test("a readable rule file with no usable name is not reported as a broken file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-port-skills-nameless-"));
  try {
    const sandRoot = path.join(root, "sand");
    const agentDir = path.join(sandRoot, "agents", "agent-1");
    const globalDir = path.join(sandRoot, "workflows");
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    for (const dir of [agentDir, globalDir, home, cwd]) mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(path.join(cwd, ".cursor", "rules", "style.mdc"), "Always run the tests.\n");
    // A dotfile that is nothing but an extension: the rules regex matches it, and
    // stripping the extension leaves an empty fallback name.
    writeFileSync(path.join(cwd, ".cursor", "rules", ".md"), "A readable rule with no name.\n");
    // Not markdown, so not discovered at all.
    writeFileSync(path.join(cwd, ".cursor", "rules", "notes.txt"), "ignored\n");
    // Nested, so not discovered at all.
    mkdirSync(path.join(cwd, ".cursor", "rules", "nested"), { recursive: true });
    writeFileSync(path.join(cwd, ".cursor", "rules", "nested", "deep.md"), "nested\n");

    const discovered = discoverLocalSkillFiles(home, cwd);
    assert.equal(discovered.length, 2, "only the two top-level markdown rule files are discoverable");

    const store = new FileWorkflowStore(agentDir, globalDir);
    const result = store.portLocalSkills(home, cwd);
    assert.equal(result.imported.length, 1, "the named rule file imports");
    assert.deepEqual(
      result.skipped.map((entry) => entry.reason),
      ["no usable name"],
      "a file that was read fine but has no usable name is reported as 'could not link', which tells the user their file is broken when it is perfectly readable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery does not offer the same file twice when the working directory is the home directory", () => {
  const box = fixture();
  try {
    const discovered = discoverLocalSkillFiles(box.cwd, box.cwd);
    assert.equal(
      new Set(discovered.map((entry) => entry.path)).size,
      discovered.length,
      "a build launched from the user's own profile — which is what happens when the host starts with the profile as its working directory — discovers the same CLAUDE.md twice",
    );
    const first = box.store.portLocalSkills(box.cwd, box.cwd);
    const second = box.store.portLocalSkills(box.cwd, box.cwd);
    assert.equal(
      box.store.library.list().length,
      first.imported.length,
      "the same file was imported under two different ids, which is the repeat-press defect reached by a different route",
    );
    assert.equal(second.imported.length, 0, "the same file was imported again on the second pass");
  } finally {
    box.dispose();
  }
});

test("a skipped source is named by a path that is actually reachable on this platform", () => {
  const box = fixture();
  try {
    const result = box.store.portLocalSkills(box.home, box.cwd);
    const second = box.store.portLocalSkills(box.home, box.cwd);
    for (const entry of second.skipped) {
      assert.doesNotMatch(
        entry.source,
        /[A-Za-z]:\\[^\s]*?\/[^\s]*$/,
        `the label ${JSON.stringify(entry.source)} mixes a backslash Windows root with a forward-slash tail, so it names a path no Windows API call would resolve`,
      );
    }
    assert.ok(
      result.imported.length > 0,
      "the fixture must import at least one source, or there is no first-pass reply to compare against",
    );
  } finally {
    box.dispose();
  }
});

test("after repeated presses the user can still create a skill of their own", () => {
  const box = fixture();
  try {
    for (let pass = 0; pass < 30; pass += 1) box.store.portLocalSkills(box.home, box.cwd);
    const created = box.store.create({
      name: "Release notes",
      description: "Write the release notes.",
      body: "Collect merged pull requests since the last tag and group them by area.",
      trigger: null,
    });
    assert.notEqual(
      created,
      null,
      "the library was so full of duplicated local-skill pointers that `create` refused a real user skill; before the fix, twenty presses of the import button were enough to do this",
    );
  } finally {
    box.dispose();
  }
});
