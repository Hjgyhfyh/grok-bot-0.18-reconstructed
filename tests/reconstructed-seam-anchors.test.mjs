import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  prepareReconstructedElectronMainArtifactFallback,
  reconstructedUpdaterGuard,
} from "../scripts/lib/build-asar.mjs";

const root = path.resolve(import.meta.dirname, "..");

// The four upstream anchors the reconstruction rewrites. Each has to occur
// exactly once in the pinned payload: `String.replace` rewrites only the first
// match, so a duplicated statement used to leave the later copies unpatched and
// the build still passed, and `scripts/verify.mjs` re-derived from the same
// partially patched source and agreed with itself.
const RUNTIME_ANCHORS = [
  "var isSandLabBuild2 = appPackageJson.sandLab === true;",
  "var isPrimaryInstance = !import_electron51.app.isPackaged || import_electron51.app.requestSingleInstanceLock();",
];

const DEV_ANCHORS = [
  "var devToolsGate = createDevToolsGate({ isDevBuild: !import_electron51.app.isPackaged });",
  "registerDevWiring({\n    ipcMain: import_electron51.ipcMain,\n    isPackaged: import_electron51.app.isPackaged,",
];

function occurrences(source, needle) {
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

function fixture(anchors = [...RUNTIME_ANCHORS, ...DEV_ANCHORS]) {
  return ["var appPackageJson = readPackage();", ...anchors, "app.whenReady().then(main);"].join("\n");
}

test("an unambiguous anchor is patched at its single occurrence", () => {
  const source = fixture();
  for (const needle of [...RUNTIME_ANCHORS, ...DEV_ANCHORS]) {
    assert.equal(occurrences(source, needle), 1, `fixture anchor must be unique: ${needle}`);
  }

  for (const dev of [false, true]) {
    const patched = prepareReconstructedElectronMainArtifactFallback(source, { dev });
    assert.ok(patched.startsWith(reconstructedUpdaterGuard));
    const body = patched.slice(reconstructedUpdaterGuard.length);
    // The runtime seams ship in both builds; the dev seams only in a dev build.
    const consumed = dev ? [...RUNTIME_ANCHORS, ...DEV_ANCHORS] : RUNTIME_ANCHORS;
    const retained = dev ? [] : DEV_ANCHORS;
    for (const needle of consumed) {
      assert.equal(occurrences(body, needle), 0, `${dev ? "dev" : "release"} build left ${needle}`);
    }
    for (const needle of retained) {
      assert.equal(occurrences(body, needle), 1, `${dev ? "dev" : "release"} build dropped ${needle}`);
    }
    assert.match(body, /isSandLabBuild2 = appPackageJson\.sandLab === true \|\| process\.env\.GROK_BOT_RECONSTRUCTED_DEV === "1";/);
    assert.match(body, /var isPrimaryInstance = process\.env\.GROK_BOT_RECONSTRUCTED_DEV === "1" \|\| !import_electron51\.app\.isPackaged/);
    if (dev) {
      assert.match(body, /createDevToolsGate\(\{ isDevBuild: process\.env\.GROK_BOT_RECONSTRUCTED_DEV === "1" \|\|/);
      assert.match(body, /isPackaged: process\.env\.GROK_BOT_RECONSTRUCTED_DEV === "1" \? false :/);
    }
  }
});

test("a duplicated runtime anchor fails the build instead of half-patching it", () => {
  const duplicated = fixture([...RUNTIME_ANCHORS, RUNTIME_ANCHORS[0], RUNTIME_ANCHORS[1]]);
  assert.equal(occurrences(duplicated, RUNTIME_ANCHORS[0]), 2);
  for (const dev of [false, true]) {
    assert.throws(
      () => prepareReconstructedElectronMainArtifactFallback(duplicated, { dev }),
      /upstream anchor is ambiguous/,
    );
  }
});

test("a duplicated dev anchor fails the dev build", () => {
  const duplicated = fixture([...RUNTIME_ANCHORS, ...DEV_ANCHORS, DEV_ANCHORS[0]]);
  assert.equal(occurrences(duplicated, DEV_ANCHORS[0]), 2);
  // The release build never reaches the dev seams, so only the dev build fails.
  assert.doesNotThrow(() => prepareReconstructedElectronMainArtifactFallback(duplicated, { dev: false }));
  assert.throws(
    () => prepareReconstructedElectronMainArtifactFallback(duplicated, { dev: true }),
    /upstream anchor is ambiguous/,
  );
});

test("a missing anchor still reports that the upstream anchor changed", () => {
  const missing = fixture([RUNTIME_ANCHORS[1], ...DEV_ANCHORS]);
  assert.throws(
    () => prepareReconstructedElectronMainArtifactFallback(missing),
    /upstream anchor changed/,
  );
  assert.throws(
    () => prepareReconstructedElectronMainArtifactFallback(fixture(RUNTIME_ANCHORS), { dev: true }),
    /upstream anchor changed/,
  );
});

test("the pinned 0.18.0 payload holds each anchor exactly once", async t => {
  const artifact = path.join(root, "src", "app", "dist", "electron-main", "main.cjs");
  try {
    await access(artifact);
  } catch {
    t.skip(`no hydrated payload at ${artifact}`);
    return;
  }
  const source = await readFile(artifact, "utf8");
  for (const needle of [...RUNTIME_ANCHORS, ...DEV_ANCHORS]) {
    assert.equal(occurrences(source, needle), 1, `anchor drifted: ${needle}`);
  }
});