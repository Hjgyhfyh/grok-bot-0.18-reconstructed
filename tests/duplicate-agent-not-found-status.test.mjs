import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// "That agent no longer exists." was answered 500, and duplicateAgent was the
// only agent command left that said it with that status.
//
// `statusForCommandError` maps one class to `404` — anything `isAgentNotFoundError`
// recognises — and `AgentLifecycle` raises it everywhere the host has positively
// established that an id names nothing: `deleteAgents` for an absent id,
// `updateAgent` for an id that is not on disk, and both sidebar switches. The one
// command that reaches the same fact by a different route raised the base
// `SandAgentLifecycleError`, whose name is in no list, so the server answered 500
// for the one thing a client is told never to retry.
//
// Measured on a live box, against the same id in the same state, one command
// apart:
//
//   POST /api/updateAgent  {"id":"<deleted>","profile":{"name":"x"}}  404
//   POST /api/deleteAgent  {"id":"<deleted>"}                          404
//   POST /api/duplicateAgent {"id":"<deleted>"}                       500
//   POST /api/duplicateAgent {"id":"11111111-2222-3333-4444-555555555555"}  500
//
// The last one is the case a client hits most: a duplicate button held open while
// the agent it points at is deleted elsewhere. The message is right — the status
// tells the caller the host broke, so it shows a failure banner and retries a
// request that can never succeed as written.
//
// The fix is one line and it is narrow in the same direction the existing status
// mapping is: a group still cannot be duplicated and that refusal stays 500,
// because "this agent exists and cannot be copied" is a different fact from "this
// id names nothing". Every test below fails against the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-dup-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

async function buildEntries(entries) {
  const directory = makeBundleDirectory();
  mkdirSync(directory, { recursive: true });
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

const { loaded, dispose } = await buildEntries([
  ["host", "gateway-server.ts"],
  ["host", "extensions", "session", "agent-errors.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const { statusForCommandError } = loaded["gateway-server.mjs"];
const { isAgentNotFoundError, SandAgentNotFoundError } = loaded["agent-errors.mjs"];
const { AgentLifecycle, SandAgentLifecycleError } = loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

const GHOST = "11111111-2222-4333-8444-555555555555";

/** A roster with two agents on disk and one delete in flight. */
function createCloneHarness() {
  const roster = [
    { id: "agent-plain", name: "Plain", isGroup: false },
    { id: "agent-group", name: "Group", isGroup: true },
  ];
  const tm = {
    sessionStore: {
      listAgents: async () => roster,
      mintAgent: async (mint) => mint("agent-copy"),
      getAgentDir: (id) => path.join("root", id),
    },
  };
  return { tm, lifecycle: new AgentLifecycle(tm) };
}

async function captureError(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

test("duplicating an agent id that names nothing is answered 404, not a server fault", async () => {
  const { lifecycle } = createCloneHarness();

  const error = await captureError(() => lifecycle.cloneAgent(GHOST));

  assert.notEqual(error, null, "cloneAgent accepted an id that names nothing");
  assert.equal(statusForCommandError(error), 404,
    "a duplicate of an id nobody created still answers 500, so a client retries a request that can never succeed");
  assert.equal(isAgentNotFoundError(error), true,
    "the refusal is not the error the 404 branch of the server recognises");
});

test("a deleted agent and an id nobody ever created are the same answer", async () => {
  const { lifecycle } = createCloneHarness();

  const neverCreated = await captureError(() => lifecycle.cloneAgent(GHOST));
  const afterDelete = await captureError(() => lifecycle.cloneAgent("agent-just-deleted"));

  assert.equal(statusForCommandError(neverCreated), statusForCommandError(afterDelete),
    "one of these ids names nothing and the other named something once; both name nothing now, so both must answer alike");
});

test("the 404 refusal still names the agent, and still catches as a lifecycle error", async () => {
  const { lifecycle } = createCloneHarness();

  const error = await captureError(() => lifecycle.cloneAgent(GHOST));

  assert.match(String(error?.message ?? ""), new RegExp(GHOST.slice(0, 8)),
    "the refusal names neither the command nor the agent, so a caller holding several ids cannot tell which one is gone");
  assert.equal(error instanceof SandAgentLifecycleError, true,
    "a caller that catches SandAgentLifecycleError no longer catches a missing agent, so the status fix broke every existing handler of that refusal");
});

test("a group still cannot be duplicated, and that refusal is still 500", async () => {
  const { lifecycle } = createCloneHarness();

  const error = await captureError(() => lifecycle.cloneAgent("agent-group"));

  assert.equal(isAgentNotFoundError(error), false,
    "an agent that exists and cannot be copied was reported as one that does not exist");
  assert.equal(statusForCommandError(error), 500,
    "widening the not-found branch swallowed the group refusal, which is a different fact");
});

test("the not-found class the fix raises is the one the server already maps", async () => {
  const { lifecycle } = createCloneHarness();

  const error = await captureError(() => lifecycle.cloneAgent(GHOST));

  // Compared by name, not by identity: each entry point above is its own bundle,
  // so this file holds two distinct copies of the class and `instanceof` would
  // answer false for the right error. The status mapping itself matches by name,
  // so the name is the thing that has to be right.
  assert.equal(error?.name, "SandAgentNotFoundError",
    "the fix used a fresh error class, so the status depended on which class name the mapping happens to list");
  assert.equal(new SandAgentNotFoundError("x").name, "SandAgentNotFoundError",
    "the mapping the server reads expects a name this file's own copy does not carry");
});
