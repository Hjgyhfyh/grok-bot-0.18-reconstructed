/**
 * The coordinator's local inference router answered `sendPrompt` for every provider except
 * `cursor`, so on a box configured for the `custom` endpoint the user's message never left the
 * desktop. The route answered it itself: it flattened the transcript into bare role/content
 * pairs, treated the routed MCP tool list as the only tool source — and that list is empty on a
 * box with no connectors, so `toToolSet` returned `undefined` and the request went out with no
 * `tools` key at all — and it sent `GROK_ROUTER_SYSTEM_PROMPT`, four lines naming no
 * capability, as the whole system text. The reply was then written into the chat as a
 * `send-message` bubble, as if the agent had sent it.
 *
 * Nothing threw and nothing looked broken. The agent runner sends a correct prompt with a
 * correct toolset; the routed provider is a working text completion. Only the composition was
 * wrong, and it was wrong above every prompt in the repository. The result was a user asking
 * "what can you do besides basic LLM functions" and being told the truth about the request that
 * had actually been made.
 *
 * The route is kept for the one concern that really is agent-free: naming the conversation from
 * the `{"isNewTopic":true,"title":"..."}` payload the model already produced. These tests prove
 * the turn is declined so the agent on the box runs it, that nothing this route produces can
 * reach the user as a chat message, that the title still lands, and that the `cursor` provider
 * behaves exactly as it did before.
 *
 * The second defect is in the same change: `getTranscript` ignored the `agentId` it was called
 * with and always answered for the active session, so three different ids returned three
 * byte-identical transcripts.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROMPT = "Что ты умеешь кроме базовых функций LLM? Перечисли все свои инструменты по именам.";
const CONTROL_REPLY = '{"isNewTopic":true,"title":"Возможности агента"}';

/**
 * Builds the real router with only `runRoutedProviderText` replaced, so the decision this test
 * is about — whether the route answers a turn — is the product's own, and the model's words are
 * the only thing that is fixed. The stub records every call into `globalThis`, because esbuild
 * inlines the stub into the router bundle and no module-level array is shared with this file.
 */
async function loadRouter({ provider = "custom", reply = CONTROL_REPLY } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-sendprompt-agent-"));
  delete globalThis.__routedProviderCalls;
  await writeFile(
    path.join(dataDir, "settings.json"),
    `${JSON.stringify({ version: 1, inferenceProvider: provider, inferenceCustomEndpoint: { baseUrl: "https://endpoint.invalid/v1", modelId: "model-under-test" } }, null, 2)}\n`,
    "utf8",
  );
  const stubPath = path.join(dataDir, "provider-session-stub.mjs");
  await writeFile(stubPath, [
    "export async function runRoutedProviderText(provider, messages, options = {}) {",
    "  (globalThis.__routedProviderCalls ??= []).push({ provider, messages, options });",
    `  return ${JSON.stringify(reply)};`,
    "}",
    "",
  ].join("\n"), "utf8");
  const outfile = path.join(dataDir, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "node-agent-coordinator", "inference-router.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins: [{
      name: "stub-provider-session",
      setup(builder) {
        builder.onResolve({ filter: /provider-session(\.js)?$/ }, () => ({ path: stubPath }));
      },
    }],
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dataDir, providerCalls: () => globalThis.__routedProviderCalls ?? [], dispose: () => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/** The roster and profile calls this route makes, plus every transcript event it emits. */
function stubbedHost({ roster, onUpdateAgent } = {}) {
  const events = [];
  const remote = [];
  return {
    events,
    remote,
    dispatchRemote: async (method, args) => {
      remote.push({ method, args });
      if (method === "listAgents") return roster ?? [{ id: "agent-1", name: "Grok", description: "probe", title: "" }];
      if (method === "updateAgent") {
        if (onUpdateAgent != null) await onUpdateAgent(args);
        return null;
      }
      return null;
    },
  };
}

/**
 * Naming is queued and never awaited, so a test observes it settling instead of assuming it
 * ended with the acknowledgement. Without a ceiling a route that never settles would hang the
 * suite instead of failing it.
 */
async function settle(signature, { intervalMs = 25, quietChecks = 6, ceilingMs = 10_000 } = {}) {
  let previous = signature();
  let quiet = 0;
  for (let elapsed = 0; elapsed < ceilingMs; elapsed += intervalMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const current = signature();
    if (current !== previous) { previous = current; quiet = 0; continue; }
    if (++quiet >= quietChecks) return;
  }
  throw new Error("the routed naming work never settled, so nothing about it can be asserted");
}

/** One `sendPrompt` through the router, with everything it touched captured afterwards. */
async function sendPrompt(loaded, host, args = {}) {
  const router = loaded.module.createCoordinatorInferenceRouter({
    dataDir: loaded.dataDir,
    postEvent: (family, payload) => host.events.push({ family, payload }),
    dispatchRemote: host.dispatchRemote,
  });
  const dispatched = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: PROMPT, ...args });
  const storePath = path.join(loaded.dataDir, "inference-router-transcript.json");
  const stored = () => { try { return readFileSync(storePath, "utf8"); } catch { return null; } };
  const signature = () => JSON.stringify([host.events, host.remote, stored()]);
  await settle(signature);
  return { dispatched, stored: stored(), providerCalls: loaded.providerCalls() };
}

test("a prompt typed in the chat is declined by this route, so the agent on the box runs the turn", async () => {
  const loaded = await loadRouter();
  const host = stubbedHost();
  try {
    const run = await sendPrompt(loaded, host);

    assert.equal(run.dispatched.handled, false, "the route answered the turn itself, so it never reached the agent runner on the box");
    assert.equal(run.dispatched.value, undefined, "the route answered a turn it should have forwarded");
    assert.deepEqual(
      run.providerCalls.map(call => call.messages.length),
      [1],
      "the route ran a model completion over the conversation, which is how the agent came to describe itself as a text model with no tools",
    );
    assert.deepEqual(
      run.providerCalls.map(call => call.options.tools),
      [undefined],
      "the route asked a model for a reply while offering it tools, so a tool call could still be answered with no agent behind it",
    );
  } finally {
    await loaded.dispose();
  }
});

test("no provider reply from this route can reach the user as a chat message", async () => {
  const loaded = await loadRouter();
  const host = stubbedHost();
  try {
    const run = await sendPrompt(loaded, host);

    assert.deepEqual(host.events.filter(event => event.family === "transcript"), [], "the route emitted a transcript entry, so its own words can still be shown as the agent's message");
    assert.equal(run.stored, null, "the route still writes a transcript of its own, so a routed turn is still a chat bubble the agent knows nothing about");
  } finally {
    await loaded.dispose();
  }
});

test("an untitled agent is still named from the title the model produced", async () => {
  const loaded = await loadRouter();
  const host = stubbedHost();
  try {
    const run = await sendPrompt(loaded, host);
    const update = host.remote.find(call => call.method === "updateAgent");

    assert.equal(run.providerCalls.length, 1, "the title is the one thing this route should still ask a model for, and it asked for nothing");
    assert.notEqual(update, undefined, "the title in the control payload was thrown away and the conversation lost its name");
    assert.deepEqual(
      update.args,
      { id: "agent-1", profile: { name: "Grok", description: "probe", title: "Возможности агента" } },
      "the title was not written through updateAgent as a full profile, so the agent was not retitled",
    );
    assert.deepEqual(
      run.providerCalls[0].messages.map(message => message.role),
      ["user"],
      "the title request must not read the conversation as if the route owned it",
    );
    assert.ok(run.providerCalls[0].messages[0].content.includes(PROMPT), "the title was asked for without the message it is supposed to name");
    assert.equal(run.providerCalls[0].options.tools, undefined, "the title request carried tools, so a title could be built out of a tool call with no agent behind it");
  } finally {
    await loaded.dispose();
  }
});

test("an agent that already has a title is not renamed by every message it receives", async () => {
  const loaded = await loadRouter();
  const host = stubbedHost({ roster: [{ id: "agent-1", name: "Grok", description: "probe", title: "Проверка маршрута" }] });
  try {
    const run = await sendPrompt(loaded, host);

    assert.deepEqual(run.providerCalls, [], "a name the user already chose was overwritten by a fresh guess, at the cost of a request per message");
    assert.deepEqual(host.remote.filter(call => call.method === "updateAgent"), [], "the agent profile was rewritten even though the agent was already titled");
  } finally {
    await loaded.dispose();
  }
});

test("a reply that is not a control payload is dropped instead of being shown", async () => {
  const loaded = await loadRouter({ reply: "Sure! Here is a name for the conversation." });
  const host = stubbedHost();
  try {
    const run = await sendPrompt(loaded, host);

    assert.deepEqual(host.remote.filter(call => call.method === "updateAgent"), [], "a plain sentence was treated as a control payload and renamed the agent with it");
    assert.deepEqual(host.events.filter(event => event.family === "transcript"), [], "a title request that failed to parse was shown in the chat as a message from the agent");
  } finally {
    await loaded.dispose();
  }
});

test("a title that cannot be stored never turns into an error in the chat", async () => {
  const loaded = await loadRouter();
  const host = stubbedHost({ onUpdateAgent: () => { throw new Error("profile store is read-only"); } });
  try {
    const run = await sendPrompt(loaded, host);

    assert.equal(run.dispatched.handled, false, "a title that could not be stored changed the verdict on the turn itself");
    assert.deepEqual(host.events.filter(event => event.family === "transcript"), [], "a failed title surfaced as an error bubble in the chat");
  } finally {
    await loaded.dispose();
  }
});

test("the cursor provider declines the turn and asks the model for nothing, exactly as before", async () => {
  const loaded = await loadRouter({ provider: "cursor" });
  const host = stubbedHost();
  try {
    const run = await sendPrompt(loaded, host);

    assert.equal(run.dispatched.handled, false, "the cursor provider stopped declining sendPrompt, which is not this route's to change");
    assert.deepEqual(run.providerCalls, [], "the cursor provider was sent a request it never sent before");
    assert.deepEqual(host.remote, [], "the cursor provider was asked for a roster it never needed before");
  } finally {
    await loaded.dispose();
  }
});

test("a prompt that names no agent reaches the agent without being named", async () => {
  const loaded = await loadRouter();
  const host = stubbedHost();
  try {
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: loaded.dataDir,
      postEvent: (family, payload) => host.events.push({ family, payload }),
      dispatchRemote: host.dispatchRemote,
    });
    const dispatched = await router.dispatch("sendPrompt", { prompt: PROMPT });
    await settle(() => `${host.events.length}|${host.remote.length}`);

    assert.equal(dispatched.handled, false, "a prompt with no agent id was answered here instead of being forwarded");
    assert.deepEqual(host.remote, [], "a prompt that names no agent was used to name some agent");
  } finally {
    await loaded.dispose();
  }
});

async function loadHostGatewayApi() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-gettranscript-agent-"));
  const outfile = path.join(directory, "host-gateway-api.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "host-gateway-api.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { module, dispose: () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

/** The transcript manager, reduced to the two methods `getTranscript` may reach. */
function stubbedManager(transcripts) {
  const calls = [];
  return {
    calls,
    api: {
      ensureLoaded(...args) { calls.push({ method: "ensureLoaded", args }); return transcripts.byId[transcripts.active]; },
      getAgentTranscript(...args) { calls.push({ method: "getAgentTranscript", args }); return transcripts.byId[args[0]]; },
    },
  };
}

async function hostApiWith(transcripts) {
  const loaded = await loadHostGatewayApi();
  const manager = stubbedManager(transcripts);
  const api = loaded.module.createHostGatewayApi({
    extensions: { api: (id) => (id === "transcript" ? manager.api : {}) },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
  return { api, manager, dispose: loaded.dispose };
}

test("getTranscript answers about the agent it was asked about, not about whichever one is active", async () => {
  const built = await hostApiWith({ active: "agent-b", byId: { "agent-a": ["a1"], "agent-b": ["b1", "b2"] } });
  try {
    const entries = await built.api.getTranscript({ agentId: "agent-a" });

    assert.deepEqual(entries, ["a1"], "asking about agent A returned the transcript of the active agent instead");
    assert.deepEqual(built.manager.calls, [{ method: "getAgentTranscript", args: ["agent-a"] }], "the requested id was not the one the transcript manager was asked for");
  } finally {
    await built.dispose();
  }
});

test("three different agent ids return three different transcripts", async () => {
  const built = await hostApiWith({ active: "agent-a", byId: { "agent-a": ["a1"], "agent-b": ["b1"], "agent-c": ["c1", "c2"] } });
  try {
    const [a, b, c] = await Promise.all([
      built.api.getTranscript({ agentId: "agent-a" }),
      built.api.getTranscript({ agentId: "agent-b" }),
      built.api.getTranscript({ agentId: "agent-c" }),
    ]);

    assert.deepEqual([a, b, c], [["a1"], ["b1"], ["c1", "c2"]], "three ids returned the same transcript, so a probe could not tell one conversation from another");
  } finally {
    await built.dispose();
  }
});

test("getTranscript with no id at all still answers for the active session", async () => {
  for (const args of [undefined, {}, { agentId: "" }]) {
    const built = await hostApiWith({ active: "agent-b", byId: { "agent-a": ["a1"], "agent-b": ["b1", "b2"] } });
    try {
      const entries = await built.api.getTranscript(args);

      assert.deepEqual(entries, ["b1", "b2"], `a call with no agent id (${JSON.stringify(args)}) stopped answering for the active session`);
      assert.deepEqual(built.manager.calls, [{ method: "ensureLoaded", args: [] }], `a call with no agent id (${JSON.stringify(args)}) was sent to the manager as an agent lookup`);
    } finally {
      await built.dispose();
    }
  }
});
