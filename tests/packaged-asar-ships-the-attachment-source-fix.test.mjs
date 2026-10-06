import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The drive-path correction was proved against a bundle, and the bundle it proved
 * against was not the one the application loads.
 *
 * `tests/packaged-attachment-source-accepts-a-windows-drive-path.test.mjs` reads
 * `.build/fidelity/app/dist/electron-main/main.cjs`. The application does not read
 * that file. `scripts/package-windows.mjs:42` calls `buildFidelityReconstructedAsar()`,
 * packs it, and `scripts/package-windows.mjs:76` copies the result over
 * `dist\Grok Bot 0.18 Reconstructed\resources\app.asar` — and Electron loads
 * `dist/electron-main/main.cjs` out of that archive. A stale package therefore
 * ships a bundle the suite has never looked at, and every bundle-level assertion
 * in the repository goes green on it.
 *
 * Measured on this machine, both directions, so the claim is a number and not a
 * story:
 *
 *  - `src/app/dist/electron-main/main.cjs` — 18,280,431 bytes, written 03.10,
 *    carries NO `WINDOWS_DRIVE_ABSOLUTE`. It still answers `null` for
 *    `C:\...\photo.png`, i.e. it is the uncorrected function. It is the pinned
 *    payload `build-asar.mjs:178` copies into a stage, which is exactly why it is
 *    worth naming: it looks like the shipped artifact and it is not.
 *  - `.build/fidelity/app/dist/electron-main/main.cjs` — 12,928,706 bytes, written
 *    06.10 01:38, carries the correction.
 *  - `dist\Grok Bot 0.18 Reconstructed\resources\app.asar` → `dist/electron-main/main.cjs`
 *    — 12,928,706 bytes, BYTE-IDENTICAL to the fidelity bundle, carries the
 *    correction. This is the file the application loads.
 *
 * So the fix does reach the shipped bytes today. This file is what keeps that true:
 * it reads the archive, runs the same acceptance battery against the function it
 * contains, and fails if the archive and the fidelity bundle ever drift apart.
 *
 * It reads `app.asar` directly rather than asserting a relationship between two
 * build outputs, because a relationship between two outputs is exactly the kind of
 * claim that stays true after one of them stops being what ships.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const packagedAsar = path.join(repoRoot, "dist", "Grok Bot 0.18 Reconstructed", "resources", "app.asar");
const fidelityBundle = path.join(repoRoot, ".build", "fidelity", "app", "dist", "electron-main", "main.cjs");
const pinnedPayload = path.join(repoRoot, "src", "app", "dist", "electron-main", "main.cjs");

/** The archive entry Electron actually loads, spelled the way @electron/asar wants it. */
const ELECTRON_MAIN_ENTRY = ["dist", "electron-main", "main.cjs"].join(path.sep);

const WINDOWS_DRIVE_PATH = "C:\\Users\\user\\AppData\\Local\\GrokBotLocalBox\\agents\\bfc58d14\\attachments\\def17206d.jpg";

/**
 * Lifts `posixPathFromFileUrl` and `normalizeAttachmentSource` out of a bundle and
 * runs them. `new Function` is a scope of its own, so the correction's
 * module-scope `var WINDOWS_DRIVE_ABSOLUTE` has to be carried across by hand —
 * the sibling test documents what happens when it is not: a `ReferenceError`
 * against a correct bundle, which reads as a product failure and is not one.
 */
function normalizerFrom(bundleText) {
  const extract = (name) => {
    const start = bundleText.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `the bundle defines no ${name}, so this file cannot see what it is guarding`);
    let index = bundleText.indexOf("{", start);
    let depth = 0;
    for (; index < bundleText.length; index += 1) {
      if (bundleText[index] === "{") depth += 1;
      else if (bundleText[index] === "}") {
        depth -= 1;
        if (depth === 0) { index += 1; break; }
      }
    }
    return bundleText.slice(start, index);
  };
  const declaration = (name) => {
    const match = new RegExp(String.raw`(^|\n)(var|let|const) ${name} = [^\n]*;`).exec(bundleText);
    assert.notEqual(
      match,
      null,
      `${name} is read by the extracted function but declared nowhere at module scope, so this harness cannot execute it`,
    );
    return match[0].trim();
  };

  const body = `${extract("posixPathFromFileUrl")}\n${extract("normalizeAttachmentSource")}`;
  const moduleScope = body.includes("WINDOWS_DRIVE_ABSOLUTE") ? [declaration("WINDOWS_DRIVE_ABSOLUTE")] : [];
  // eslint-disable-next-line no-new-func
  return new Function(`${moduleScope.join("\n")}\n${body}\nreturn normalizeAttachmentSource;`)();
}

/** The acceptance battery, stated once. */
function assertDrivePathIsAccepted(normalizer, where) {
  assert.equal(
    normalizer(WINDOWS_DRIVE_PATH),
    WINDOWS_DRIVE_PATH,
    `${where}: normalizeAttachmentSource answered null for a path the host stores, so the card renders "Image unavailable"`,
  );
  assert.equal(
    normalizer("d:/agents/a/attachments/photo.png"),
    "d:/agents/a/attachments/photo.png",
    `${where}: a forward-slash drive path is refused`,
  );
  assert.equal(
    normalizer("https://example.com/photo.png"),
    null,
    `${where}: a remote URL is read as a local file, which is a hole the correction was never meant to open`,
  );
  assert.equal(
    normalizer("C:photo.png"),
    null,
    `${where}: a drive-relative path is accepted, which is not an absolute path`,
  );
}

test("the pinned payload is still the uncorrected function, and the archive is not it", (t) => {
  // The control that gives the rest of this file its meaning. If this ever passes
  // as "corrected", the pinned tree was rebuilt and the two bundles have stopped
  // being distinguishable — at which point the identity assertion below is the
  // only thing still doing work.
  if (!existsSync(pinnedPayload)) return t.skip("src/app/dist is not hydrated on this checkout");
  const text = readFileSync(pinnedPayload, "utf8");
  assert.equal(
    text.includes("WINDOWS_DRIVE_ABSOLUTE"),
    false,
    "src/app/dist/electron-main/main.cjs now carries the correction, so this file's control case needs rewriting before its other tests mean anything",
  );
});

test("the archive the application loads carries the corrected attachment source", (t) => {
  if (!existsSync(packagedAsar)) {
    return t.skip(
      `no packaged application at ${path.relative(repoRoot, packagedAsar)}; run "npm run package" to guard the shipped bytes. The suite as it stands would go green on a stale package, which is the whole reason this file exists.`,
    );
  }

  let shipped;
  try {
    shipped = asar.extractFile(packagedAsar, ELECTRON_MAIN_ENTRY);
  } catch (error) {
    assert.fail(`${ELECTRON_MAIN_ENTRY} is not in ${path.relative(repoRoot, packagedAsar)}: ${error && error.message}`);
  }
  assert.ok(shipped.byteLength > 0, "the archive entry is empty, so the application would load nothing at all");

  assertDrivePathIsAccepted(normalizerFrom(shipped.toString("utf8")), "the shipped app.asar");

  // The archive and the bundle the sibling test guards must be the same bytes.
  // Without this, a rebuild could fix the archive and leave the sibling guarding
  // a stale file, or the other way round, and neither suite would notice.
  if (existsSync(fidelityBundle)) {
    const guarded = readFileSync(fidelityBundle);
    assert.equal(
      Buffer.compare(shipped, guarded),
      0,
      `the packaged app.asar and ${path.relative(repoRoot, fidelityBundle)} have drifted apart (${shipped.byteLength} vs ${guarded.byteLength} bytes), so one of the two bundle guards is reading a file the application does not load`,
    );
  }
});

test("the shipped archive is not the pinned payload, which is the reason the sibling test was not enough", (t) => {
  if (!existsSync(packagedAsar)) return t.skip("no packaged application on this checkout");
  if (!existsSync(fidelityBundle)) return t.skip("no fidelity build output on this checkout");
  const shipped = asar.extractFile(packagedAsar, ELECTRON_MAIN_ENTRY);
  const guarded = readFileSync(fidelityBundle);
  const pinned = existsSync(pinnedPayload) ? readFileSync(pinnedPayload) : null;

  assert.equal(
    pinned === null ? Buffer.compare(shipped, guarded) === 0 : Buffer.compare(shipped, pinned) !== 0,
    true,
    "the application is loading src/app/dist/electron-main/main.cjs, which does not carry the correction, so every image in the app is broken no matter what the source says",
  );
});

test("this file can still execute a bundle that does carry the correction", async () => {
  // The harness, not the product, is under test here. A lift-and-run harness that
  // cannot follow a module-scope reference fails as a product failure, and it
  // fails only against the corrected function — the one this repository wants to
  // ship. Building the corrected source with the same bundler puts it in front of
  // the harness here instead.
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-asar-harness-"));
  try {
    const entry = path.join(directory, "entry.ts");
    const outfile = path.join(directory, "main.cjs");
    writeFileSync(
      entry,
      [
        `export { normalizeAttachmentSource } from ${JSON.stringify(path.join(repoRoot, "source", "electron-main", "attachments", "attachments.ts"))};`,
        `export { posixPathFromFileUrl } from ${JSON.stringify(path.join(repoRoot, "source", "shared", "node", "paths.ts"))};`,
        "",
      ].join("\n"),
      "utf8",
    );
    await build({ entryPoints: [entry], outfile, bundle: true, format: "cjs", platform: "node", target: "node22", logLevel: "silent", absWorkingDir: repoRoot });
    assertDrivePathIsAccepted(normalizerFrom(readFileSync(outfile, "utf8")), "a freshly built bundle of the corrected source");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});