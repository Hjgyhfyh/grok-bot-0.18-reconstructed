import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The second question an agent was blocked on could not be found, so it never got
 * an answer and the agent was told the user had walked away.
 *
 * `listPendingLocalToolPermissions` was added so that a window closed before the
 * card was drawn would not leave a question unreachable: the push surface is a
 * subscription, and a question nobody is listening for is a question nobody can
 * answer. Its implementation read ONE pending ask for the agent:
 *
 *   const ask = method(localToolPermission, "getPendingRequestForAgent")(agentId);
 *   return ask == null ? [] : [ask];
 *
 * and the comment above it said at most one ask per agent is open at a time "in
 * practice". That is false, and the code below is why. The model puts two local
 * tool calls in one assistant message, `tool-stream-executor.ts:1477` runs them
 * with `Promise.all(toolPromises)`, and both reach `ask` before either is
 * answered. `askKey` holds the `toolCallId`, so the two questions are genuinely
 * distinct entries and both stay in the pending map at the same time.
 *
 * So one agent blocked on two tool calls had two open questions, and every
 * reader of the queue — this command, and `getPendingRequestForAgent` itself —
 * named the older one and dropped the younger. Measured against the real
 * controller before the fix:
 *
 *   created events: 2  ask-3:npm run build, ask-4:npm run test
 *   listPending answered: [ ask-3 ]
 *   the id hidden from every reader: ask-4
 *   ask-4 was still pending and still answerable by id: npm run test
 *
 * Nothing named ask-4 anywhere. Its card was never drawn, so it could not be
 * answered from the surface either. It sat behind a referenced ten-minute timer
 * holding the event loop open, and when it expired the agent was told
 * `SAND_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE` — "the request to run this on the user's
 * computer went unanswered". True, and not what happened: the user was never
 * shown a question to answer. This is the exact silence the command was written
 * to end, reproduced by the command itself.
 *
 * The pull now answers with every open question, and the single-slot accessor
 * stays for the callers that genuinely want one.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Falsification hook.
 *
 * With `GROK_PERMISSION_QUEUE_HEAD=1` these same assertions run against the four
 * owned files as they are at `git HEAD`, served to esbuild through an `onLoad`
 * hook. The working tree is never read for those files and never written, every
 * other file in `source/` is the working tree, and the run fails on the old code
 * — which is what proves the tests below are measuring this change and not the
 * surrounding code. `npm test` never sets it, so the suite always measures the
 * tree.
 */
const OWNED_FILES = [
  "source/host/host-gateway-api.ts",
  "source/host/gateway-server.ts",
  "source/host/extensions/local-tool-permission/local-tool-permission-controller.ts",
  "source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts",
];
const useGitHead = process.env.GROK_PERMISSION_QUEUE_HEAD === "1";

function git(args) {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_KEY_")) delete env[key];
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

/** Esbuild plugin that answers the owned files from `git show HEAD:<path>`. */
function gitHeadPlugin() {
  const atHead = new Map(OWNED_FILES.map((file) => [path.join(repoRoot, ...file.split("/")), git(["show", `HEAD:${file}`])]));
  return {
    name: "grok-permission-queue-head",
    setup(build) {
      build.onLoad({ filter: /host-gateway-api\.ts$|gateway-server\.ts$|local-tool-permission-controller\.ts$|local-tool-permission-resolution\.ts$/ }, (args) => {
        const contents = atHead.get(path.resolve(args.path));
        return contents === undefined ? null : { contents, loader: "ts" };
      });
    },
  };
}

/**
 * The gateway, the refusal class its status is decided by, and the permission
 * controller are one bundle: `statusForCommandError` matches
 * `SandLocalToolPermissionResolutionError` by `error.name`, and a second copy of
 * the class in a second bundle would still carry the name, but the gateway edge
 * that raises `SandGatewayRequestError` is an `instanceof` and must be one copy.
 */
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-permission-queue-"));
await build({
  stdin: {
    contents: [
      `export { SandLocalToolPermissionController } from "./source/host/extensions/local-tool-permission/local-tool-permission-controller.js";`,
      `export { resolveLocalToolPermissionAsk, SandLocalToolPermissionResolutionError } from "./source/host/extensions/local-tool-permission/local-tool-permission-resolution.js";`,
      `export * as machinery from "./source/shared/local-tool-permission-machinery.js";`,
      `export { statusForCommandError, startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "permission-queue-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "permission-queue.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
  plugins: useGitHead ? [gitHeadPlugin()] : [],
});
const {
  createHostGatewayApi,
  machinery,
  resolveLocalToolPermissionAsk,
  SandLocalToolPermissionController,
  SandLocalToolPermissionResolutionError,
  startGatewayServer,
  statusForCommandError,
} = await import(pathToFileURL(path.join(directory, "permission-queue.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

const COMMAND = "listPendingLocalToolPermissions";
const AGENT = "11111111-1111-4111-8111-111111111111";
/**
 * Long enough that a burst of loopback round trips cannot expire a question
 * mid-assertion, short enough that a test which fails before settling its asks
 * does not hold the run for a minute afterwards. The timer an open ask installs
 * is deliberately referenced, so it really does hold the run until it fires.
 */
const ASK_TTL_MS = 15_000;
/** A hung agent fails the assertion instead of hanging the run. */
const SAFETY_CEILING_MS = 3_000;

let counter = 0;
const settleWithin = (blocked) =>
  Promise.race([
    blocked,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("HUNG"), SAFETY_CEILING_MS);
      timer.unref?.();
    }),
  ]);

/** The real controller behind the real extension surface, wired the way `extension.ts` wires it. */
function permissionExtension({ permission = "ask" } = {}) {
  let state = permission;
  const controller = new SandLocalToolPermissionController({
    getPermission: () => state,
    setPermission: (next) => { state = next; },
    canAsk: () => true,
    hasLiveComputer: () => true,
    askTtlMs: ASK_TTL_MS,
    randomId: () => `ask-${++counter}`,
  });
  const transcript = { widgetResponses: { settleStaleLocalToolPermissionCard: async () => false } };
  return Object.assign(controller, {
    resolveAsk: (args) => resolveLocalToolPermissionAsk({ asks: controller, transcript }, args),
  });
}

/** The real host API in front of it, over doubles that answer nothing in particular. */
function hostApi(extension) {
  const proxy = new Proxy({}, { get: (_target, name) => () => undefined });
  const telemetry = new Proxy({ analytics: proxy }, {
    get: (target, name) => (typeof name === "symbol" ? Reflect.get(target, name) : name in target ? target[name] : (() => undefined)),
  });
  return createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "local-tool-permission") return extension;
        if (id === "telemetry") return telemetry;
        if (id === "mcp") return { mcp: {}, management: {}, listBoxServers: async () => [] };
        return proxy;
      },
    },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  });
}

/** The loopback gateway with the real API in front of it, so statuses are the ones a caller receives. */
async function withServer(api, run) {
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed };
  };
  try {
    return await run(call);
  } finally {
    await server.close();
  }
}

const askEndpoint = (call, agentId = AGENT) => call(`/api/${COMMAND}`, { agentId });

/**
 * Blocks one agent on two tool calls, the way two tool calls in one assistant
 * message do: started together, answered separately.
 */
function blockTwice(extension, targets = ["npm run build", "npm run test"]) {
  const created = [];
  const unsubscribe = extension.subscribe((event) => { if (event.type === "created") created.push(event.request); });
  const blocked = targets.map((target, index) =>
    extension.authorize({ agentId: AGENT, toolCallId: `call-${index}` }, { action: "run-command", target }));
  return { blocked, created, unsubscribe };
}

test("the harness measured the product and not a double", async () => {
  const extension = permissionExtension();
  const api = hostApi(extension);
  assert.ok(Object.keys(api).length >= 100,
    `the API object offered ${Object.keys(api).length} methods, so this file is measuring a broken bundle rather than the gateway`);
  assert.equal(typeof api[COMMAND], "function",
    `the gateway has no ${COMMAND} method at all, so every assertion below would pass without reaching anything`);

  const blocked = extension.authorize({ agentId: AGENT, toolCallId: "call-0" }, { action: "run-command", target: "echo hi" });
  const asked = extension.getPendingRequestForAgent(AGENT);
  assert.notEqual(asked, undefined,
    "the real controller produced no pending ask, so an empty answer from the gateway would prove nothing");
  extension.resolveRequest(asked.id, "deny");
  await settleWithin(blocked);
});

test("an agent blocked on two tool calls reports both questions, not the older one", async () => {
  const extension = permissionExtension();
  const api = hostApi(extension);
  const { blocked, created, unsubscribe } = blockTwice(extension);
  assert.equal(created.length, 2,
    `only ${created.length} question was created, so this test is not measuring the two-at-once case it is named for`);

  const answer = await withServer(api, askEndpoint);

  assert.equal(answer.status, 200,
    `a command that named the agent came back as ${answer.status}, so the caller has no way to read the questions`);
  assert.ok(Array.isArray(answer.body),
    `the command answered ${JSON.stringify(answer.body)}, and a caller cannot poll an answer whose shape depends on how many questions happen to be open`);
  assert.equal(answer.body.length, 2,
    `the agent is blocked on ${created.length} tool calls and the caller was told about ${answer.body.length}: ${JSON.stringify(answer.body.map((a) => a.target))}`);
  assert.deepEqual(new Set(answer.body.map((seen) => seen.id)), new Set(created.map((asked) => asked.id)),
    `the caller was handed ${JSON.stringify(answer.body.map((a) => a.id))} instead of the questions the host is holding: ${JSON.stringify(created.map((a) => a.id))}`);
  for (const seen of answer.body) {
    assert.equal(seen.status, "pending",
      `the question reached the caller already answered: ${seen.status}`);
    assert.equal(seen.agentId, AGENT,
      `another conversation's question leaked into this agent's answer: ${JSON.stringify(seen)}`);
  }

  unsubscribe();
  extension.resolveRequest(answer.body[0].id, "deny");
  extension.resolveRequest(answer.body[1].id, "deny");
  await settleWithin(blocked[0]);
  await settleWithin(blocked[1]);
});

test("answering one question leaves the other one on the surface", async () => {
  // The point of listing both: the second card is not merely discoverable, it
  // survives the first answer and can still be answered. A queue that reported
  // both but dropped one on the first settlement would be the same defect.
  const extension = permissionExtension();
  const api = hostApi(extension);
  const { blocked, created, unsubscribe } = blockTwice(extension);
  unsubscribe();

  await withServer(api, async (call) => {
    const before = await askEndpoint(call);
    assert.equal(before.body.length, 2, `the first poll reported ${before.body.length} questions`);

    await call("/api/resolveLocalToolPermission", {
      agentId: AGENT,
      entryId: "entry-1",
      requestId: before.body[0].id,
      resolution: "allow-once",
    });

    const after = await askEndpoint(call);
    assert.equal(after.body.length, 1,
      `after one of two questions was answered the caller still saw ${after.body.length}: ${JSON.stringify(after.body.map((a) => a.id))}`);
    assert.equal(after.body[0].id, created[1].id,
      `the question left on the surface is ${after.body[0].id} and the one still open is ${created[1].id}, so answering the first handed the caller a card for a settled question`);

    await call("/api/resolveLocalToolPermission", {
      agentId: AGENT,
      entryId: "entry-2",
      requestId: after.body[0].id,
      resolution: "deny",
    });
  });

  assert.deepEqual(await settleWithin(blocked[0]), { allowed: true, approvalId: created[0].id },
    "the question the user allowed did not run, so the second poll proved nothing about the first answer");
  assert.notEqual((await settleWithin(blocked[1])).allowed, true,
    "the question the user denied still ran");
  assert.deepEqual(created.map((asked) => asked.target), ["npm run build", "npm run test"],
    "the two questions this test opened are not the two it reported, so the run proved nothing");
});

test("an idle agent still polls clean, and one agent's questions never reach another's", async () => {
  // The list grew, so the two things a poller depends on have to be re-proved:
  // an empty answer is still an array and not a 404, and the list is still
  // scoped to one agent. A queue that leaked a neighbour's question would offer
  // a person a card for an action they never asked about.
  const extension = permissionExtension();
  const api = hostApi(extension);
  const idle = await withServer(api, askEndpoint);
  assert.equal(idle.status, 200,
    `an agent with no open question came back as ${idle.status}, so a caller polling a healthy agent is told the endpoint is missing`);
  assert.deepEqual(idle.body, [],
    `an agent with no open question answered ${JSON.stringify(idle.body)} instead of an empty list`);

  const { blocked, created, unsubscribe } = blockTwice(extension);
  unsubscribe();
  const neighbour = await withServer(api, (call) => askEndpoint(call, "22222222-2222-4222-8222-222222222222"));
  assert.deepEqual(neighbour.body, [],
    `an agent that never asked was told about ${JSON.stringify(neighbour.body)}, which is another conversation's question`);

  for (const asked of created) extension.resolveRequest(asked.id, "deny");
  await settleWithin(blocked[0]);
  await settleWithin(blocked[1]);
});

test("an answer the host cannot apply is refused to the caller as a client error", async () => {
  // Both refusals of `resolveLocalToolPermission` — a `resolution` that is not
  // one of the four words, and an answer for a question that is no longer open —
  // used to reach the wire as `500`, which tells the caller the server broke and
  // invites a retry of an answer that can never succeed as written. Measured on
  // a live box before the fix:
  //   POST /api/resolveLocalToolPermission {"resolution":"yes"}
  //     500 {"error":"Unknown local-tool permission resolution."}
  const extension = permissionExtension();
  const api = hostApi(extension);
  const { blocked, unsubscribe } = blockTwice(extension, ["echo one"]);
  unsubscribe();
  const asked = extension.getPendingRequestForAgent(AGENT);

  await withServer(api, async (call) => {
    const bad = await call("/api/resolveLocalToolPermission", {
      agentId: AGENT, entryId: "entry-1", requestId: asked.id, resolution: "yes",
    });
    assert.equal(bad.status, 400,
      `an answer whose resolution is not one of the four words came back as ${bad.status}, which tells the caller the host broke`);
    assert.match(bad.body?.error ?? "", /Malformed resolveLocalToolPermission request/,
      `the refusal does not name the command: ${JSON.stringify(bad.body)}`);
    assert.match(bad.body?.error ?? "", /"resolution"/,
      `the refusal does not name the field the caller has to fix: ${JSON.stringify(bad.body)}`);
    assert.doesNotMatch(bad.body?.error ?? "", /Cannot read properties of/,
      `a V8 TypeError reached the caller: ${JSON.stringify(bad.body)}`);

    const unknownId = await call("/api/resolveLocalToolPermission", {
      agentId: AGENT, entryId: "entry-9", requestId: "no-such-question", resolution: "allow-once",
    });
    assert.equal(unknownId.status, 400,
      `an answer for a question that does not exist came back as ${unknownId.status}, so a stale card makes the caller think the host broke`);

    const good = await call("/api/resolveLocalToolPermission", {
      agentId: AGENT, entryId: "entry-1", requestId: asked.id, resolution: "deny",
    });
    assert.equal(good.status, 200,
      `a well-formed answer to a live question came back as ${good.status}, so the command refuses everything`);
  });

  assert.notEqual((await settleWithin(blocked[0])).allowed, true,
    "the question the user denied still ran");
  assert.deepEqual(asked.target, "echo one",
    "the question this test opened is not the one it answered, so the run proved nothing");
});

test("the refusal class names itself, so the status can be decided at all", () => {
  // Checked directly because the wire status is decided by `error.name`, and a
  // refusal class that does not set it arrives as a plain `Error` and falls into
  // the `500` branch of `statusForCommandError` no matter what it says.
  const refusal = new SandLocalToolPermissionResolutionError("no longer waiting");
  assert.equal(refusal.name, "SandLocalToolPermissionResolutionError",
    "the refusal class does not name itself, so nothing can classify it and every declined answer is a server fault again");
  assert.equal(statusForCommandError(refusal), 400,
    "the refusal class no longer reaches the caller as a client error, so a declined answer tells the caller to retry a request that can never succeed");
  assert.equal(statusForCommandError(new Error("an actual fault")), 500,
    "every error is now a client error, so a real server fault tells the caller to stop retrying");
  assert.equal(machinery.SAND_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE.includes("went unanswered"), true,
    "the sentence an unanswered question produces changed, so the measurements in this file's header no longer describe it");
});