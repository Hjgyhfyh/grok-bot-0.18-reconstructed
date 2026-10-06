/*
  A double slash in the custom endpoint's base URL moved the model-list probe onto a
  host the user never typed.

  `sandEndpointModelProbeTarget` built the probe as
  `new URL(`${basePath}/models`, url.origin)`, where `basePath` is `url.pathname` with
  trailing slashes stripped. For `https://api.example.com//evil.example.com/v1` the
  WHATWG parser puts the whole `//evil.example.com/v1` in `pathname`, so `basePath`
  still begins with `//` — and a template literal that starts with `//` is a
  protocol-relative reference, not a path. `new URL("//evil.example.com/v1/models",
  "https://api.example.com")` therefore resolves to `https://evil.example.com/v1/models`.
  The host the credential was scoped to is gone, and the probe is still reported as
  `ok`, so the Router panel says the list came from the endpoint the user typed.

  Nothing caught it because `https://api.example.com/v1//` (the common case — a
  trailing slash, same shape, no second host) resolves correctly and produces the
  expected URL, so the whole-string prefix check passes and the double-slash case looks
  like a curiosity rather than a credential leak. The `isSandEndpointModelBaseUrlAllowed`
  gate returned `true` for it too: the guard was satisfied, and the request still left.

  These tests prove the probe target stays on the host the user typed, and that the
  credential is never offered to any other host.
*/

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listerPath = path.join(repoRoot, "source", "shared", "node", "inference-endpoint-models.ts");

/** A value that only ever exists inside this test. Never a real credential. */
const SECRET = "sk-probe-only-not-a-real-credential-0000";
const TYPED_HOST = "api.example.com";

async function loadLister() {
  const source = await readFile(listerPath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("a base URL whose path starts with a double slash probes the host the user typed, not the one in the path", async () => {
  const { sandEndpointModelProbeTarget } = await loadLister();

  // MEASURED BEFORE THE FIX: `https://api.example.com//evil.example.com/v1` produced
  // `https://evil.example.com/v1/models`.
  const probe = sandEndpointModelProbeTarget(`https://${TYPED_HOST}//evil.example.com/v1`);
  assert.notEqual(probe, null, "a https base URL on a public host must stay probeable");
  assert.equal(
    new URL(probe.url).host,
    TYPED_HOST,
    "a double slash inside the path must not re-point the probe at a different host",
  );
  assert.equal(new URL(probe.report).host, TYPED_HOST, "the reported endpoint must name the host the user typed");
});

test("the probe target keeps the host for every double-slash shape, including a bare `//v1`", async () => {
  const { sandEndpointModelProbeTarget } = await loadLister();
  for (const baseUrl of [
    `https://${TYPED_HOST}//v1`,
    `https://${TYPED_HOST}//v1//`,
    `https://${TYPED_HOST}///`,
    `https://${TYPED_HOST}//evil.example.com/v1`,
    `https://${TYPED_HOST}//evil.example.com/v1//`,
    `http://127.0.0.1:8080//v1`,
  ]) {
    const probe = sandEndpointModelProbeTarget(baseUrl);
    assert.notEqual(probe, null, `${baseUrl} must stay probeable`);
    assert.equal(
      new URL(probe.url).host,
      new URL(baseUrl).host,
      `${baseUrl} must be probed on the host the user typed`,
    );
  }
});

test("the stored credential is never offered to a host other than the one the user typed", async () => {
  const { listSandEndpointModels } = await loadLister();
  const requests = [];
  const listing = await listSandEndpointModels({
    baseUrl: `https://${TYPED_HOST}//evil.example.com/v1`,
    apiKey: SECRET,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), host: new URL(String(url)).host, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "alpha" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requests.length, 1, "the probe must actually have been issued");
  assert.equal(requests[0].host, TYPED_HOST, "the request left for a host the user never typed");
  assert.equal(requests[0].authorization, `Bearer ${SECRET}`, "the credential belongs on the typed host, and only there");
  assert.equal(listing.status, "ok");
  assert.equal(new URL(listing.endpoint).host, TYPED_HOST, "the panel must be told the host the list actually came from");
});

test("the ordinary base URLs still probe exactly where they did", async () => {
  const { sandEndpointModelProbeTarget } = await loadLister();
  // MEASURED BEFORE THE FIX, these four were already correct and must stay correct.
  assert.deepEqual(
    sandEndpointModelProbeTarget(`https://${TYPED_HOST}/v1`),
    { url: `https://${TYPED_HOST}/v1/models`, report: `https://${TYPED_HOST}/v1/models` },
  );
  assert.deepEqual(
    sandEndpointModelProbeTarget(`https://${TYPED_HOST}/v1/`),
    { url: `https://${TYPED_HOST}/v1/models`, report: `https://${TYPED_HOST}/v1/models` },
  );
  assert.deepEqual(
    sandEndpointModelProbeTarget(`https://${TYPED_HOST}`),
    { url: `https://${TYPED_HOST}/models`, report: `https://${TYPED_HOST}/models` },
  );
  assert.deepEqual(
    sandEndpointModelProbeTarget(`https://${TYPED_HOST}/v1?token=x#frag`),
    { url: `https://${TYPED_HOST}/v1/models`, report: `https://${TYPED_HOST}/v1/models` },
  );
  assert.equal(sandEndpointModelProbeTarget(`https://${TYPED_HOST}//v1`).url, `https://${TYPED_HOST}//v1/models`, "a doubled inner slash is a path, not a host");
});