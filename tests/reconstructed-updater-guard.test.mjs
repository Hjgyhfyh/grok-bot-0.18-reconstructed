import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  applyReconstructedUpdaterGuard,
  prepareReconstructedElectronMainArtifactFallback,
  reconstructedUpdaterGuard,
} from "../scripts/lib/build-asar.mjs";

const root = path.resolve(import.meta.dirname, "..");

// Every composition entry point ships the reconstructed updater lock, not just
// one of them. Counting the call sites is what keeps a fifth entry point from
// appearing unguarded.
const CLEAN_BUILD_ENTRY_POINTS = 4;

function prepareProductionActivationsCallSites(source) {
  return source
    .split("\n")
    .filter(line => line.includes("prepareProductionActivations(") && !line.includes("function prepareProductionActivations("));
}

test("reconstructed fallback and clean packaging share one idempotent service guard", async () => {
  const source = "console.log('electron-main');\n";
  const guarded = applyReconstructedUpdaterGuard(source);
  assert.equal(guarded, `${reconstructedUpdaterGuard}${source}`);
  assert.equal(applyReconstructedUpdaterGuard(guarded), guarded);
  assert.match(guarded, /SAND_DISABLE_UPDATES \?\?= "1"/);
  assert.match(guarded, /SAND_DISABLE_SENTRY \?\?= "1"/);
  assert.match(guarded, /SAND_DISABLE_TELEMETRY \?\?= "1"/);

  const fallbackFixture = [
    "var isSandLabBuild2 = appPackageJson.sandLab === true;",
    "var isPrimaryInstance = !import_electron51.app.isPackaged || import_electron51.app.requestSingleInstanceLock();",
  ].join("\n");
  assert.ok(prepareReconstructedElectronMainArtifactFallback(fallbackFixture).startsWith(reconstructedUpdaterGuard));

  const cleanBuildSource = await readFile(path.join(root, "scripts", "clean-build.mjs"), "utf8");
  assert.match(cleanBuildSource, /fidelityRuntimeComposition, \{ reconstructedPackage: true \}/);
});

test("every prepareProductionActivations call site passes the reconstructed-package flag", async () => {
  const cleanBuildSource = await readFile(path.join(root, "scripts", "clean-build.mjs"), "utf8");
  const callSites = prepareProductionActivationsCallSites(cleanBuildSource);
  assert.equal(callSites.length, CLEAN_BUILD_ENTRY_POINTS);
  for (const callSite of callSites) {
    assert.match(callSite, /\{ reconstructedPackage: true \}/, `unguarded activation: ${callSite.trim()}`);
  }

  // Dropping the flag from any one entry point has to fail the assertion above,
  // which is the defect this test closes.
  for (const [index, callSite] of callSites.entries()) {
    const weakened = cleanBuildSource.replace(callSite, callSite.replace("{ reconstructedPackage: true }", "{}"));
    assert.notEqual(weakened, cleanBuildSource);
    const weakenedSites = prepareProductionActivationsCallSites(weakened);
    assert.equal(weakenedSites.length, CLEAN_BUILD_ENTRY_POINTS);
    const offending = weakenedSites.filter(site => !/\{ reconstructedPackage: true \}/.test(site));
    assert.equal(offending.length, 1, `call site ${index + 1} lost the reconstructed-package flag`);
  }
});
