import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { extractAll, extractFile } from "@electron/asar";
import {
  cacheDir,
  cachedRuntimeApp,
  isWindowsRuntimeHost,
  runtimeAsarPath,
  runtimeExecutablePath,
  runtimeUnpackedPath,
  sourceAppDir,
  upstreamAsarSha256,
  upstreamVersion
} from "./config.mjs";
import { capture, run } from "./process.mjs";
import { systemTool } from "./system-tools.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// A missing path has to be reported as an incomplete runtime, not as the bare
// `ENOENT` that `stat` raises, because four call sites surface this error to a
// person who has no other way to learn which runtime is broken.
async function safeStat(target) {
  try {
    return await stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// macOS carries its short version in Info.plist; the Windows build has no
// bundle metadata, so the same identity is read from the app.asar manifest that
// both platforms ship.
async function runtimeDeclaredVersion(appPath) {
  if (!isWindowsRuntimeHost) {
    const infoPlist = path.join(appPath, "Contents", "Info.plist");
    return await capture(systemTool("plutil"), ["-extract", "CFBundleShortVersionString", "raw", infoPlist]);
  }
  const manifest = JSON.parse(extractFile(runtimeAsarPath(appPath), "package.json").toString("utf8"));
  return typeof manifest.version === "string" ? manifest.version : null;
}

export async function validateRuntimeApp(appPath) {
  const executable = runtimeExecutablePath(appPath);
  const unpacked = runtimeUnpackedPath(appPath);
  const version = await runtimeDeclaredVersion(appPath);
  if (version !== upstreamVersion) {
    throw new Error(`Expected Grok Bot ${upstreamVersion}, got ${version} at ${appPath}`);
  }
  const [executableStat, unpackedStat] = await Promise.all([safeStat(executable), safeStat(unpacked)]);
  if (executableStat?.isFile() !== true || unpackedStat?.isDirectory() !== true) {
    const missing = [
      executableStat?.isFile() !== true ? executable : null,
      unpackedStat?.isDirectory() !== true ? unpacked : null,
    ].filter(Boolean).join(", ");
    throw new Error(`Incomplete Grok Bot runtime at ${appPath}: missing ${missing}`);
  }
  return appPath;
}

/**
 * Publish a fully staged runtime tree at the cache path in one rename. The old
 * cache is only displaced after the new tree is in place, and a failed rename
 * puts the old tree back, so `cachedRuntimeApp` is never observed half-written.
 */
export async function commitRuntimeTree(staged, destination = cachedRuntimeApp) {
  await mkdir(path.dirname(destination), { recursive: true });
  const retired = `${destination}.retired-${randomUUID()}`;
  const hadPrevious = await exists(destination);
  if (hadPrevious) await rename(destination, retired);
  try {
    await rename(staged, destination);
  } catch (error) {
    if (hadPrevious) {
      try {
        await rename(retired, destination);
      } catch {
        // The retired tree is now the only copy. Reporting the original failure
        // is the useful message; the path is printed by the caller.
      }
    }
    throw error;
  }
  if (hadPrevious) {
    // The new cache is already committed, so a stale sibling that some other
    // process still holds open must not fail the build.
    try {
      await rm(retired, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove the superseded runtime tree ${retired}: ${error.message}`);
    }
  }
  return destination;
}

/**
 * Materialise a runtime tree through a sibling staging directory, validate it
 * there, and only then swap it into the cache. Extraction that is interrupted —
 * a full disk, an antivirus holding `Grok Bot.exe`, Ctrl-C — therefore damages
 * the staging directory alone: the cache keeps the tree it already had, and the
 * partial staging directory is removed.
 */
export async function extractRuntimeTree(extract, destination = cachedRuntimeApp) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staged = await mkdtemp(path.join(parent, `${path.basename(destination)}.staging-`));
  try {
    await extract(staged);
    await validateRuntimeApp(staged);
    return await commitRuntimeTree(staged, destination);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Reuse the cached runtime only when it validates. A cache left partial by an
 * interrupted extraction fails `validateRuntimeApp`; it is removed here so the
 * caller re-extracts instead of accepting it. That is the whole recovery path
 * for a cache an earlier run poisoned: the next bootstrap sees no cache, runs
 * the extraction again into a fresh staging sibling, and commits it.
 */
export async function resolveValidatedCachedRuntime(appPath = cachedRuntimeApp) {
  if (!(await exists(appPath))) return null;
  try {
    return await validateRuntimeApp(appPath);
  } catch (error) {
    console.warn(`Discarding unusable cached runtime at ${appPath}: ${error.message}`);
    try {
      await rm(appPath, { recursive: true, force: true });
    } catch (removalError) {
      throw new Error(
        `Unusable cached runtime at ${appPath} cannot be replaced because it cannot be removed: ${removalError.message}`,
      );
    }
    return null;
  }
}

export async function resolveRuntimeApp() {
  const configured = process.env.GROK_BOT_018_APP?.trim();
  if (configured) {
    return await validateRuntimeApp(path.resolve(configured));
  }
  // Read-only on purpose: a build must report an unusable cache, not silently
  // delete it. Only `npm run bootstrap` discards and rebuilds one.
  if (await exists(cachedRuntimeApp)) {
    return await validateRuntimeApp(cachedRuntimeApp);
  }
  throw new Error("Missing 0.18.0 runtime. Run `npm run bootstrap` first.");
}

export async function cacheRuntimeFromApp(source) {
  const validated = await validateRuntimeApp(path.resolve(source));
  return await extractRuntimeTree(async staged => {
    if (isWindowsRuntimeHost) {
      // ditto is the macOS fidelity copy; Windows has no equivalent and no
      // extended attributes to preserve, so the recursive copy stands in.
      await copyTree(validated, staged);
    } else {
      await run(systemTool("ditto"), [validated, staged]);
    }
  });
}

export async function hydrateSourcePayloadFromAsar(archive, {
  destination = sourceAppDir,
  expectedSha256 = upstreamAsarSha256,
} = {}) {
  const bytes = await readFile(archive);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Upstream app.asar checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const hydrationRoot = path.join(cacheDir, "source-payloads");
  await mkdir(hydrationRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(hydrationRoot, "grok-bot-018-"));
  try {
    extractAll(archive, temporary);
    for (const required of [
      "dist/electron-main/main.cjs",
      "dist/host/host-main.cjs",
      "dist/renderer/index.html",
    ]) {
      if (!(await stat(path.join(temporary, required))).isFile()) {
        throw new Error(`Upstream app.asar is missing ${required}`);
      }
    }
    await mkdir(destination, { recursive: true });
    await rm(path.join(destination, "dist"), { recursive: true, force: true });
    await cp(path.join(temporary, "dist"), path.join(destination, "dist"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { archive, sha256: actualSha256, destination: path.join(destination, "dist") };
}

export async function hydrateSourcePayloadFromRuntime(runtimeApp, options = {}) {
  const archive = runtimeAsarPath(await validateRuntimeApp(runtimeApp));
  return hydrateSourcePayloadFromAsar(archive, options);
}

export async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}
