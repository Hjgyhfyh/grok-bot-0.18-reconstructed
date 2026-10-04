import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { archivedDmg, archivedSetup, dmgSha256, windowsSetupSha256 } from "../scripts/lib/config.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const archiveRoot = path.join(repositoryRoot, "research-archives", "original", "0.18.0");

const relativeToArchiveRoot = target => path.relative(archiveRoot, target).split(path.sep).join("/");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

test("preserved 0.18.0 installers match the exact public release inventory", async () => {
  const manifest = JSON.parse(await readFile(path.join(archiveRoot, "artifacts.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "product", "schemaVersion", "version"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, "Grok Bot");
  assert.equal(manifest.version, "0.18.0");
  assert.equal(manifest.artifacts.length, 2);

  for (const artifact of manifest.artifacts) {
    assert.deepEqual(
      Object.keys(artifact).sort(),
      ["architecture", "bytes", "path", "platform", "sha256", "sourceUrl"],
    );
    assert.match(artifact.path, /^(macos-arm64\/[^/]+\.dmg|windows-x64\/[^/]+\.exe)$/);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.match(artifact.sourceUrl, /^https:\/\/downloads\.cursor\.com\/grokbot\/stable\//);
    const file = path.join(archiveRoot, artifact.path);
    assert.ok(file.startsWith(`${archiveRoot}${path.sep}`));
    const metadata = await lstat(file);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.size, artifact.bytes, `${artifact.path} requires git lfs pull`);
    assert.equal(await sha256(file), artifact.sha256);
  }
});

test("bootstrap prefers the hash-pinned local archive before the network", async () => {
  const [attributes, manifest, bootstrap] = await Promise.all([
    readFile(path.join(repositoryRoot, ".gitattributes"), "utf8"),
    readFile(path.join(archiveRoot, "artifacts.json"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
  ]);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.dmg filter=lfs diff=lfs merge=lfs -text/);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.exe filter=lfs diff=lfs merge=lfs -text/);
  // The pinned identities are asserted against the archive inventory itself
  // rather than against a source regex in `config.mjs`, which the macOS/Windows
  // platform split made brittle: both platforms hydrate from a local artifact,
  // so what has to hold is that the pinned constants name those artifacts.
  const artifacts = JSON.parse(manifest).artifacts;
  const byPlatform = new Map(artifacts.map(artifact => [`${artifact.platform}/${artifact.architecture}`, artifact]));
  assert.deepEqual([...byPlatform.keys()].sort(), ["darwin/arm64", "win32/x64"]);

  const darwin = byPlatform.get("darwin/arm64");
  assert.equal(darwin.path, relativeToArchiveRoot(archivedDmg));
  assert.equal(darwin.sha256, dmgSha256);

  const win32 = byPlatform.get("win32/x64");
  assert.equal(win32.path, relativeToArchiveRoot(archivedSetup));
  assert.equal(win32.sha256, windowsSetupSha256);

  assert.match(bootstrap, /const archivedDigest = await sha256\(archivedDmg\)/);
  assert.match(bootstrap, /if \(archivedDigest !== dmgSha256\)/);
  assert.match(bootstrap, /await copyFile\(archivedDmg, cachedDmg\)/);
  // `indexOf` answers -1 for an absent needle and `-1 < N` is true, so the old
  // `indexOf(a) < indexOf(b)` comparison passed even when neither call was in the
  // file at all. Both call sites have to be located before they can be ordered.
  const localCopy = bootstrap.indexOf("await copyFile(archivedDmg, cachedDmg)");
  const networkFetch = bootstrap.indexOf("await fetch(dmgUrl");
  assert.ok(localCopy >= 0, "bootstrap-runtime.mjs must copy the pinned local archive");
  assert.ok(networkFetch >= 0, "bootstrap-runtime.mjs must still be able to download the DMG");
  assert.ok(localCopy < networkFetch, "the local archive must be preferred over the network");

  // The Windows branch has no DMG to mount, so it must reach the same
  // local-archive-first, hash-pinned decision through the setup executable.
  assert.match(bootstrap, /if \(!\(await exists\(archivedSetup\)\)\)/);
  assert.match(bootstrap, /if \(digest !== windowsSetupSha256\)/);
});
