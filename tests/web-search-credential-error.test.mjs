import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Web search reported "this may be temporary. Try again" on a host where it could never
 * succeed, and the model believed it. `WebSearch` and `WebFetch` are the only web tools the
 * product has, and both are served by a gRPC call into the Cursor backend. On a host with no
 * signed-in account -- the supported `inferenceProvider: "custom"` configuration -- the
 * credential lookup inside the connect interceptor throws `SandCredentialsWaitingError`
 * before any request is built. Connect wraps that throw as `[unknown]`, the code switch in
 * `maybeNormalizeExecBoundaryError` has no case for it and falls into `default:`, and the
 * model was handed "Tool failed; this may be temporary. Try again."
 *
 * Measured on the live box: four `WebSearch` calls and one `WebFetch`, five identical
 * failures, and then the agent told the user web search was broken. Nothing was transient,
 * nothing was wrong with the network -- `curl` reached the same host through the shell tool
 * moments later -- and no retry could ever have changed the answer. The provider's own text
 * made it worse by promising "renews this automatically ... this resolves on its own
 * shortly", the exact false reassurance `classifierFailureFromError` was written to strip on
 * the classifier path and which had no guard here.
 *
 * These tests drive the real service, so the fix is proved on the real failure and not on a
 * hand-built error object.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-websearch-"));
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
      // The Cursor backend client pulls undici, which is CommonJS and calls `require`
      // at runtime. Without this shim the bundle throws "Dynamic require of assert is not
      // supported" before a single line of product code runs.
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
  ["host", "extensions", "inference", "cursor-web-tools.ts"],
  ["host", "extensions", "auth", "auth-service.ts"],
  ["packages", "agent", "tools", "core", "connect-error.ts"],
]);
const { createCursorWebSearchService } = loaded["cursor-web-tools.mjs"];
const { SandCredentialsWaitingError, SAND_SHORTLIVED_CREDS_WAITING_MESSAGE } = loaded["auth-service.mjs"];
const { maybeNormalizeExecBoundaryError } = loaded["connect-error.mjs"];

test.after(() => dispose());

/** Exactly what `auth-service.getAccessToken` does on a host with no signed-in account. */
const accountlessGetAccessToken = async () => {
  throw new SandCredentialsWaitingError(SAND_SHORTLIVED_CREDS_WAITING_MESSAGE);
};

test("a web search on a host with no account is reported as impossible, not as temporary", async () => {
  const service = createCursorWebSearchService({
    getAccessToken: accountlessGetAccessToken,
    getMachineId: () => "test-machine-id",
    modelId: "test-model",
  });

  const raised = await service(undefined, { searchTerm: "vlad mafaney twitch" }).then(
    () => assert.fail("the search was expected to fail, and it did not: the host has no account, so there is nothing to fail against"),
    (error) => error,
  );

  assert.ok(
    raised instanceof Error,
    "the credential lookup threw inside the connect interceptor, so the service rejects with an Error",
  );

  const normalized = maybeNormalizeExecBoundaryError(raised);
  const modelMessage = normalized.modelVisibleErrorMessage;

  assert.equal(
    modelMessage.includes("Try again"),
    false,
    "the model was told to retry a call that can never succeed, and it retried four times before reporting web search as broken",
  );
  assert.equal(
    modelMessage.includes("may be temporary"),
    false,
    "nothing about a missing account is temporary; the message must not invite a retry",
  );
  assert.match(
    modelMessage,
    /signed-in/i,
    "the model has to learn the actual cause, or it will keep reaching for a tool that cannot work",
  );
  assert.equal(
    normalized.classification,
    "unexpected_environment",
    "a host without an account is an environment that cannot serve the call, not a provider error and not a user rejection",
  );
  assert.equal(
    normalized.cause,
    raised,
    "the original error stays on cause so the log keeps the real reason",
  );
});

test("the promise of automatic renewal never reaches the model or the user", async () => {
  const service = createCursorWebSearchService({
    getAccessToken: accountlessGetAccessToken,
    getMachineId: () => "test-machine-id",
    modelId: "test-model",
  });

  const raised = await service(undefined, { searchTerm: "anything" }).then(
    () => assert.fail("the search was expected to fail, and it did not"),
    (error) => error,
  );
  const normalized = maybeNormalizeExecBoundaryError(raised);

  for (const [surface, message] of [
    ["model-visible", normalized.modelVisibleErrorMessage],
    ["client-visible", normalized.clientVisibleErrorMessage],
  ]) {
    assert.equal(
      /renews this automatically|resolves on its own/i.test(message),
      false,
      `the ${surface} message repeats a self-healing this host cannot deliver, which is the false reassurance the classifier path was fixed to remove`,
    );
    assert.equal(
      /temporary|Try again/i.test(message),
      false,
      `the ${surface} message still invites a retry of a call that cannot succeed, which is what produced the four identical attempts`,
    );
  }
});

test("a credential failure on a tool other than web search is reported the same way", async () => {
  const raised = new Error(`[unauthenticated] ${SAND_SHORTLIVED_CREDS_WAITING_MESSAGE}`);
  const normalized = maybeNormalizeExecBoundaryError(raised);

  assert.match(
    normalized.modelVisibleErrorMessage,
    /signed-in/i,
    "every Cursor-backed tool dies this way, so the correction belongs at the boundary and not inside the web search tool",
  );
});

test("an unrelated connect failure keeps its own classification", () => {
  const rateLimited = maybeNormalizeExecBoundaryError(
    new Error("[resource_exhausted] high load, rate limit exceeded"),
  );

  assert.equal(
    rateLimited.classification,
    "provider_error",
    "a genuinely temporary provider failure must still be classified as a provider error, or this fix would silence real retries",
  );
  assert.match(
    rateLimited.modelVisibleErrorMessage,
    /rate limited/i,
    "a real rate limit still has to read as a rate limit",
  );
});