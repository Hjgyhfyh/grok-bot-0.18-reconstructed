import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A photo attached in the composer rendered as "Image unavailable", while the
 * file itself was on disk the whole time.
 *
 * What broke: `normalizeAttachmentSource` in
 * `source/electron-main/attachments/attachments.ts` decided what an attachment
 * source was by handing it to `new URL` and asking for the `file:` protocol. A
 * native Windows absolute path is a legal URL whose scheme is the drive letter,
 * so `new URL("C:\\...\\photo.jpg")` succeeds with protocol `"c:"`, the `file:`
 * test failed, and the function returned `null` before anything tried to open
 * the file.
 *
 * Why nothing noticed: every producer of attachment paths on this platform is
 * `node:path.join`, so every attachment this app has ever created is a Windows
 * absolute path and every one of them was refused. Nothing tested the function,
 * and the only place it runs end to end is Electron's main process, which no
 * test drives.
 *
 * Measured on a live box before the fix: a 232109-byte JPEG committed at
 * `<root>/agents/<id>/attachments/<sha256>.jpg` was answered `null` by
 * `normalizeAttachmentSource` and by the whole `resolveMedia` chain, while the
 * host read the identical path back over the gateway as HTTP 200 with a
 * 309503-character data URL. The renderer's media resolver turns a `null` into
 * `{ status: "missing" }` and the transcript card renders that as
 * "Image unavailable" — the symptom that was reported.
 *
 * What this now proves: a native absolute path survives normalisation, the
 * desktop edge returns the real bytes for an image that exists on disk, and the
 * inputs the old code refused for a reason of its own are still refused.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function buildModule(temporary, name, entry) {
  const output = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return output;
}

async function loadAttachmentEdgeModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-source-"));
  const stamp = Date.now();
  const [edge, manager, mime, extensions] = await Promise.all([
    buildModule(temporary, "attachments", "source/electron-main/attachments/attachments.ts"),
    buildModule(temporary, "attachment-manager", "source/electron-main/attachments/attachment-manager.ts"),
    buildModule(temporary, "image-mime", "source/shared/media/image-mime.ts"),
    buildModule(temporary, "media-extensions", "source/shared/media/media-extensions.ts"),
  ]);
  return {
    module: await import(`${pathToFileURL(edge).href}?${stamp}`),
    manager: await import(`${pathToFileURL(manager).href}?${stamp}`),
    mime: await import(`${pathToFileURL(mime).href}?${stamp}`),
    extensions: await import(`${pathToFileURL(extensions).href}?${stamp}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

/** A 1x1 PNG. Small enough to keep in the test, real enough to be served. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The edge deps with the product's own image resolver in the seat the production
 * adapter gives it. `resolveImageAttachment` and the mime tables are real code:
 * a hand-written stand-in here would pass whether or not the product can open a
 * file, which is exactly the trap this test exists to avoid.
 */
function edgeDeps({ manager, mime, extensions }, readAttachmentImage) {
  const nativeImageStub = {
    createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    createFromDataURL: () => ({ isEmpty: () => true }),
  };
  const { AUDIO_MIME_FROM_EXTENSION, IMAGE_MIME_FROM_EXTENSION, VIDEO_MIME_FROM_EXTENSION, extensionOf } = extensions;
  return {
    legs: {
      readAttachmentImage,
      readAttachmentText: async () => null,
      readAttachmentChunk: async () => null,
      uploadAttachment: async () => { throw new Error("the upload leg is not exercised by this test"); },
    },
    getMainWindow: () => null,
    onEdgeFailure: () => {},
    videoMimeFromPath: (value) => VIDEO_MIME_FROM_EXTENSION[extensionOf(value)] ?? null,
    audioMimeFromPath: (value) => AUDIO_MIME_FROM_EXTENSION[extensionOf(value)] ?? null,
    displayableImageMimeFromPath: (value) => IMAGE_MIME_FROM_EXTENSION[extensionOf(value)] ?? null,
    buildMediaUrl: (value) => `sand-media://attachment/${encodeURIComponent(value)}`,
    resolveImage: (value, readRemote) => manager.resolveImageAttachment(value, readRemote, {
      nativeImage: nativeImageStub,
      readPortableDimensions: () => null,
      servableImageMimeFromPath: (candidate) => mime.servableImageMimeFromPath(candidate) ?? null,
    }),
    fetchLinkMetadata: async () => null,
    boundPreviewImage: () => null,
    nativeImage: nativeImageStub,
    getUserDataDir: () => os.tmpdir(),
    downloadsDir: os.tmpdir(),
    previewKindNeedsBytes: () => false,
    getFilePreviewKind: () => "image",
    previewByteCap: 1024,
    byteLimitForName: () => 25 * 1024 * 1024,
    getStagingDir: () => path.join(os.tmpdir(), "grok-attachment-source-staging"),
    isWithinStagingDir: () => false,
    resolveSuggestedDownloadName: ({ sourcePath }) => sourcePath,
    resolveDefaultDownloadPath: () => os.tmpdir(),
    showSaveDialog: async () => ({ canceled: true }),
    createHiddenWindow: () => null,
    showErrorMessage: async () => {},
  };
}

test("a native absolute path is an attachment source, not a URL scheme", async () => {
  const loaded = await loadAttachmentEdgeModule();
  try {
    const { normalizeAttachmentSource } = loaded.module;
    const drive = path.join(os.tmpdir(), "grok", "agents", "a", "attachments", "photo.png");

    assert.equal(
      normalizeAttachmentSource(drive),
      drive,
      "the absolute path node:path.join produced was refused, so no attachment this app stores can be previewed",
    );

    // A drive letter is a URL scheme. That is the whole defect, stated as data.
    assert.equal(new URL("C:\\agents\\a\\attachments\\photo.png").protocol, "c:", "a drive letter parses as a scheme");
    assert.equal(
      normalizeAttachmentSource("C:\\agents\\a\\attachments\\photo.png"),
      "C:\\agents\\a\\attachments\\photo.png",
      "a Windows absolute path with a backslash separator must survive normalisation",
    );
    assert.equal(
      normalizeAttachmentSource("d:/agents/a/attachments/photo.png"),
      "d:/agents/a/attachments/photo.png",
      "a Windows absolute path with a forward-slash separator must survive normalisation too",
    );
    assert.equal(
      normalizeAttachmentSource("file:///C:/agents/a/attachments/photo.png"),
      "C:/agents/a/attachments/photo.png",
      "a file: URL that decodes to /C:/... is not a path Windows can open, so the leading slash is dropped",
    );

    // Everything the old code refused for a reason of its own stays refused.
    assert.equal(normalizeAttachmentSource("https://example.com/photo.png"), null, "a remote URL is not a local file");
    assert.equal(normalizeAttachmentSource("data:image/png;base64,AAAA"), null, "an inline data URL is not a file path");
    assert.equal(normalizeAttachmentSource("sand-media://attachment/photo.mp4"), null, "a media scheme URL is not read here");
    assert.equal(
      normalizeAttachmentSource("/home/box/sand-data/agents/a/attachments/photo.png"),
      "/home/box/sand-data/agents/a/attachments/photo.png",
      "a POSIX path decodes unchanged and must still pass through",
    );
    assert.equal(
      normalizeAttachmentSource("attachments/photo.png"),
      "attachments/photo.png",
      "a string that is not a URL still passes through exactly as it arrived",
    );
    assert.equal(normalizeAttachmentSource("C:photo.png"), null, "a drive-relative path is not an absolute path");
    assert.equal(normalizeAttachmentSource(""), null, "an empty source names no file");
    assert.equal(normalizeAttachmentSource(undefined), null, "a missing source names no file");
  } finally {
    await loaded.dispose();
  }
});

test("the desktop edge returns the image bytes for a file the host already stored", async () => {
  const loaded = await loadAttachmentEdgeModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-source-e2e-"));
  try {
    // The host creates the agent's attachments directory when it writes, so the
    // fixture does the same rather than handing the edge a path that never was.
    const stored = path.join(temporary, "agents", "agent-under-test", "attachments", "photo.png");
    await mkdir(path.dirname(stored), { recursive: true });
    await writeFile(stored, ONE_PIXEL_PNG);

    const { readFile } = await import("node:fs/promises");
    const port = loaded.module.createAttachmentEdgePort(edgeDeps(loaded, async ({ path: value }) => {
      try {
        const data = await readFile(value);
        return { dataUrl: `data:image/png;base64,${data.toString("base64")}`, width: 1, height: 1 };
      } catch { return null; }
    }));

    const resolved = await port.resolveMedia(stored);

    assert.notEqual(resolved, null, "resolveMedia answered null, which the renderer renders as \"Image unavailable\"");
    assert.equal(resolved.kind, "image", "a stored PNG must resolve as an image, not as a file or a video");
    assert.equal(
      resolved.dataUrl,
      `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`,
      "the bytes handed to the renderer must be the bytes on disk",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});