/**
 * A provider failure was replaced by `WriteIterableClosedError` before it ever reached the
 * turn. `duplicateStream` feeds one provider stream into two consumers — the collector and the
 * UI — and it awaited `stream1.write(chunk)` then `stream2.write(chunk)` in sequence.
 * `WritableIterable.write` only settles when a reader takes the chunk, and any consumer that
 * stops reading closes its branch. `consumeStream` has three exit paths that do exactly that
 * (a single-message loop guard at `interaction-handler.ts:201`, the deliberate `return` on
 * `InputTokenLimitError`, and the early `throw` on a consumer-side error), so the UI branch was
 * routinely closed while the collector was still waiting. The next write to the closed branch
 * threw `WriteIterableClosedError`, the pump caught it, and it handed *that* to the collector —
 * the real reason the provider failed was discarded, and the caller then threw the substitute.
 *
 * The pump also ended in `void run().catch(error => { throw error })`. A rethrow inside a
 * `catch` of a floating promise is an unhandled rejection, and an unhandled rejection in the
 * Electron main process terminates it with the provider's reason nowhere in the transcript.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "source", "packages", "agent", "tool-stream-executor.ts");

async function bundle(entry) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-tool-stream-"));
  const outfile = path.join(directory, `${path.basename(entry.at(-1), ".ts")}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source", ...entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    external: ["prom-client"],
  });
  return { module: await import(pathToFileURL(outfile).href), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { module: executor, dispose } = await bundle(["packages", "agent", "tool-stream-executor.ts"]);
const { duplicateStream } = executor;
test.after(() => dispose());

/** Stands in for the turn context: `duplicateStream` only logs through it. */
const ctx = { signal: new AbortController().signal };

function failingSource(chunks, failure) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
    throw failure;
  })();
}

test("a consumer that stopped reading does not replace the provider's reason with a closed-stream error", async () => {
  const providerFailure = new Error("upstream stream failed: provider returned 500");
  const [collector, uiStream] = duplicateStream(ctx, failingSource(["a", "b", "c"], providerFailure));

  // `consumeStream` reads one chunk and then bails out on its loop guard, which closes the UI
  // branch of the duplication.
  const uiConsumed = (async () => {
    for await (const chunk of uiStream) {
      assert.equal(chunk, "a", "the UI branch saw a chunk out of order");
      break;
    }
  })();

  const collected = [];
  let collectorError = null;
  try {
    for await (const chunk of collector) collected.push(chunk);
  } catch (error) {
    collectorError = error;
  }
  await uiConsumed;

  assert.deepEqual(collected, ["a", "b", "c"], "the collector lost chunks that the provider had already sent");
  assert.equal(
    collectorError,
    providerFailure,
    "the collector was told the stream was closed instead of being told why the provider failed",
  );
});

test("a failing pump never becomes an unhandled rejection in the main process", async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const providerFailure = new Error("provider connection reset");
    const [collector, uiStream] = duplicateStream(ctx, failingSource(["x"], providerFailure));
    void (async () => { for await (const _chunk of uiStream) { /* drain */ } })().catch(() => {});
    await collector[Symbol.asyncIterator]().next().catch(() => {});
    // One macrotask is enough for any floating rejection to surface.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(
    seen.map((reason) => (reason instanceof Error ? reason.message : String(reason))),
    [],
    "a rejected duplication pump takes down the Electron main process",
  );
});

test("the duplication pump contains no rethrow from a floating promise", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.ok(source.length > 0, "the guard read an empty file, so it cannot prove anything");
  const start = source.indexOf("export function duplicateStream");
  assert.notEqual(start, -1, "the guard could not find the duplication pump, so it proved nothing");
  const body = source.slice(start, source.indexOf("\n}", start));
  const rethrows = [...body.matchAll(/catch\s*\(\s*error[^\)]*\)\s*\{\s*throw\s+error\s*;/g)];
  assert.deepEqual(
    rethrows.length,
    0,
    "a `catch` that rethrows inside a floating promise is an unhandled rejection in the main process",
  );
});