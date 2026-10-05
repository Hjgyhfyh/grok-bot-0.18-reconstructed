/**
 * The application could not open at all. Opening the window threw
 * `TypeError: n.filter is not a function` from the renderer, and the sidebar never
 * painted.
 *
 * The renderer counts attachments for the last thing an agent said. It receives
 * them from the host projection, and the host was handing it a `Record<string,
 * number>` where the renderer does `kinds.filter(...)`. An object has no
 * `length`, so the renderer's own null-and-empty guard never fires and the call
 * reaches `.filter` on an object.
 *
 * This test does not re-describe what the renderer does. It reads the shipped
 * renderer chunk, pulls out the real counting function, and runs it against the
 * host's real output.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY_CHUNK = "index-lA9cgT4O.js";

/** The host projection, bundled so it can be exercised for real. */
async function loadProjection(repoRoot) {
  const esbuild = await import("esbuild");
  const out = await mkdtemp(join(tmpdir(), "grokbot-attachment-kinds-"));
  try {
    const entry = join(out, "entry.mjs");
    await writeFile(
      entry,
      `export { buildAttachmentLastEntry, collectLastAttachmentBatchKinds } from ${JSON.stringify(join(repoRoot, "source/host/extensions/session/session-projection.ts"))};`,
    );
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: join(out, "projection.mjs"),
      logLevel: "silent",
    });
    return await import(`file://${join(out, "projection.mjs")}`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/**
 * Pulls the attachment tally out of the real shipped renderer and runs it.
 *
 * The renderer is minified, so this reads the function body by its own source
 * rather than by a name: the guard that fails on a wrongly shaped argument is
 * what we want, and a faithful copy of that guard is the thing under test. The
 * shape handed to it is the host's, unchanged.
 */
function loadShippedRendererTally(chunkText) {
  const fn = chunkText.match(/function (\w+)\((\w+)\)\{if\(\2==null\|\|\2\.length===0\)return\[\];const \w+=\2\.filter\(/);
  assert.ok(fn, "the shipped renderer no longer holds the attachment tally this test pins");
  const start = chunkText.lastIndexOf(`function ${fn[1]}(`, fn.index);
  // Walk to the matching close brace so the tally comes along whole.
  let depth = 0;
  let i = chunkText.indexOf("{", start);
  for (; i < chunkText.length; i += 1) {
    if (chunkText[i] === "{") depth += 1;
    else if (chunkText[i] === "}") {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  const source = chunkText.slice(start, i);

  // The tally reads a label table for each kind it recognises. Pull that table
  // out of the same chunk rather than writing our own, so an unknown kind is
  // handled exactly as the shipped renderer handles it. It is an object of
  // objects, so it has to be cut by brace depth, not by a pattern.
  const decl = chunkText.indexOf("const mut=");
  assert.notEqual(decl, -1, "the shipped renderer's kind-label table moved");
  const open = chunkText.indexOf("{", decl);
  let d = 0;
  let j = open;
  for (; j < chunkText.length; j += 1) {
    if (chunkText[j] === "{") d += 1;
    else if (chunkText[j] === "}") {
      d -= 1;
      if (d === 0) { j += 1; break; }
    }
  }
  const labels = chunkText.slice(decl, j);
  const factory = new Function(`${labels}\n${source}; return ${fn[1]};`);
  return factory();
}

function findChunk(repoRoot) {
  // The payload is checksum-pinned, so the authoritative copy lives in the
  // shipped app tree rather than in anything this session rebuilt.
  return join(repoRoot, "src/app/dist/renderer/assets", REGISTRY_CHUNK);
}

test("the attachment tally the renderer runs does not throw on what the host sends", async () => {
  const repoRoot = process.cwd();
  const chunkText = await readFile(findChunk(repoRoot), "utf8");
  const tally = loadShippedRendererTally(chunkText);
  const { buildAttachmentLastEntry } = await loadProjection(repoRoot);

  const entry = buildAttachmentLastEntry(
    [
      { kind: "user-attachment", batchId: "b1", file_name: "one.png", file_path: "C:/box/one.png" },
      { kind: "user-attachment", batchId: "b1", file_name: "two.pdf", file_path: "C:/box/two.pdf" },
      { kind: "user-attachment", batchId: "b1", file_name: "three.png", file_path: "C:/box/three.png" },
    ],
    2,
  );

  assert.equal(entry.kind, "attachment", "the projection still reports an attachment batch");
  assert.equal(entry.count, 3, "the batch size is the number of attachments, not the number of kinds");

  // This is the call that threw. It is the renderer's own guard and its own
  // `.filter`, given the host's own output.
  const counted = tally(entry.kinds);

  assert.ok(Array.isArray(entry.kinds), "the renderer reads kinds as a list and calls filter on it");
  assert.equal(
    counted.reduce((sum, part) => sum + part.count, 0),
    3,
    "every attachment in the batch is accounted for by kind",
  );
  assert.deepEqual(
    counted.map((part) => part.kind).sort(),
    ["document", "image"],
    "two images and one document are two kinds, not three attachments",
  );
});

test("an attachment kind the renderer has no word for still reaches the call", async () => {
  const repoRoot = process.cwd();
  const chunkText = await readFile(findChunk(repoRoot), "utf8");
  const tally = loadShippedRendererTally(chunkText);
  const { buildAttachmentLastEntry } = await loadProjection(repoRoot);

  const entry = buildAttachmentLastEntry(
    [{ kind: "user-attachment", batchId: "b1", file_name: "sheet.xlsx", file_path: "C:/box/sheet.xlsx" }],
    0,
  );
  assert.equal(entry.count, 1);

  // The host classifies a spreadsheet as "document", while the shipped renderer
  // words its kinds as image/video/audio/pdf/markdown/table/json/text/document/
  // archive/file. Falling back to "file" is the renderer's own designed
  // behaviour, not a failure: what matters is that the call completes and the
  // attachment is still counted.
  const counted = tally(entry.kinds);
  assert.equal(counted.length, 1, "one kind in the batch reads as one part of the tally");
  assert.equal(
    counted.reduce((sum, part) => sum + part.count, 0),
    1,
    "the attachment is counted even when the renderer has no word for its kind",
  );
});

test("the projection's kinds field matches the shape the shared media contract declares", async () => {
  const repoRoot = process.cwd();
  const { buildAttachmentLastEntry } = await loadProjection(repoRoot);
  const entry = buildAttachmentLastEntry(
    [{ kind: "user-attachment", batchId: "b1", file_name: "clip.mp4", file_path: "C:/box/clip.mp4" }],
    0,
  );

  // `mergeKindCounts` in shared/media/attachments.ts is typed against
  // `AttachmentKindCount[]` and returns `{kind, count}[]`. If this ever drifts
  // back to a record, the two sides of that contract stop agreeing again.
  assert.ok(Array.isArray(entry.kinds), "shared/media/attachments.ts expects a list here");
  for (const part of entry.kinds) {
    assert.equal(typeof part.kind, "string", "each part names its kind");
    assert.equal(typeof part.count, "number", "each part carries how many");
  }
});