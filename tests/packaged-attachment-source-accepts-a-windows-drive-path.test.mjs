import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * A photo attached in the composer rendered as "Image unavailable" while the
 * file was on disk and the host could read it back over the gateway as HTTP 200.
 *
 * What broke: `source/electron-main/attachments/attachments.ts` was corrected so
 * that a native Windows absolute path survives normalisation, but the correction
 * never reached a built artifact. `normalizeAttachmentSource` in the bundle that
 * `npm run build` produces still asks `new URL(source)` for a `file:` protocol and
 * still answers `null` for anything else, so every attachment this product creates
 * — and every one is a `node:path.join` result, hence a drive path — was refused
 * before anything tried to open the file.
 *
 * Why nothing noticed: the only test for the function
 * (`windows-attachment-source-is-not-a-url-scheme.test.mjs`) builds
 * `source/electron-main/attachments/attachments.ts` with esbuild and therefore
 * proves the source is correct. It never looks at a bundle. The source test went
 * green at 21:06 on 05.10.2026; the bundle that ships was written at 15:50 the
 * same day, five hours earlier, and stayed that way. A green source test and a
 * broken app is exactly what a source-only guard cannot see.
 *
 * Measured on a live box before the fix: a 232109-byte JPEG committed at
 * `<root>/agents/<id>/attachments/<sha256>.jpg` was answered `null` by
 * `normalizeAttachmentSource`, while `POST /api/readAttachmentImage` for the
 * identical path answered HTTP 200 with a 309503-character data URL. The
 * renderer's media resolver turns `null` into `{ status: "missing" }` and the
 * transcript card renders that as "Image unavailable".
 *
 * What this now proves: the harness can execute the corrected source at all, the bundle the
 * app actually runs accepts a drive path, and the inputs the guard refused for a reason of
 * its own are still refused. The last two assertions exist so that this test cannot be
 * satisfied by widening the guard — every attachment source on this platform is a drive
 * path, so "accept more" and "accept the right thing" have to be told apart.
 *
 * WHY THE HARNESS ITSELF IS UNDER TEST. This file used to lift `posixPathFromFileUrl` and
 * `normalizeAttachmentSource` out of the bundle and run them through `new Function`, which
 * is a scope of its own with no module scope of the bundle behind it. That was enough for
 * the uncorrected function, whose whole body called only its parameter. The correction
 * introduced a module-scope `var WINDOWS_DRIVE_ABSOLUTE`, so the same harness threw
 * `ReferenceError: WINDOWS_DRIVE_ABSOLUTE is not defined` against a bundle of the corrected
 * source — measured, not inferred. The file therefore could not have gone green after the
 * rebuild that fixes the photo, which means `npm run check` would have failed and with it
 * `npm run package`, and the correction for the user's photo would never have shipped. The
 * first test below builds the corrected source with the same bundler the build uses and
 * runs this harness against it, so that a harness which cannot follow a module-scope
 * reference fails here instead of after the rebuild it would have blocked.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The bundle under test defaults to the one `npm run build` produces. The override
// exists so that the correction can be shown to make this test pass without editing
// a build artifact: point it at a patched copy in a temp directory and the first
// test goes green, which is what proves the assertion measures the defect and not
// something else. It is never set in an ordinary run.
const bundle = process.env.GROK_ATTACHMENT_BUNDLE
  ? path.resolve(process.env.GROK_ATTACHMENT_BUNDLE)
  : path.join(repoRoot, ".build", "fidelity", "app", "dist", "electron-main", "main.cjs");

/**
 * A bundle of the corrected source, built exactly the way esbuild builds the shipped one.
 *
 * The harness above reads a bundle, so nothing about it is proved until it is run against one.
 * The build it reads is written by `npm run build`, which this session may not run, so the
 * first test below stayed red for the whole session while this file looked finished — and the
 * reason it was red turned out to be the harness, not the product. Building the two source
 * files with the same bundler the build uses puts the corrected `normalizeAttachmentSource`
 * in front of the harness here, so a harness that cannot follow a module-scope reference
 * fails inside this file instead of being discovered after the rebuild it would have blocked.
 */
async function buildCorrectedSourceBundle() {
  const outdir = mkdtempSync(path.join(os.tmpdir(), "grok-attachment-bundle-"));
  const entry = path.join(outdir, "entry.ts");
  const outfile = path.join(outdir, "main.cjs");
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
  return { outfile, dispose: () => rmSync(outdir, { recursive: true, force: true }) };
}

function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `the bundle no longer defines ${name}, so this test can no longer see what it is guarding`);
  let index = text.indexOf("{", start);
  let depth = 0;
  for (; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) { index += 1; break; }
    }
  }
  return text.slice(start, index);
}

/** Names every JavaScript scope already has, so they are not missing dependencies. */
const HARNESS_GLOBALS = new Set([
  "URL", "await", "break", "case", "catch", "const", "continue", "decodeURI", "decodeURIComponent",
  "default", "do", "else", "encodeURI", "encodeURIComponent", "false", "finally", "for", "function",
  "if", "let", "new", "null", "of", "return", "switch", "throw", "true", "try", "typeof", "undefined",
  "var", "void", "while", "Error", "String", "Boolean", "Number", "Object", "Array",
]);

/**
 * Names the extracted source uses but does not declare for itself.
 *
 * These are exactly the references that broke this harness. `normalizeAttachmentSource`
 * reads the module-scope `var WINDOWS_DRIVE_ABSOLUTE` that esbuild hoists next to it, and
 * `new Function` has no access to that module scope, so calling the function raised
 * `ReferenceError: WINDOWS_DRIVE_ABSOLUTE is not defined`. Measured against a real esbuild
 * bundle of the corrected source before this was handled, not reasoned about.
 *
 * Property names are removed before the scan, because `url.protocol` is a member of a
 * local and not a dependency. That removal is the difference between this finding one
 * missing `var` and reporting `protocol`, which nothing declares anywhere.
 */
function freeIdentifiers(source) {
  const code = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, ".");

  const declared = new Set(HARNESS_GLOBALS);
  for (const match of code.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of code.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const parameter of match[1].split(",")) declared.add(parameter.trim());
  }

  const free = new Set();
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (!declared.has(match[0])) free.add(match[0]);
  }
  return [...free];
}

/**
 * The bundle's own declaration of `name`, sliced out verbatim.
 *
 * esbuild emits a hoisted `var` on one line, so a single-line declaration is the whole
 * statement. A name with no declaration is a hard failure rather than a `ReferenceError`
 * thrown later from inside the function body, because "the harness lost a dependency" and
 * "the product is wrong" have to be told apart by the message.
 */
function extractModuleDeclaration(text, name) {
  const pattern = new RegExp(String.raw`(^|\n)(var|let|const) ${name} = [^\n]*;`);
  const match = pattern.exec(text);
  if (match == null) {
    throw new Error(`${name} is used by the extracted functions but the bundle declares no ${name} at module scope, so this harness cannot execute it`);
  }
  return match[0].trim();
}

function loadBundledNormalizer(from = bundle) {
  let text;
  try {
    text = readFileSync(from, "utf8");
  } catch {
    return { normalizer: null, reason: `${from} is missing, so no bundle can be inspected. Run "npm run build" first.` };
  }
  const extracted = `${extractFunction(text, "posixPathFromFileUrl")}\n${extractFunction(text, "normalizeAttachmentSource")}`;
  const dependencies = freeIdentifiers(extracted).map((name) => extractModuleDeclaration(text, name));
  const source = `${dependencies.join("\n")}\n${extracted}\nreturn normalizeAttachmentSource;`;
  // eslint-disable-next-line no-new-func
  return { normalizer: new Function(source)(), reason: null, dependencies };
}

test("the harness can execute the corrected source it exists to guard", async () => {
  const built = await buildCorrectedSourceBundle();
  try {
    const { normalizer, reason, dependencies } = loadBundledNormalizer(built.outfile);
    assert.notEqual(normalizer, null, reason ?? "");

    // The proof that the harness, not only the product, changed. A harness that lifts two
    // functions out of a bundle and runs them in a scope of its own has to carry every
    // module-scope declaration those functions read. It did not: the corrected
    // `normalizeAttachmentSource` reads `WINDOWS_DRIVE_ABSOLUTE`, esbuild hoists that to a
    // `var` beside it, and the call raised `ReferenceError: WINDOWS_DRIVE_ABSOLUTE is not
    // defined` against a bundle of the corrected source. Measured before this file was
    // repaired; the call below is the same call and it answers.
    const drive = "C:\\Users\\user\\AppData\\Local\\GrokBotLocalBox\\agents\\bfc58d14\\attachments\\def17206d.jpg";
    assert.equal(
      normalizer(drive),
      drive,
      "the corrected source does not accept the path the host stores, so the first test could never have gone green",
    );
    assert.ok(
      dependencies.some((line) => /WINDOWS_DRIVE_ABSOLUTE/.test(line)),
      `the harness lifted no module-scope declaration, so it answered only by luck: ${JSON.stringify(dependencies)}`,
    );
    assert.equal(
      normalizer("https://example.com/photo.png"),
      null,
      "the corrected source reads a remote URL as a local file",
    );
    assert.equal(
      normalizer("C:photo.png"),
      null,
      "the corrected source accepts a drive-relative path, which is not an absolute path",
    );
  } finally {
    built.dispose();
  }
});

test("the bundle the app runs accepts a native Windows path as an attachment source", () => {
  const { normalizer, reason } = loadBundledNormalizer();
  assert.notEqual(normalizer, null, reason ?? "");

  const drive = "C:\\Users\\user\\AppData\\Local\\GrokBotLocalBox\\agents\\bfc58d14\\attachments\\def17206d.jpg";
  assert.equal(
    normalizer(drive),
    drive,
    "normalizeAttachmentSource answered null for a path the host stored, so the card renders \"Image unavailable\"",
  );

  assert.equal(
    normalizer("C:\\agents\\a\\attachments\\photo.png"),
    "C:\\agents\\a\\attachments\\photo.png",
    "a backslash Windows path is refused by the bundle",
  );
  assert.equal(
    normalizer("d:/agents/a/attachments/photo.png"),
    "d:/agents/a/attachments/photo.png",
    "a forward-slash drive path is refused by the bundle",
  );
});

test("the bundle still refuses the sources it refused before the correction", () => {
  const { normalizer, reason } = loadBundledNormalizer();
  assert.notEqual(normalizer, null, reason ?? "");

  assert.equal(
    normalizer("https://example.com/photo.png"),
    null,
    "the bundle reads a remote URL as a local file, which is a hole the correction was never meant to open",
  );
  assert.equal(
    normalizer("data:image/png;base64,AAAA"),
    null,
    "the bundle treats an inline data URL as a file path",
  );
  assert.equal(
    normalizer("C:photo.png"),
    null,
    "the bundle accepts a drive-relative path, which is not an absolute path",
  );
  assert.equal(
    normalizer(""),
    null,
    "the bundle answers something other than null for an empty source",
  );
  assert.equal(
    normalizer("/home/box/sand-data/agents/a/attachments/photo.png"),
    "/home/box/sand-data/agents/a/attachments/photo.png",
    "the bundle stopped passing through a POSIX absolute path, which no correction asked for",
  );
});
