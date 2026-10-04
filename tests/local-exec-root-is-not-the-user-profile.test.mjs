import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * An agent with local-exec hands could read the user's whole Windows account.
 * `resolveLocalExecRoot` in `source/host/local-exec/local-exec-machine.ts`
 * answered `homedir()` when neither `SAND_LOCAL_EXEC_ROOT` nor
 * `SAND_AGENT_PROJECT_DIR` was set, so the containment root was `%USERPROFILE%`
 * itself. Escaping that root was already refused — `containPath` has always done
 * it honestly, symlinks included — but the root was the account, so the
 * containment closed nothing at all: inside the root the agent could read
 * `%USERPROFILE%\.ssh\id_rsa`, and
 * `%USERPROFILE%\AppData\Local\GrokBotLocalBox\gateway.json`, which holds the
 * loopback gateway bearer token, plus `launcher-secrets.txt` and
 * `launcher-gateway-token.txt`. Nothing about that failed, warned or logged: the
 * calls returned ordinary successful reads, because a read inside the root was
 * supposed to succeed.
 *
 * The fallback is now the box workspace — `<sandRoot>\box-workspace`, the same
 * directory `host/main.ts` hands the box exec daemon as its workspace root, and
 * the directory the user deploys their own MCP servers into. The tests below fail
 * against the old fallback and pass against this one, and they check the second
 * half of the obligation too: the agent must still be able to work there.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-exec-root-"));
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

const { loaded, dispose } = await bundle([["host", "local-exec", "local-exec-machine.ts"]]);
const { containPath, resolveLocalExecRoot, SandLocalExecPathError } = loaded["local-exec-machine.mjs"];

test.after(() => dispose());

/** A stand-in for the real `%LOCALAPPDATA%\GrokBotLocalBox`, so no test touches it. */
function makeSandRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-sand-root-"));
  const boxRoot = path.join(base, "GrokBotLocalBox");
  const workspace = path.join(boxRoot, "box-workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(boxRoot, "gateway.json"), '{"token":"not-a-real-token"}');
  mkdirSync(path.join(base, ".ssh"), { recursive: true });
  writeFileSync(path.join(base, ".ssh", "id_rsa"), "not-a-real-key");
  writeFileSync(path.join(base, "launcher-secrets.txt"), "not-a-real-secret");
  return {
    base,
    env: { SAND_DATA_ROOT: boxRoot, LOCALAPPDATA: base },
    boxRoot,
    workspace,
    sshKey: path.join(base, ".ssh", "id_rsa"),
    gateway: path.join(boxRoot, "gateway.json"),
    secrets: path.join(base, "launcher-secrets.txt"),
    drop: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

/** Resolves through the real containment, or returns the refusal the caller got. */
async function resolveUnder(root, requested) {
  try {
    return { allowed: true, resolved: await containPath({ root, path: requested }) };
  } catch (error) {
    assert.ok(error instanceof SandLocalExecPathError,
      `containPath refused with ${error?.constructor?.name} instead of SandLocalExecPathError: ${error?.message}`);
    return { allowed: false, reason: error.message };
  }
}

test("the default local-exec root is the box workspace, not the user's home directory", () => {
  const world = makeSandRoot();
  try {
    const root = resolveLocalExecRoot(world.env);
    assert.equal(root, world.workspace,
      `the default root resolved to ${root}, so an agent with local-exec hands starts inside the whole account again`);
  } finally {
    world.drop();
  }
});

test("a configured SAND_LOCAL_EXEC_ROOT still overrides the default", () => {
  const world = makeSandRoot();
  try {
    const elsewhere = path.join(world.base, "somewhere-else");
    mkdirSync(elsewhere, { recursive: true });
    assert.equal(resolveLocalExecRoot({ ...world.env, SAND_LOCAL_EXEC_ROOT: elsewhere }), elsewhere,
      "an operator who names a root is overruled by the new default, which turns a deliberate setting into a surprise");
    assert.equal(resolveLocalExecRoot({ ...world.env, SAND_AGENT_PROJECT_DIR: elsewhere }), elsewhere,
      "SAND_AGENT_PROJECT_DIR stopped being honoured, so the second documented override is dead");
    assert.equal(resolveLocalExecRoot({ ...world.env, SAND_LOCAL_EXEC_ROOT: "   " }).length > 0, true,
      "a blank override left the agent with no root at all instead of falling through to the default");
  } finally {
    world.drop();
  }
});

test("the default root refuses the gateway token file, the launcher's secrets and .ssh", async () => {
  const world = makeSandRoot();
  try {
    const root = resolveLocalExecRoot(world.env);
    for (const [label, target] of [
      ["the loopback gateway descriptor", world.gateway],
      ["the launcher's secrets file", world.secrets],
      ["the user's SSH private key", world.sshKey],
    ]) {
      const outcome = await resolveUnder(root, target);
      assert.equal(outcome.allowed, false,
        `${label} is inside the default local-exec root, so an agent can read it and put it in a transcript`);
      assert.match(outcome.reason, /outside the allowed local-exec root/i,
        `the refusal for ${label} does not say what was refused or why: ${outcome.reason}`);
    }
  } finally {
    world.drop();
  }
});

test("the default root still lets the agent work in the box workspace", async () => {
  const world = makeSandRoot();
  try {
    const root = resolveLocalExecRoot(world.env);
    const notes = path.join(root, "mcp-servers", "notes.mjs");
    mkdirSync(path.dirname(notes), { recursive: true });
    writeFileSync(notes, "// the user's own MCP server lives exactly here");

    const absolute = await resolveUnder(root, notes);
    assert.equal(absolute.allowed, true,
      `the agent can no longer reach a file in its own workspace: ${absolute.reason}`);
    assert.equal(absolute.resolved, notes, "the workspace file was resolved to a different path than the one written");

    const relative = await resolveUnder(root, path.join("mcp-servers", "notes.mjs"));
    assert.equal(relative.allowed, true,
      `a path relative to the workspace is refused, so the agent loses the working directory it had: ${relative.reason}`);
    assert.equal(relative.resolved, notes, "a relative workspace path resolved somewhere other than the workspace file");
  } finally {
    world.drop();
  }
});

test("a link out of the root is still refused, which is the defence the default did not need", async () => {
  // The escape-out-of-root defence is not mine to widen and must not regress: a
  // narrow root does not make it unnecessary, it makes it the only thing standing
  // between the agent and the account. The junction is placed INSIDE the root and
  // points at the directory that holds `.ssh`, so it genuinely leaves the root.
  const world = makeSandRoot();
  const link = path.join(world.workspace, "vault-link");
  try {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(world.base, link, "junction");
    const outcome = await resolveUnder(world.workspace, link);
    assert.equal(outcome.allowed, false,
      "a junction leaving the root was followed, so the containment now reads through links out of the workspace");
    assert.match(outcome.reason, /resolves through a symlink/i,
      `the refusal does not say a link was followed, so the user cannot act on it: ${outcome.reason}`);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  } finally {
    world.drop();
  }
});