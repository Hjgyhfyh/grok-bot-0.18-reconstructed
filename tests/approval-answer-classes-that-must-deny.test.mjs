import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * An answer nobody meant as approval released an action Auto-review had blocked.
 *
 * The defect had exactly one shape, repeated at every layer: the answer was
 * treated as a free string and every layer asked only "is this the word
 * `denied`?". `SandAutoReviewController.resolveApproval` was the last gate, and
 * it branched on `resolution === "denied"`, so everything else — a trailing
 * space, a capital `D`, an empty string, a JSON body pasted into the field, a
 * word with a sentence after it, the number `42` — took the APPROVE branch. The
 * gateway never looked at the field at all, so none of those values ever met a
 * validator on the way to that branch.
 *
 * The status written into the approval record was the misspelling itself, so a
 * sweep of the transcript found nothing: every settled approval read either
 * `approved` or `denied`. The approval had in fact been granted.
 *
 * This file is the inventory of what that gate used to accept, one test per
 * CLASS of malformed answer rather than one per string, because the classes are
 * what a future change has to keep failing closed. The existing
 * `auto-review-answer-that-is-not-a-word` file covers six hand-picked values;
 * this one covers the nine classes the whole surface can produce, including the
 * three that are not a string at all and the two that are not an answer but an
 * absence of one (the card running out of time, the caller disconnecting).
 *
 * The local-tool question is the sibling half of the same round trip and is
 * measured here for the same reason: it has four answers instead of two, and it
 * was reached by the same unvalidated string.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Falsification hook.
 *
 * With `GROK_APPROVAL_CLASSES_HEAD=1` the same assertions run against these five
 * files as they are at `git HEAD`, served to esbuild through an `onLoad` hook.
 * The working tree is never read for those files and never written; every other
 * file under `source/` is the working tree. `npm test` never sets it, so the
 * suite always measures the tree.
 */
const OWNED_FILES = [
  "source/host/runner/sand-auto-review.ts",
  "source/host/host-gateway-api.ts",
  "source/host/gateway-server.ts",
  "source/host/extensions/local-tool-permission/local-tool-permission-controller.ts",
  "source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts",
];
const useGitHead = process.env.GROK_APPROVAL_CLASSES_HEAD === "1";

function git(args) {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG_KEY_")) delete env[key];
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

function gitHeadPlugin() {
  const atHead = new Map(OWNED_FILES.map((file) => [path.join(repoRoot, ...file.split("/")), git(["show", `HEAD:${file}`])]));
  return {
    name: "grok-approval-classes-head",
    setup(build) {
      build.onLoad({ filter: /sand-auto-review\.ts$|host-gateway-api\.ts$|gateway-server\.ts$|local-tool-permission-controller\.ts$|local-tool-permission-resolution\.ts$/ }, (args) => {
        const contents = atHead.get(path.resolve(args.path));
        return contents === undefined ? null : { contents, loader: "ts" };
      });
    },
  };
}

/**
 * One bundle for all five files. `statusForCommandError` decides a status by an
 * `instanceof` and by `error.name`, and the gateway edge that raises
 * `SandGatewayRequestError` is an `instanceof`, so three bundles would give the
 * code under test three copies of itself.
 */
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-approval-classes-"));
await build({
  stdin: {
    contents: [
      `export { SandAutoReviewController, SAND_AUTO_REVIEW_APPROVAL_TTL_MS } from "./source/host/runner/sand-auto-review.js";`,
      `export { AutoReviewService } from "./source/host/extensions/auto-review/auto-review-service.js";`,
      `export { statusForCommandError, startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
      `export { SandLocalToolPermissionController } from "./source/host/extensions/local-tool-permission/local-tool-permission-controller.js";`,
      `export { resolveLocalToolPermissionAsk, SandLocalToolPermissionResolutionError } from "./source/host/extensions/local-tool-permission/local-tool-permission-resolution.js";`,
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "approval-classes-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "approval-classes.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
  plugins: useGitHead ? [gitHeadPlugin()] : [],
});
const {
  AutoReviewService,
  createHostGatewayApi,
  resolveLocalToolPermissionAsk,
  SAND_AUTO_REVIEW_APPROVAL_TTL_MS,
  SandAutoReviewController,
  SandLocalToolPermissionController,
  SandLocalToolPermissionResolutionError,
  startGatewayServer,
  statusForCommandError,
} = await import(pathToFileURL(path.join(directory, "approval-classes.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

const AGENT = "11111111-1111-4111-8111-111111111111";
/** Long enough that a loopback round trip cannot expire a card mid-assertion. */
const APPROVAL_TTL_MS = 15_000;
/** A hung approval fails the assertion instead of hanging the run. */
const SAFETY_CEILING_MS = 3_000;
const ASK_TTL_MS = 15_000;

let counter = 0;
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/** A blocked call that is never answered must fail the assertion, not hang the run. */
const settleWithin = (raw, ms = SAFETY_CEILING_MS) =>
  Promise.race([raw, new Promise((resolve) => { const timer = setTimeout(() => resolve("HUNG"), ms); timer.unref?.(); })]);

/**
 * The real controller, blocked on a real approval.
 *
 * `outcome` stays `null` until the blocked tool call is actually woken, so a
 * test can tell "it was told to go ahead" apart from "it was never told
 * anything". That difference is the whole file.
 */
function blockedApproval(options = {}) {
  const controller = new SandAutoReviewController({
    agentId: AGENT,
    hostGeneration: "generation-under-test",
    approvalTtlMs: options.approvalTtlMs ?? APPROVAL_TTL_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
    randomId: () => `approval-${++counter}`,
  });
  const events = [];
  controller.subscribe((event) => events.push(event));
  let outcome = null;
  const raw = controller
    .requestApproval({
      surface: "hostShell",
      fingerprint: "sha256:target",
      reason: "Auto-review flagged this command.",
      summary: "npm publish",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    .then((decision) => { outcome = decision; return decision; });
  const pending = controller.getPendingApprovals()[0];
  assert.notEqual(pending, undefined, "the controller opened no approval, so nothing below is measuring a blocked action");
  return { controller, events, pending, outcome: () => outcome, settleWithin: (ms) => settleWithin(raw, ms), cancel: () => controller.expire("session_end") };
}

/**
 * The answer a caller can produce which is not one of the two words.
 *
 * `wire: false` marks a value the loopback gateway cannot even carry — a
 * non-string reaches the command as JSON that is still a valid request, so all
 * of these can be posted; none is skipped.
 */
const CLASSES = [
  {
    name: "whitespace around the word",
    why: "a trailing, leading, or line-ending space is still the same word to a person, and was not the same word to the gate",
    values: ["denied ", " denied", "denied\n", "\tdenied", "denied\r\n", "denied \n "],
  },
  {
    name: "a different case of the word",
    why: "the card, the wire and the transcript all spell it in one case; a caller that normalises differently does not get consent",
    values: ["Denied", "DENIED", "dEnied", "Denied "],
  },
  {
    name: "the whole request wrapped in JSON",
    why: "a caller that serialises its payload and hands the raw body to the field must be refused, not parsed on its behalf",
    values: ['{"resolution":"denied"}', '["denied"]', '"denied"', '{"approved":false}'],
  },
  {
    name: "the word with a sentence attached to it",
    why: "an answer with any other characters in it is not the word, however clearly a person meant it",
    values: ["denied.", "denied, please", "no, denied", "denied -- the user said no", "not denied", "und enied"],
  },
  {
    name: "nothing at all",
    why: "an empty or blank field is a caller that never answered, and a caller that never answered has not agreed",
    values: ["", " ", "\n", "\t\t"],
  },
  {
    name: "a value that is not a string",
    why: "the field is typed as a word; a number, a boolean, an object or an array is a caller with a different payload shape, not an answer",
    values: [42, true, false, null, undefined, ["approved"], { approved: true }, { resolution: "denied" }],
  },
  {
    name: "a refusal in the other vocabulary",
    why: "the wire only knows two answers; a caller that uses its own word for refusal has not answered this card",
    values: ["no", "false", "reject", "rejected", "deny", "refuse", "decline", "n", "0", "none", "cancel"],
  },
];

/**
 * Drive one class through the controller and then through the wire.
 *
 * The controller half proves the guard itself refused: nothing settled, the
 * pending record survived so the card is still answerable, and the blocked call
 * was never told to go ahead. The wire half proves the request is named as
 * malformed rather than silently swallowed, because a caller that is told `200`
 * will never retry the answer that actually works — and it posts against a
 * LIVE approval the service owns, so the `400` cannot be confused with the
 * "there is no such question" answer.
 */
async function assertClassDenies(aClass, post) {
  for (const value of aClass.values) {
    const label = `the ${aClass.name} class (${JSON.stringify(value) ?? "undefined"})`;
    const held = blockedApproval();
    const settled = held.controller.resolveApproval(held.pending.id, value);

    assert.equal(settled, undefined,
      `${label} settled an approval Auto-review had blocked: ${JSON.stringify(settled)}`);
    assert.deepEqual(held.controller.getPendingApprovals().map((a) => a.id), [held.pending.id],
      `${label} consumed the pending approval, so the user is left with a card that no longer does anything`);
    assert.deepEqual(held.events.map((event) => event.type), ["created"],
      `${label} told the approval surface that the question was answered`);

    await sleep(25);
    assert.equal(held.outcome(), null,
      `${label} told the blocked tool call to go ahead: ${JSON.stringify(held.outcome())}`);

    held.cancel();
    assert.notEqual(await held.settleWithin(), "HUNG",
      `expiring the approval after ${label} left the blocked tool call waiting forever, so the test cannot clean up after itself`);

    const live = serviceBackedApproval();
    const answer = await post({ requestId: live.pending.id, resolution: value });
    assert.equal(answer.status, 400,
      `${label} came back from the wire as ${answer.status}, which tells the caller the host broke and invites a retry of an answer that can never succeed as written`);
    assert.match(answer.body?.error ?? "", /"resolution"/,
      `${label} is refused without naming the field the caller has to fix: ${JSON.stringify(answer.body)}`);
    await sleep(25);
    assert.equal(live.outcome(), null,
      `${label} reached a live blocked tool call through the wire: ${JSON.stringify(live.outcome())}`);
    assert.deepEqual(live.controller.getPendingApprovals().map((a) => a.id), [live.pending.id],
      `${label} consumed a live approval, so the card moved off its buttons`);
    live.cancel();
    assert.notEqual(await live.settleWithin(), "HUNG",
      `expiring the live approval after ${label} left its blocked call waiting forever`);
  }
}

// ── the live wire, built once ──────────────────────────────────────────────────

const service = new AutoReviewService({
  auth: {},
  experiments: { checkFeatureGate: () => false },
  settings: { getAutoReviewInstructions: () => ({ isEnabled: false, allowInstructions: [], blockInstructions: [] }) },
  telemetry: { reportAutoReviewDisplayRecheckFailed: () => {}, reportAutoReviewApproval: () => {} },
  awaitingSink: { trySetForTab: () => {}, clearForTab: () => {} },
  transcript: { settleStaleAutoReviewCard: async () => false },
  hostGeneration: "generation-under-test",
  createClassifierExecutor: () => ({}),
});
const proxy = new Proxy({}, { get: (_t, name) => (...args) => undefined });
const api = createHostGatewayApi({
  extensions: {
    api: (id) => {
      if (id === "auto-review") return service;
      if (id === "telemetry") return new Proxy({ analytics: proxy }, { get: (t, n) => (typeof n === "symbol" ? Reflect.get(t, n) : n in t ? t[n] : proxy) });
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
const server = await startGatewayServer({
  api,
  subscribe: () => () => {},
  getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
  startedAt: 0,
  authToken: "test-token",
});
test.after(async () => { await server.close(); });

const post = async (body) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/resolveAutoReviewApproval`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ agentId: AGENT, entryId: "entry-1", ...body }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
};

/**
 * A live approval owned by the real `AutoReviewService`, which is what the
 * gateway command actually calls.
 *
 * The controller half of a class is measured on a bare controller because that
 * isolates the guard. The wire half has to go through the service, because the
 * service owns the lookup and a refusal the service never sees would prove
 * nothing about the wire.
 */
function serviceBackedApproval() {
  const bound = service.bindRunner({ agentId: AGENT, onUpdate: () => {} });
  const controller = bound.autoReviewController;
  let outcome = null;
  const raw = controller
    .requestApproval({ surface: "hostShell", fingerprint: "sha256:target", reason: "r", summary: "s" })
    .then((decision) => { outcome = decision; return decision; });
  const pending = controller.getPendingApprovals()[0];
  assert.notEqual(pending, undefined, "the service opened no approval, so the wire assertions below prove nothing");
  return { controller, pending, outcome: () => outcome, settleWithin: (ms) => settleWithin(raw, ms), cancel: () => controller.expire("session_end") };
}

// ── tests ──────────────────────────────────────────────────────────────────────

test("the harness measured the product and not a double", async () => {
  // Both real answers have to work before any class is judged wrong. A guard that
  // refuses everything would pass every assertion below while having stopped
  // guarding anything.
  assert.ok(Object.keys(api).length >= 100,
    `the API object offered ${Object.keys(api).length} methods, so this file is measuring a broken bundle rather than the gateway`);
  assert.equal(typeof api.resolveAutoReviewApproval, "function",
    "the gateway has no resolveAutoReviewApproval, so every wire assertion below would pass without reaching anything");
  assert.equal(SAND_AUTO_REVIEW_APPROVAL_TTL_MS, 10 * 60 * 1_000,
    "the approval lifetime moved, so the time-out class below would no longer describe the shipped behaviour");

  const denied = blockedApproval();
  denied.controller.resolveApproval(denied.pending.id, "denied");
  assert.equal((await denied.settleWithin()).approved, false,
    `pressing "denied" did not deny: ${JSON.stringify(await denied.settleWithin())}`);

  const approved = blockedApproval();
  approved.controller.resolveApproval(approved.pending.id, "approved");
  assert.equal((await approved.settleWithin()).approved, true,
    `pressing "approved" did not approve: ${JSON.stringify(await approved.settleWithin())}`);

  const live = serviceBackedApproval();
  const good = await post({ requestId: live.pending.id, resolution: "denied" });
  assert.equal(good.status, 200,
    `a well-formed refusal of a live approval came back as ${good.status}, so the wire now refuses every answer`);
  assert.equal((await live.settleWithin()).approved, false,
    "the wire delivered a well-formed refusal and the blocked tool call was told to go ahead");
});

for (const aClass of CLASSES) {
  test(`an answer that is ${aClass.name} grants nothing`, async () => {
    await assertClassDenies(aClass, post);
  });
}

test("the card running out of time grants nothing", async () => {
  // A timeout is not an answer, and it is the class most likely to be "fixed"
  // by accident: the expiry path settles the record with a reason, which reads
  // like a decision. It must be a refusal, it must leave nothing approved, and
  // it must say so in the reason the agent receives.
  const held = blockedApproval({ approvalTtlMs: 40 });
  const decision = await held.settleWithin(2_000);
  assert.notEqual(decision, "HUNG", "the card never expired, so this class is not being measured");
  assert.equal(decision.approved, false,
    `a card nobody answered reported approval: ${JSON.stringify(decision)}`);
  assert.match(decision.reason ?? "", /Auto-review blocked this action/,
    `an unanswered card produced no honest reason for the agent: ${JSON.stringify(decision)}`);
  assert.deepEqual(held.controller.getPendingApprovals(), [],
    "an expired card is still on the surface, so the user is offered buttons that cannot work");
  assert.deepEqual(held.events.map((event) => event.type), ["created", "expired"],
    `an expired card told the surface something other than created+expired: ${JSON.stringify(held.events.map((e) => e.type))}`);
});

test("a caller that disconnects mid-question grants nothing", async () => {
  // The caller walking away — an aborted tool call, a cancelled turn — is the
  // other absence of an answer. It must refuse, and it must refuse as a
  // cancellation rather than as a denial: the two lead the agent to behave
  // differently, and the difference is visible in the transcript.
  const abort = new AbortController();
  const held = blockedApproval({ signal: abort.signal });
  abort.abort();
  const decision = await held.settleWithin();
  assert.notEqual(decision, "HUNG", "the cancelled question never settled, so this class is not being measured");
  assert.equal(decision.approved, false,
    `a cancelled approval reported approval: ${JSON.stringify(decision)}`);
  assert.match(decision.reason ?? "", /cancelled/i,
    `a cancellation was reported to the agent as something else: ${JSON.stringify(decision)}`);
});

test("the two answers are the only ones, and the refusal reaches the wire as a client error", async () => {
  // `statusForCommandError` is checked directly because the wire status is an
  // `instanceof` and a name check, and a refusal class that stops being
  // classified silently turns every declined answer back into a `500`, which
  // tells the caller the server broke.
  const refusal = new SandLocalToolPermissionResolutionError("no longer waiting");
  assert.equal(refusal.name, "SandLocalToolPermissionResolutionError",
    "the refusal class does not name itself, so nothing can classify it and a declined answer is a server fault again");
  assert.equal(statusForCommandError(refusal), 400,
    "a refusal the host raised on its own terms no longer reaches the caller as a client error");
  assert.equal(statusForCommandError(new Error("an actual fault")), 500,
    "every error is now a client error, so a real server fault tells the caller to stop retrying");
});

// ── the sibling half: the local-tool question ───────────────────────────────────

/** The real local-tool controller behind the real answer command, as `extension.ts` wires it. */
function localToolExtension() {
  let permission = "ask";
  const controller = new SandLocalToolPermissionController({
    getPermission: () => permission,
    setPermission: (next) => { permission = next; },
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
 * Blocks one agent on one command, the way a local tool call does.
 *
 * `outcome` stays `null` while the call is still waiting, which is how the test
 * tells "it was told to go ahead" apart from "it was never told anything".
 */
function blockedLocalTool(extension, target = "npm publish") {
  const seen = [];
  extension.subscribe((event) => { if (event.type === "created") seen.push(event.request); });
  let outcome = null;
  const raw = extension
    .authorize({ agentId: AGENT, toolCallId: `call-${++counter}` }, { action: "run-command", target })
    .then((decision) => { outcome = decision; return decision; });
  assert.equal(seen.length, 1, "the controller asked no question, so this class is not being measured");
  return { ask: seen[0], outcome: () => outcome, settleWithin: (ms) => settleWithin(raw, ms) };
}

const LOCAL_TOOL_CLASSES = [
  { name: "whitespace around the word", values: ["allow-once ", " allow-once", "deny\n", "always "] },
  { name: "a different case of the word", values: ["ALLOW-ONCE", "Deny", "Always", "NEVER"] },
  { name: "the whole request wrapped in JSON", values: ['{"resolution":"deny"}', '["allow-once"]'] },
  { name: "the word with a sentence attached to it", values: ["deny please", "never, thanks", "allow-once."] },
  { name: "nothing at all", values: ["", " "] },
  { name: "a value that is not a string", values: [42, true, null, undefined, ["deny"], { resolution: "deny" }] },
  { name: "a refusal in the other vocabulary", values: ["yes", "no", "allow", "denied", "reject", "once"] },
];

test("a malformed answer to a local-tool question grants nothing and does not consume the question", async () => {
  // The sibling half of the same round trip, with four answers instead of two.
  // It never failed OPEN — `resolveRequest` compares the word by equality, so a
  // misspelling could only ever produce `allowed:false`. What it did was fail
  // LOUDLY in the wrong direction: it consumed the pending question and settled
  // it with a status that is not one of the six the transcript knows, so the
  // card went dead, the audit row recorded `undefined`, and the user could not
  // answer the question they were actually asked. A refusal that destroys the
  // question is a denial the user never gave.
  for (const aClass of LOCAL_TOOL_CLASSES) {
    for (const value of aClass.values) {
      const label = `the ${aClass.name} class (${JSON.stringify(value) ?? "undefined"})`;
      const extension = localToolExtension();
      const blocked = blockedLocalTool(extension);

      let raised = null;
      try {
        await extension.resolveAsk({ agentId: AGENT, entryId: "entry-1", requestId: blocked.ask.id, resolution: value });
      } catch (error) {
        raised = error;
      }
      assert.notEqual(raised, null,
        `${label} was applied by the answer command, so the caller is told it answered a question it did not`);
      assert.equal(statusForCommandError(raised), 400,
        `${label} is refused with a ${statusForCommandError(raised)}, which tells the caller the host broke instead of that the answer was wrong`);
      assert.notEqual(extension.getPendingRequestById(blocked.ask.id), undefined,
        `${label} consumed the open question, so the card goes dead and the user cannot answer the question they were asked`);
      await sleep(25);
      assert.equal(blocked.outcome(), null,
        `${label} told the blocked tool call to go ahead: ${JSON.stringify(blocked.outcome())}`);
      extension.beginTurn(AGENT);
      assert.notEqual(await blocked.settleWithin(), "HUNG",
        `${label} left the blocked tool call waiting forever, so the test cannot clean up after itself`);
    }
  }
});

test("all four real answers to a local-tool question still work", async () => {
  // The control pass for the table above: a guard that refuses everything would
  // satisfy every one of those assertions while having stopped guarding.
  for (const [resolution, expected] of [["allow-once", true], ["deny", false], ["always", true], ["never", false]]) {
    const extension = localToolExtension();
    const blocked = blockedLocalTool(extension);
    await extension.resolveAsk({ agentId: AGENT, entryId: "entry-1", requestId: blocked.ask.id, resolution });
    assert.equal((await blocked.settleWithin()).allowed, expected,
      `the answer "${resolution}" did not produce allowed=${expected}, so the table above proves nothing about refusals`);
    extension.beginTurn(AGENT);
  }
});