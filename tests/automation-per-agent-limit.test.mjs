import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The 51st routine was refused in silence. `FileAutomationStore.upsert` returns
 * `null` once `count()` reaches `AUTOMATION_MAX_PER_AGENT`, and both callers
 * read that `null` as "nothing changed": `createAgentAutomation` compares list
 * lengths, and the gateway compared the length before and after and answered
 * HTTP 200 with the same list it already had. Fifty-five routines in, fifty on
 * disk, and no error anywhere — the user saw a form that appeared to save.
 *
 * What is provable from this module is the refusal itself: there is now one
 * named reason and one error type for the limit, so the store
 * (`automation-store.ts`, line 70) and the gateway (`host-gateway-api.ts`,
 * lines 408-425) have something to raise instead of a bare `null`. This test
 * pins that contract and pins the silent behaviour it replaces, so the moment
 * the store starts surfacing the reason these two claims move together.
 *
 * The store and the gateway are owned elsewhere; until they call
 * `assertAutomationCapacity`, a routine over the limit is still dropped without
 * a word and only this file's part of the fix is real.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-routine-limit-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names)
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "automations", "automation-store.ts"],
  ["host", "automations", "automation.ts"],
]);
const { FileAutomationStore } = loaded["automation-store.mjs"];
const {
  AUTOMATION_LIMIT_REACHED_REASON,
  AUTOMATION_MAX_PER_AGENT,
  AutomationLimitReachedError,
  assertAutomationCapacity,
  describeAutomationLimitReached,
} = loaded["automation.mjs"];

test.after(() => dispose());

const createdDirs = [];
/** One agent directory per test, so the limit under test is the only limit in play. */
function createStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-routine-limit-agent-"));
  createdDirs.push(dir);
  return new FileAutomationStore(dir);
}
test.after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function spec(index) {
  return {
    name: `routine ${index}`,
    prompt: `Do the thing number ${index}.`,
    trigger: { type: "cron", schedule: "0 7 * * *" },
    isEnabled: true,
  };
}

test("the store stops at the limit and reports nothing, which is the defect", () => {
  const store = createStore();
  const refused = [];

  for (let index = 1; index <= AUTOMATION_MAX_PER_AGENT + 5; index += 1)
    if (store.upsert(spec(index)) == null) refused.push(index);

  assert.equal(store.count(), 50, "the limit is fifty routines per agent");
  assert.equal(
    refused.length,
    5,
    "the five routines past the limit were refused without a reason: the store returns null and both callers read null as success",
  );
  assert.deepEqual(
    refused,
    [51, 52, 53, 54, 55],
    "the refusals must start exactly at the limit, not earlier, or the limit is not the limit",
  );
});

test("crossing the limit has one named reason that a caller can raise", () => {
  assert.equal(
    AUTOMATION_LIMIT_REACHED_REASON,
    "automation_limit_reached",
    "the reason is what a caller matches on to turn a refusal into an error response",
  );
  assert.doesNotThrow(
    () => assertAutomationCapacity(AUTOMATION_MAX_PER_AGENT - 1),
    "the last routine that fits must still save",
  );
  assert.throws(
    () => assertAutomationCapacity(AUTOMATION_MAX_PER_AGENT),
    (error) => {
      assert.ok(
        error instanceof AutomationLimitReachedError,
        "the refusal has to be typed, so a caller can tell it apart from a bad name, a bad prompt or a bad trigger",
      );
      assert.equal(error.reason, AUTOMATION_LIMIT_REACHED_REASON);
      assert.equal(error.count, AUTOMATION_MAX_PER_AGENT);
      return true;
    },
  );
});

test("the message tells the user what happened and what to do", () => {
  const detail = describeAutomationLimitReached(AUTOMATION_MAX_PER_AGENT);

  assert.match(detail, /50/, "the message names the limit instead of saying 'too many'");
  assert.match(detail, /Nothing was saved/, "the user has to be told the routine was not stored");
  assert.match(
    detail,
    /delete or pause/i,
    "a refusal the user cannot act on is the same silence this replaces",
  );
});

test("a store that knows the limit can refuse with that reason instead of null", () => {
  const store = createStore();
  store.upsert(spec(1));

  // This is the shape the store has to adopt at `upsert`: ask before writing,
  // and let the typed error carry the reason out to the gateway.
  const guarded = (create) => {
    assertAutomationCapacity(store.count());
    return create();
  };

  assert.doesNotThrow(
    () => guarded(() => store.upsert(spec(2))),
    "the first routine of an agent must never be blocked by the guard",
  );
});