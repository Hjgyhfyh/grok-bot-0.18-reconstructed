import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * `cursorAccountSlot` used to answer `null` for every auth status that was not
 * `logged-in`, so `applyClaim` took its `nextSlot === null` branch and never called
 * `createRuntime`. On a machine with no account the coordinator process therefore did
 * not exist at all: `production-provider.requestRendererPort` had no active session to
 * hand the renderer its MessagePort, and every one of the ~140
 * `COORDINATOR_METHOD_TABLE` methods was unreachable — including `listAgents`,
 * `createAgent`, `sendPrompt` and `getOnboardingSeen`, the renderer's very first call,
 * so the window could not even render its own startup screen. Nothing reported a
 * failure, because every earlier test of this module started from an already signed-in
 * status, which always produced a slot.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_SLOT_ENV = "SAND_LOCAL_ACCOUNT_SLOT";
const TOUCHED_ENV = [LOCAL_SLOT_ENV];

const ACCOUNT_ID = "user@example.com";
const SECOND_ACCOUNT_ID = "second@example.com";

const REFUSED_STATUS = { kind: "revoked", reason: "host not bound to the account" };

const savedEnv = new Map();

before(() => {
  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
});

after(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function loadCoordinatorAccountRuntimeModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-account-"));
  const output = path.join(temporary, "coordinator-account-runtime.mjs");
  await build({
    entryPoints: [
      path.join(repoRoot, "source", "electron-main", "coordinator", "coordinator-account-runtime.ts"),
    ],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

/** Install an environment value for the duration of `body`, then put it back. */
async function withEnv(name, value, body) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/**
 * Stands in for a coordinator child process. `requestRendererPort` hands its port to
 * the sink right away, exactly as the real runtime does once its MessageChannel is up,
 * so a granted port is visible as a value that reached the renderer's callback.
 */
function createFakeSession(index) {
  const port = { portName: `message-port-${index}` };
  const grantedSinks = [];
  const revokedSinks = [];
  let disposeCalls = 0;
  let restartCalls = 0;
  let disposed = false;
  return {
    port,
    grantedSinks,
    revokedSinks,
    disposeCalls: () => disposeCalls,
    restartCalls: () => restartCalls,
    isDisposed: () => disposed,
    requestRendererPort(sink) {
      grantedSinks.push(sink);
      sink(port);
    },
    revokeRendererPortRequest() {
      if (grantedSinks.length > 0) revokedSinks.push(grantedSinks.at(-1));
    },
    async restart() {
      restartCalls += 1;
    },
    async dispose() {
      disposeCalls += 1;
      disposed = true;
    },
  };
}

/**
 * Builds the whole dependency surface the product declares, recording every call, so
 * a test can assert on what the runtime actually did instead of on a bare "it ran".
 */
function createRecordingDependencies({ authorize = true } = {}) {
  const log = {
    sessions: [],
    authorizations: [],
    preparedTransitions: [],
    revokedCredentials: 0,
    revokedMainDataPorts: 0,
    resets: 0,
    delivered: [],
    problems: [],
  };
  const dependencies = {
    createRuntime() {
      const session = createFakeSession(log.sessions.length + 1);
      log.sessions.push(session);
      return session;
    },
    async authorizeAccount(slot, context) {
      log.authorizations.push({ slot, context });
      return authorize;
    },
    async revokeRefusedAccount() {
      log.revokedCredentials += 1;
      return { kind: "revoked", status: REFUSED_STATUS };
    },
    async prepareAccountTransition(transition) {
      log.preparedTransitions.push(transition);
    },
    resetAccountState() {
      log.resets += 1;
    },
    revokeMainDataPort() {
      log.revokedMainDataPorts += 1;
    },
    deliverStatus(status) {
      log.delivered.push(status);
    },
    onProblem(problem) {
      log.problems.push(problem);
    },
  };
  return { dependencies, log };
}

test("a signed-out status still launches the coordinator instead of leaving no process at all", async () => {
  const loaded = await loadCoordinatorAccountRuntimeModule();
  try {
    const { module } = loaded;
    const { dependencies, log } = createRecordingDependencies();
    const runtime = module.createCoordinatorAccountRuntime(dependencies);

    assert.equal(module.LOCAL_ACCOUNT_SLOT, "local", "the local slot constant is the contract every test below relies on");

    await runtime.start({ kind: "logged-out" });
    const settled = await runtime.whenIdle();

    assert.equal(log.sessions.length, 1, "the coordinator was never created for a signed-out status");
    assert.equal(log.authorizations.length, 1, "the local slot was never authorized");
    assert.equal(log.authorizations[0].slot, module.LOCAL_ACCOUNT_SLOT, "a signed-out status produced something other than the local slot");
    assert.equal(log.authorizations[0].context.isStartup, true, "the first launch was not marked as a startup");
    assert.deepEqual(settled, { kind: "logged-out" }, "the runtime did not settle on the status it was started with");
    assert.deepEqual(log.problems, [], "launching the local coordinator reported a problem");

    // `restart()` reaches the live session only while the runtime is active, so this
    // is what proves the launched session became the active one rather than a throwaway.
    await runtime.restart();
    assert.equal(log.sessions[0].restartCalls(), 1, "the runtime never reached the active state, so no session owns the restart");
  } finally {
    await loaded.dispose();
  }
});

test("the renderer is granted its MessagePort while nobody is signed in", async () => {
  const loaded = await loadCoordinatorAccountRuntimeModule();
  try {
    const { module } = loaded;
    const { dependencies, log } = createRecordingDependencies();
    const runtime = module.createCoordinatorAccountRuntime(dependencies);

    await runtime.start({ kind: "logged-out" });
    const received = [];
    runtime.requestRendererPort((port) => { received.push(port); });

    assert.equal(log.sessions[0].grantedSinks.length, 1, "the live coordinator was never handed the renderer's port request");
    assert.equal(received.length, 1, "the renderer's sink was never called, so the renderer still holds no MessagePort");
    assert.equal(received[0], log.sessions[0].port, "the sink was called with a port that did not come from the live session");

    await runtime.dispose();
    assert.equal(log.sessions[0].disposeCalls(), 1, "the local coordinator outlived the runtime that owned it");
  } finally {
    await loaded.dispose();
  }
});

test("switching the local slot off restores the old rule that refuses to start signed out", async () => {
  for (const setting of ["0", " 0 "]) {
    await withEnv(LOCAL_SLOT_ENV, setting, async () => {
      const loaded = await loadCoordinatorAccountRuntimeModule();
      try {
        const { module } = loaded;
        const { dependencies, log } = createRecordingDependencies();
        const runtime = module.createCoordinatorAccountRuntime(dependencies);

        // The renderer asks for its port before the auth status settles, so a granted
        // port can only come from a coordinator that actually launched.
        const received = [];
        runtime.requestRendererPort((port) => { received.push(port); });
        await runtime.start({ kind: "logged-out" });
        const settled = await runtime.whenIdle();

        assert.equal(log.sessions.length, 0, `SAND_LOCAL_ACCOUNT_SLOT=${setting} still created a coordinator`);
        assert.equal(log.authorizations.length, 0, `SAND_LOCAL_ACCOUNT_SLOT=${setting} still authorized an account slot`);
        assert.equal(received.length, 0, `SAND_LOCAL_ACCOUNT_SLOT=${setting} still granted the renderer a port`);
        assert.deepEqual(settled, { kind: "logged-out" }, `SAND_LOCAL_ACCOUNT_SLOT=${setting} did not settle on the signed-out status`);
      } finally {
        await loaded.dispose();
      }
    });
  }

  // The opt-out must be an opt-out and not a blanket kill switch.
  for (const setting of ["1", ""]) {
    await withEnv(LOCAL_SLOT_ENV, setting, async () => {
      const loaded = await loadCoordinatorAccountRuntimeModule();
      try {
        const { module } = loaded;
        const { dependencies, log } = createRecordingDependencies();
        const runtime = module.createCoordinatorAccountRuntime(dependencies);
        await runtime.start({ kind: "logged-out" });
        assert.equal(log.sessions.length, 1, `SAND_LOCAL_ACCOUNT_SLOT=${setting} disabled the local slot even though it is not the opt-out value`);
      } finally {
        await loaded.dispose();
      }
    });
  }
});

test("a signed-in account keeps its own slot and is never replaced by the local fallback", async () => {
  const loaded = await loadCoordinatorAccountRuntimeModule();
  try {
    const { module } = loaded;
    const { dependencies, log } = createRecordingDependencies();
    const runtime = module.createCoordinatorAccountRuntime(dependencies);

    await runtime.start({ kind: "logged-in", authId: ACCOUNT_ID, email: "other@example.com" });

    assert.equal(log.authorizations[0].slot, ACCOUNT_ID, "the local fallback hijacked a real signed-in account");
    assert.equal(log.sessions.length, 1, "a signed-in account did not launch a coordinator");

    // Switching to another account reads the live slot out of the active state, so
    // this is what proves the running slot is the account id and not the local one.
    await runtime.observe({ kind: "logged-in", authId: SECOND_ACCOUNT_ID, email: "second@example.com" });
    await runtime.whenIdle();

    assert.deepEqual(
      log.preparedTransitions,
      [{ previousSlot: ACCOUNT_ID, nextSlot: SECOND_ACCOUNT_ID }],
      "the running slot was not the signed-in account id",
    );
    assert.deepEqual(
      log.authorizations.map((entry) => entry.slot),
      [ACCOUNT_ID, SECOND_ACCOUNT_ID],
      "the second account was authorized under the wrong slot",
    );
    assert.equal(log.sessions.length, 2, "the second account never got its own coordinator");
    assert.equal(log.sessions[0].disposeCalls(), 1, "the first account's coordinator was never stopped");

    // An empty authId is not a usable slot, even when an email is present.
    const { dependencies: emptyDependencies, log: emptyLog } = createRecordingDependencies();
    const emptyRuntime = module.createCoordinatorAccountRuntime(emptyDependencies);
    await emptyRuntime.start({ kind: "logged-in", authId: "", email: "no-id@example.com" });
    await emptyRuntime.whenIdle();
    assert.equal(
      emptyLog.authorizations[0].slot,
      module.LOCAL_ACCOUNT_SLOT,
      "an empty authId produced a slot that cannot name a real account",
    );
  } finally {
    await loaded.dispose();
  }
});

test("signing out stops the account coordinator and starts a local one instead of leaving it dangling", async () => {
  const loaded = await loadCoordinatorAccountRuntimeModule();
  try {
    const { module } = loaded;
    const { dependencies, log } = createRecordingDependencies();
    const runtime = module.createCoordinatorAccountRuntime(dependencies);

    await runtime.start({ kind: "logged-in", authId: ACCOUNT_ID });
    const received = [];
    runtime.requestRendererPort((port) => { received.push(port); });
    assert.equal(received.length, 1, "the signed-in account never handed the renderer its port, so this transition proves nothing");

    await runtime.observe({ kind: "logged-out" });
    const settled = await runtime.whenIdle();

    assert.equal(log.sessions.length, 2, "signing out did not start a local coordinator to replace the account one");
    assert.equal(log.sessions[0].disposeCalls(), 1, "the signed-out account coordinator was never stopped");
    assert.equal(log.sessions[0].isDisposed(), true, "the account session is still live after the account was signed out");
    assert.equal(log.sessions[1].isDisposed(), false, "the local session was started and left dangling instead of running");
    assert.equal(log.sessions[0].revokedSinks.length, 1, "the signed-out account session still holds the renderer's port request");
    assert.deepEqual(
      log.preparedTransitions,
      [{ previousSlot: ACCOUNT_ID, nextSlot: module.LOCAL_ACCOUNT_SLOT }],
      "the account-to-local transition was not prepared",
    );
    assert.deepEqual(
      log.authorizations.map((entry) => entry.slot),
      [ACCOUNT_ID, module.LOCAL_ACCOUNT_SLOT],
      "the local session was not authorized as the local slot",
    );
    assert.equal(log.revokedMainDataPorts, 1, "the old account's main data port was not revoked");
    assert.equal(log.resets, 1, "the account state was not reset for the local session");
    assert.equal(received.length, 2, "the renderer did not receive the local session's port");
    assert.equal(received[1], log.sessions[1].port, "the renderer received a port that did not come from the new local session");
    assert.deepEqual(settled, { kind: "logged-out" }, "the runtime did not settle on the signed-out status");
    assert.deepEqual(log.problems, [], "switching from the account to the local slot reported a problem");
  } finally {
    await loaded.dispose();
  }
});

test("the local slot is still authorized and a host that refuses it launches nothing", async () => {
  const loaded = await loadCoordinatorAccountRuntimeModule();
  try {
    const { module } = loaded;
    const { dependencies, log } = createRecordingDependencies({ authorize: false });
    const runtime = module.createCoordinatorAccountRuntime(dependencies);

    const received = [];
    runtime.requestRendererPort((port) => { received.push(port); });
    await runtime.start({ kind: "logged-out" });
    const settled = await runtime.whenIdle();

    assert.equal(log.authorizations.length, 1, "the local slot skipped authorization entirely");
    assert.equal(log.authorizations[0].slot, module.LOCAL_ACCOUNT_SLOT, "a different slot than the local one was authorized");
    assert.equal(log.sessions.length, 0, "a refused local slot launched a coordinator anyway");
    assert.equal(received.length, 0, "the renderer was granted a port even though the local slot was refused");
    assert.equal(log.revokedCredentials, 1, "the refused account's credentials were not revoked");
    assert.ok(
      log.problems.some((problem) => problem.includes("not bound to this account")),
      `the refusal was not reported, got: ${log.problems.join(" | ")}`,
    );
    assert.equal(settled.kind, REFUSED_STATUS.kind, "the runtime settled on a status it never observed");
    assert.deepEqual(log.delivered, [REFUSED_STATUS], "the revoked status was never delivered to the renderer");

    await runtime.restart();
    assert.equal(log.sessions.length, 0, "restarting a refused local slot launched a coordinator behind the refusal");
  } finally {
    await loaded.dispose();
  }
});