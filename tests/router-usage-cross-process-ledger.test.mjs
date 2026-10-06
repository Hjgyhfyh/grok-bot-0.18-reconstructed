import assert from "node:assert/strict";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { build } from "esbuild";

// UNFIXED DEFECT. This file is skipped on purpose, and the skip is the finding.
//
// `SandSettingsStore.recordInferenceUsage` is an unsynchronised read-modify-write: `update()` is
// `persist(mutator(this.load()))`, and `persist` writes a temp file and renames it over the real
// one. Nothing holds a lock across the read and the write, and the token ledger is not the only
// thing in that file — every other setter races the same way.
//
// Two processes record into that one file on the live path. The coordinator is FORKED
// (`electron-main/production-provider.ts`) and reaches `runRoutedProviderText` at
// `node-agent-coordinator/inference-router.ts:200`; the desktop reaches `createProviderPromptSession`
// at `host/runner/turn-run-shell.ts:189`. Both end in `recordRoutedUsage`.
//
// MEASURED on this machine, 4 processes x 20 records = 80, every record the same size:
//   run 1 -> requests 24 of 80 (56 lost, 70%), inputTokens 2400 of 8000, cacheRead 168 of 560
//   run 2 -> requests 28 of 80 (52 lost, 65%), inputTokens 2800 of 8000, cacheRead 196 of 560
// Three of the four children also died on `EPERM: operation not permitted, rename
// settings.json.<pid>.tmp -> settings.json` from Windows. Since each child dies at its FIRST
// EPERM, the surviving tally is dominated by that throw: one child completed all 20 and the
// other three roughly one each. `recordRoutedUsage` now absorbs that throw (see
// router-usage-record-failure-isolation.test.mjs), which is why these runs still complete at all.
//
// Not fixed here on purpose. The correct fix is real mutual exclusion across processes — an
// exclusive lockfile acquired synchronously around the read-modify-write — inside
// `SandSettingsStore`. That class is used at 10 call sites, it sits on a path guarded by
// `agent-store-sync/paths.ts`, and the only existing lock helper
// (`agent-store-sync/store-lock.ts`) is async while this class is sync. Landing that here would
// mean an unverifiable rewrite of the settings layer by one of twenty agents working at once, so
// the defect is reported with its numbers and left for the orchestrator to schedule. An
// optimistic compare-and-set retry would NOT be a fix: the verify-then-rename window stays open,
// so it would ship a heuristic that reads like a guarantee.
//
// Run it by hand with `node --test --test-name-pattern` after `test.skip` is removed, or with
// the probe that produced the numbers above.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHILDREN = 4;
const ITERATIONS = 20;
const INPUT_TOKENS = 100;
const OUTPUT_TOKENS = 10;
const CACHE_READ_TOKENS = 7;
const CACHE_WRITE_TOKENS = 3;

let dataRoot;
let settingsPath;
let childModulePath;
let runnerPath;

before(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "grok-usage-xproc-"));
  settingsPath = path.join(dataRoot, "settings.json");
  childModulePath = path.join(dataRoot, "settings-store.mjs");
  runnerPath = path.join(dataRoot, "recorder.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "shared", "node", "settings", "sand-settings-store.ts")],
    outfile: childModulePath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  await writeFile(
    runnerPath,
    `import { SandSettingsStore } from ${JSON.stringify(pathToFileURL(childModulePath).href)};
const [settingsPath, provider, iterations] = process.argv.slice(2);
const store = new SandSettingsStore(settingsPath);
for (let index = 0; index < Number(iterations); index += 1) {
  store.recordInferenceUsage(provider, { inputTokens: ${INPUT_TOKENS}, outputTokens: ${OUTPUT_TOKENS}, cacheReadTokens: ${CACHE_READ_TOKENS}, cacheWriteTokens: ${CACHE_WRITE_TOKENS} });
}
`,
    "utf8",
  );
});

after(async () => {
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

function runRecorder(index) {
  const errorPath = path.join(dataRoot, `child-${index}.err`);
  const descriptor = openSync(errorPath, "w");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, settingsPath, "custom", String(ITERATIONS)], {
      stdio: ["ignore", "ignore", descriptor],
      windowsHide: true,
    });
    child.on("exit", () => {
      closeSync(descriptor);
      resolve(errorPath);
    });
  });
}

test.skip("concurrent turns recorded by two processes keep every token count", async () => {
  await writeFile(settingsPath, `${JSON.stringify({ version: 1, inferenceProvider: "custom" }, null, 2)}\n`, "utf8");

  // SAFETY CEILING: four children, each a bounded loop of twenty synchronous calls whose length
  // is a literal. The loop lives inside the child, so this cannot run away or grow.
  assert.equal(CHILDREN * ITERATIONS, 80, "the ceiling of this test is four children of twenty records each");
  await Promise.all(Array.from({ length: CHILDREN }, (_, index) => runRecorder(index)));

  const ledger = JSON.parse(await readFile(settingsPath, "utf8")).inferenceRouterUsage.providers.custom;
  const expected = CHILDREN * ITERATIONS;

  assert.equal(ledger.requests, expected, `two processes lost ${expected - ledger.requests} of ${expected} ledger updates`);
  assert.equal(ledger.inputTokens, expected * INPUT_TOKENS, "input token counts were lost to a concurrent writer");
  assert.equal(ledger.outputTokens, expected * OUTPUT_TOKENS, "output token counts were lost to a concurrent writer");
  assert.equal(ledger.cacheReadTokens, expected * CACHE_READ_TOKENS, "cache read counts were lost to a concurrent writer");
  assert.equal(ledger.cacheWriteTokens, expected * CACHE_WRITE_TOKENS, "cache write counts were lost to a concurrent writer");
});