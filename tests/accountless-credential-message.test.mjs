import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A host with no account was told its missing inference credential would "resolve on its own
 * shortly", and it never will. `createHostAuthService` writes exactly one sentence for this
 * throw -- `SAND_SHORTLIVED_CREDS_WAITING_MESSAGE`, "Grok Bot's computer renews this
 * automatically (no desktop required); this resolves on its own shortly" -- and used it on
 * both of the branches the method has. Only one of them can honour that promise.
 *
 * The renewer needs something to renew *from*. When no renewal credential was ever delivered
 * into the box, `getAccessToken` does not even attempt a renewal: it skips
 * `requestImmediateRenewal()` entirely and throws. Nothing is scheduled, nothing is pending,
 * and no amount of waiting produces a token. The service already knew this -- the line it
 * logs at startup reads "no renewal credential was delivered into the box; inference is
 * unavailable until the box is re-provisioned with one" -- so the throw contradicted the
 * host's own log by a few lines.
 *
 * The sentence was not harmless. The tool boundary in
 * `packages/agent/tools/core/connect-error.ts` recognises the condition by matching the text
 * `waiting for an inference credential` and replaces it with a terminal "this needs a
 * signed-in account" answer, which is why `web-search-credential-error.test.mjs` passes and
 * why nothing the model read said "try again". But that rewrite covers tool calls only. The
 * same error reaches `describeAgentRunError` (`host/extensions/transcript/agent-run-error.ts`,
 * reached from `turn-runtime.ts` and eight other places), whose `runErrorSentenceOf` prints
 * `error.message` verbatim for any error that did not come off the wire -- and a
 * `SandCredentialsWaitingError` carries no status code, no response body and no wire-shaped
 * field, so it qualifies. Through that path the user reads the raw sentence, and "this
 * resolves on its own shortly" is a retry-shaped promise about a condition that is terminal.
 *
 * `web-search-credential-error.test.mjs` could not catch this: it builds its error from the
 * message constant directly, so it never asked which branch produced it. These tests drive
 * the real `createHostAuthService` in both states and assert on what each one throws.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-accountless-credential-"));
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
  ["packages", "agent", "tools", "core", "connect-error.ts"],
]);
const {
  createHostAuthService,
  SAND_SHORTLIVED_CREDS_WAITING_MESSAGE,
  SAND_NO_RENEWAL_CREDENTIAL_MESSAGE,
} = loaded["auth-service.mjs"];
const { SAND_INFERENCE_RENEWAL_CREDENTIAL_ENV } = loaded["credential-renewer.mjs"];
const { maybeNormalizeExecBoundaryError } = loaded["connect-error.mjs"];

test.after(() => dispose());

/** Records every consultation instead of throwing, so the no-credential case can prove zero. */
function createRecordingRetry() {
  const attempts = [];
  return {
    attempts,
    schedule(attempt, signal) {
      attempts.push(attempt);
      // Resolves only on abort, so a pending backoff neither hangs nor rejects as an
      // unhandled rejection after the test has already finished.
      return {
        elapsed: new Promise((resolve) => {
          if (signal?.aborted === true) resolve(undefined);
          else signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
      };
    },
  };
}

const idleClock = { now: () => Date.now(), schedule: () => ({ dispose() {} }) };

/** Builds the real service over an explicit env, so nothing leaks in from the shell. */
function createService(env, logs, retry) {
  return createHostAuthService({
    env,
    retry,
    clock: idleClock,
    log: (message) => logs.push(message),
    renewCredential: async () => {
      throw new Error("the backend was contacted from a test that was not expecting network use");
    },
    getMachineId: async () => "test-machine-id",
  });
}

const terminalPromise = /renews this automatically|resolves on its own|try again|may be temporary/i;

test("a box that was never given a renewal credential is told the wait is terminal", async () => {
  const logs = [];
  const retry = createRecordingRetry();
  const service = createService({}, logs, retry);
  try {
    const raised = await service.getAccessToken().then(
      () => assert.fail("the credential lookup was expected to fail, and it did not"),
      (error) => error,
    );

    assert.equal(
      raised.message,
      SAND_NO_RENEWAL_CREDENTIAL_MESSAGE,
      "with no renewal credential there is nothing to renew from, so the throw must not promise a self-healing",
    );
    assert.equal(
      terminalPromise.test(raised.message),
      false,
      "'this resolves on its own shortly' is a retry-shaped promise about a condition that never clears on this host",
    );
    assert.equal(
      retry.attempts.length,
      0,
      "no renewal was attempted and none was scheduled, which is what makes the wait terminal rather than slow",
    );
    assert.match(
      logs.join("\n"),
      /inference is unavailable until the box is re-provisioned/,
      "the startup log already called this terminal, and the throw used to contradict it",
    );
  } finally {
    service.dispose();
  }
});

test("a box that has a renewal credential keeps the self-healing sentence, because that branch really does retry", async () => {
  const logs = [];
  const retry = createRecordingRetry();
  const service = createService(
    { [SAND_INFERENCE_RENEWAL_CREDENTIAL_ENV]: "renewal-credential" },
    logs,
    retry,
  );
  try {
    const raised = await service.getAccessToken().then(
      () => assert.fail("the credential lookup was expected to fail, and it did not"),
      (error) => error,
    );

    assert.equal(
      raised.message,
      SAND_SHORTLIVED_CREDS_WAITING_MESSAGE,
      "with a renewal credential in hand the renewer really does keep retrying, so the old sentence is true here and must not be rewritten",
    );
    assert.notEqual(
      raised.message,
      SAND_NO_RENEWAL_CREDENTIAL_MESSAGE,
      "the two branches must not collapse onto one message, or a host that is genuinely waiting loses the only explanation it can act on",
    );
  } finally {
    service.dispose();
  }
});

test("the terminal message is still recognised at the tool boundary as a missing account", () => {
  // The rewrite above keeps the phrase `waiting for an inference credential`, which is the
  // only thing `connect-error.ts` matches on. Lose it and this call falls through to the
  // `default:` branch, which hands the model "Tool failed; this may be temporary. Try again."
  const normalized = maybeNormalizeExecBoundaryError(
    new Error(SAND_NO_RENEWAL_CREDENTIAL_MESSAGE),
  );

  assert.match(
    normalized.modelVisibleErrorMessage,
    /signed-in/i,
    "the marker phrase survived the rewrite, so the boundary still recognises the condition",
  );
  assert.equal(
    terminalPromise.test(normalized.modelVisibleErrorMessage),
    false,
    "the boundary rewrite has to stay terminal after this change, or the fix moved the lie rather than removing it",
  );
});