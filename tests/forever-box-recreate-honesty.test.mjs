import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A host with no account was told to retry a computer update it can never send. `reset()` and
 * `update()` in `host/extensions/forever-box/forever-box-service.ts` both funnel into
 * `recreate()`, and `recreate()` caught every failure from the recreate call and replaced it
 * with one fixed sentence -- `RECREATE_UNAVAILABLE_MESSAGE`, "Couldn't reach the service that
 * updates this computer. It is unchanged. Try again in a moment; if it keeps failing, the
 * backend may need to be updated."
 *
 * That sentence is true for a network blip and false for the commonest failure this host has.
 * `recreateInBox` reaches `GrokBotService` through the Cursor backend client, and that client's
 * interceptor resolves `auth.getAccessToken` before any request leaves. With no account it
 * throws `SandCredentialsWaitingError` and nothing is ever sent, so nothing was unreachable and
 * there is no backend to update. Measured against a live box with no account, both
 * `POST /api/resetForeverBox` and `POST /api/updateForeverBox` answered `500` with exactly that
 * sentence, and the renderer shows it to the user verbatim: `ProductionRenderer.tsx:2019` calls
 * `setNotice(error instanceof Error ? error.message : String(error))`. Settings > Updates was
 * telling the reader to retry a request that cannot be made.
 *
 * The same lie reached the error tray a second way. `maybeAutoUpdate()` pushes "Grok Bot will
 * retry, or you can run 'Update Grok Bot's Computer' from Settings > Updates" on any recreate
 * failure, and with no account that retry can never succeed either. `ensure()` is the reachable
 * door into it: it reads the image state and hands it straight to `maybeAutoUpdate()`.
 *
 * Nothing caught this, because every existing test either stubbed the lifecycle client or only
 * read the constants. These tests drive `ForeverBoxService` through its real `reset()`,
 * `update()` and `ensure()` methods with the error the real `createHostAuthService` throws, and
 * assert on the message that reaches the caller. The transient branch is asserted too: a genuine
 * network failure must keep the retry-shaped wording, or the fix would have cost an honest
 * answer.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-forever-box-recreate-"));
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
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
      },
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "auth", "auth-service.ts"],
  ["host", "extensions", "auth", "credential-renewer.ts"],
  ["host", "extensions", "forever-box", "forever-box-service.ts"],
]);
const { createHostAuthService } = loaded["auth-service.mjs"];
const { ForeverBoxService, SandForeverBoxError, RECREATE_UNAVAILABLE_MESSAGE, RECREATE_CREDENTIAL_REQUIRED_MESSAGE } = loaded["forever-box-service.mjs"];

test.after(() => dispose());

/**
 * Never lets a scheduled retry run. `elapsed` resolves only on abort, so the renewer cannot
 * loop on microtasks and a pending backoff cannot outlive the test.
 */
const idleRetry = {
  schedule: () => ({
    elapsed: new Promise((resolve) => { resolve(undefined); }),
    dispose() {},
  }),
};
const idleClock = { now: () => Date.now(), schedule: () => ({ dispose() {} }) };
/** Runs the operation straight through: no deadline, no wait, no hang. */
const immediateDeadline = { run: (operation) => operation() };
/** Never retries and never completes on its own; `dispose()` aborts it. */
const neverElapsedRetry = {
  schedule: (_attempt, signal) => ({
    elapsed: new Promise((resolve) => {
      if (signal?.aborted === true) resolve(undefined);
      else signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
    dispose() {},
  }),
};

/**
 * The real refusal this host produces, taken from the real service rather than written by hand,
 * so a rewrite of the wording in `auth-service.ts` fails here instead of silently restoring the
 * false "try again" answer. `env` is an explicit empty object, so no credential can leak in
 * from the shell that launched the suite.
 */
async function createRealNoCredentialError() {
  const service = createHostAuthService({ env: {}, retry: neverElapsedRetry, clock: idleClock, log: () => {} });
  try {
    await service.getAccessToken();
  } catch (error) {
    return error;
  } finally {
    service.dispose();
  }
  throw new Error("expected the host to refuse without a credential, but getAccessToken resolved");
}

/** A network failure: real, transient, and not about accounts. */
class TransientNetworkError extends Error {
  constructor() {
    super("connect ECONNRESET after 10.0.0.4:443");
    this.name = "ConnectError";
  }
}

function createService(recreateFailure, { imageUpdateAvailable } = {}) {
  const pushedErrors = [];
  const service = new ForeverBoxService({
    box: {
      subscribe: () => () => {},
      getStatus: async () => ({ agentId: "agent-1", state: "running", vncUrl: "vnc://box" }),
      ensure: async () => ({ agentId: "agent-1", state: "running", vncUrl: "vnc://box", imageUpdateAvailable }),
    },
    lifecycleClient: {
      recreateInBox: async () => { throw recreateFailure; },
      fetchImageUpdateAvailable: async () => imageUpdateAvailable === true,
    },
    trays: { pushError: (value) => pushedErrors.push(value) },
    telemetry: { reportBoxRecreateDecided: () => {}, reportBoxImageCheck: () => {} },
    imagePolling: { start: () => () => {}, dispose() {} },
    imagePollingStartDelay: neverElapsedRetry.schedule(),
    imageSeedRetry: neverElapsedRetry,
    imageCheckDeadline: immediateDeadline,
    migrationExpiry: neverElapsedRetry.schedule(),
    screenshotDeadline: immediateDeadline,
    recreateFlushWaitDeadline: immediateDeadline,
    flushPendingUploads: async () => {},
    autoUpdateEnabled: true,
    hostBundleAutoUpdateEnabled: false,
    isInBox: () => true,
    log: () => {},
    now: () => 1_000,
  });
  return { service, pushedErrors };
}

/** Both `reset()` and `update()` funnel through `recreate()`, so both are asserted. */
async function captureRecreateError(invoke, recreateFailure) {
  const { service } = createService(recreateFailure);
  try {
    await invoke(service);
  } catch (error) {
    return error;
  } finally {
    service.dispose();
  }
  throw new Error("expected the recreate to be refused, but it resolved");
}

async function captureRecreateMessage(invoke, recreateFailure) {
  const error = await captureRecreateError(invoke, recreateFailure);
  return { message: error.message, error };
}

/** `ensure()` fires `maybeAutoUpdate()` without awaiting it, so let its microtasks settle. */
async function settleAutoUpdate() {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

test("a recreate refused for want of a credential names the account instead of promising a retry", async () => {
  const refusal = await createRealNoCredentialError();
  // The guard the fix rests on: the marker must actually be inside the real refusal, or every
  // assertion below would be about a message this host never produces.
  assert.match(
    refusal.message.toLowerCase(),
    /waiting for an inference credential/,
    "the real host refusal must carry the credential marker the fix matches on",
  );

  for (const [label, invoke] of [
    ["reset()", (service) => service.reset({ id: "agent-1" })],
    ["update()", (service) => service.update({ id: "agent-1" })],
  ]) {
    const { message, error } = await captureRecreateMessage(invoke, refusal);
    assert.ok(error instanceof SandForeverBoxError, `${label} keeps its own error class, because callers match on it`);
    assert.equal(message, RECREATE_CREDENTIAL_REQUIRED_MESSAGE, `${label} names the account as the reason`);
    assert.doesNotMatch(message, /try again/i, `${label} promised a retry for a condition that can never clear`);
    assert.doesNotMatch(message, /backend may need to be updated/i, `${label} blamed a backend that was never reached`);
    assert.match(message, /signed-in Grok Bot account/i, `${label} states the terminal condition the reader can act on`);
  }
});

test("a transient network failure keeps the retry-shaped wording, so the honest answer survives", async () => {
  const { message } = await captureRecreateMessage(
    (service) => service.update({ id: "agent-1" }),
    new TransientNetworkError(),
  );
  assert.equal(message, RECREATE_UNAVAILABLE_MESSAGE, "a network blip clears on its own and must still be retried");
  assert.match(message, /try again in a moment/i, "the transient branch is the one case where retrying is real advice");
  assert.doesNotMatch(message, /signed-in/i, "a socket reset is not an account problem and must not be reported as one");
});

test("the refusal is still recognised when the transport wraps it, not just on a bare throw", async () => {
  // The client wraps the interceptor's failure, so a fix matching only the top-level error
  // would pass the first test and miss the call the running host actually makes.
  const refusal = await createRealNoCredentialError();
  const wrapped = new Error(`[unknown] ${refusal.message}`, { cause: refusal });
  const { message } = await captureRecreateMessage((service) => service.update({ id: "agent-1" }), wrapped);
  assert.equal(message, RECREATE_CREDENTIAL_REQUIRED_MESSAGE, "a wrapped refusal is still a refusal and must still name the account");
});

test("the error tray stops promising a retry when an available image cannot be applied without an account", async () => {
  const refusal = await createRealNoCredentialError();
  const { service, pushedErrors } = createService(refusal, { imageUpdateAvailable: true });
  try {
    await service.ensure({ id: "agent-1" });
    await settleAutoUpdate();
  } finally {
    service.dispose();
  }
  assert.equal(pushedErrors.length, 1, "one tray error is pushed when an available image cannot be applied");
  const [entry] = pushedErrors;
  assert.equal(entry.title, "Computer update failed", "the tray keeps its title so the existing notice layout still matches");
  assert.match(entry.detail, /signed-in Grok Bot account/i, "the tray names the account as the reason");
  assert.doesNotMatch(entry.detail, /will retry/i, "the tray promised a retry that can never succeed without an account");
});

test("the tray still promises a retry when the same path fails for a transient reason", async () => {
  const { service, pushedErrors } = createService(new TransientNetworkError(), { imageUpdateAvailable: true });
  try {
    await service.ensure({ id: "agent-1" });
    await settleAutoUpdate();
  } finally {
    service.dispose();
  }
  assert.equal(pushedErrors.length, 1, "one tray error is pushed for a transient failure too");
  const [entry] = pushedErrors;
  assert.match(entry.detail, /will retry/i, "a network failure is retried, so the tray must keep saying so");
  assert.doesNotMatch(entry.detail, /signed-in/i, "a socket reset is not an account problem and must not be reported as one");
});