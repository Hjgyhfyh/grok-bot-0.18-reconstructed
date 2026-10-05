import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The baseline these tests read the defect from. It is a fixed commit, not HEAD:
// reading HEAD only proves anything while the fix is uncommitted, and once it is
// committed HEAD holds the fixed code and every falsification inverts.
const DEFECT_BASELINE = "18fe9fc";


/**
 * A question the user was never shown, and no way left to find it.
 *
 * An agent that wanted to run a command on the user's computer left a pending ask
 * in `SandLocalToolPermissionController`. The host pushed that ask to the renderer
 * as a `local-tool-permission` transcript card, and the card's buttons called
 * `resolveLocalToolPermission` — that half worked and is covered by
 * `local-tool-permission-ask-round-trip.test.mjs`.
 *
 * There was no second way to reach the question. `getPendingRequestForAgent`
 * existed on the controller and had no caller in the repository outside a test, and
 * no gateway command read it. So if the window closed before the card was drawn,
 * or the card was never drawn at all because the agent was not the open
 * conversation, the user had nothing to look at. The agent sat blocked inside
 * `authorize` with a referenced ten-minute timer holding the event loop open, and
 * the only thing the user could observe was an agent that had stopped. Ten minutes
 * later the ask expired on its own, the settlement was reported as
 * `SAND_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE`, and nothing anywhere said a question had
 * ever been asked. Silence that looks like slowness is what the user was shown.
 *
 * `listPendingLocalToolPermissions` is that second way. It answers with an ARRAY,
 * and an empty array is a real answer rather than a `404`: "this agent is not
 * waiting on you" and "there is no such command" have to stay different, because
 * the first is what a caller polls and the second is what a caller mistypes. The
 * request field is `agentId` and it goes through `requirePath`, so a request that
 * names no agent is refused with `400` and a sentence that names both the command
 * and the field — the same honesty the neighbouring commands were given in the
 * previous wave.
 *
 * What this cannot fix, and what is deliberately left to the interface owner, is
 * the discovery half. The command is a pull: something has to call it. The card is
 * persisted in the agent's `store.db` and is redrawn when that conversation is
 * reopened, so the question is *not* lost on reopen — it is merely invisible while
 * that conversation is not open, and invisible wherever a human is not already
 * looking. The written report says exactly what an owner would have to build on
 * top of this.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The two files this feature lives in. Both are the ones the falsification hook rewinds. */
const OWNED_FILES = ["source/host/host-gateway-api.ts", "source/host/gateway-protocol.ts"];

/**
 * Falsification hook.
 *
 * With `GROK_PENDING_ASK_HEAD=1` these same assertions run against
 * `source/host/host-gateway-api.ts` and `source/host/gateway-protocol.ts` as they
 * were at `git HEAD`, served to esbuild through an `onLoad` hook. The working tree
 * is never read for those two files and never written, every other file in
 * `source/` is the working tree, and the run fails on the old code — which is what
 * proves the tests below are measuring this change and not the surrounding code.
 * `npm test` never sets it, so the suite always measures the tree.
 */
const useGitHead = process.env.GROK_PENDING_ASK_HEAD === "1";

function git(args) {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_KEY_")) delete env[key];
  }
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

/** Esbuild plugin that answers the two owned files from `git show HEAD:<path>`. */
function gitHeadPlugin() {
  const atHead = new Map(
    OWNED_FILES.map((file) => [
      path.join(repoRoot, ...file.split("/")),
      git(["show", `${DEFECT_BASELINE}:${file}`]),
    ]),
  );
  return {
    name: "grok-git-head-source",
    setup(build) {
      build.onLoad({ filter: /host-gateway-api\.ts$|gateway-protocol\.ts$/ }, (args) => {
        const contents = atHead.get(path.resolve(args.path));
        if (contents === undefined) return null;
        return { contents, loader: "ts" };
      });
    },
  };
}

/**
 * `gateway-server.ts`, `host-gateway-api.ts`, `gateway-protocol.ts` and the
 * permission controller are bundled together on purpose. `host-gateway-api.ts`
 * imports `SandGatewayRequestError` from `gateway-server.ts`, and the `400` branch
 * of `statusForCommandError` is an `instanceof`; bundling them as separate files
 * would give each its own copy of the class, every refusal would miss the branch,
 * and the status assertions below would pass for the wrong reason.
 */
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-pending-ask-"));
await build({
  stdin: {
    contents: [
      `export { statusForCommandError, startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
      `export { SAND_GATEWAY_COMMANDS } from "./source/host/gateway-protocol.js";`,
      `export { SandLocalToolPermissionController } from "./source/host/extensions/local-tool-permission/local-tool-permission-controller.js";`,
      `export { resolveLocalToolPermissionAsk } from "./source/host/extensions/local-tool-permission/local-tool-permission-resolution.js";`,
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "pending-ask-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "pending-ask.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
  plugins: useGitHead ? [gitHeadPlugin()] : [],
});
const {
  createHostGatewayApi,
  resolveLocalToolPermissionAsk,
  SandLocalToolPermissionController,
  SAND_GATEWAY_COMMANDS,
  startGatewayServer,
  statusForCommandError,
} = await import(pathToFileURL(path.join(directory, "pending-ask.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

const COMMAND = "listPendingLocalToolPermissions";
const AGENT = "agent-1";
/**
 * Long enough that a burst of loopback round trips cannot expire the question
 * mid-assertion, short enough that a test which fails before settling its ask does
 * not hold the event loop for a minute afterwards. The timer an open ask installs
 * is deliberately referenced — that is the defect
 * `local-tool-permission-ask-round-trip.test.mjs` covers — so it really does hold
 * the run until it fires.
 */
const ASK_TTL_MS = 15_000;
/** A hung agent fails the assertion instead of hanging the run. */
const SAFETY_CEILING_MS = 5_000;

/** The real controller behind the real extension surface, wired the way `extension.ts` wires it. */
function permissionExtension() {
  let state = "ask";
  let counter = 0;
  const controller = new SandLocalToolPermissionController({
    getPermission: () => state,
    setPermission: (permission) => { state = permission; },
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

/**
 * The real host API in front of it, over doubles that answer nothing in particular.
 *
 * Every double call is recorded together with the extension it was reached on. The
 * recording is on the extension id and not just the method name because
 * `markActive` runs before the field check and is not a refusal leaking: a test
 * that asserted "no double was called at all" would fail on the product being
 * correct, and would have been fixed by deleting the honest call order.
 */
function hostApi(extension) {
  const calls = [];
  const record = (id) => (name) => (...args) => {
    calls.push({ extension: id, name, args });
    return undefined;
  };
  const proxy = new Proxy({}, { get: (_target, name) => record("other")(String(name)) });
  const telemetryRecord = record("telemetry");
  const telemetry = new Proxy({ analytics: proxy }, {
    get: (target, name) => (typeof name === "symbol"
      ? Reflect.get(target, name)
      : name in target ? target[name] : telemetryRecord(String(name))),
  });
  const api = createHostGatewayApi({
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
  return { api, calls };
}

/** The loopback gateway with the real API in front of it, so statuses are the ones a caller receives. */
async function withServer(api, run) {
  const reported = [];
  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
    onCommandError: (report) => reported.push(report),
    onCommandComplete: (report) => reported.push(report),
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };
  try {
    return await run(call);
  } finally {
    await server.close();
  }
}

/** Resolves to the string HUNG rather than waiting forever on a blocked agent. */
function settleWithin(blocked) {
  return Promise.race([
    blocked,
    new Promise((resolve) => { setTimeout(() => resolve("HUNG"), SAFETY_CEILING_MS).unref?.(); }),
  ]);
}

const askEndpoint = (call, agentId = AGENT) =>
  call(`/api/${COMMAND}`, JSON.stringify({ agentId }));

/** Blocks an agent the way a real tool call does. */
function askPermission(controller, { target = "npm install left-pad", toolCallId = "call-1" } = {}) {
  return controller.authorize({ agentId: AGENT, toolCallId }, { action: "run-command", target });
}

/** What a caller is entitled to rely on, so a dropped field fails here rather than in a card. */
const ASK_FIELDS = ["id", "agentId", "action", "target", "status", "createdAtMs", "expiresAtMs"];

test("the harness measured the product and not a double", async () => {
  // Every assertion below is meaningless if the API object came back empty or the
  // controller never asked anything. Both are checked before anything else.
  const extension = permissionExtension();
  const { api } = hostApi(extension);
  assert.ok(Object.keys(api).length >= 100,
    `the API object offered ${Object.keys(api).length} methods, so this file is measuring a broken bundle rather than the gateway`);
  assert.equal(typeof api[COMMAND], "function",
    `the gateway has no ${COMMAND} method at all, so there is nothing for a caller to reach and every test below would pass for the wrong reason`);
  assert.equal(typeof SAND_GATEWAY_COMMANDS[COMMAND], "function",
    `${COMMAND} is implemented but absent from SAND_GATEWAY_COMMANDS, so POST /api/${COMMAND} answers 404 unknown gateway method and the implementation looks finished while working for nothing`);

  const blocked = askPermission(extension);
  const asked = extension.getPendingRequestForAgent(AGENT);
  assert.notEqual(asked, undefined,
    "the real controller produced no pending ask, so an empty answer from the gateway would prove nothing");
  extension.resolveRequest(asked.id, "deny");
  await settleWithin(blocked);
});

test("the command is routed with a parsed JSON body, not with the raw string", () => {
  // The dispatcher hands every handler the raw body and each entry parses it. An
  // entry that forgot that would read `agentId` off a string and refuse a request
  // that was perfectly well formed.
  const calls = [];
  const spy = { [COMMAND]: (args) => { calls.push(args); return []; } };
  const answer = SAND_GATEWAY_COMMANDS[COMMAND](spy, JSON.stringify({ agentId: AGENT }));
  assert.ok(Array.isArray(answer),
    `the routed command answered ${JSON.stringify(answer)}, so the table entry is not the command the protocol promises`);
  assert.deepEqual(calls, [{ agentId: AGENT }],
    `the table entry forwarded ${JSON.stringify(calls)} instead of the parsed body, so the agent id was never read off the request`);
});

test("an agent that asked is visible to the caller, and the answer carries what a card needs", async () => {
  const extension = permissionExtension();
  const { api } = hostApi(extension);
  const blocked = askPermission(extension, { target: "npm install left-pad" });
  const asked = extension.getPendingRequestForAgent(AGENT);

  const answer = await withServer(api, (call) => askEndpoint(call));

  assert.equal(answer.status, 200,
    `a command that names the agent came back as ${answer.status}, so the caller has no way to read the question`);
  assert.ok(Array.isArray(answer.body),
    `the command answered ${JSON.stringify(answer.body)}, and a caller cannot poll an answer whose shape depends on whether a question happens to be open`);
  assert.equal(answer.body.length, 1,
    `the agent has exactly one open question and the caller was told about ${answer.body.length}`);
  const seen = answer.body[0];
  assert.deepEqual(seen, asked,
    `the caller was handed ${JSON.stringify(seen)} instead of the question the host is holding: ${JSON.stringify(asked)}`);
  for (const field of ASK_FIELDS) {
    assert.ok(field in seen,
      `the answer carries no "${field}", so a caller cannot draw the question, name the request it is answering, or say how long is left`);
  }
  assert.equal(seen.status, "pending",
    `the question reached the caller already answered: ${seen.status}`);
  assert.ok(seen.expiresAtMs - seen.createdAtMs > 0,
    "the answer carries no lifetime, so a caller cannot tell the user that the question will give up on its own");

  extension.resolveRequest(seen.id, "deny");
  await settleWithin(blocked);
});

test("a window that closed before the card was drawn still leaves the question reachable", async () => {
  // This is the defect. The push surface is a subscription: when it is gone the
  // card is never drawn, and the agent waits in silence until the ask expires. The
  // pull has to answer with the same question afterwards, or the user has no way
  // to see it and no way to answer it.
  const extension = permissionExtension();
  const { api } = hostApi(extension);

  const drawn = [];
  const unsubscribe = extension.subscribe((event) => drawn.push(event));

  const blocked = askPermission(extension);
  assert.equal(drawn.length, 1,
    "the ask surface was never told about the question, so this test starts from an impossible state");

  unsubscribe(); // The window closed. Nothing is on screen and nothing will be.
  assert.equal(drawn.length, 1,
    "unsubscribing redrew the card, so the window did not actually close");

  const after = await withServer(api, askEndpoint);
  assert.equal(after.status, 200,
    `the pull after the window closed came back as ${after.status}, so the question became invisible and unrecoverable`);
  assert.equal(after.body.length, 1,
    `after the window closed the caller saw ${after.body.length} questions, so the only record of the question died with the window`);
  assert.equal(after.body[0].id, extension.getPendingRequestForAgent(AGENT).id,
    "the pull after the window closed answered about a different question than the one the agent is blocked on");

  extension.resolveRequest(after.body[0].id, "deny");
  await settleWithin(blocked);
});

test("the user's own answer empties the answer, and the blocked agent gets it", async () => {
  const extension = permissionExtension();
  const { api } = hostApi(extension);
  const blocked = askPermission(extension);
  const asked = extension.getPendingRequestForAgent(AGENT);

  await withServer(api, (call) => call("/api/resolveLocalToolPermission", JSON.stringify({
    agentId: AGENT,
    entryId: "entry-1",
    requestId: asked.id,
    resolution: "allow-once",
  })));

  const decision = await settleWithin(blocked);
  assert.deepEqual(decision, { allowed: true, approvalId: asked.id },
    `the user answered "allow once" and the blocked agent did not get it: ${JSON.stringify(decision)}`);

  const after = await withServer(api, askEndpoint);
  assert.equal(after.status, 200,
    `a settled question came back as ${after.status}, so a polling caller cannot tell "answered" from "endpoint is gone"`);
  assert.deepEqual(after.body, [],
    `the caller was still told a question is open after the user answered it: ${JSON.stringify(after.body)}. A card built from that would offer buttons for a request that no longer exists`);
});

test("an empty answer is 200 and an array, because a caller polls it", async () => {
  // The distinction the status has to keep: "this agent is not waiting on you" is
  // the normal state of every agent and must poll clean. "There is no such command"
  // is a typo and must be a `404`. Answering `404` for an idle agent teaches every
  // caller to treat the ordinary case as an error.
  const extension = permissionExtension();
  const { api } = hostApi(extension);
  const answer = await withServer(api, askEndpoint);

  assert.equal(answer.status, 200,
    `an agent with no open question came back as ${answer.status}, so a caller polling a healthy agent is told the endpoint is missing`);
  assert.deepEqual(answer.body, [],
    `an agent with no open question answered ${JSON.stringify(answer.body)} instead of an empty list`);

  const unknown = await withServer(api, (call) => call("/api/noSuchCommandAtAll", "{}"));
  assert.equal(unknown.status, 404,
    `a command nobody implemented came back as ${unknown.status}, so a typo is indistinguishable from an idle agent and the 200 above proves nothing`);
});

test("a request that names no agent is refused with 400 and the field in the sentence", async () => {
  const extension = permissionExtension();
  const { api, calls } = hostApi(extension);
  const cases = [
    { body: "{}", why: "the field was left out entirely" },
    { body: '{"agentId":42}', why: "the field arrived as a number" },
    { body: '{"agentId":""}', why: "the field arrived empty" },
    { body: '{"agentId":null}', why: "the field arrived as null" },
    { body: '{"agentId":["agent-1"]}', why: "the field arrived as an array" },
  ];
  await withServer(api, async (call) => {
    for (const entry of cases) {
      const answer = await call(`/api/${COMMAND}`, entry.body);
      assert.equal(answer.status, 400,
        `a request where ${entry.why} came back as ${answer.status}, which tells the caller the host broke and invites a retry of a request that can never succeed as written`);
      assert.match(answer.body?.error ?? "", new RegExp(`Malformed ${COMMAND} request`),
        `the refusal for a request where ${entry.why} does not name the command: ${JSON.stringify(answer.body)}`);
      assert.ok((answer.body?.error ?? "").includes('"agentId"'),
        `the refusal for a request where ${entry.why} does not name the field the caller has to fix: ${JSON.stringify(answer.body)}`);
      assert.doesNotMatch(answer.body?.error ?? "", /Cannot read properties of/,
        `a V8 TypeError reached the caller for a request where ${entry.why}: ${JSON.stringify(answer.body)}`);
    }
  });
  assert.equal(calls.filter((call) => call.extension === "local-tool-permission").length, 0,
    "the permission controller was reached with a request the gateway had already refused, so the refusal does not stop the call");
  assert.ok(calls.some((call) => call.name === "markActive"),
    "the command never marked the host active, so this refusal left no trace that the user was ever asked anything");
});

test("the refusal is the one class the gateway answers 400, and not 500", () => {
  // Checked directly because the wire status is decided by an `instanceof` on a
  // class that lives in this same bundle for a reason. A `500` here would invite
  // the caller to retry a request that can never succeed.
  const extension = permissionExtension();
  const { api } = hostApi(extension);
  let raised = null;
  try {
    api[COMMAND]({});
  } catch (error) {
    raised = error;
  }
  assert.notEqual(raised, null,
    "the command answered a request that names no agent, so a caller polling a mistyped agent id is told there is nothing waiting instead of that the request was wrong");
  assert.equal(statusForCommandError(raised), 400,
    "the refusal no longer reaches 400, so the caller is told the host broke for a request the host refused on its own terms");
});

test("a question belonging to another agent is not reported as this agent's", async () => {
  // The answer is per agent, and an answer that leaked a neighbour's question would
  // offer the user a card for an action they never asked about.
  const extension = permissionExtension();
  const { api } = hostApi(extension);
  const blocked = askPermission(extension);
  const asked = extension.getPendingRequestForAgent(AGENT);

  const answer = await withServer(api, (call) => askEndpoint(call, "agent-somebody-else"));
  assert.equal(answer.status, 200, `an agent that never asked came back as ${answer.status} instead of a well-formed empty answer`);
  assert.deepEqual(answer.body, [],
    `an agent that never asked was told about ${JSON.stringify(answer.body)}, which is another conversation's question`);

  const mine = await withServer(api, askEndpoint);
  assert.equal(mine.body[0]?.id, asked.id,
    "the agent that did ask is no longer answered, so the refusal for somebody else took the question down with it");

  extension.resolveRequest(asked.id, "deny");
  await settleWithin(blocked);
});