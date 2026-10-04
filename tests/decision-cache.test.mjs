import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDecisionCacheModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-decision-cache-"));
  const output = path.join(temporary, "decision-cache.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/runner/decisions/decision-cache.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const QUESTION = {
  type: "choice",
  instructions: "Choose the single option that best describes the state.",
  criteria: { block: "Unsafe.", allow: "Safe.", unclear: "Unclear." },
};

test("the cache key is a content hash of model, state and question and ignores key order", async () => {
  const loaded = await loadDecisionCacheModule();
  try {
    const { module } = loaded;
    const base = { model: "jev-1.13.0", state: "a state", question: QUESTION };
    const key = module.decisionCacheKey(base);
    assert.match(key, /^[0-9a-f]{64}$/);
    // The same question in a different key order is the same question.
    assert.equal(module.decisionCacheKey({ ...base, question: { ...QUESTION, criteria: { unclear: "Unclear.", allow: "Safe.", block: "Unsafe." } } }), key);
    // Any difference in model, state or the option set is a different question.
    assert.notEqual(module.decisionCacheKey({ ...base, model: "jev-1.13.1" }), key);
    assert.notEqual(module.decisionCacheKey({ ...base, state: "another state" }), key);
    assert.notEqual(module.decisionCacheKey({ ...base, question: { ...QUESTION, criteria: { ...QUESTION.criteria, allow: "Safe to run." } } }), key);
    // Adding an option moves every probability, so it must move the key too.
    assert.notEqual(module.decisionCacheKey({ ...base, question: { ...QUESTION, criteria: { ...QUESTION.criteria, ask: "Ask a human." } } }), key);
    // The question id is a readable prefix of the same hash.
    assert.equal(module.decisionQuestionId(key), key.slice(0, 16));

    // Array order is meaningful: a rubric is ordered, so a reversed rubric is another question.
    const rubric = { type: "score", instructions: "Rate.", criteria: ["harmful", "useful"] };
    assert.notEqual(module.decisionCacheKey({ ...base, question: rubric }), module.decisionCacheKey({ ...base, question: { ...rubric, criteria: ["useful", "harmful"] } }));
  } finally {
    await loaded.dispose();
  }
});

test("the cache expires on TTL and evicts the least recently used entry past its bound", async () => {
  const loaded = await loadDecisionCacheModule();
  try {
    const { module } = loaded;
    let clockMs = 1_000;
    const cache = new module.DecisionCache({ ttlMs: 500, maxEntries: 2, now: () => clockMs });
    cache.set("a", 1);
    cache.set("b", 2);
    assert.equal(cache.get("a"), 1);
    // "b" is now the least recently used entry.
    cache.set("c", 3);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.size, 2);

    clockMs += 499;
    assert.equal(cache.get("a"), 1);
    clockMs += 1;
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("c"), undefined);
    assert.equal(cache.size, 0);

    cache.set("d", 4);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get("d"), undefined);
    assert.throws(() => new module.DecisionCache({ ttlMs: 0 }), /ttlMs/);
    assert.throws(() => new module.DecisionCache({ maxEntries: 0 }), /maxEntries/);
    assert.equal(module.DEFAULT_DECISION_CACHE_TTL_MS, 900_000);
    assert.equal(module.DEFAULT_DECISION_CACHE_MAX_ENTRIES, 512);
  } finally {
    await loaded.dispose();
  }
});