import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * An agent asked the user for permission and could never be told yes.
 *
 * The question itself worked: `authorize` created a pending ask, the host sent
 * it to the renderer as a `local-tool-permission` card, the four buttons called
 * `resolveLocalToolPermission`, and `resolveRequest` woke the blocked tool call
 * with the user's answer. What never came back was a *second* chance. Every
 * settlement that was not a plain approval was written into the controller's
 * refusal memory — and the user's own timeout was one of them. `settle` in
 * `source/host/extensions/local-tool-permission/local-tool-permission-controller.ts`
 * remembered a refusal for any status that was not `allowed` and not `always`,
 * so an ask that simply went unanswered for its ten minutes produced exactly
 * the same record as an ask the user pressed "Deny once" on.
 *
 * Nothing was logged and nothing threw. The second request for that command was
 * answered with `SAND_LOCAL_TOOLS_ABANDONED_MESSAGE` — "the user was already
 * asked about this exact action and did not approve it … will not be asked
 * again" — a sentence that was true in the sense that the user had never been
 * asked at all. The agent read it as a refusal, stopped, and said so in chat.
 * And because `authorize` consults the refusal memory before it reads the
 * setting, setting *Execution on Local Computer* to "Always allow" afterwards
 * could not lift it either: one ten-minute coffee break permanently removed
 * that exact command from the user's machine for the rest of the session.
 *
 * The same settlement rule also classified a cancellation as a refusal, so an
 * agent that gave up waiting poisoned its own next attempt.
 *
 * Only the user's own answer is now remembered: `denied` and `never`. An ask
 * that times out says the truth — it went unanswered, nothing ran — and the
 * next request for the same action asks again, which is what the user was
 * waiting for. The tests below drive the whole round trip: the question the
 * interface is handed, the answer, the decision the blocked agent receives, the
 * honest expiry, and the guarantee that a real "no" still sticks.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-tool-ask-"));
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

const { loaded, dispose } = await bundle([
  ["host", "extensions", "local-tool-permission", "local-tool-permission-controller.ts"],
  ["host", "extensions", "local-tool-permission", "local-tool-permission-resolution.ts"],
  ["shared", "local-tool-permission-machinery.ts"],
]);
const { SandLocalToolPermissionController } = loaded["local-tool-permission-controller.mjs"];
const { resolveLocalToolPermissionAsk } = loaded["local-tool-permission-resolution.mjs"];
const {
  SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
  SAND_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE,
  SAND_LOCAL_TOOLS_DENIED_MESSAGE,
} = loaded["local-tool-permission-machinery.mjs"];

test.after(() => dispose());

const ASK_TTL_MS = 40;
/** Long enough that a hung agent fails the assertion instead of the run. */
const SAFETY_CEILING_MS = 2_000;

function controllerFor({ permission = "ask", askTtlMs = ASK_TTL_MS } = {}) {
  let state = permission;
  let counter = 0;
  const controller = new SandLocalToolPermissionController({
    getPermission: () => state,
    setPermission: (next) => { state = next; },
    canAsk: () => true,
    hasLiveComputer: () => true,
    askTtlMs: ASK_TTL_MS,
    randomId: () => `ask-${++counter}`,
  });
  return { controller, setPermission: (next) => { state = next; } };
}

const scope = (toolCallId) => ({ agentId: "agent-1", toolCallId, action: "run-command" });

/** The transcript side the resolution module reaches for when an answer arrives too late. */
const transcript = {
  widgetResponses: {
    settleStaleLocalToolPermissionCard: async () => false,
  },
};

/** Resolves to the string HUNG rather than waiting forever on a missing settlement. */
function settleWithin(pending, label) {
  return Promise.race([
    pending,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("HUNG"), SAFETY_CEILING_MS);
      timer.unref?.();
      void label;
    }),
  ]);
}

/** Every field the renderer is handed for a card, captured off the controller's events. */
function collectEvents(controller) {
  const events = [];
  controller.subscribe((event) => events.push(event));
  return events;
}

const runCommand = (target) => ({ action: "run-command", target });

test("an allowed ask reaches the blocked agent as a decision it can act on", async () => {
  const { controller } = controllerFor();
  const events = collectEvents(controller);
  const blocked = controller.authorize(scope("call-1"), runCommand("npm install left-pad"));

  const asked = controller.getPendingRequestForAgent("agent-1");
  assert.notEqual(asked, undefined, "the agent was never asked, so there was no question for the user to see");
  assert.equal(asked.status, "pending", `the question reached the interface already answered: ${asked?.status}`);
  assert.equal(asked.expiresAtMs - asked.createdAtMs, ASK_TTL_MS,
    "the card is shown without a lifetime, so the user cannot tell that it will give up on its own");

  await resolveLocalToolPermissionAsk(
    { asks: controller, transcript },
    { agentId: "agent-1", entryId: "entry-1", requestId: asked.id, resolution: "allow-once" },
  );
  const decision = await settleWithin(blocked, "allow-once");

  assert.deepEqual(decision, { allowed: true, approvalId: asked.id },
    `the user answered "allow once" and the agent did not get an answer it can run: ${JSON.stringify(decision)}`);
  assert.equal(controller.getPendingRequestById(asked.id), undefined,
    "the answer did not retire the question, so the interface keeps offering buttons for a request that is already settled");
  assert.deepEqual(events.map((event) => `${event.type}:${event.request.status}`), ["created:pending", "settled:allowed"],
    "the interface was not told the question was asked and then answered, which is the only way a card can move off its buttons");
});

test("the question the user is shown carries what the card renders and what an answer is matched by", async () => {
  const { controller } = controllerFor();
  const events = collectEvents(controller);
  const blocked = controller.authorize(
    scope("call-1"),
    { action: "run-command", target: "npm install left-pad", description: "  installs the missing package  " },
  );
  const created = events.find((event) => event.type === "created")?.request;
  assert.notEqual(created, undefined, "no question was ever offered to the interface");
  assert.deepEqual(
    { action: created.action, target: created.target, status: created.status, description: created.description },
    { action: "run-command", target: "npm install left-pad", status: "pending", description: "installs the missing package" },
    `the card cannot show what it is approving, because the question does not carry the command, the action and the reason: ${JSON.stringify(created)}`,
  );
  await resolveLocalToolPermissionAsk(
    { asks: controller, transcript },
    { agentId: "agent-1", entryId: "entry-1", requestId: created.id, resolution: "deny" },
  );
  await settleWithin(blocked, "deny");
});

test("the question the user is shown is the one the shipped renderer draws", async () => {
  // The shipped renderer is checksum-pinned and is never rebuilt from source, so
  // the fields it needs are read off the shipped bundle rather than off the
  // recovered frontend. Minified names are never written by hand: the bundle
  // locates its own prompt by a string only that prompt carries, and the field
  // reads are looked for around it.
  const bundleText = readFileSync(
    path.join(repoRoot, "src", "app", "dist", "renderer", "assets", "index-lA9cgT4O.js"),
    "utf8",
  );
  const anchor = "Always allow is disabled by team policy";
  const anchorAt = bundleText.indexOf(anchor);
  assert.notEqual(anchorAt, -1,
    "the shipped renderer carries no local-tool-permission prompt, so the question has nowhere to be drawn");
  const prompt = bundleText.slice(anchorAt - 4_000, anchorAt + 8_000);
  for (const field of ["requestId", "status", "action", "target"]) {
    assert.match(prompt, new RegExp(`\\.${field}\\b`),
      `the shipped prompt never reads ask.${field}, so the host emitting it proves nothing about the real card`);
  }
  assert.match(prompt, /"aria-label":"Local tool permissions"/,
    "the prompt is not the dock that carries local-tool permissions, so it draws some other question");
});

test("an ask nobody answers expires honestly and is offered again", async () => {
  const { controller } = controllerFor();
  const events = collectEvents(controller);
  const blocked = controller.authorize(scope("call-1"), runCommand("npm install left-pad"));
  const asked = controller.getPendingRequestById(controller.getPendingRequestForAgent("agent-1").id);

  const decision = await settleWithin(blocked, "timeout");
  assert.notEqual(decision, "HUNG",
    "the agent waited on the user forever, so an unanswered question is not a question with a lifetime");
  assert.deepEqual(decision, { allowed: false, reason: SAND_LOCAL_TOOLS_ASK_EXPIRED_MESSAGE },
    `the agent was not told the request simply went unanswered: ${JSON.stringify(decision)}`);
  assert.equal(asked.status !== undefined, true, "the request vanished instead of expiring, so the card cannot say what happened");
  assert.deepEqual(
    events.filter((event) => event.type === "settled").map((event) => event.request.status), ["expired"],
    "the interface was never told the question expired, so it keeps offering buttons that no longer do anything",
  );
  assert.equal(controller.getPendingRequestById(asked.id), undefined,
    "the expired question was left in the pending map, so the next identical request joins a question nobody can see");

  const askedAgain = controller.authorize(scope("call-2"), runCommand("npm install left-pad"));
  assert.notEqual(controller.getPendingRequestForAgent("agent-1"), undefined,
    "after the user let one question go by, the agent may not ask that question again, so the user is never given the chance to say yes");
  assert.notEqual(controller.getPendingRequestById(controller.getPendingRequestForAgent("agent-1").id).id, asked.id,
    "the second question reused the settled id, so the interface cannot tell them apart");
  await resolveLocalToolPermissionAsk(
    { asks: controller, transcript },
    {
      agentId: "agent-1",
      entryId: "entry-2",
      requestId: controller.getPendingRequestForAgent("agent-1").id,
      resolution: "allow-once",
    },
  );
  assert.deepEqual(await settleWithin(askedAgain, "second ask"),
    { allowed: true, approvalId: controller.liveApprovalIds()[0] },
    "the user said yes the second time and the agent did not get it, so a timed-out question really did cost the user their say");
});

test("a timeout leaves no refusal behind for the setting to be measured against", async () => {
  const { controller, setPermission } = controllerFor();
  await settleWithin(
    controller.authorize(scope("call-1"), runCommand("npm install left-pad")),
    "timeout",
  );
  setPermission("always");
  controller.notePermissionChanged();
  const decision = await settleWithin(
    controller.authorize(scope("call-2"), runCommand("npm install left-pad")),
    "always after a timeout",
  );
  assert.deepEqual(decision, { allowed: true },
    `ten minutes of silence turned into a permanent veto that "Always allow" could not lift: ${JSON.stringify(decision)}`);
});

test("the lifetime of an open question keeps the loop alive, so it cannot be skipped", async () => {
  // A timer that does not keep the loop alive can be skipped by a process with
  // nothing else pending, and the agent blocked in `authorize` is the only thing
  // pending: it would exit on an unanswered question instead of expiring it.
  // `getActiveResourcesInfo` reports only what is actually keeping the loop
  // alive, so a lifetime timer that does not count here is one that can be
  // skipped. The control pass measures what this test itself adds, so unrelated
  // timers cannot pass the check on their own.
  const liveTimers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const measure = async (open) => {
    const before = liveTimers();
    const handle = open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const during = liveTimers() - before;
    return { handle, during };
  };

  const { during: controlTimers } = await measure(() => {});
  const { controller } = controllerFor({ askTtlMs: 30_000 });
  const { during: askTimers } = await measure(() => {
    const blocked = controller.authorize(scope("call-1"), runCommand("npm install left-pad"));
    void settleWithin(blocked, "long ttl");
  });

  assert.ok(askTimers > controlTimers,
    `an open question held ${askTimers} loop-keeping timers against a control of ${controlTimers}, so its lifetime can be skipped and a waiting agent never hears anything back`);

  const asked = controller.getPendingRequestForAgent("agent-1");
  assert.equal(asked?.status, "pending", "the question under measurement was never actually left open");
  controller.resolveRequest(asked.id, "deny");
});

test("an answer the user actually gave is remembered as a refusal", async () => {
  const { controller } = controllerFor();
  const blocked = controller.authorize(scope("call-1"), runCommand("rm -rf build"));
  const asked = controller.getPendingRequestForAgent("agent-1");
  await resolveLocalToolPermissionAsk(
    { asks: controller, transcript },
    { agentId: "agent-1", entryId: "entry-1", requestId: asked.id, resolution: "deny" },
  );
  const decision = await settleWithin(blocked, "deny");
  assert.deepEqual(decision, { allowed: false, reason: SAND_LOCAL_TOOLS_DENIED_MESSAGE },
    `the user pressed "Deny once" and the agent was not told so: ${JSON.stringify(decision)}`);

  const retried = await settleWithin(
    controller.authorize(scope("call-2"), runCommand("rm -rf build")),
    "retry after deny",
  );
  assert.equal(retried.reason, SAND_LOCAL_TOOLS_ABANDONED_MESSAGE,
    `a refusal the user actually gave was forgotten, so the agent will ask again about the very thing they said no to: ${JSON.stringify(retried)}`);
});

test("always allow covers the next identical action instead of asking again", async () => {
  const { controller } = controllerFor();
  const blocked = controller.authorize(scope("call-1"), runCommand("npm run build"));
  const asked = controller.getPendingRequestForAgent("agent-1");
  await resolveLocalToolPermissionAsk(
    { asks: controller, transcript },
    { agentId: "agent-1", entryId: "entry-1", requestId: asked.id, resolution: "always" },
  );
  await settleWithin(blocked, "always");
  assert.equal(controller.permission(), "always", "pressing Always allow did not change the setting the button promises");

  const events = collectEvents(controller);
  const next = await settleWithin(
    controller.authorize(scope("call-2"), runCommand("npm run build")),
    "same command after always",
  );
  assert.deepEqual(next, { allowed: true },
    `Always allow promised to cover the next such action and did not: ${JSON.stringify(next)}`);
  assert.equal(events.some((event) => event.type === "created"), false,
    "Always allow asked the user again, which is the one thing the button exists to stop");

  const different = await settleWithin(
    controller.authorize(scope("call-3"), runCommand("npm run test")),
    "another command after always",
  );
  assert.deepEqual(different, { allowed: true },
    `Always allow covered only the command it was pressed on: ${JSON.stringify(different)}`);
});

test("an answer for somebody else's question is refused rather than applied", async () => {
  const { controller } = controllerFor();
  const blocked = controller.authorize(scope("call-1"), runCommand("npm install left-pad"));
  const asked = controller.getPendingRequestForAgent("agent-1");
  await assert.rejects(
    () => resolveLocalToolPermissionAsk(
      { asks: controller, transcript },
      { agentId: "agent-2", entryId: "entry-1", requestId: asked.id, resolution: "allow-once" },
    ),
    /no longer waiting for an answer/,
    "an answer naming another agent settled a question that agent never saw",
  );
  assert.notEqual(controller.getPendingRequestById(asked.id), undefined,
    "the question was settled by an answer meant for a different conversation");
  await resolveLocalToolPermissionAsk(
    { asks: controller, transcript },
    { agentId: "agent-1", entryId: "entry-1", requestId: asked.id, resolution: "deny" },
  );
  await settleWithin(blocked, "deny");
});