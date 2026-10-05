import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * No photo could be attached from the composer at all, and every file — not just
 * images — reported `Couldn't attach "photo.jpg".`
 *
 * What broke: `stageBytes` in
 * `source/electron-main/attachments/attachments.ts` built the staged file name
 * with `` `${(deps.now ?? Date.now)()}-${(deps.randomUUID ?? crypto.randomUUID)()}${extname(filename)}` ``.
 * `deps.randomUUID` is declared optional and
 * `createProductionAttachmentGatewayBinding` never supplies it, so the fallback
 * runs. That fallback is the **global Web Crypto** `crypto`, whose `randomUUID`
 * is a class method: the `??` extracts the function, the trailing `()` calls it
 * with no receiver, and V8 throws
 * `TypeError [ERR_INVALID_THIS]: Value of "this" must be of type Crypto`. The
 * throw lands in `stageBytes`' own catch, which reports it to `onEdgeFailure` and
 * returns `{ ok: false, reason: "failed" }`.
 *
 * Why nothing noticed: every other `randomUUID` in this repository is imported
 * from `node:crypto` as a free function, which detaches harmlessly — so the
 * `(x ?? y)()` idiom is correct everywhere except the one place that used the
 * global. The failure is invisible in review because the deps object looks
 * optional rather than half-used, and the reason string the composer finally
 * shows ("Couldn't attach") names the user, not the port that threw.
 *
 * Measured on this machine before the fix, driving the real `createAttachmentEdgePort`:
 * `stageBytes("photo.png", new Uint8Array(png))` returned
 * `{"ok":false,"reason":"failed"}` with
 * `onEdgeFailure({"leg":"stage","errorClass":"TypeError"})` — for a valid filename,
 * non-empty bytes and a byte limit far above the payload. The staging directory
 * was created and left empty.
 *
 * What this now proves: with the production dep shape — no `randomUUID`, no
 * `now` — staging returns `ok: true` and the bytes are on disk under the staging
 * directory, and the three refusal reasons still name the file for the reasons
 * they were written for.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAttachmentEdgeModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-stage-"));
  const output = path.join(temporary, "attachments.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/attachments/attachments.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return {
    module: await import(`${pathToFileURL(output).href}?${Date.now()}`),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

/**
 * The production dep shape. `resolveDeps` in
 * `source/electron-main/adapters/attachment-gateway.ts` returns no `now` and no
 * `randomUUID`, and `validateAttachmentDeps` does not require either, so those
 * two keys are deliberately absent here: a test that supplied them would pass
 * against code that cannot run in the app.
 */
function edgeDeps(stagingDir, failures) {
  const nativeImageStub = {
    createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    createFromDataURL: () => ({ isEmpty: () => true }),
  };
  return {
    legs: {
      readAttachmentImage: async () => null,
      readAttachmentText: async () => null,
      readAttachmentChunk: async () => null,
      uploadAttachment: async () => { throw new Error("the upload leg is not exercised by this test"); },
    },
    getMainWindow: () => null,
    onEdgeFailure: (failure) => failures.push(failure),
    videoMimeFromPath: () => null,
    audioMimeFromPath: () => null,
    displayableImageMimeFromPath: () => "image/png",
    buildMediaUrl: (value) => value,
    resolveImage: async () => null,
    fetchLinkMetadata: async () => null,
    boundPreviewImage: () => null,
    nativeImage: nativeImageStub,
    getUserDataDir: () => os.tmpdir(),
    downloadsDir: os.tmpdir(),
    previewKindNeedsBytes: () => false,
    getFilePreviewKind: () => "image",
    previewByteCap: 1024,
    byteLimitForName: () => 25 * 1024 * 1024,
    getStagingDir: () => stagingDir,
    isWithinStagingDir: (value) => value.startsWith(stagingDir),
    resolveSuggestedDownloadName: ({ sourcePath }) => sourcePath,
    resolveDefaultDownloadPath: () => os.tmpdir(),
    showSaveDialog: async () => ({ canceled: true }),
    createHiddenWindow: () => null,
    showErrorMessage: async () => {},
  };
}

test("the composer can stage a photo when no randomUUID dependency is supplied", async () => {
  const loaded = await loadAttachmentEdgeModule();
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-stage-dir-"));
  try {
    const failures = [];
    const port = loaded.module.createAttachmentEdgePort(edgeDeps(stagingDir, failures));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

    const result = await port.stageBytes("photo.png", bytes);

    assert.deepEqual(failures, [], "staging reported an edge failure, so the port threw instead of writing the file");
    assert.equal(result.ok, true, "the composer turns a false here into \"Couldn't attach\", so no file could ever be attached");
    assert.equal(typeof result.path, "string", "a successful stage must name the file it wrote");

    const staged = await readdir(stagingDir);
    assert.equal(staged.length, 1, "exactly one staged file must exist for one attachment");
    assert.equal(staged[0].endsWith(".png"), true, "the staged name must keep the extension the composer sent, or the host classifies it as an unknown binary");

    const written = await readFile(result.path);
    assert.deepEqual([...written], [...bytes], "the staged bytes must be the bytes the renderer sent, byte for byte");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("staging a photo works on every call, not only the first", async () => {
  const loaded = await loadAttachmentEdgeModule();
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-stage-repeat-"));
  try {
    const port = loaded.module.createAttachmentEdgePort(edgeDeps(stagingDir, []));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await port.stageBytes("photo.png", new Uint8Array([attempt]));
      assert.equal(result.ok, true, `attempt ${attempt + 1} of 5 was refused, so the failure would be intermittent rather than total`);
    }
    assert.equal((await readdir(stagingDir)).length, 5, "each attempt must write its own staged file");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("a supplied randomUUID dependency is still the one that is used", async () => {
  const loaded = await loadAttachmentEdgeModule();
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-stage-dep-"));
  try {
    const deps = edgeDeps(stagingDir, []);
    deps.now = () => 1000;
    deps.randomUUID = () => "fixed-uuid";
    const port = loaded.module.createAttachmentEdgePort(deps);

    const result = await port.stageBytes("photo.png", new Uint8Array([7, 7]));

    assert.equal(result.ok, true, "the injected clock and id must produce the same successful write");
    assert.equal(path.basename(result.path), "1000-fixed-uuid.png", "the supplied dependencies must decide the name, not the fallback");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("the three refusal reasons still name the file for their own reasons", async () => {
  const loaded = await loadAttachmentEdgeModule();
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-stage-refuse-"));
  try {
    const port = loaded.module.createAttachmentEdgePort(edgeDeps(stagingDir, []));

    assert.deepEqual(
      await port.stageBytes("photo.png", new Uint8Array(0)),
      { ok: false, reason: "empty" },
      "zero bytes is \"empty\", which the composer explains as an empty file rather than as a failure",
    );
    assert.deepEqual(
      await port.stageBytes("photo.png", new Uint8Array(25 * 1024 * 1024 + 1)),
      { ok: false, reason: "too-large" },
      "a payload over the byte limit is \"too-large\", which the composer explains with the limit",
    );
    assert.deepEqual(
      await port.stageBytes("sub/dir/photo.png", new Uint8Array([1])),
      { ok: false, reason: "failed" },
      "a filename carrying a path separator is refused before anything is written",
    );
    assert.deepEqual(
      await port.stageBytes("photo.png", { 0: 1, 1: 2 }),
      { ok: false, reason: "failed" },
      "bytes that did not arrive as a Uint8Array are refused before anything is written",
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});