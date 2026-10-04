import { statSync } from "node:fs";
import path from "node:path";

import { isWindowsRuntimeHost, runtimeResourcesDir } from "./config.mjs";

const APP_BUNDLE_EXTENSION = ".app";
const BUNDLE_RESOURCES_SEGMENTS = ["Contents", "Resources"];
// The Windows payload root is a directory, and these names always denote a
// single file instead: the packed ASAR, the installer/launcher, or an archive.
// `Grok Bot 0.18 Reconstructed` looks like a file to `path.extname` (its last dot
// belongs to the version), so a name-based test alone cannot classify a Windows
// payload root and the filesystem is consulted first.
const FILE_PAYLOAD_EXTENSIONS = new Set([
  ".7z",
  ".appx",
  ".asar",
  ".dmg",
  ".exe",
  ".msi",
  ".msix",
  ".zip"
]);

function existingEntryKind(appPath) {
  try {
    return statSync(appPath).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

export function resolvePackagedAppArtifacts(appPath) {
  if (typeof appPath !== "string" || appPath.trim() === "") {
    throw new TypeError("A packaged application path is required");
  }
  const resolvedApp = path.resolve(appPath);
  const extension = path.extname(resolvedApp);
  // macOS ships a `.app` bundle and nothing else, so its contract is unchanged:
  // only a `.app` suffix is accepted, whatever the host happens to be.
  const isBundle = extension === APP_BUNDLE_EXTENSION;
  // Windows ships a flat directory that Electron loads directly, which is
  // accepted whenever the path really is a directory, and accepted by name for a
  // not-yet-created output root. Anything that exists as a file, or that names a
  // packed archive or installer, is rejected just as firmly as on macOS.
  const entryKind = isWindowsRuntimeHost ? existingEntryKind(resolvedApp) : "file";
  const isFlatDirectory = entryKind === "directory"
    || (entryKind === "missing" && !FILE_PAYLOAD_EXTENSIONS.has(extension));
  if (!isBundle && !isFlatDirectory) {
    throw new TypeError(`Expected a .app bundle path, received ${appPath}`);
  }
  // A `.app` keeps the bundle layout on every host, so macOS tooling and its
  // tests can still resolve a bundle path when the toolchain runs on Windows.
  // Only the Windows directory shape defers to the platform helper, which keeps
  // the layout knowledge in `config.mjs` instead of here.
  const resourcesDir = isBundle
    ? path.join(resolvedApp, ...BUNDLE_RESOURCES_SEGMENTS)
    : runtimeResourcesDir(resolvedApp);
  // Both payload shapes keep the same ASAR file name below their resources
  // directory, so callers only ever swap the root, never the artifact names.
  const asarPath = path.join(resourcesDir, "app.asar");
  return Object.freeze({
    appPath: resolvedApp,
    shape: isBundle ? "app-bundle" : "app-directory",
    asarPath,
    unpackedPath: `${asarPath}.unpacked`,
  });
}
