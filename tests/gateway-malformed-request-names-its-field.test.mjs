import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Six gateway commands answered a malformed request with the raw text of a V8
 * `TypeError`. Measured on a live box: `POST /api/sendPrompt {}` returned
 * `500 {"error":"Cannot read properties of undefined (reading 'trim')"}`, and so
 * did `respondToWidget`, `submitSecret`, `reactToMessage` and `connectChannel`.
 * `createAgentAutomation` with `spec:{}` returned
 * `500 {"error":"Cannot read properties of undefined (reading 'replace')"}`.
 *
 * Every one of those strings comes from a callee that trusted its arguments.
 * The `.trim()` lives in `widget-responses.ts` and the `.replace` in the
 * automation runtime; neither is near the request, so the message names no
 * command, no field and no remedy. To a caller on a loopback control surface
 * this reads as "the server is broken", not "you left a field out", and the two
 * need completely different responses.
 *
 * Two commands in the same file already got this right — `getAgentTranscriptWindow`
 * and `getAgentThread` parse their request and refuse with
 * `Malformed <command> request`. The check was simply missing everywhere else.
 *
 * These tests build the real API over a recording extension and assert that every
 * refusal names its command and its field. They also pin the other half of the
 * contract: a request that is well-formed is still forwarded unchanged, and an
 * empty `value` is still a legitimate `respondToWidget` answer that reaches the
 * extension rather than being refused here — a fix that tightened more than the
 * error message would have been a new defect.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-args-shape-"));
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

const { loaded, dispose } = await bundle([["host", "host-gateway-api.ts"]]);
const { createHostGatewayApi, HOST_CAPABILITIES } = loaded["host-gateway-api.mjs"];
test.after(() => dispose());

/**
 * An API over extensions that record every call. Each manager method resolves to
 * a recording function, so a test can tell "the gateway refused" from "the
 * extension was reached and objected".
 *
 * The four widget commands deliberately do what the real extensions do on their
 * first line — `value.trim()`, `emoji.trim()` — and the automation command does
 * what the real runtime does to a missing trigger. Without that, a recording
 * double that accepts everything would let the pre-fix gateway forward a
 * malformed request and the test would pass on broken code for the wrong reason.
 */
function recordingApi() {
  const calls = [];
  const firstUse = {
    sendPrompt: (args) => args[0].trim(),
    respondToWidget: (args) => args[1].trim(),
    submitSecret: (args) => args[1].trim(),
    reactToMessage: (args) => args[1].trim(),
    connectChannel: (args) => args[2].trim(),
    createAgentAutomation: (args) => args[1].trigger.type.replace("x", "y"),
    setBoxSecrets: (args) => Object.keys(args[0].secrets),
  };
  const record = (name) => (...args) => {
    calls.push({ name, args });
    // What the real extension does with the argument before anything else.
    firstUse[name]?.(args);
    // The shapes the real extensions answer with, reduced to what a caller reads.
    if (name === "getAgentAutomations" || name === "createAgentAutomation") return [];
    if (name === "getAgentChannels") return { manifests: [], connections: [] };
    if (name === "listAgentsSync") return [];
    if (name === "sendPrompt" || name === "respondToWidget") return { accepted: true };
    return undefined;
  };
  const proxy = new Proxy({}, { get: (_target, name) => record(String(name)) });
  // `telemetry` is both an API and an object of APIs: `sendPrompt` calls
  // `telemetry.reportMessageSent` while `markActive` reaches through
  // `telemetry.analytics.markActive`. A double that answers every property with
  // a function makes every command fail for the wrong reason, and one that
  // answers with a plain object makes it fail for a different wrong reason.
  const telemetryApi = new Proxy({ analytics: proxy }, {
    get: (target, name) => (typeof name === "symbol"
      ? Reflect.get(target, name)
      : name in target
        ? target[name]
        : record(String(name))),
  });
  const extensions = {
    api: (id) => {
      if (id === "mcp") return { mcp: {}, listBoxServers: async () => [] };
      if (id === "telemetry") return telemetryApi;
      return proxy;
    },
  };
  const host = createHostGatewayApi({
    extensions,
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
  assert.notEqual(typeof host.sendPrompt, "undefined",
    "the gateway returned no sendPrompt at all, so this test would be measuring nothing");
  return { api: host, calls };
}

const refuse = async (invoke) => {
  try {
    await invoke();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const CASES = [
  { command: "sendPrompt", field: "prompt", call: (api) => api.sendPrompt({}) },
  { command: "sendPrompt", field: "prompt", call: (api) => api.sendPrompt({ prompt: 42 }) },
  { command: "respondToWidget", field: "value", call: (api) => api.respondToWidget({}) },
  { command: "respondToWidget", field: "value", call: (api) => api.respondToWidget({ value: null }) },
  { command: "submitSecret", field: "value", call: (api) => api.submitSecret({}) },
  { command: "reactToMessage", field: "emoji", call: (api) => api.reactToMessage({}) },
  { command: "connectChannel", field: "platform", call: (api) => api.connectChannel({}) },
  { command: "connectChannel", field: "token", call: (api) => api.connectChannel({ platform: "slack" }) },
  { command: "createAgentAutomation", field: "id", call: (api) => api.createAgentAutomation({}) },
  { command: "createAgentAutomation", field: "spec.trigger", call: (api) => api.createAgentAutomation({ id: "a1", spec: {} }) },
  { command: "executeRoutedMcpTool", field: "name", call: (api) => api.executeRoutedMcpTool({}) },
  { command: "executeRoutedMcpTool", field: "toolName", call: (api) => api.executeRoutedMcpTool({ name: "x" }) },
  { command: "setBoxSecrets", field: "secrets", call: (api) => api.setBoxSecrets({}) },
  { command: "setBoxSecrets", field: "secrets", call: (api) => api.setBoxSecrets({ secrets: [] }) },
];

test("every malformed command request names the command and the field", async () => {
  for (const entry of CASES) {
    const { api, calls } = recordingApi();
    const message = await refuse(() => entry.call(api));
    assert.doesNotMatch(
      message ?? "",
      /Cannot read properties of (undefined|null)|Cannot read property/,
      `${entry.command} leaked a raw V8 TypeError to the caller: "${message}"`,
    );
    assert.notEqual(message, null, `${entry.command} answered a malformed request instead of refusing it`);
    assert.match(
      message,
      new RegExp(`Malformed ${entry.command} request`),
      `${entry.command} refused with "${message}", which names neither the command nor that the request is malformed`,
    );
    assert.ok(
      message.includes(`"${entry.field}"`),
      `${entry.command} refused with "${message}", which does not name the field "${entry.field}"`,
    );
    assert.doesNotMatch(
      message,
      /Cannot read properties of (undefined|null)/,
      `${entry.command} leaked the raw V8 TypeError text "${message}" to the caller`,
    );
    assert.equal(calls.filter((call) => call.name === entry.command).length, 0,
      `${entry.command} reached the transcript manager with a request the gateway had already refused, so the refusal does not stop the call`);
  }
});

test("a well-formed request still reaches the extension, unchanged", async () => {
  const { api, calls } = recordingApi();
  await api.sendPrompt({ agentId: "a1", prompt: "  hello  ", replyToId: "e9" });
  const sent = calls.find((call) => call.name === "sendPrompt");
  assert.notEqual(sent, undefined, "a well-formed sendPrompt never reached the transcript manager");
  assert.equal(sent.args[0], "  hello  ",
    "the gateway trimmed the prompt on its way in, so the extension no longer sees what the caller sent");
  assert.equal(sent.args[1].agentId, "a1", "the agent id was lost on the way to the extension");
  assert.equal(sent.args[1].replyToId, "e9", "the reply target was lost on the way to the extension");

  const reaction = recordingApi();
  await reaction.api.reactToMessage({ entryId: "e1", emoji: "👍", agentId: "a1" });
  const reacted = reaction.calls.find((call) => call.name === "reactToMessage");
  assert.deepEqual(reacted.args, ["e1", "👍", "a1"],
    `reactToMessage received ${JSON.stringify(reacted.args)} instead of the three arguments the extension was handed before`);
});

test("an empty value is a legitimate answer, not a malformed request", async () => {
  // `respondToWidget` answers `{accepted:false}` for an empty reply, and
  // `submitSecret` returns for one. Refusing here would have turned a quiet
  // "nothing to say" into an error the user cannot act on.
  for (const [command, args] of [["respondToWidget", { value: "" }], ["submitSecret", { value: "" }], ["reactToMessage", { emoji: "  " }]]) {
    const { api, calls } = recordingApi();
    const message = await refuse(() => api[command](args));
    assert.equal(message, null, `${command} refused an empty string with "${message}"`);
    assert.ok(calls.some((call) => call.name === command), `${command} dropped an empty string instead of forwarding it`);
  }
});

test("the capability list is untouched by the argument checks", () => {
  assert.ok(Array.isArray(HOST_CAPABILITIES) && HOST_CAPABILITIES.length > 0,
    "the host capability list came back empty, so the box would negotiate no capabilities");
});