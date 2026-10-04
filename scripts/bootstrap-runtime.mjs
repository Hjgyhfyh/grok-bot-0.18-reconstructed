import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extractFile } from "@electron/asar";
import {
  archivedDmg,
  archivedSetup,
  cacheDir,
  cachedDmg,
  cachedRuntimeApp,
  dmgSha256,
  dmgUrl,
  isWindowsRuntimeHost,
  runtimeAsarPath,
  sourceAppDir,
  windowsSetupSha256
} from "./lib/config.mjs";
import { run } from "./lib/process.mjs";
import {
  cacheRuntimeFromApp,
  extractRuntimeTree,
  hydrateSourcePayloadFromRuntime,
  resolveValidatedCachedRuntime,
  validateRuntimeApp,
} from "./lib/runtime.mjs";
import { systemTool } from "./lib/system-tools.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadDmg() {
  await mkdir(path.dirname(cachedDmg), { recursive: true });
  if (await exists(cachedDmg)) {
    const digest = await sha256(cachedDmg);
    if (digest === dmgSha256) return;
    await rm(cachedDmg, { force: true });
  }

  if (await exists(archivedDmg)) {
    const archivedDigest = await sha256(archivedDmg);
    if (archivedDigest !== dmgSha256) {
      throw new Error(`Archived DMG checksum mismatch: expected ${dmgSha256}, got ${archivedDigest}. Run git lfs pull before bootstrapping.`);
    }
    console.log(`Using archived release ${archivedDmg}`);
    await copyFile(archivedDmg, cachedDmg);
    return;
  }

  console.log(`Downloading ${dmgUrl}`);
  const response = await fetch(dmgUrl, { redirect: "follow" });
  if (!response.ok || response.body == null) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const partial = `${cachedDmg}.partial`;
  await rm(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o600 }));
  const digest = await sha256(partial);
  if (digest !== dmgSha256) {
    await rm(partial, { force: true });
    throw new Error(`DMG checksum mismatch: expected ${dmgSha256}, got ${digest}`);
  }
  await rename(partial, cachedDmg);
}

async function extractRuntime() {
  const mountRoot = await mkdtemp(path.join(tmpdir(), "grok-bot-018-mount-"));
  let attached = false;
  try {
    await run(systemTool("hdiutil"), ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, cachedDmg]);
    attached = true;
    await cacheRuntimeFromApp(path.join(mountRoot, "Grok Bot.app"));
  } finally {
    if (attached) await run(systemTool("hdiutil"), ["detach", mountRoot]);
    await rm(mountRoot, { recursive: true, force: true });
  }
}

// Windows has no DMG to mount. The pinned 0.18.0 release ships a Windows setup
// executable whose payload is the same runtime in flat-directory form, so the
// archived installer replaces the DMG and 7-Zip replaces hdiutil.
async function resolveSevenZip() {
  const candidates = [
    process.env.SEVEN_ZIP?.trim(),
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error(
    "7-Zip is required to unpack the pinned Windows runtime. Install it or set SEVEN_ZIP to the 7z.exe path."
  );
}

async function extractWindowsRuntime() {
  if (!(await exists(archivedSetup))) {
    throw new Error(
      `Missing archived Windows release ${archivedSetup}. Run git lfs pull before bootstrapping.`
    );
  }
  const digest = await sha256(archivedSetup);
  if (digest !== windowsSetupSha256) {
    throw new Error(
      `Archived Windows installer checksum mismatch: expected ${windowsSetupSha256}, got ${digest}.`
    );
  }
  console.log(`Using archived release ${archivedSetup}`);
  const sevenZip = await resolveSevenZip();
  // The release setup is an NSIS package: the runtime itself is a nested
  // app-<arch>.7z under $PLUGINSDIR, exactly the way hdiutil reveals the
  // runtime inside a DMG on macOS.
  const installerRoot = path.join(cacheDir, "windows-installer");
  await rm(installerRoot, { recursive: true, force: true });
  await mkdir(installerRoot, { recursive: true });
  try {
    await run(sevenZip, ["x", "-y", `-o${installerRoot}`, archivedSetup]);
    const pluginDir = path.join(installerRoot, "$PLUGINSDIR");
    const payloads = (await readdir(pluginDir)).filter(entry => /^app-.*\.7z$/i.test(entry));
    if (payloads.length !== 1) {
      throw new Error(`Expected exactly one nested runtime archive in ${pluginDir}, found ${payloads.length}.`);
    }
    // 7-Zip writes into a sibling staging directory, `extractRuntimeTree`
    // validates the result there, and the validated tree replaces the cache in
    // a single rename. Extracting straight into the cache meant an interrupted
    // run left it partial, and the next bootstrap reused that partial tree
    // forever instead of unpacking the installer again.
    await extractRuntimeTree(
      staged => run(sevenZip, ["x", "-y", `-o${staged}`, path.join(pluginDir, payloads[0])]),
    );
  } finally {
    await rm(installerRoot, { recursive: true, force: true });
  }
}

// The staged app is assembled from the payload directory, so the manifest that
// describes the entrypoint has to sit beside the hydrated `dist`.
async function writePayloadManifest(destination, runtimeApp) {
  const manifestPath = path.join(destination, "package.json");
  if (await exists(manifestPath)) return;
  await mkdir(destination, { recursive: true });
  await writeFile(manifestPath, extractFile(runtimeAsarPath(runtimeApp), "package.json"));
}

// A cached runtime is reused only when it validates. One left partial by an
// interrupted extraction is removed here and rebuilt from the pinned archive, so
// the wedge that used to require a hand-deleted directory is repaired by the
// next `npm run bootstrap`.
const cachedApp = await resolveValidatedCachedRuntime();
const configuredApp = process.env.GROK_BOT_018_APP?.trim();
let runtimeApp;
if (configuredApp) {
  runtimeApp = await cacheRuntimeFromApp(configuredApp);
} else if (cachedApp != null) {
  runtimeApp = cachedApp;
} else if (isWindowsRuntimeHost) {
  await extractWindowsRuntime();
  runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
} else {
  await downloadDmg();
  await extractRuntime();
  runtimeApp = await validateRuntimeApp(cachedRuntimeApp);
}

const hydrated = await hydrateSourcePayloadFromRuntime(runtimeApp);
await writePayloadManifest(sourceAppDir, runtimeApp);

console.log(`Runtime ready: ${cachedRuntimeApp}`);
console.log(`Checksum-pinned source payload ready: ${hydrated.destination} (${hydrated.sha256})`);
console.log("The checksum-pinned app supplies only the Electron shell, ABI-matched native dependencies, and explicitly documented build fallbacks.");
