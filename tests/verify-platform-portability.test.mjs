import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPackage, extractFile, listPackage } from "@electron/asar";

import { fromArchiveEntry, listArchiveFiles, toArchiveRelative } from "../scripts/lib/asar-paths.mjs";
import { readRendererExtensionChunks } from "../scripts/lib/macos-package-verification.mjs";
import {
  DARWIN_SYSTEM_TOOLS,
  SYSTEM_TOOLS,
  WINDOWS_SYSTEM_TOOLS,
  systemTool,
} from "../scripts/lib/system-tools.mjs";

const isWindowsHost = process.platform === "win32";
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Builds a small but structurally real ASAR so the archive helpers are exercised
// through the same separator-native API that packaged verification uses.
async function packFixture(files) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "grok-bot-asar-"));
  const stage = path.join(scratch, "stage");
  const archive = path.join(scratch, "app.asar");
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(stage, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  await createPackage(stage, archive);
  return { scratch, archive };
}

test("archive addressing follows the host separator in both directions", async () => {
  const { scratch, archive } = await packFixture({
    "dist/renderer/index.html": "<!doctype html>",
    "dist/renderer/assets/index-ABCDEFGH.js": "export const banner = 1;",
  });
  try {
    const entries = listArchiveFiles(archive, listPackage);
    // The canonical spelling is host-independent, so comparisons stay portable.
    assert.deepEqual(
      entries.filter(entry => entry.endsWith(".js") || entry.endsWith(".html")).sort(),
      ["dist/renderer/assets/index-ABCDEFGH.js", "dist/renderer/index.html"],
    );
    // `listPackage` reports the host separator; that is what the helpers absorb.
    const raw = listPackage(archive);
    assert.ok(raw.every(entry => entry.startsWith(path.sep)));
    assert.ok(raw.every(entry => entry.endsWith(".html") || !entry.includes("/")));
    assert.ok(entries.includes(fromArchiveEntry(raw.find(entry => entry.endsWith("index.html")))));
    // `extractFile` rejects the POSIX spelling on Windows, so it must be routed.
    assert.equal(extractFile(archive, toArchiveRelative("dist/renderer/index.html")).toString("utf8"), "<!doctype html>");
    assert.equal(toArchiveRelative("/dist/renderer/index.html"), ["dist", "renderer", "index.html"].join(path.sep));
    assert.equal(fromArchiveEntry(`${path.sep}dist${path.sep}renderer`), "dist/renderer");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an unpatched packaged renderer reports no router settings extension", async () => {
  const { scratch, archive } = await packFixture({ "dist/renderer/index.html": "<!doctype html>" });
  try {
    const expectedFiles = new Map([["index.html", { path: "index.html", bytes: 15, sha256: sha256("<!doctype html>") }]]);
    assert.equal(readRendererExtensionChunks({ archivePath: archive, expectedFiles }), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the router settings extension pins shipped and patched chunk identities", async () => {
  const shipped = "export const wDn=[];";
  const patched = "export const wDn=[{id:\"router\"}];";
  const chunkRelative = "assets/index-BoDVc20G.js";
  const chunkPath = `dist/renderer/${chunkRelative}`;
  const shippedIdentity = { bytes: Buffer.byteLength(shipped), sha256: sha256(shipped) };
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: [{
      role: "panel",
      path: chunkPath,
      original: { ...shippedIdentity },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    }],
    features: ["settings-router-provider"],
    transformations: ["settings-registry"],
  };
  const { scratch, archive } = await packFixture({
    "dist/renderer/index.html": "<!doctype html>",
    [chunkPath]: patched,
    "dist/renderer-router-extension.json": `${JSON.stringify(record, null, 2)}\n`,
  });
  try {
    const expectedFiles = new Map([[chunkRelative, { path: chunkRelative, ...shippedIdentity }]]);
    const extension = readRendererExtensionChunks({ archivePath: archive, expectedFiles });
    assert.equal(extension.chunks.size, 1);
    assert.equal(extension.chunks.get(chunkRelative).patched.sha256, sha256(patched));
    // The packaged bytes must satisfy the patched identity, not the shipped one.
    assert.equal(extractFile(archive, toArchiveRelative(chunkPath)).toString("utf8"), patched);

    // An extension that re-baselines a chunk it did not come from is rejected.
    const drifted = new Map([[chunkRelative, { path: chunkRelative, bytes: 1, sha256: sha256("x") }]]);
    assert.throws(() => readRendererExtensionChunks({ archivePath: archive, expectedFiles: drifted }), /source identity drift/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a member name with a space and non-ASCII characters survives the round trip", async () => {
  // Separator handling is exactly where non-ASCII breaks: the archive header is
  // byte-indexed and the entry name travels through path arithmetic, so a name
  // that is neither pure ASCII nor separator-free is the case worth pinning.
  const awkward = "dist/renderer/Ассеты/файл с пробелом — ünïcode.json";
  const contents = `{"имя":"файл с пробелом","emoji":"🚀","nul":"\\u0000"}\n`;
  const { scratch, archive } = await packFixture({
    [awkward]: contents,
    "dist/renderer/index.html": "<!doctype html>",
  });
  try {
    const entries = listArchiveFiles(archive, listPackage);
    assert.ok(
      entries.includes(awkward),
      `expected ${JSON.stringify(awkward)} in the canonical listing, got ${JSON.stringify(entries)}`,
    );
    // The raw listing is separator-native, so the awkward name has to survive the
    // conversion in both directions byte for byte.
    const raw = listPackage(archive);
    assert.ok(raw.every(entry => entry.startsWith(path.sep)));
    assert.equal(
      fromArchiveEntry(raw.find(entry => entry.endsWith("ünïcode.json"))),
      awkward,
    );
    // The routed spelling is what actually reads the bytes back.
    assert.equal(
      extractFile(archive, toArchiveRelative(awkward)).toString("utf8"),
      contents,
    );
    // The POSIX spelling is what this whole suite exists to prevent. It is
    // asserted only where it is guaranteed to fail; a two-segment path would
    // succeed by accident on Windows, because win32 `dirname`/`basename` accept
    // `/`, so the deep `dist/renderer/...` shape is used instead.
    assert.throws(
      () => extractFile(archive, awkward),
      /was not found in (this )?archive|Cannot find/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the system tool table matches the host instead of pretending tools exist", () => {
  if (isWindowsHost) {
    // Windows resolves through PATH and has no macOS-only counterpart at all.
    assert.deepEqual(Object.keys(SYSTEM_TOOLS).sort(), ["git", "powershell", "sevenZip", "tar"]);
    assert.equal(systemTool("git"), "git");
    assert.equal(systemTool("powershell"), "powershell.exe");
    assert.equal(systemTool("sevenZip"), "C:\\Program Files\\7-Zip\\7z.exe");
    for (const macosOnly of ["codesign", "plutil", "xattr", "hdiutil", "ditto"]) {
      assert.equal(SYSTEM_TOOLS[macosOnly], undefined);
      assert.throws(() => systemTool(macosOnly), /not available on win32/);
    }
  } else {
    assert.deepEqual(Object.keys(SYSTEM_TOOLS).sort(), ["codesign", "cp", "ditto", "hdiutil", "lsof", "plutil", "ps", "xattr"]);
    assert.equal(systemTool("plutil"), "/usr/bin/plutil");
    assert.equal(systemTool("codesign"), "/usr/bin/codesign");
    assert.throws(() => systemTool("git-does-not-exist"), /not available on/);
  }
});

test("both host tables are asserted on every host, not just the selected one", () => {
  // `SYSTEM_TOOLS` is chosen once from `process.platform`, so a host only ever
  // exercises its own branch and the other table would ship unverified forever.
  // That is how a wrong `plutil` path or a missing `ditto` survived until now:
  // each was only ever checked on the host that selects it. Both tables are
  // asserted here on every host, so the mutations fail everywhere.
  assert.deepEqual(DARWIN_SYSTEM_TOOLS, {
    cp: "/bin/cp",
    lsof: "/usr/sbin/lsof",
    ps: "/bin/ps",
    codesign: "/usr/bin/codesign",
    ditto: "/usr/bin/ditto",
    hdiutil: "/usr/bin/hdiutil",
    plutil: "/usr/bin/plutil",
    xattr: "/usr/bin/xattr",
  });
  assert.deepEqual(WINDOWS_SYSTEM_TOOLS, {
    git: "git",
    powershell: "powershell.exe",
    sevenZip: "C:\\Program Files\\7-Zip\\7z.exe",
    tar: "tar",
  });

  // Spot-check the two entries whose silent mutation is the stated risk, so the
  // failure names the table and the key rather than a deep-equal diff.
  assert.equal(DARWIN_SYSTEM_TOOLS.plutil, "/usr/bin/plutil", "the macOS plutil path must be the absolute /usr/bin location");
  assert.ok("ditto" in DARWIN_SYSTEM_TOOLS, "ditto must stay in the macOS table: packaging copies bundles with it");
  assert.equal(DARWIN_SYSTEM_TOOLS.codesign, "/usr/bin/codesign");
  assert.equal(WINDOWS_SYSTEM_TOOLS.powershell, "powershell.exe", "Windows process probes need a named powershell entry");
  assert.ok("sevenZip" in WINDOWS_SYSTEM_TOOLS, "the Windows runtime bootstrap needs a named 7-Zip entry");

  // The two tables stay disjoint in the macOS-only direction, which is what lets
  // a macOS-only step fail with a named error on Windows.
  for (const macosOnly of ["codesign", "plutil", "xattr", "hdiutil", "ditto", "cp", "ps", "lsof"]) {
    assert.equal(WINDOWS_SYSTEM_TOOLS[macosOnly], undefined, `${macosOnly} has no Windows counterpart`);
  }
  for (const windowsOnly of ["powershell", "sevenZip"]) {
    assert.equal(DARWIN_SYSTEM_TOOLS[windowsOnly], undefined, `${windowsOnly} is Windows-only`);
  }

  // `SYSTEM_TOOLS` is one of the two, not a third shape that can drift.
  assert.ok(SYSTEM_TOOLS === DARWIN_SYSTEM_TOOLS || SYSTEM_TOOLS === WINDOWS_SYSTEM_TOOLS);
  assert.ok(Object.isFrozen(DARWIN_SYSTEM_TOOLS) && Object.isFrozen(WINDOWS_SYSTEM_TOOLS));
});