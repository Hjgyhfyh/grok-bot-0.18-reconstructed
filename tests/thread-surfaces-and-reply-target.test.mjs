import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as acorn from "acorn";
import { build } from "esbuild";

import {
  COMPONENT_SOURCE,
  patchOriginalAccountSlot,
  patchOriginalSettingsRegistry,
  patchOriginalSignInGate,
  patchOriginalThreadSurfaces,
} from "../scripts/lib/router-renderer-patch.mjs";

/**
 * A thread reply lost its identity on both sides of the wire, and neither loss raised
 * anything.
 *
 * Host: `resolveSendReplyThreading` asked only the in-memory transcript cache whether a
 * `replyToId` existed. That cache is a cache — `clearActiveTranscript` resets it to an
 * empty list while still stamping `inMemoryTranscriptAgentId`, so it can describe an agent
 * with none of its entries. On that miss the reply target was dropped, `isFork` collapsed
 * to false because it is gated on `replyToId != null`, and the user's message was written
 * as an ordinary entry in the main feed while the renderer was showing the thread. The
 * agent answered there too, so from the thread the message looked deleted and the reply
 * looked never sent. The durable store already held the entry and was never consulted.
 *
 * Renderer: a thread root lives outside the loaded window once a conversation is longer
 * than the 500-entry tail the renderer fetches, and this build never asks the host for a
 * thread by id. `N_n` resolved that ambiguity by deleting the entry from both the main
 * feed and the thread summary, and the open-thread guard closed the thread outright when
 * its root was not in the entry map. Same result, no error: the message the user had just
 * sent disappeared and nothing was left to click.
 *
 * The tests below pin both halves. They also pin what the fix must NOT change — the
 * payload anchors, the checksummed patch lines, and the shipped chunk still parsing — so a
 * future upstream move fails here instead of shipping a blank window.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_CHUNK = path.join(
  repoRoot,
  "src",
  "app",
  "dist",
  "renderer",
  "assets",
  "index-lA9cgT4O.js",
);
const PATCH_MODULE = path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs");

// Baseline md5 prefixes for lines 5-11 of the patch module. These lines are the anchors
// that carry the whole Settings extension; a build that changes one of them silently
// changes the injected bytes while `verify` still compares against the record the same run
// produced.
const PROTECTED_LINES = {
  5: "ABBDC82204",
  6: "60F9ABAEF8",
  7: "4AF368A8ED",
  8: "A1CC810621",
  9: "4143D5C2BA",
  10: "5AFB1B34C9",
  11: "881C5D6D30",
};

const registryChunk = readFileSync(REGISTRY_CHUNK, "utf8");
const patchedRegistryChunk = [
  patchOriginalSettingsRegistry,
  patchOriginalSignInGate,
  patchOriginalAccountSlot,
  patchOriginalThreadSurfaces,
].reduce((source, transform) => transform(source), registryChunk);

function occurrences(source, needle) {
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The shipped `N_n` orphan branch: drop the entry when older history may hold the root. */
const DROPPING_ORPHAN_BRANCH = "if(u==null){if(t){r=!0;continue}i.push(c);continue}";
/** The shipped close guard: drop an open thread whose root is not in the entry map. */
const UNGUARDED_THREAD_CLOSE = "!d&&A!=null&&!Y.has(A)&&E(null)";
/** The whole render-phase statement the guard lives in, which is what the patch anchors on. */
const CLOSE_GUARD_STATEMENT =
  "!d&&I!=null&&!Y.has(I)&&P(null),!d&&A!=null&&!Y.has(A)&&E(null)";

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-thread-"));
  const files = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    const outfile = path.join(directory, name);
    files.push([name, outfile]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of files) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "transcript", "send-thread-stamping.ts"],
]);
const { resolveSendReplyThreading } = loaded["send-thread-stamping.mjs"];

test.after(() => dispose());

/** A turn runtime with the shipped identity rules and no behaviour of its own. */
function turnRuntime(entries) {
  return {
    resolveReplyTarget: (list, id) =>
      list.some((entry) => entry.id === id) ? id : undefined,
    buildReplyContext: (list, targetId) => {
      if (targetId == null) return undefined;
      const target = list.find((entry) => entry.id === targetId);
      return target == null ? undefined : { targetId, quote: target.content };
    },
  };
}

const ROOT = { id: "t0u", kind: "message", role: "user", content: "ROOT-OK" };

test("a thread root the in-memory cache has lost is still stamped as a thread reply", () => {
  // The renderer only ever sees a 500-entry tail, and the host cache is a cache. Neither
  // is the record; the store is.
  const store = new Map([[ROOT.id, ROOT]]);
  const resolved = resolveSendReplyThreading(
    { turnRuntime: turnRuntime([]) },
    ROOT.id,
    true,
    () => [],
    (id) => store.get(id) ?? null,
  );

  assert.equal(
    resolved.replyToId,
    ROOT.id,
    "the reply target was dropped, so the message left the thread the user was looking at",
  );
  assert.equal(
    resolved.isFork,
    true,
    "without branched:true the entry was written to the main feed instead of the thread",
  );
  assert.deepEqual(
    resolved.replyContext,
    { targetId: ROOT.id, quote: ROOT.content },
    "the quoted reply context needs the entry, not just its id",
  );
});

test("a reply target that is in neither the cache nor the store is still refused", () => {
  // The fallback must not turn a stale renderer into a dangling `replyTo`; an id the
  // agent has never seen stays a plain message, which is what happened before.
  const resolved = resolveSendReplyThreading(
    { turnRuntime: turnRuntime([]) },
    "t9u",
    true,
    () => [],
    () => null,
  );

  assert.equal(
    resolved.replyToId,
    undefined,
    "an id that exists nowhere must not become a reply target",
  );
  assert.equal(
    resolved.isFork,
    false,
    "isFork is gated on a resolved reply target, so it must follow the refusal",
  );
});

test("a send with no reply target is untouched by the durable fallback", () => {
  let storeReads = 0;
  const resolved = resolveSendReplyThreading(
    { turnRuntime: turnRuntime([ROOT]) },
    undefined,
    true,
    () => [ROOT],
    () => {
      storeReads += 1;
      return null;
    },
  );

  assert.equal(resolved.replyToId, undefined, "a plain send names no reply target");
  assert.equal(
    resolved.isFork,
    false,
    "isFork must not be true for a plain send, whatever the caller asked for",
  );
  assert.equal(storeReads, 0, "the store is only consulted for a named reply target");
});

test("the patched renderer keeps a branched entry whose thread root is off-window", () => {
  assert.equal(
    occurrences(registryChunk, DROPPING_ORPHAN_BRANCH),
    1,
    "the orphan branch in N_n must be a single unambiguous anchor, or the patch is a no-op",
  );
  assert.equal(
    patchedRegistryChunk.includes(DROPPING_ORPHAN_BRANCH),
    false,
    "the shipped renderer still deletes a message the user just sent when its root is off-window",
  );
  assert.equal(
    patchedRegistryChunk.includes("if(u==null){r=!0;i.push(c);continue}"),
    true,
    "the orphan must be kept in the visible feed so it is still on screen",
  );
});

test("the patched renderer closes an open thread only when the window is complete", () => {
  assert.equal(
    occurrences(registryChunk, UNGUARDED_THREAD_CLOSE),
    1,
    "the open-thread close guard must be a single unambiguous anchor",
  );
  assert.equal(
    patchedRegistryChunk.includes(UNGUARDED_THREAD_CLOSE),
    false,
    "an open thread is still closed by a partial window, which is what emptied the user's thread",
  );
  assert.equal(
    patchedRegistryChunk.includes("!d&&!f&&A!=null&&!Y.has(A)&&E(null)"),
    true,
    "the close must be gated on hasOlder: absence from a partial tail proves nothing",
  );
  assert.equal(
    patchedRegistryChunk.includes("!d&&I!=null&&!Y.has(I)&&P(null)"),
    true,
    "the reply-target reset is a separate guard and must survive the patch byte for byte",
  );
});

test("the thread patch refuses a drifted upstream chunk instead of half-applying", () => {
  assert.throws(
    () => patchOriginalThreadSurfaces(registryChunk.replace(DROPPING_ORPHAN_BRANCH, "")),
    /orphaned branch entry anchor is missing or ambiguous/,
    "an upstream move that renames the orphan branch must fail the build, not skip it",
  );
  const at = registryChunk.indexOf(CLOSE_GUARD_STATEMENT);
  const duplicated =
    registryChunk.slice(0, at) + CLOSE_GUARD_STATEMENT + registryChunk.slice(at);
  assert.equal(
    occurrences(duplicated, CLOSE_GUARD_STATEMENT),
    2,
    "the drift fixture must really hold two copies, or the guard test proves nothing",
  );
  assert.throws(
    () => patchOriginalThreadSurfaces(duplicated),
    /open-thread close guard anchor is missing or ambiguous/,
    "a duplicated close guard must be rejected rather than patched at the first match only",
  );
});

test("the checksummed patch lines and the patched chunk are unchanged in shape", () => {
  const lines = readFileSync(PATCH_MODULE, "utf8").split("\n");
  for (const [number, expected] of Object.entries(PROTECTED_LINES)) {
    const actual = createHash("md5")
      .update(Buffer.from(lines[Number(number) - 1], "utf8"))
      .digest("hex")
      .slice(0, 10)
      .toUpperCase();
    assert.equal(actual, expected, `protected patch line ${number} drifted`);
  }

  assert.doesNotThrow(
    () => acorn.parse(COMPONENT_SOURCE, { ecmaVersion: "latest" }),
    "COMPONENT_SOURCE must stay parseable or the panel chunk becomes TS1005 at end of file",
  );
  assert.doesNotThrow(
    () => acorn.parse(patchedRegistryChunk, { ecmaVersion: "latest", sourceType: "module" }),
    "the patched registry chunk must stay parseable",
  );
  assert.ok(
    COMPONENT_SOURCE.includes("Endpoint model list") &&
      COMPONENT_SOURCE.includes("RRouterFallbackModels"),
    "the endpoint model picker is a separate injected feature and must survive a new patch",
  );
});