import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * `always` in settings.json answered "yes" before it looked at what it was
 * answering "yes" to. `authorize` in
 * `source/host/extensions/local-tool-permission/local-tool-permission-controller.ts`
 * returned `{allowed:true}` the moment the setting read `always`, and every check
 * on the request's target — the size cap, and any refusal derived from it — lived
 * further down inside `ask`, which only runs when the setting reads `ask`.
 * `awaitDesktopStandingDecision` did the same one function earlier, so it never
 * even reached `authorize`.
 *
 * Nothing failed and nothing warned. The setting lives in `settings.json`, the
 * decision is taken in code, and the code read the setting as the answer instead
 * of as the question. The user had set "always allow", understood it as "stop
 * asking me", and got "do not look at this either".
 *
 * The target is now checked on the way in, in every mode. The setting decides
 * only whether the user is asked. The tests below drive all three settings
 * through the same request and show that the well-formed ones are still allowed
 * without a question, so the fix did not turn `always` into `ask`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-tool-target-"));
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
  ["host", "extensions", "local-tool-permission", "local-tool-permission-controller.ts"],
  ["shared", "local-tool-permission-machinery.ts"],
]);
const {
  SandLocalToolPermissionController,
  SAND_LOCAL_TOOL_TARGET_MAX_CHARS,
  SAND_LOCAL_TOOLS_TARGET_REQUIRED_MESSAGE,
} = loaded["local-tool-permission-controller.mjs"];
// The refusal wording lives in the shared machinery, which is not this change's
// file; the controller only reaches for it. Asserting against the real text means
// the test cannot pass on a string invented here.
const {
  SAND_LOCAL_TOOLS_DISABLED_MESSAGE,
  SAND_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
} = loaded["local-tool-permission-machinery.mjs"];

test.after(() => dispose());

/** A controller wired to a fixed setting, with a deterministic id source. */
function controllerFor(permission) {
  let counter = 0;
  return new SandLocalToolPermissionController({
    getPermission: () => permission,
    setPermission: () => {},
    canAsk: () => true,
    hasLiveComputer: () => true,
    randomId: () => `ask-${++counter}`,
  });
}

const scope = (agentId = "agent-1", toolCallId = "call-1") => ({ agentId, toolCallId, action: "run-command" });

const oversized = () => "echo " + "a".repeat(SAND_LOCAL_TOOL_TARGET_MAX_CHARS);

test("the size cap on a target applies with the setting reading always", async () => {
  const controller = controllerFor("always");
  const decision = await controller.authorize(scope(), { action: "run-command", target: oversized() });
  assert.equal(decision.allowed, false,
    "a target past the size cap was allowed because the setting read always, so the cap only ever guarded a mode nobody uses");
  assert.equal(decision.reason, SAND_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
    `the refusal does not name the size cap, so the model cannot tell a cap from a denial: ${decision.reason}`);
});

test("a target that names nothing is refused in every mode, including always", async () => {
  for (const permission of ["always", "ask"]) {
    const controller = controllerFor(permission);
    const decision = await controller.authorize(scope(), { action: "read-file", target: "" });
    assert.equal(decision.allowed, false,
      `an empty target was allowed with the setting reading ${permission}, so there is nothing to show the user and nothing to run`);
    assert.equal(decision.reason, SAND_LOCAL_TOOLS_TARGET_REQUIRED_MESSAGE,
      `the refusal for an empty target under ${permission} does not say the target was missing: ${decision.reason}`);
  }
  const ask = controllerFor("ask");
  await ask.authorize(scope(), { action: "read-file", target: "" });
  assert.equal(ask.getPendingRequestForAgent("agent-1"), undefined,
    "the user was asked to approve a request that names no file, which is a blank box they cannot judge");
});

test("the same target is judged the same way whatever the setting reads", async () => {
  const target = oversized();
  const reasons = [];
  for (const permission of ["always", "ask"]) {
    const controller = controllerFor(permission);
    reasons.push((await controller.authorize(scope(), { action: "run-command", target })).reason);
  }
  assert.deepEqual(reasons, [SAND_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE, SAND_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE],
    "the setting changed the answer to a question about the target itself, which is the defect this file was reopened for");
});

test("always still answers without asking, for a target that is well formed", async () => {
  const controller = controllerFor("always");
  const decision = await controller.authorize(scope(), { action: "run-command", target: "echo hello" });
  assert.equal(decision.allowed, true,
    `a well-formed command was not allowed under always, so the setting stopped meaning what it says: ${decision.reason}`);
  assert.equal(controller.getPendingRequestForAgent("agent-1"), undefined,
    "always asked the user a question, which is the one thing the setting exists to stop");
  assert.equal(controller.requiresApproval(), false, "always stopped meaning do-not-ask");
});

test("awaitDesktopStandingDecision judges the command before it honours the setting", async () => {
  const allowed = await controllerFor("always").awaitDesktopStandingDecision({
    agentId: "agent-1", toolCallId: "call-1", command: "echo hello",
  });
  assert.equal(allowed.allowed, true, `a real command was refused on the standing-decision path: ${allowed.reason}`);

  const tooLarge = await controllerFor("always").awaitDesktopStandingDecision({
    agentId: "agent-1", toolCallId: "call-2", command: oversized(),
  });
  assert.equal(tooLarge.allowed, false,
    "awaitDesktopStandingDecision returned allowed:true for an oversized command, so it answers before it looks");
  assert.equal(tooLarge.reason, SAND_LOCAL_TOOLS_TARGET_TOO_LARGE_MESSAGE,
    `the standing-decision refusal does not name the cap: ${tooLarge.reason}`);

  const missing = await controllerFor("always").awaitDesktopStandingDecision({
    agentId: "agent-1", toolCallId: "call-3",
  });
  assert.equal(missing.allowed, false,
    "a standing decision with no command at all was granted, so an empty request reaches the user's machine unchecked");

  const disabled = await controllerFor("never").awaitDesktopStandingDecision({
    agentId: "agent-1", toolCallId: "call-4", command: "echo hello",
  });
  assert.equal(disabled.allowed, false, "the never setting stopped refusing a standing decision");
  assert.equal(disabled.reason, SAND_LOCAL_TOOLS_DISABLED_MESSAGE,
    `the never setting refuses with the wrong reason: ${disabled.reason}`);
});

test("a target past the cap on one point is still allowed, so the cap is a boundary", async () => {
  const controller = controllerFor("always");
  const atLimit = "a".repeat(SAND_LOCAL_TOOL_TARGET_MAX_CHARS);
  const decision = await controller.authorize(scope(), { action: "run-command", target: atLimit });
  assert.equal(decision.allowed, true,
    `a target exactly on the limit was refused, so the check is off by one against the model: ${decision.reason}`);
});