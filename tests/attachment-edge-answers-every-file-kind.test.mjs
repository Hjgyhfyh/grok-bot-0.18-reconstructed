import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The composer's card, the PDF viewer and the "agent sent you a screenshot"
 * bubble all read the same two functions, and only one of them has ever been
 * driven with more than a PNG.
 *
 * `createAttachmentEdgePort` in `source/electron-main/attachments/attachments.ts`
 * is what the renderer's four attachment methods land on
 * (`resolveAttachmentMedia`, `readAttachmentText`, `readAttachmentBytes`,
 * `downloadAttachment` — `source/shared/rpc/main.ts:44-50`). Each of its three
 * reads starts with `normalizeAttachmentSource`, and each then takes a different
 * branch by file kind: `resolveMedia` answers an image / video / audio object,
 * `readBytes` answers raw bytes for the kinds that need a previewer, and
 * `readText` answers text or a binary verdict. A kind that falls through all
 * three is a file the user attached and can only download.
 *
 * The kinds that were never exercised together are the interesting ones, because
 * the branch table is three parallel lookups over the same extension:
 *
 *  - `getFilePreviewKind` knows `pdf`, `table`, `docx`, `json`, `markdown`;
 *    `imageMimeFromPath` knows nine image extensions and no pdf; and
 *    `readHostAttachmentChunk` reports a mime for image/video/audio only. So a
 *    PDF is answered by exactly one of the three, and a `.heic` — which
 *    `servableImageMimeFromPath` DOES know — is answered by none of them. That
 *    last one is measured below rather than asserted from reading, because it is
 *    the kind of gap that gets closed by a patch and reopened by a rename.
 *
 * What this now proves, with the real edge, the real `resolveImageAttachment`,
 * the real host read functions and the real `SendMessage` shaping in front of it:
 * every file kind gets an answer from every read, the answer is the one that kind
 * should get, and the sizes involved (a 25 MB ceiling, a 4 MB chunk) are the
 * product's own constants rather than numbers chosen to make a test pass.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-attachment-edge-"));
  const written = [];
  for (const [key, ...entry] of entries) {
    const file = path.join(directory, `${key}.mjs`);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: file,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    });
    written.push([key, file]);
  }
  const loaded = {};
  for (const [key, file] of written) loaded[key] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["attachments", "electron-main", "attachments", "attachments.ts"],
  ["manager", "electron-main", "attachments", "attachment-manager.ts"],
  ["protocol", "electron-main", "media", "media-protocol.ts"],
  ["mime", "shared", "media", "image-mime.ts"],
  ["kind", "shared", "media", "file-preview-kind.ts"],
  ["limits", "shared", "media", "attachment-limits.ts"],
  ["dimensions", "shared", "media", "image-dimensions.ts"],
  ["host", "host", "extensions", "attachments", "attachments-service.ts"],
  ["sendMessage", "host", "runner", "tools", "send-message-tool.ts"],
  ["schema", "host", "runner", "tools", "send-message-schema.ts"],
]);
test.after(() => dispose());

const { createAttachmentEdgePort, GATEWAY_READ_CHUNK_BYTES } = loaded.attachments;
const manager = loaded.manager;
const protocol = loaded.protocol;
const mime = loaded.mime;
const kind = loaded.kind;
const limits = loaded.limits;
const dimensions = loaded.dimensions;
const host = loaded.host;
const { buildSandSendMessage } = loaded.sendMessage;
const schema = loaded.schema;

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const previousRoot = process.env.SAND_DATA_ROOT;
const sandbox = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-sandbox-"));
process.env.SAND_DATA_ROOT = sandbox;
test.after(async () => {
  if (previousRoot === undefined) delete process.env.SAND_DATA_ROOT;
  else process.env.SAND_DATA_ROOT = previousRoot;
  await rm(sandbox, { recursive: true, force: true });
});

const agentDir = path.join(sandbox, "agents", AGENT_ID);
const attachmentsDir = path.join(agentDir, "attachments");
await mkdir(attachmentsDir, { recursive: true });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "utf8");
const CSV = Buffer.from("a,b\n1,2\n", "utf8");
const CORRUPT_PNG = Buffer.concat([PNG.subarray(0, 40), Buffer.alloc(512, 0xab)]);
/** Two chunks plus a remainder, so the chunk loop in readBoxBytes runs more than once. */
const CHUNKED_PDF = Buffer.concat([PDF, Buffer.alloc(2 * GATEWAY_READ_CHUNK_BYTES + 1234, 0x25)]);

const files = {
  "photo.png": PNG,
  "photo.jpg": JPEG,
  "report.pdf": PDF,
  "sheets.csv": CSV,
  "broken.png": CORRUPT_PNG,
  "data.zzz": Buffer.from("opaque bytes\n", "utf8"),
  "noextension": Buffer.from("opaque bytes\n", "utf8"),
};
for (const [name, bytes] of Object.entries(files)) {
  await writeFile(path.join(attachmentsDir, name), bytes);
}
await writeFile(path.join(attachmentsDir, "huge.pdf"), CHUNKED_PDF);

/** A video and a sound, so the media branch is not asserted from the mime table alone. */
const MP4 = Buffer.concat([
  Buffer.from("0000001c", "hex"),
  Buffer.from([0x6d, 0x70, 0x34, 0x32]),
  Buffer.alloc(64, 0),
]);
await writeFile(path.join(attachmentsDir, "clip.mp4"), MP4);

const storedPath = (name) => path.join(attachmentsDir, name);

/**
 * The production dependency set from `createProductionAttachmentGatewayBinding`
 * (`source/electron-main/adapters/attachment-gateway.ts:87-133`), with the real
 * host read functions in the leg seats and a `nativeImage` that reports what the
 * bytes actually contain. A stub that returned a fixed size here would make every
 * dimension assertion in this file meaningless, so `readDesktopImageSize`'s real
 * fallback — `readImageFileDimensions` — does the work instead.
 */
const nativeImage = {
  createFromBuffer: (buffer) => {
    const size = dimensions.readImageFileDimensions(buffer);
    return { isEmpty: () => size == null, getSize: () => size ?? { width: 0, height: 0 } };
  },
  createFromDataURL: () => ({ isEmpty: () => true }),
};
const edge = createAttachmentEdgePort({
  legs: {
    readAttachmentImage: (request) => host.readHostAttachmentImage(request.path),
    readAttachmentText: (request) => host.readAttachmentText(agentDir, request.path),
    readAttachmentChunk: async (request) => {
      const chunk = await host.readHostAttachmentChunk(agentDir, request.path, request.offset, request.length);
      return chunk == null ? null : { totalSize: chunk.totalSize, bytesBase64: chunk.bytesBase64 };
    },
    uploadAttachment: async () => { throw new Error("the upload leg is not exercised by this file"); },
  },
  getMainWindow: () => null,
  onEdgeFailure: () => {},
  videoMimeFromPath: (value) => mime.videoMimeFromPath(value) ?? null,
  audioMimeFromPath: (value) => mime.audioMimeFromPath(value) ?? null,
  displayableImageMimeFromPath: (value) => mime.imageMimeFromPath(value) ?? null,
  buildMediaUrl: protocol.buildSandMediaUrl,
  resolveImage: (value, readRemote) =>
    manager.resolveImageAttachment(value, readRemote, {
      nativeImage,
      readPortableDimensions: (buffer) => dimensions.readWebpOrHeicDimensions(buffer),
      servableImageMimeFromPath: (value) => mime.servableImageMimeFromPath(value) ?? null,
    }),
  fetchLinkMetadata: async () => null,
  boundPreviewImage: () => null,
  nativeImage,
  getUserDataDir: () => sandbox,
  downloadsDir: sandbox,
  previewKindNeedsBytes: (value) => kind.previewKindNeedsBytes(value),
  getFilePreviewKind: (value) => kind.getFilePreviewKind(value),
  previewByteCap: limits.ATTACHMENT_BYTE_LIMIT,
  byteLimitForName: (name) => limits.attachmentByteLimitForName(name),
  getStagingDir: () => path.join(sandbox, "attachment-staging"),
  isWithinStagingDir: (value) => typeof value === "string" && value.startsWith(path.join(sandbox, "attachment-staging")),
  resolveSuggestedDownloadName: ({ sourcePath }) => sourcePath,
  resolveDefaultDownloadPath: () => sandbox,
  showSaveDialog: async () => ({ canceled: true }),
  createHiddenWindow: () => null,
  showErrorMessage: async () => {},
});

test("a stored image reaches the renderer as the bytes that are on disk", async () => {
  for (const [name, bytes, expectedKind] of [
    ["photo.png", PNG, "image/png"],
    ["photo.jpg", JPEG, "image/jpeg"],
  ]) {
    const resolved = await edge.resolveMedia(storedPath(name));
    assert.notEqual(resolved, null, `${name}: resolveMedia answered null, which the renderer renders as "Image unavailable"`);
    assert.equal(resolved.kind, "image", `${name}: an image resolved as ${resolved.kind}`);
    assert.equal(
      resolved.dataUrl,
      `data:${expectedKind};base64,${bytes.toString("base64")}`,
      `${name}: the bytes handed to the renderer are not the bytes on disk`,
    );
    assert.equal(resolved.width, 1, `${name}: a 1x1 image was measured as something else`);
    assert.equal(resolved.height, 1, `${name}: a 1x1 image was measured as something else`);
  }
});

test("a corrupt image is served as itself rather than as a missing one", async () => {
  const resolved = await edge.resolveMedia(storedPath("broken.png"));
  assert.notEqual(
    resolved,
    null,
    "a corrupt image was reported as missing, which is the exact symptom the drive-path fix produced for every healthy image",
  );
  assert.equal(
    resolved.dataUrl,
    `data:image/png;base64,${CORRUPT_PNG.toString("base64")}`,
    "the corrupt bytes were not returned unchanged, so the renderer cannot tell a broken image from an absent one",
  );
  // The header survived the corruption, so the dimensions are real. The pixels are
  // not, and the <img> fails to decode — which is an honest outcome and is why
  // the host does not second-guess the header.
  assert.equal(resolved.width, 1, "the intact IHDR of a corrupt PNG was measured as something else");
});

test("a video resolves to a media URL rather than to a data URL", async () => {
  const resolved = await edge.resolveMedia(storedPath("clip.mp4"));
  assert.notEqual(resolved, null, "a stored video resolved to nothing");
  assert.equal(resolved.kind, "video", "a stored video resolved as something other than a video");
  assert.equal(
    resolved.src,
    protocol.buildSandMediaUrl(storedPath("clip.mp4")),
    "the video was given a different URL than the one the media protocol parses",
  );
  assert.equal(
    protocol.parseSandMediaUrl(resolved.src),
    storedPath("clip.mp4"),
    "the media URL the renderer is handed does not parse back to the file it is meant to serve",
  );
});

test("a PDF is answered by the byte reader and by nothing else", async () => {
  const media = await edge.resolveMedia(storedPath("report.pdf"));
  assert.equal(media, null, "the media reader answered for a PDF, so the viewer would be handed a media object it cannot render");

  const bytes = await edge.readBytes(storedPath("report.pdf"));
  assert.notEqual(bytes, null, "the byte reader answered nothing for a PDF, so the PDF viewer has nothing to draw");
  assert.equal(bytes.kind, "bytes", `a PDF came back as ${bytes?.kind} instead of bytes`);
  assert.deepEqual(
    Buffer.from(bytes.bytes),
    PDF,
    "the PDF the viewer draws is not the PDF that was attached",
  );

  const text = await edge.readText(storedPath("report.pdf"));
  assert.equal(text?.kind, "binary", "a PDF was read as text");
});

test("a file larger than one chunk is assembled whole", async () => {
  assert.ok(
    CHUNKED_PDF.byteLength > 2 * GATEWAY_READ_CHUNK_BYTES,
    `the fixture is smaller than two chunks, so the assembly loop is never exercised (${CHUNKED_PDF.byteLength})`,
  );
  const bytes = await edge.readBytes(storedPath("huge.pdf"));
  assert.equal(bytes?.kind, "bytes", "a PDF spanning several chunks did not come back as bytes");
  assert.equal(
    bytes.bytes.length,
    CHUNKED_PDF.byteLength,
    "the assembled file is not the file that was attached, so a large PDF is silently truncated",
  );
  assert.deepEqual(
    Buffer.from(bytes.bytes),
    CHUNKED_PDF,
    "the assembled bytes differ from the attachment, so a chunk boundary lost or duplicated data",
  );
});

test("the preview ceiling is the product's own constant and it holds", async () => {
  const ceiling = limits.ATTACHMENT_BYTE_LIMIT;
  assert.equal(ceiling, 25 * 1024 * 1024, "the attachment ceiling is not the product's own constant any more");
  const overCeiling = path.join(attachmentsDir, "over.txt");
  await writeFile(overCeiling, Buffer.alloc(ceiling + 1, 0x61));
  try {
    // A caller may ask for more than the ceiling. It does not get it.
    const asked = await edge.readBytes(overCeiling, ceiling * 4);
    assert.equal(
      asked?.kind,
      "too-large",
      "a caller that asked for four times the ceiling still read a file over the ceiling, so the ceiling is only a default",
    );
    assert.equal(
      asked.size,
      ceiling + 1,
      "the too-large answer does not carry the real size, so the renderer cannot say how big the file is",
    );

    // And a caller that asks for less than the ceiling is obeyed exactly.
    const small = await edge.readBytes(storedPath("report.pdf"), 1);
    assert.equal(
      small?.kind,
      "too-large",
      "an explicit maxBytes below the file size did not produce the too-large answer",
    );
    assert.equal(small.size, PDF.byteLength, "the too-large answer reports the wrong size for an explicit maxBytes");
  } finally {
    await rm(overCeiling, { force: true });
  }
});

test("an unknown extension and an absent extension are both download-only", async () => {
  for (const name of ["data.zzz", "noextension"]) {
    const file = storedPath(name);
    assert.equal(await edge.resolveMedia(file), null, `${name}: the media reader invented a media object for it`);
    assert.equal(await edge.readBytes(file), null, `${name}: the byte reader answered for a kind with no previewer`);
    const text = await edge.readText(file);
    assert.notEqual(text, null, `${name}: the text reader answered nothing, so the card cannot show even a size`);
  }
  assert.equal(kind.getFilePreviewKind(storedPath("data.zzz")), "unknown", "an unknown extension is not classified as unknown");
  assert.equal(kind.getFilePreviewKind(storedPath("noextension")), "unknown", "an absent extension is not classified as unknown");
  assert.equal(kind.getFilePreviewKind(storedPath("report.pdf")), "pdf", "a PDF is not classified as a PDF");
});

test("a HEIC is servable by the host and unreachable by the desktop", async () => {
  // Measured rather than asserted from reading, because this is the seam where a
  // later rename reopens it silently: `servableImageMimeFromPath` is the union of
  // the two tables, and the desktop's own `displayableImageMimeFromPath` is only
  // the first one.
  const heic = storedPath("IMG_0001.HEIC");
  await writeFile(heic, Buffer.from("ftypheic", "utf8"));

  assert.equal(
    mime.servableImageMimeFromPath(heic),
    "image/heic",
    "the host's servable table lost heic, so the control for this measurement is gone",
  );
  assert.equal(
    mime.imageMimeFromPath(heic),
    undefined,
    "the desktop's displayable table now answers for heic, so this test no longer measures anything and needs rewriting",
  );
  assert.equal(
    kind.getFilePreviewKind(heic),
    "unknown",
    "a HEIC acquired a preview kind, so this gap is closed and the test should say so",
  );
  assert.equal(
    await edge.resolveMedia(heic),
    null,
    "the media reader answered for a HEIC even though the desktop's own displayable table has no answer for it",
  );
  await rm(heic, { force: true });
});

test("an image an agent sends is ingested and then reads back through the same card", async () => {
  // The SendMessage half of the area. `mcp-image-assets.ts:23` tells the agent to
  // pass the `fileUrl` it was handed, and `resolveAttachmentSource` converts that
  // URL to a path, ingests it, and converts the ingested path back to a URL. The
  // card the renderer draws never sees any of that: it sees the URL the tool
  // returned, and it asks `resolveAttachmentMedia` about it.
  const source = storedPath("photo.png");
  const fileUrl = pathToFileURL(source).href;
  const ingested = [];
  const shaped = await buildSandSendMessage(
    {},
    { type: "attachment", url: fileUrl, alt: "a photo" },
    {
      getIngestAttachment: () => async (sourcePath) => {
        ingested.push(sourcePath);
        const target = path.join(attachmentsDir, `sent-${ingested.length}.png`);
        await writeFile(target, await readFile(sourcePath));
        return target;
      },
      resolveBoxAttachment: async () => null,
      readMediaDimensions: async () => ({ width: 1, height: 1 }),
      onSendMessage: () => "t1s1",
    },
  );

  assert.equal(ingested.length, 1, "the agent's image was never ingested, so the host has no copy to serve");
  assert.equal(ingested[0], source, "the agent's image was ingested from a different path than the one it named");
  assert.equal(shaped.type, "attachment", "the agent's image was not shaped as an attachment");
  assert.equal(shaped.file_name, "photo.png", "the card has no filename to show, so the user cannot save what they were sent");
  assert.equal(shaped.width, 1, "the agent's image lost its dimensions, so the card reserves no space for it");

  const resolved = await edge.resolveMedia(shaped.url);
  assert.notEqual(resolved, null, "the card the renderer draws for an agent-sent image resolves to nothing");
  assert.equal(resolved.kind, "image", "an agent-sent image resolved as something other than an image");
  assert.equal(
    resolved.dataUrl,
    `data:image/png;base64,${PNG.toString("base64")}`,
    "the bytes shown for an agent-sent image are not the bytes that were sent",
  );

  // The refused forms, kept honest: a raw drive path is refused BY NAME, with a
  // message that tells the agent what to do instead, and it is not silently
  // dropped.
  assert.equal(schema.isValidAttachmentUrl(source), false, "a raw drive path was accepted as a URL");
  const issues = schema.refineSendMessage({ type: "attachment", url: source });
  assert.equal(issues.length, 1, `a raw drive path produced ${issues.length} complaints instead of one named one`);
  assert.match(issues[0].message, /file:\/\/ or https:\/\/ scheme/, "the refusal does not tell the agent what form to use instead");
  await assert.rejects(
    () => buildSandSendMessage({}, { type: "attachment", url: source }, { getIngestAttachment: () => undefined, onSendMessage: () => "t1s1" }),
    /file:\/\/ or https:\/\/ scheme/,
    "the schema refused the path but the tool built a message anyway",
  );

  // And a source that names no file is refused by the same schema, rather than
  // becoming an attachment card with an empty url behind it.
  await assert.rejects(
    () => buildSandSendMessage({}, { type: "attachment", url: "" }, { onSendMessage: () => "t1s1" }),
    /url is required when type is attachment/,
    "an attachment with no url was built anyway, so the user gets a card that opens nothing",
  );
});