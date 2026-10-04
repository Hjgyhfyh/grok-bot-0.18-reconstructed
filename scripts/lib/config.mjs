import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// The toolchain was originally written against the macOS `.app` runtime. The
// same 0.18.0 runtime ships for Windows as a flat directory with `resources\`
// beside the executable, so every layout-dependent path is derived from the
// host platform instead of being hard-coded to the macOS bundle shape.
export const isWindowsRuntimeHost = process.platform === "win32";
export const runtimeResourcesDir = appPath => (isWindowsRuntimeHost
  ? path.join(appPath, "resources")
  : path.join(appPath, "Contents", "Resources"));
export const runtimeExecutablePath = appPath => (isWindowsRuntimeHost
  ? path.join(appPath, "Grok Bot.exe")
  : path.join(appPath, "Contents", "MacOS", "Grok Bot"));
export const runtimeAsarPath = appPath => path.join(runtimeResourcesDir(appPath), "app.asar");
export const runtimeUnpackedPath = appPath => `${runtimeAsarPath(appPath)}.unpacked`;

export const repoRoot = path.resolve(thisDir, "../..");
// One payload directory serves both platforms: bootstrap hydrates it from
// whichever pinned runtime this host builds against, so the checked-in state is
// simply "the payload for the platform last bootstrapped".
export const sourceAppDir = path.join(repoRoot, "src", "app");
export const cacheDir = path.join(repoRoot, ".cache");
export const cachedRuntimeApp = isWindowsRuntimeHost
  ? path.join(cacheDir, "runtime", "win-x64", "Grok Bot")
  : path.join(cacheDir, "runtime", "Grok Bot.app");
export const cachedDmg = path.join(cacheDir, "downloads", "Grok_Bot_0.18.0.dmg");
export const archivedDmg = path.join(repoRoot, "research-archives", "original", "0.18.0", "macos-arm64", "Grok_Bot_0.18.0.dmg");
export const buildDir = path.join(repoRoot, ".build");
export const stagedAppDir = path.join(buildDir, "app");
export const builtAsar = path.join(buildDir, "app.asar");
export const builtAsarUnpacked = `${builtAsar}.unpacked`;
export const fidelityBuildDir = path.join(buildDir, "fidelity");
export const fidelityStagedAppDir = path.join(fidelityBuildDir, "app");
export const fidelityBuiltAsar = path.join(fidelityBuildDir, "app.asar");
export const fidelityBuiltAsarUnpacked = `${fidelityBuiltAsar}.unpacked`;
export const fidelityCandidateManifest = path.join(fidelityBuildDir, "release-candidate.json");
export const fidelityE2ECandidateManifest = path.join(fidelityBuildDir, "e2e-candidate.json");
export const fidelityReleaseEvidenceDir = path.join(fidelityBuildDir, "release-evidence");
export const outputDir = path.join(repoRoot, "dist");
const configuredOutputName = process.env.GROK_BOT_OUTPUT_APP_NAME?.trim();
// A packaged macOS build is a `.app` bundle; the Windows build is a plain
// directory that Electron loads directly. Callers that still assume `.app`
// (verification, fidelity diagnostics) remain macOS-only on purpose.
const reconstructedOutputName = isWindowsRuntimeHost
  ? "Grok Bot 0.18 Reconstructed"
  : "Grok Bot 0.18 Reconstructed.app";
export const outputApp = path.join(
  outputDir,
  configuredOutputName ? path.basename(configuredOutputName) : reconstructedOutputName
);
export const fidelityOutputApp = path.join(outputDir, isWindowsRuntimeHost
  ? "Grok Bot 0.18 Fidelity"
  : "Grok Bot 0.18 Fidelity.app");
// A per-ASAR-hash fidelity build follows the platform split like every other
// layout-dependent path here: a macOS build is a `.app` bundle installed under
// `/Applications`, while the Windows build is the flat payload directory that
// Electron loads directly. Without the branch, `path.join("/Applications", …)`
// resolves to a drive-relative `\Applications\…` on Windows.
export const fidelityOutputAppForAsarHash = asarHash => {
  if (!/^[0-9a-f]{64}$/.test(asarHash)) throw new TypeError("A full lowercase ASAR SHA-256 is required");
  const suffix = `Grok Bot 0.18 Fidelity-${asarHash.slice(0, 12)}`;
  return path.join(outputDir, isWindowsRuntimeHost ? suffix : `${suffix}.app`);
};
export const fidelityInstalledAppForAsarHash = asarHash => path.join(
  isWindowsRuntimeHost ? "C:\\Program Files" : "/Applications",
  path.basename(fidelityOutputAppForAsarHash(asarHash)),
);
export const recoveredFrontendDir = path.join(repoRoot, "recovered", "frontend");
export const recoveredRendererDir = path.join(recoveredFrontendDir, "app");
export const frontendDir = path.join(repoRoot, "frontend");
export const devOutputApp = path.join(outputDir, isWindowsRuntimeHost
  ? "Grok Bot 0.18 Dev"
  : "Grok Bot 0.18 Dev.app");
export const devProfileDir = path.join(cacheDir, "dev-profile");

export const upstreamVersion = "0.18.0";
export const reconstructedBundleId = "com.anysphere.sand.reconstructed";
export const reconstructedName = "Grok Bot 0.18 Reconstructed";
export const fidelityBundleId = "com.anysphere.sand.reconstructed.fidelity";
export const fidelityName = "Grok Bot 0.18 Fidelity";
export const dmgUrl = "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.18.0/Grok_Bot_0.18.0.dmg";
export const dmgSha256 = "a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb";
export const macosUpstreamAsarSha256 = "6665408168466f9cacc6087e917890c17f59d2e2e9c2404a5c4a59ad79c1de58";
// Windows x64 0.18.0 app.asar, extracted from the pinned release installer. The
// macOS and Windows 0.18.0 builds are distinct artifacts, so the pinned identity
// has to follow the host platform.
export const windowsUpstreamAsarSha256 = "38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0";
// The platform split used to be inlined at module load, which made the choice
// unobservable from a single host: pinning the macOS hash everywhere passed. The
// selection is a named function so it can be asked about both platforms at once,
// and `GROK_BOT_UPSTREAM_ASAR_SHA256` still overrides both of them.
export const selectUpstreamAsarSha256 = (platform = process.platform) =>
  process.env.GROK_BOT_UPSTREAM_ASAR_SHA256?.trim()
    || (platform === "win32" ? windowsUpstreamAsarSha256 : macosUpstreamAsarSha256);
export const upstreamAsarSha256 = selectUpstreamAsarSha256();
export const windowsSetupSha256 = "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e";
export const archivedSetup = path.join(repoRoot, "research-archives", "original", "0.18.0", "windows-x64", "Grok_Bot_0.18.0_Setup.exe");
