import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listerPath = path.join(repoRoot, "source", "shared", "node", "inference-endpoint-models.ts");
const patchPath = path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs");

const SECRET = "oc_sk_live_do_not_leak_me_0123456789";

async function loadLister() {
  const source = await readFile(listerPath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function jsonResponse(body, init = {}) {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function listingJson() {
  return jsonResponse({
    object: "list",
    data: [
      { id: "space-bunny-free", object: "model", owned_by: "opencode" },
      { id: "gpt-6-luna", object: "model", owned_by: "opencode" },
      { id: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
      { id: "grok-4.7" },
      { notAnId: true },
    ],
  });
}

function serializable(value) {
  return JSON.stringify(value, (_key, item) => (item instanceof Error ? { name: item.name, message: item.message } : item));
}

/** Every string the renderer can observe, flattened for a leak check. */
function stringsOf(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value != null && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

test("the lister returns endpoint ids and display names for a valid list", async () => {
  const { listSandEndpointModels } = await loadLister();
  const seen = [];
  const listing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async (url, init) => { seen.push([url, init]); return listingJson(); },
  });

  assert.deepEqual(seen[0][0], "https://opencode.ai/zen/go/v1/models");
  assert.equal(seen[0][1].method, "GET");
  assert.equal(seen[0][1].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(listing.status, "ok");
  assert.equal(listing.reason, null);
  assert.equal(listing.endpoint, "https://opencode.ai/zen/go/v1/models");
  assert.deepEqual(listing.models.map((model) => model.id), ["space-bunny-free", "gpt-6-luna", "deepseek-v4-pro", "grok-4.7"]);
  assert.deepEqual(listing.models[2], { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" });
  assert.equal(listing.models[0].name, null);
});

test("a 401 degrades to no list without leaking the key", async () => {
  const { listSandEndpointModels } = await loadLister();
  const listing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse({ error: { message: `invalid key ${SECRET}` } }, { status: 401 }),
  });

  assert.equal(listing.status, "unavailable");
  assert.equal(listing.reason, "unauthorized");
  assert.deepEqual(listing.models, []);
  assert.equal(listing.endpoint, "https://opencode.ai/zen/go/v1/models");
  for (const text of stringsOf(listing)) assert.equal(text.includes(SECRET), false, `leaked the key: ${text}`);
});

test("a non-JSON body degrades to no list without leaking the key", async () => {
  const { listSandEndpointModels } = await loadLister();
  const listing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse(`<!doctype html><p>gateway</p>`),
  });

  assert.equal(listing.status, "unavailable");
  assert.equal(listing.reason, "invalid-response");
  assert.deepEqual(listing.models, []);
  for (const text of stringsOf(listing)) assert.equal(text.includes(SECRET), false, `leaked the key: ${text}`);
});

test("a missing or malformed data array degrades to no list", async () => {
  const { listSandEndpointModels } = await loadLister();
  const bodies = [{}, { data: null }, { data: "space-bunny-free" }, { data: { id: "x" } }, []];
  for (const body of bodies) {
    const listing = await listSandEndpointModels({
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: SECRET,
      fetchImpl: async () => jsonResponse(body),
    });
    assert.equal(listing.status, "unavailable", JSON.stringify(body));
    assert.equal(listing.reason, "invalid-response", JSON.stringify(body));
    assert.deepEqual(listing.models, [], JSON.stringify(body));
  }
});

test("an entry list with no usable id degrades to no list", async () => {
  const { listSandEndpointModels } = await loadLister();
  const listing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse({ data: [{ nope: 1 }, null, 7, "  "] }),
  });
  assert.equal(listing.status, "unavailable");
  assert.equal(listing.reason, "no-models");
  assert.deepEqual(listing.models, []);
});

test("a network failure and a timeout degrade to no list and never reject", async () => {
  const { listSandEndpointModels } = await loadLister();
  const failing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED with key ${SECRET}`); },
  });
  assert.equal(failing.status, "unavailable");
  assert.equal(failing.reason, "network-error");
  for (const text of stringsOf(failing)) assert.equal(text.includes(SECRET), false, `leaked the key: ${text}`);

  const timedOut = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    timeoutMs: 10,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  assert.equal(timedOut.status, "unavailable");
  assert.equal(timedOut.reason, "timeout");
});

test("a huge list is truncated instead of streamed to the renderer", async () => {
  const { listSandEndpointModels, SAND_ENDPOINT_MODEL_LIST_LIMIT } = await loadLister();
  const data = Array.from({ length: SAND_ENDPOINT_MODEL_LIST_LIMIT + 500 }, (_item, index) => ({ id: `model-${index}` }));
  const listing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse({ data }),
  });
  assert.equal(listing.status, "ok");
  assert.equal(listing.models.length, SAND_ENDPOINT_MODEL_LIST_LIMIT);
  assert.equal(listing.truncated, true);
});

test("a non-https, non-loopback base URL is refused before any request", async () => {
  const { listSandEndpointModels, isSandEndpointModelBaseUrlAllowed, sandEndpointModelProbeTarget } = await loadLister();
  let called = 0;
  for (const baseUrl of ["http://api.example.com/v1", "ftp://api.example.com/v1", "file:///etc/passwd", "not a url", "", "https://user:pass@api.example.com/v1"]) {
    const listing = await listSandEndpointModels({
      baseUrl,
      apiKey: SECRET,
      fetchImpl: async () => { called += 1; return listingJson(); },
    });
    assert.equal(listing.status, "unavailable", baseUrl);
    assert.equal(listing.reason, "insecure-url", baseUrl);
    assert.deepEqual(listing.models, [], baseUrl);
    assert.equal(listing.endpoint, "", baseUrl);
  }
  assert.equal(called, 0, "a refused base URL must never reach the network");

  assert.equal(isSandEndpointModelBaseUrlAllowed("https://api.example.com/v1"), true);
  assert.equal(isSandEndpointModelBaseUrlAllowed("http://127.0.0.1:1234/v1"), true);
  assert.equal(isSandEndpointModelBaseUrlAllowed("http://localhost:1234/v1"), true);
  assert.equal(isSandEndpointModelBaseUrlAllowed("http://api.example.com/v1"), false);
  assert.deepEqual(sandEndpointModelProbeTarget("https://api.example.com/v1"), { url: "https://api.example.com/v1/models", report: "https://api.example.com/v1/models" });
});

test("the key never appears in any returned value, even when the endpoint echoes it", async () => {
  const { listSandEndpointModels } = await loadLister();
  const listing = await listSandEndpointModels({
    baseUrl: `https://api.example.com/v1?token=${SECRET}#${SECRET}`,
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse({
      data: [
        { id: SECRET, name: `prefix ${SECRET}` },
        { id: "echoed-in-name", name: SECRET },
        { id: "fine-model", name: "Fine" },
      ],
    }),
  });

  assert.equal(listing.status, "ok");
  assert.deepEqual(listing.models, [{ id: "fine-model", name: "Fine" }]);
  assert.equal(listing.endpoint.includes(SECRET), false);
  assert.equal(listing.endpoint, "https://api.example.com/v1/models");
  for (const text of stringsOf(listing)) assert.equal(text.includes(SECRET), false, `leaked the key: ${text}`);
});

test("a missing stored key degrades to no list and never reaches the network", async () => {
  const { listSandEndpointModels } = await loadLister();
  let called = 0;
  for (const apiKey of [null, undefined, "", "   "]) {
    const listing = await listSandEndpointModels({
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey,
      fetchImpl: async () => { called += 1; return listingJson(); },
    });
    assert.equal(listing.status, "unavailable");
    assert.equal(listing.reason, "missing-credential");
    assert.deepEqual(listing.models, []);
  }
  assert.equal(called, 0);
});

test("a 5xx answers as http-status and never surfaces the response body", async () => {
  const { listSandEndpointModels } = await loadLister();
  const listing = await listSandEndpointModels({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: SECRET,
    fetchImpl: async () => jsonResponse(`upstream rejected ${SECRET}`, { status: 503 }),
  });
  assert.equal(listing.status, "unavailable");
  assert.equal(listing.reason, "http-status");
  for (const text of stringsOf(listing)) assert.equal(text.includes(SECRET), false, `leaked the key: ${text}`);
});

test("the renderer's custom panel keeps a free-text escape hatch and a select", async () => {
  const patch = await readFile(patchPath, "utf8");
  const injected = patch.match(/const COMPONENT_SOURCE = String\.raw`([\s\S]*?)`;/)?.[1] ?? "";
  assert.ok(injected.length > 0, "the patch must keep its component source");

  // The same field the free-text input sets is what a selection writes.
  assert.match(injected, /a\.jsx\("input",\{"aria-label":"Endpoint model id"[\s\S]*?onChange:j=>f\(\[g,j\.currentTarget\.value\]\)/);
  assert.match(injected, /onPick:j=>f\(\[g,j\]\)/);
  assert.match(injected, /const E=\{baseUrl:g\.trim\(\),modelId:v\.trim\(\)\}/);
  assert.match(injected, /a\.jsx\("select",\{"aria-label":"Endpoint model list"/);
  assert.match(injected, /a\.jsx\(RRouterModelSelect,\{busy:o,listing:p,modelId:v,onPick:j=>f\(\[g,j\]\),onRetry:\(\)=>b\(x=>x\+1\)\}\)/);

  // A typed id that the list does not carry is reported, never reset.
  assert.match(injected, /function RRouterModelAbsent\(/);
  assert.match(injected, /it is kept exactly as you typed it/);

  // React hygiene: no render-phase writes beyond the converging guard setter.
  assert.doesNotMatch(injected, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(injected, /innerHTML/);
  assert.doesNotMatch(injected, /OPENAI_API_KEY/);
  assert.doesNotMatch(injected, /ANTHROPIC_API_KEY/);
  assert.match(injected, /live=false;clearTimeout\(timer\)/);
});

test("the preload and main edge expose one read-only model-listing call", async () => {
  const preload = await readFile(path.join(repoRoot, "source", "electron-preload", "preload.ts"), "utf8");
  const mainEdge = await readFile(path.join(repoRoot, "source", "electron-main", "main-edge.ts"), "utf8");

  assert.match(preload, /listInferenceRouterModels: \(baseUrl: string\) => edge\("listInferenceRouterModels", \{ baseUrl \}\)/);
  assert.match(mainEdge, /listInferenceRouterModels: async \(raw\) => await listSandEndpointModels\(\{ baseUrl: req\(raw\)\.baseUrl, apiKey: await storedCustomEndpointApiKey\(deps\) \}\)/);
  // The handler reveals the key itself and never forwards it into the reply.
  assert.match(mainEdge, /const CUSTOM_ENDPOINT_SECRET_KEY = "OPENAI_COMPATIBLE_API_KEY"/);
  assert.equal(serializable(mainEdge.match(/listInferenceRouterModels:[^\n]*/)[0]).includes(SECRET), false);
  // The router save path carries the provider the store agreed to, not the one the
  // caller asked for. Forwarding the requested value would push the account-backed
  // provider at the box and hand the panel back a route no turn ever took.
  assert.match(mainEdge, /syncHostSettingsToBox\(\{ inferenceProvider: resolveServedInferenceProvider\(provider\) \}\)/);
  assert.match(mainEdge, /return \{ provider: resolveServedInferenceProvider\(provider\), usage:/);
});