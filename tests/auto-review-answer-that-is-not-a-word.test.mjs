import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A misspelt refusal was read as consent, and it released the action.
 *
 * Auto-review is the gate. The classifier blocks an action, the user gets a card
 * with two answers, and `resolveLocalToolPermission`'s sibling
 * `resolveAutoReviewApproval` applies one of them. Every layer of that treated
 * the answer as a free string and only ever asked one question about it:
 * `SandAutoReviewController.resolveApproval` tested `resolution === "denied"`
 * and sent everything else down the approve branch.
 *
 * So `"denied "` with a trailing space, `"Denied"`, `"no"`, `"false"`, `""` and
 * `"reject"` all approved an action Auto-review had just blocked, the pending
 * record was consumed, and the card moved off its buttons. Measured against the
 * real controller before the fix, one pending approval and one answer each:
 *
 *   resolution="denied"   -> status=denied   the blocked tool call was told {"approved":false,…}
 *   resolution="denied "  -> status="denied " the blocked tool call was told {"approved":true}
 *   resolution="Denied"   -> status=Denied    the blocked tool call was told {"approved":true}
 *   resolution="no"       -> status=no        the blocked tool call was told {"approved":true}
 *   resolution="false"    -> status=false     the blocked tool call was told {"approved":true}
 *   resolution=""         -> status=          the blocked tool call was told {"approved":true}
 *   resolution="reject"   -> status=reject    the blocked tool call was told {"approved":true}
 *
 * Nothing threw and nothing was logged: the status written into the approval
 * was the misspelling itself, which is why no sweep of the transcript found a
 * single approval recorded as anything but "approved" or "denied" and why the
 * one place that would have caught it — the wire — never looked. The gateway's
 * `resolveAutoReviewApproval` checked `agentId` and passed the rest straight
 * through, so the value never met a validator on its way to the guard.
 *
 * The guard now fails closed. An answer that is neither of the two words is not
 * an answer: it does not settle the approval, it does not consume the pending
 * record, and it does not wake the blocked tool call. The card stays on screen
 * so a person can answer it properly, and the wire refuses the request by name
 * so the caller learns what to send.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Falsification hook.
 *
 * With `GROK_AUTO_REVIEW_ANSWER_HEAD=1` the same assertions run against
 * `source/host/runner/sand-auto-review.ts`, `source/host/host-gateway-api.ts` and
 * `source/host/gateway-server.ts` as they are at `git HEAD`, served to esbuild
 * through an `onLoad` hook. The working tree is never read for those three files
 * and never written, every other file in `source/` is the working tree, and the
 * run fails on the old code — which is what proves the tests below are measuring
 * this change and not the surrounding code. `npm test` never sets it, so the
 * suite always measures the tree.
 */
const OWNED_FILES = [
  "source/host/runner/sand-auto-review.ts",
  "source/host/host-gateway-api.ts",
  "source/host/gateway-server.ts",
];
const useGitHead = process.env.GROK_AUTO_REVIEW_ANSWER_HEAD === "1";

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
    name: "grok-auto-review-answer-head",
    setup(build) {
      build.onLoad({ filter: /sand-auto-review\.ts$|host-gateway-api\.ts$|gateway-server\.ts$/ }, (args) => {
        const contents = atHead.get(path.resolve(args.path));
        return contents === undefined ? null : { contents, loader: "ts" };
      });
    },
  };
}

/**
 * The controller, the service that owns it, and the gateway that fronts both are
 * bundled into one file on purpose: `statusForCommandError` is an `instanceof`
 * and a name check, and three bundles would give the code under test three
 * copies of itself.
 */
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-auto-review-answer-"));
await build({
  stdin: {
    contents: [
      `export { SandAutoReviewController, SAND_AUTO_REVIEW_APPROVAL_TTL_MS } from "./source/host/runner/sand-auto-review.js";`,
      `export { AutoReviewService } from "./source/host/extensions/auto-review/auto-review-service.js";`,
      `export { statusForCommandError, startGatewayServer } from "./source/host/gateway-server.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "auto-review-answer-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "auto-review-answer.mjs"),
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
  SandAutoReviewController,
  SAND_AUTO_REVIEW_APPROVAL_TTL_MS,
  startGatewayServer,
  statusForCommandError,
} = await import(pathToFileURL(path.join(directory, "auto-review-answer.mjs")).href + "?" + Date.now());
test.after(() => rmSync(directory, { recursive: true, force: true }));

const AGENT = "11111111-1111-4111-8111-111111111111";
/** Long enough that a loopback round trip cannot expire the card mid-assertion. */
const APPROVAL_TTL_MS = 15_000;
/** A hung approval fails the assertion instead of hanging the run. */
const SAFETY_CEILING_MS = 3_000;

let counter = 0;
/** A blocked call that is never answered must fail the assertion, not hang the run. */
const settleWithin = (raw, ms = SAFETY_CEILING_MS) =>
  Promise.race([
    raw,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("HUNG"), ms);
      timer.unref?.();
    }),
  ]);

/**
 * The real controller, blocked on a real approval.
 *
 * `outcome` is `null` until the blocked tool call is actually woken, so a test
 * can tell "it was told to go ahead" apart from "it was never told anything" —
 * the difference the whole file turns on. The returned holder exposes the
 * pending approval and every event the approval surface was handed, because the
 * defect is not only what the blocked tool call was told: it is that the card
 * was taken off the screen and recorded as settled, so nobody can go back and
 * see what the user pressed.
 */
function blockedApproval() {
  const controller = new SandAutoReviewController({
    agentId: AGENT,
    hostGeneration: "generation-under-test",
    approvalTtlMs: APPROVAL_TTL_MS,
    randomId: () => `approval-${++counter}`,
  });
  const events = [];
  controller.subscribe((event) => events.push(event));
  let outcome = null;
  const raw = controller.requestApproval({
    surface: "hostShell",
    fingerprint: "sha256:target",
    reason: "Auto-review flagged this command.",
    summary: "npm publish",
  }).then((decision) => { outcome = decision; return decision; });
  const pending = controller.getPendingApprovals()[0];
  assert.notEqual(pending, undefined, "the controller opened no approval, so nothing below is measuring a blocked action");
  return {
    controller,
    events,
    pending,
    /** What the blocked tool call was told, or `null` while it is still waiting. */
    outcome: () => outcome,
    settleWithin: (ms) => settleWithin(raw, ms),
  };
}

/** The whole answers the UI and the loopback gateway can send, one being wrong. */
const NOT_A_DENIAL = [
  { value: "denied ", why: "a trailing space after the word" },
  { value: "Denied", why: "the word capitalised" },
  { value: "no", why: "the plain-English synonym" },
  { value: "false", why: "the boolean written as text" },
  { value: "", why: "an empty string" },
  { value: "reject", why: "a different word for the same decision" },
];

test("the harness measured the product and not a double", async () => {
  // Both real answers have to work before either is judged wrong. A controller
  // that refuses everything would pass every "must not approve" assertion below
  // while having stopped guarding anything.
  const deny = blockedApproval();
  deny.controller.resolveApproval(deny.pending.id, "denied");
  const denied = await deny.settleWithin();
  assert.equal(denied.approved, false, `pressing "denied" did not deny: ${JSON.stringify(denied)}`);

  const allow = blockedApproval();
  allow.controller.resolveApproval(allow.pending.id, "approved");
  const approved = await allow.settleWithin();
  assert.equal(approved.approved, true, `pressing "approved" did not approve: ${JSON.stringify(approved)}`);
});

test("an answer that is neither word is a refusal to answer, not an approval", async () => {
  for (const entry of NOT_A_DENIAL) {
    const held = blockedApproval();
    const settled = held.controller.resolveApproval(held.pending.id, entry.value);

    assert.equal(settled, undefined,
      `an answer of ${JSON.stringify(entry.value)} — ${entry.why} — settled an approval Auto-review had blocked, and the card moved off its buttons`);
    assert.deepEqual(held.controller.getPendingApprovals().map((a) => a.id), [held.pending.id],
      `an answer of ${JSON.stringify(entry.value)} — ${entry.why} — consumed the pending approval, so the user is left with a card that no longer does anything`);
    assert.deepEqual(held.events.map((event) => event.type), ["created"],
      `an answer of ${JSON.stringify(entry.value)} — ${entry.why} — told the approval surface that the question was answered`);

    await new Promise((resolve) => { const timer = setTimeout(resolve, 25); timer.unref?.(); });
    assert.equal(held.outcome(), null,
      `an answer of ${JSON.stringify(entry.value)} — ${entry.why} — told the blocked tool call to go ahead: ${JSON.stringify(held.outcome())}`);

    held.controller.expire("session_end");
    assert.notEqual(await held.settleWithin(), "HUNG",
      `expiring the approval left the blocked tool call waiting forever, so this test cannot clean up after itself`);
  }
});

test("the wire refuses an answer that is neither word, and names the field", async () => {
  const sink = { trySetForTab: () => {}, clearForTab: () => {} };
  const service = new AutoReviewService({
    auth: {},
    experiments: { checkFeatureGate: () => false },
    settings: { getAutoReviewInstructions: () => ({ isEnabled: false, allowInstructions: [], blockInstructions: [] }) },
    telemetry: { reportAutoReviewDisplayRecheckFailed: () => {}, reportAutoReviewApproval: () => {} },
    awaitingSink: sink,
    transcript: { settleStaleAutoReviewCard: async () => false },
    hostGeneration: "generation-under-test",
    createClassifierExecutor: () => ({}),
  });
  const bound = service.bindRunner({ agentId: AGENT, onUpdate: () => {} });
  const controller = bound.autoReviewController;
  let outcome = null;
  const raw = controller.requestApproval({ surface: "hostShell", fingerprint: "sha256:target", reason: "r", summary: "s" })
    .then((decision) => { outcome = decision; return decision; });
  const pending = controller.getPendingApprovals()[0];
  assert.notEqual(pending, undefined, "the service opened no approval, so nothing below is measuring a blocked action");

  /** The real host API in front of the real service, over doubles that answer nothing. */
  const calls = [];
  const record = (id) => (name) => (...args) => { calls.push({ extension: id, name, args }); return undefined; };
  const proxy = new Proxy({}, { get: (_target, name) => record("other")(String(name)) });
  const telemetryRecord = record("telemetry");
  const telemetry = new Proxy({ analytics: proxy }, {
    get: (target, name) => (typeof name === "symbol" ? Reflect.get(target, name) : name in target ? target[name] : telemetryRecord(String(name))),
  });
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "auto-review") return service;
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
  assert.ok(Object.keys(api).length >= 100,
    `the API object offered ${Object.keys(api).length} methods, so this file is measuring a broken bundle rather than the gateway`);
  assert.equal(typeof api.resolveAutoReviewApproval, "function",
    "the gateway has no resolveAutoReviewApproval, so the wire assertions below would pass without reaching anything");

  const server = await startGatewayServer({
    api,
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false, lastBusyAtMs: null }),
    startedAt: 0,
    authToken: "test-token",
  });
  const call = async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/resolveAutoReviewApproval`, {
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
    for (const entry of NOT_A_DENIAL) {
      const answer = await call({ agentId: AGENT, entryId: "entry-1", requestId: pending.id, resolution: entry.value });
      assert.equal(answer.status, 400,
        `a request whose resolution is ${JSON.stringify(entry.value)} — ${entry.why} — came back as ${answer.status}, which tells the caller the host broke and invites a retry of an answer that can never succeed as written`);
      assert.match(answer.body?.error ?? "", /Malformed resolveAutoReviewApproval request/,
        `the refusal for ${JSON.stringify(entry.value)} does not name the command: ${JSON.stringify(answer.body)}`);
      assert.match(answer.body?.error ?? "", /"resolution"/,
        `the refusal for ${JSON.stringify(entry.value)} does not name the field the caller has to fix: ${JSON.stringify(answer.body)}`);
      assert.match(answer.body?.error ?? "", /"denied"/,
        `the refusal for ${JSON.stringify(entry.value)} does not say what a valid answer looks like: ${JSON.stringify(answer.body)}`);
    }

    const wrongType = await call({ agentId: AGENT, entryId: "entry-1", requestId: pending.id, resolution: 42 });
    assert.equal(wrongType.status, 400,
      `a resolution that arrived as a number came back as ${wrongType.status}, so a caller that serialises its enum badly is told the host broke`);

    assert.deepEqual(controller.getPendingApprovals().map((a) => a.id), [pending.id],
      "a refused answer consumed the pending approval, so the question is gone from the surface without anybody answering it");
    assert.equal(outcome, null,
      `a refused answer still told the blocked tool call to go ahead: ${JSON.stringify(outcome)}`);

    // The control pass: the one answer that is a word is applied.
    const good = await call({ agentId: AGENT, entryId: "entry-1", requestId: pending.id, resolution: "denied" });
    assert.equal(good.status, 200,
      `a well-formed refusal of a live approval came back as ${good.status}, so the command refuses every answer`);
    const settled = await settleWithin(raw);
    assert.equal(settled.approved, false,
      `the wire delivered "denied" and the blocked tool call was told to go ahead: ${JSON.stringify(settled)}`);
  } finally {
    await server.close();
    controller.expire("session_end");
  }
});

test("the approval lifetime is ten minutes and is not what decides this", () => {
  // Pinned so a future change to the TTL cannot quietly turn "the user answered
  // something else" into "the user ran out of time", which is the other way this
  // defect could present and needs a different fix.
  assert.equal(SAND_AUTO_REVIEW_APPROVAL_TTL_MS, 10 * 60 * 1_000,
    "the auto-review approval lifetime moved, so this file's numbers no longer describe the shipped behaviour");
});

test("the refusal class still reaches the wire as a client error", () => {
  // `statusForCommandError` is checked directly because the wire status is
  // decided by an `instanceof` and a name check, and a refusal that stops being
  // classified silently turns every declined answer back into a `500`.
  const held = blockedApproval();
  let raised = null;
  try {
    held.controller.resolveApproval(held.pending.id, "denied ");
  } catch (error) {
    raised = error;
  }
  assert.equal(raised, null,
    "the controller threw for an answer that is neither word, so a caller cannot tell a refused answer from a broken host");
  assert.equal(statusForCommandError(new Error("unrelated")), 500,
    "every refusal is now a client error, so a real server fault would tell the caller to stop retrying");
  held.controller.expire("session_end");
});