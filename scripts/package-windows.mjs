import { cp, mkdir, rm } from "node:fs/promises";

import {
  isWindowsRuntimeHost,
  outputApp,
  outputDir,
  runtimeExecutablePath
} from "./lib/config.mjs";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { resolvePackagedAppArtifacts } from "./lib/packaged-app.mjs";

if (!isWindowsRuntimeHost) {
  throw new Error("The reconstructed Windows application can only be packaged on Windows.");
}

/**
 * Removes a directory that a stopped build may still have open.
 *
 * EBUSY and EPERM mean somebody is still holding a file, which on Windows is
 * normal for a few seconds after a process is asked to quit. Everything else is
 * a real failure and is raised immediately rather than retried into a confusing
 * timeout.
 */
const REMOVAL_RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
async function removeOutputApp(directory, attempts = 20) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error?.code;
      if (!REMOVAL_RETRYABLE_CODES.has(code) || attempt >= attempts) throw error;
      // 150ms, doubling to roughly 8s of total patience across the attempts.
      await new Promise((resolve) => setTimeout(resolve, Math.min(150 * 2 ** (attempt - 1), 1_000)));
    }
  }
}

// Keep the checksum-pinned shipped renderer as the polished UI authority. Small
// reconstructed UI extensions are installed by the clean preload, leaving the
// original renderer chunks byte-for-byte intact.
const { builtAsar, builtAsarUnpacked, runtimeApp } = await buildFidelityReconstructedAsar();
// The official Windows payload is the only available runtime source, so unlike
// the macOS build there is no separate signed release audit to run: the payload
// copied below is the reference itself.
await mkdir(outputDir, { recursive: true });
// Windows keeps a handle on an executable that is still running, so removing the
// output directory fails with EBUSY while the previous build is up. Retrying for
// a few seconds turns "stop the app first, and time it exactly right" into
// "stop the app first"; a single unretried `rm` made the whole package step fail
// on a timing detail the caller cannot see.
await removeOutputApp(outputApp);
// `ditto` is a macOS tool and has no Windows equivalent. `fs.cp` reproduces the
// same metadata-preserving tree copy: `dereference: false` keeps the runtime's
// directory layout exactly as shipped instead of resolving anything through a
// link, and `preserveTimestamps` keeps native module timestamps unchanged so the
// copied binaries stay identical to the runtime ones.
await cp(runtimeApp, outputApp, { recursive: true, dereference: false, preserveTimestamps: true });

// The macOS signing steps have no counterpart here, on purpose:
//   * Info.plist rewriting (`plutil`) - a flat Windows payload has no bundle
//     identity to restate. `CFBundleIdentifier`, `CFBundleDisplayName` and
//     `CFBundleURLTypes` exist only to identify a bundle to Launch Services,
//     which Windows never reads, so there is nothing to rewrite and no
//     consequence for inheriting the runtime's metadata untouched.
//   * `xattr -cr` - the quarantine flag is a macOS provenance attribute that
//     `cp` on Windows never sets, and there is no Gatekeeper to strip it for.
//   * `codesign` / ad-hoc signing - Authenticode signs the PE images only, and
//     the payload tree contains no signed PE outside `Grok Bot.exe`, which this
//     script never touches. Replacing `resources\app.asar` and its `.unpacked`
//     sibling therefore cannot invalidate any signature, so the inherited
//     executable stays trusted exactly as copied.
const { asarPath: packagedAsar, unpackedPath: packagedUnpacked } = resolvePackagedAppArtifacts(outputApp);
await rm(packagedAsar, { force: true });
await rm(packagedUnpacked, { recursive: true, force: true });
await cp(builtAsar, packagedAsar);
await cp(builtAsarUnpacked, packagedUnpacked, {
  recursive: true,
  dereference: false,
  preserveTimestamps: true
});

console.log(`Packaged application: ${outputApp}`);
console.log(`Packaged executable: ${runtimeExecutablePath(outputApp)}`);
