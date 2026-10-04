import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The cap-reclaim pass could not tell a live agent from a leftover directory,
// and the host answered the wrong question. `SandSessionMaterialization` asks
// its host two things per directory — `isAgentInUse` ("the host still holds
// this") and `hasMemory` ("the memory extension holds facts for this") — and
// the production host supplied neither, so both optional calls read `undefined`
// and both answers were "no". The hook it did supply, `isVisibleAgent`, asked a
// third question ("would the roster show this?"), which the pass already answers
// itself, and which nothing ever called; `summarizeAgentById` summarizes with
// `includeBlank: true`, so it returns a record for an empty agent and its answer
// was always "visible". The consequence was not only that garbage survived: a
// blank agent with an open session — exactly what a user has just created — is
// what `buildSummary({ includeBlank: false })` returns `null` for, so the next
// cap check would reclaim the agent out from under the person using it. The
// tests below wire the real host extras and fail against the old hooks.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-placeholder-hooks-"));
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
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "session", "production.ts"],
]);
const { createSessionProductionExtras } = loaded["production.mjs"];

test.after(() => dispose());

const ENV_NAMES = ["SAND_DATA_ROOT", "SAND_USER_DATA_DIR"];
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function dropRoot(base) {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

/**
 * Builds the store exactly the way the host does, with the real materialization
 * and the real host extras, over a throwaway data root.
 */
function makeHost(base) {
  const dataRoot = path.join(base, "data");
  mkdirSync(dataRoot, { recursive: true });
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  const extras = createSessionProductionExtras({
    deps: {
      "forever-box": { box: { ensureReady: async () => ({}) } },
      settings: {},
      experiments: {},
      telemetry: {
        logs: { reportBoxHelp() {}, reportSessionDiagnostic() {} },
        analytics: { trackEvent() {} },
      },
    },
    host: { events: { emit: async () => {} } },
    onStop() {},
  });
  const store = extras.createStore(() => undefined);
  return { dataRoot, store, materialization: store.materialization };
}

async function mintBlankAgent(store) {
  const session = await store.createSession({ name: "", description: "" });
  return session.id;
}

test("an agent the host is still holding is not reclaimed as a placeholder", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-host-holds-"));
  try {
    const { store, materialization } = makeHost(base);
    const agentId = await mintBlankAgent(store);

    assert.equal(existsSync(path.join(store.rootDir, agentId, "store.db")), true,
      "the test proves nothing unless a real agent with a real store was minted");

    assert.equal(await materialization.isPrunedPlaceholder(agentId), false,
      "an agent with an open session and no transcript yet was judged a leftover, so the next cap check would have deleted the agent the user just created");

    await store.releaseSession(agentId);
  } finally {
    dropRoot(base);
  }
});

test("an agent with stored memory and nothing else is not reclaimed", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-memory-keep-"));
  try {
    const { store, materialization } = makeHost(base);
    const agentId = await mintBlankAgent(store);
    await store.releaseSession(agentId);
    const memoryDir = path.join(store.rootDir, agentId, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      path.join(memoryDir, "profile.md"),
      "# About the user\n\n- (2024-03-04) The operator lives in Berlin.\n",
      "utf8",
    );

    assert.equal(await materialization.isPrunedPlaceholder(agentId), false,
      "an agent whose only content is memory the host still has was judged a leftover and would have been deleted");
  } finally {
    dropRoot(base);
  }
});

test("a directory nothing holds and nothing describes is still reclaimed", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-reclaim-garbage-"));
  try {
    const { store, materialization } = makeHost(base);
    const agentId = await mintBlankAgent(store);
    await store.releaseSession(agentId);

    assert.equal(await materialization.isPrunedPlaceholder(agentId), true,
      "the reclaim pass stopped reclaiming, so the fifty-agent cap can fill up again");
    await materialization.reclaimPrunedPlaceholders();
    assert.equal(existsSync(path.join(store.rootDir, agentId)), false,
      "a placeholder the pass agreed about was left on disk");
  } finally {
    dropRoot(base);
  }
});

test("the host supplies the hooks the reclaim pass reads, and no other", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-hook-shape-"));
  try {
    const { materialization } = makeHost(base);
    const host = materialization.host;
    assert.equal(typeof host.isAgentInUse, "function",
      "the pass asks `isAgentInUse` and the host does not answer, so every open session reads as garbage");
    assert.equal(typeof host.hasMemory, "function",
      "the pass asks `hasMemory` and the host does not answer, so every remembered agent reads as garbage");
    assert.equal("isVisibleAgent" in host, false,
      "a hook that answers a question the pass does not ask is a hook nothing reads");
  } finally {
    dropRoot(base);
  }
});
