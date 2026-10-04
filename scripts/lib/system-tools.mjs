import { isWindowsRuntimeHost } from "./config.mjs";

// The macOS payload is driven by a fixed set of system binaries that live at
// absolute locations. Windows ships no counterpart for most of them, so the
// table is selected per host instead of pretending that `/usr/bin/plutil` can
// ever run: a macOS-only step that leaks into a Windows run now fails with a
// named, actionable error rather than an opaque spawn failure.
//
// Both tables are exported, not just the selected one. `SYSTEM_TOOLS` is chosen
// once from `process.platform`, so a host only ever exercises its own branch and
// the other table ships unverified until someone runs on that platform. Exporting
// them lets a test assert both on every host.
export const DARWIN_SYSTEM_TOOLS = Object.freeze({
  cp: "/bin/cp",
  lsof: "/usr/sbin/lsof",
  ps: "/bin/ps",
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
  xattr: "/usr/bin/xattr",
});

// Git for Windows provides `git`, and Windows 10 and newer ship `tar` (bsdtar)
// in System32, so both are resolved through PATH like any other executable.
// `powershell.exe` is the Windows counterpart of the POSIX process probes and is
// named explicitly so a missing shell surfaces as a named tool rather than as a
// bare `spawn(undefined)`. `sevenZip` is the documented default install location
// for the runtime bootstrap; the bootstrap still probes both Program Files
// variants and honours `SEVEN_ZIP` before falling back to this entry.
// Everything else is macOS-only and is absent by design: `codesign`, `plutil`,
// `xattr`, `hdiutil` and `ditto` have no Windows equivalent at all, and the
// POSIX `cp`/`ps`/`lsof` are not part of a base Windows install either.
export const WINDOWS_SYSTEM_TOOLS = Object.freeze({
  git: "git",
  powershell: "powershell.exe",
  sevenZip: "C:\\Program Files\\7-Zip\\7z.exe",
  tar: "tar",
});

export const SYSTEM_TOOLS = Object.freeze(
  isWindowsRuntimeHost ? WINDOWS_SYSTEM_TOOLS : DARWIN_SYSTEM_TOOLS,
);

/**
 * Resolve a system tool for this host, failing loudly when the host has no
 * counterpart instead of handing `undefined` to `spawn`.
 */
export function systemTool(name) {
  const tool = SYSTEM_TOOLS[name];
  if (tool == null) {
    throw new Error(
      `System tool ${name} is not available on ${process.platform}. Available: ${Object.keys(SYSTEM_TOOLS).join(", ")}`,
    );
  }
  return tool;
}