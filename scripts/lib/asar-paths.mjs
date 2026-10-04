import path from "node:path";

// @electron/asar addresses archive members with the platform separator: on
// Windows its readers require `dist\renderer\index.html` and reject the POSIX
// spelling, and `listPackage` reports entries backslash-separated with a
// leading separator. The rest of this toolchain keys everything on canonical
// forward-slash relative paths, so archive members are converted at the
// boundary instead of at every call site.
export function toArchiveRelative(relative) {
  return String(relative).replace(/^[/\\]+/, "").split(/[/\\]+/).join(path.sep);
}

export function fromArchiveEntry(entry) {
  return String(entry).replace(/^[/\\]+/, "").split(/[/\\]+/).join("/");
}

export function listArchiveFiles(archivePath, listPackage) {
  return listPackage(archivePath).map(fromArchiveEntry);
}
