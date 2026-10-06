/**
 * An agent could not change its own name, title or description. The tool the
 * product advertises for exactly that \u2014 `update_state`, `target: "profile"` \u2014
 * was wired to a profile writer that no caller ever supplied:
 * `createSandAgentState` called `deps.readProfile()`, and the only production
 * call site of `createAgentState` (`host-runner-composition.ts`, the
 * `agentStateOwner` build) passes memory, automations, workflows, channels,
 * agentDir, agentId and readBoxFile \u2014 no reader and no writer. A repo-wide
 * search found the two names nowhere but their own declaration. So every
 * `update_state` profile write ended on `TypeError: deps.readProfile is not a
 * function`, and the person using the app was right that it fails with an
 * error.
 *
 * Nothing noticed, for three reasons that are worth naming because they repeat.
 * One: the composer reaches the memory extension through `method()`, typed
 * `(...args: any[]) => any`, so a missing member of the dependency object is a
 * runtime `TypeError` and not a compile error. Two: the shape that fails is a
 * call, not a list \u2014 there is no fallback here to look healthy. Three: the same
 * owner answered `{ ok, message }` where `SandStateWriter` declares
 * `{ ok, detail }` / `{ ok, reason }`, so even a success would have reached the
 * model as `undefined` and a refusal as the sentence "Not saved \u2014 undefined".
 * The tool could not have reported the rename even if it had made one.
 *
 * What these tests close:
 *
 *  - the three fields are written, on a real agents root, through the real
 *    `AgentLifecycle.updateAgent` \u2014 the same host method the profile edit
 *    screen calls, with the agent's own id \u2014 and the model is told what
 *    changed in a sentence;
 *  - `title` is reachable at all, which before this change it was not: it is
 *    not in the tool's parameter schema and it was not in the writer;
 *  - a field the call leaves out keeps its stored value, which is the same
 *    silent-drop defect that made the flat `{"id","title"}` shape return the
 *    old value;
 *  - a call with nothing to change, a blank name, a host that answers with
 *    nothing, and a host that throws all answer with a sentence and leave the
 *    stored profile exactly as it was;
 *  - an owner built without a writer answers with a sentence instead of
 *    throwing, so the class of defect cannot come back silently;
 *  - the static guard proves the production call site actually binds
 *    `updateOwnProfile` to `updateAgent` on `session.id`, and counts what it
 *    found rather than trusting that it ran.
 *
 * What these tests do NOT prove: that a model will decide to call the tool.
 * They prove the host side \u2014 the write, the merge, the answer. The capability
 * limits below are asserted as refusals of the schema, not as prompt text, so
 * they hold no matter what the prompt says.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-self-profile-"));
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
  ["host", "extensions", "memory", "agent-state.ts"],
  ["host", "runner", "tools", "sand-state-tool.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
  ["host", "extensions", "session", "agent-session.ts"],
]);

const { createSandAgentState } = loaded["agent-state.mjs"];
const {
  OPERATIONS,
  TARGETS,
  applySandStateUpdate,
  sandUpdateStateParameters,
} = loaded["sand-state-tool.mjs"];
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];
const { SandAgentSessionStore } = loaded["agent-session.mjs"];

test.after(() => dispose());

// ---------------------------------------------------------------------------
// A real agents root, a real store, the real lifecycle and the real routing
// function. Nothing about the storage half is stubbed, because the claim under
// test is that the rename survives on disk through the host the UI uses.
// ---------------------------------------------------------------------------

const AGENT_ID_FIELDS = { name: "Original", description: "old description", title: "old title" };

/** Exactly the mapping `createSandStateTool`'s execute performs. */
const asTheModelSeesIt = (outcome) =>
  outcome.ok ? outcome.detail : `Not saved — ${outcome.reason}`;

function makeWorld() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-self-profile-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  const store = new SandAgentSessionStore(rootDir);
  const sessionStore = {
    createSession: (profile, origin, purpose) => store.createSession(profile, origin, purpose),
    getAgentDir: (id) => store.getAgentDir(id),
    agentDirExists: (id) => store.agentDirExists(id),
    releaseSession: (id) => store.releaseSession(id),
    getAgentProfileText: (id) => store.getAgentProfileText(id),
    writeAgentProfileFile: (id, profile) => store.writeAgentProfileFile(id, profile),
    updateAgentProfile: (id, profile) => store.updateAgentProfile(id, profile),
    summarizeOpenSession: async (session) => ({
      id: session.id,
      ...(store.getAgentProfileText(session.id) ?? {}),
    }),
  };
  const tm = {
    sessionStore,
    sessions: {
      activeSession: undefined,
      liveSessions: new Map(),
      pendingSessionOpens: new Set(),
      deletedAgentIds: new Set(),
      markSessionLeftBehind: async () => {},
      invalidateDeferredActivation: () => {},
      replaceSession: async (session) => { tm.sessions.activeSession = session; },
      clearActiveTranscript: () => {},
    },
    roster: {
      emit: () => {},
      emitAgents: async () => {},
      emitAgentUpdate: async () => {},
      emitProfileChanged: () => {},
      reserveSnapshotStamp: () => "stamp",
      finalizeSummaryForRpc: (summary) => summary,
    },
  };
  return { base, rootDir, store, tm, lifecycle: new AgentLifecycle(tm) };
}

async function openAgent(world, profile = AGENT_ID_FIELDS) {
  const session = await world.store.createSession(profile, "user");
  const hostCalls = [];
  // The one seam the composition binds: the agent's own id, into the same host
  // method the profile edit screen calls. Nothing else is crossed out.
  const state = createSandAgentState({
    memory: { addMemory: () => ({ content: "" }), removeMemoryByContent: () => false },
    automations: {},
    workflows: {},
    channels: { remove: () => false },
    agentDir: world.store.getAgentDir(session.id),
    agentId: session.id,
    updateOwnProfile: (patch) => {
      hostCalls.push({ id: session.id, patch });
      return world.lifecycle.updateAgent(session.id, patch);
    },
  });
  /** Exactly the mapping `createSandStateTool`'s execute performs. */
  const runOutcome = (args) => applySandStateUpdate(args, { state });
  const run = async (args) => asTheModelSeesIt(await runOutcome(args));
  const readProfile = () =>
    JSON.parse(readFileSync(path.join(world.rootDir, session.id, "profile.json"), "utf8"));
  return { ...session, state, run, runOutcome, hostCalls, readProfile };
}

async function withAgent(body, profile = AGENT_ID_FIELDS) {
  const world = makeWorld();
  let opened = null;
  try {
    opened = await openAgent(world, profile);
    await body(world, opened);
  } finally {
    await release(world, opened);
  }
}

/** Windows refuses to unlink an open `store.db`, so the handle goes first. */
async function release(world, agent) {
  if (agent != null) await world.store.releaseSession(agent.id).catch(() => {});
  try {
    rmSync(world.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

// ---------------------------------------------------------------------------

test("an agent renames itself through the same host method the profile edit screen calls", async () => {
  await withAgent(async (world, agent) => {
    const answer = await agent.run({
      target: "profile", action: "set", name: "Probe2", title: "t2", description: "d2",
    });

    assert.equal(answer, "Updated your name, description, title.",
      "the model was not told what changed, so it cannot report a rename it never saw confirmed");

    assert.equal(agent.hostCalls.length, 1,
      "the write did not go through exactly one host call, so the merge and the roster event are not accounted for");
    assert.equal(agent.hostCalls[0].id, agent.id,
      "the profile of somebody other than this agent was written, so a self-rename turned into an edit of a teammate");
    assert.deepEqual(agent.hostCalls[0].patch,
      { name: "Probe2", title: "t2", description: "d2" },
      "the host was handed a shape it does not read, which is how the flat shape returned the old value in silence");

    const onDisk = agent.readProfile();
    assert.equal(onDisk.name, "Probe2",
      "the agent is still called Original on disk, so the rename never happened where the UI reads it");
    assert.equal(onDisk.title, "t2",
      "the title was dropped, so the short line under the name still shows the old one");
    assert.equal(onDisk.description, "d2",
      "the description was dropped, so the agent still advertises what it used to be for");

    // The other caller of the same host method, with the shape the renderer sends.
    await world.lifecycle.updateAgent(agent.id, { name: "From The UI", description: "ui", title: "ui" });
    assert.deepEqual(
      { name: agent.readProfile().name, title: agent.readProfile().title },
      { name: "From The UI", title: "ui" },
      "the UI-shaped caller no longer writes the same file, so there are two code paths behind one profile again");
  });
});

test("the title is a parameter the model can send, not only a field the host stores", () => {
  const shape = sandUpdateStateParameters.shape;
  assert.notEqual(shape.title, undefined,
    "the tool schema has no `title`, so the one field the profile screen offers and the agent cannot set is unreachable from a turn");
  assert.equal(sandUpdateStateParameters.safeParse({
    target: "profile", action: "set", title: "Analyst",
  }).data.title, "Analyst",
    "a well-formed title is dropped by the schema, so the tool cannot carry it even when the writer would accept it");
});

test("a field the call leaves out keeps its stored value", async () => {
  await withAgent(async (_world, agent) => {
    const answer = await agent.run({ target: "profile", action: "set", title: "Analyst" });

    assert.equal(answer, "Updated your title.",
      "the answer does not say that only the title changed, so a caller cannot tell a partial write from a full one");
    assert.deepEqual(
      { name: agent.readProfile().name, description: agent.readProfile().description, title: agent.readProfile().title },
      { name: "Original", description: "old description", title: "Analyst" },
      "a write of one field cleared the others, which is the silent-drop defect the flat shape had on the host path");
  });
});

test("a call with nothing to change is refused with a sentence and writes nothing", async () => {
  await withAgent(async (_world, agent) => {
    const outcome = await agent.runOutcome({ target: "profile", action: "set" });
    const answer = asTheModelSeesIt(outcome);

    assert.equal(outcome.ok, false,
      "an empty profile write was not refused at all, so a no-op is treated as a change");
    assert.match(outcome.reason, /at least one of name, title or description/,
      `the refusal does not say what to pass: ${outcome.reason}`);
    assert.match(answer, /^Not saved — (?!\s*undefined)/,
      `the model is shown a refusal with no reason in it: ${answer}`);
    assert.equal(agent.hostCalls.length, 0,
      "an empty write still reached the host, so a no-op round-trips through the roster");
    assert.equal(agent.readProfile().name, "Original",
      "an empty write changed the stored name, so the refusal is not the whole story");
  });
});

test("a blank name is refused with a sentence and writes nothing", async () => {
  await withAgent(async (_world, agent) => {
    const outcome = await agent.runOutcome({ target: "profile", action: "set", name: "   ", title: "t" });
    const answer = asTheModelSeesIt(outcome);

    assert.equal(outcome.ok, false,
      "a blank name was accepted, so the agent can no longer be addressed by name");
    assert.match(outcome.reason, /blank name is not allowed/,
      `the refusal does not say what is wrong: ${outcome.reason}`);
    assert.match(answer, /^Not saved — (?!\s*undefined)/,
      `the model is shown a refusal with no reason in it: ${answer}`);
    assert.equal(agent.hostCalls.length, 0,
      "a blank name still reached the host, so the stored name was decided somewhere nobody can see");
    assert.equal(agent.readProfile().name, "Original",
      "a blank name was written, so the agent can no longer be addressed by name");
    assert.equal(agent.readProfile().title, "old title",
      "the title changed even though the call was refused, so the profile is left half-applied");
  });
});

test("a host that answers with nothing is not reported to the user as a success", async () => {
  const world = makeWorld();
  let agent = null;
  try {
    agent = await openAgent(world);
    const silent = createSandAgentState({
      memory: { addMemory: () => ({ content: "" }), removeMemoryByContent: () => false },
      automations: {},
      workflows: {},
      channels: { remove: () => false },
      agentDir: world.store.getAgentDir(agent.id),
      agentId: agent.id,
      updateOwnProfile: async () => null,
    });
    const outcome = await applySandStateUpdate(
      { target: "profile", action: "set", name: "Ghost" },
      { state: silent },
    );

    assert.equal(outcome.ok, false,
      "a host that stored nothing was reported as a successful write, so the model tells the user a rename happened that did not");
    assert.match(`${outcome.detail ?? ""}${outcome.reason ?? ""}`, /host answered with nothing/,
      "the refusal does not say what went wrong, so there is nothing to act on");
  } finally {
    await release(world, agent);
  }
});

test("a host refusal reaches the model instead of disappearing", async () => {
  const world = makeWorld();
  let agent = null;
  try {
    agent = await openAgent(world);
    const refusing = createSandAgentState({
      memory: { addMemory: () => ({ content: "" }), removeMemoryByContent: () => false },
      automations: {},
      workflows: {},
      channels: { remove: () => false },
      agentDir: world.store.getAgentDir(agent.id),
      agentId: agent.id,
      updateOwnProfile: async () => { throw new Error("Agent is gone."); },
    });
    const outcome = await applySandStateUpdate(
      { target: "profile", action: "set", name: "Renamed" },
      { state: refusing },
    );

    assert.equal(outcome.ok, false,
      "a throwing host was reported as a successful write, so the model claims a rename that raised");
    assert.match(`${outcome.reason ?? ""}`, /Agent is gone\./,
      "the host's own sentence was dropped, so the model cannot tell a gone agent from a broken disk");
  } finally {
    await release(world, agent);
  }
});

test("an owner with no writer bound answers with a sentence instead of throwing", async () => {
  const world = makeWorld();
  let agent = null;
  try {
    agent = await openAgent(world);
    // The exact shape `host-runner-composition.ts` used to build: every
    // dependency but the profile writer. This is what shipped, and it died on
    // `TypeError: deps.readProfile is not a function`.
    const unbound = createSandAgentState({
      memory: { addMemory: () => ({ content: "" }), removeMemoryByContent: () => false },
      automations: {},
      workflows: {},
      channels: { remove: () => false },
      agentDir: world.store.getAgentDir(agent.id),
      agentId: agent.id,
    });
    const outcome = await applySandStateUpdate(
      { target: "profile", action: "set", name: "Renamed" },
      { state: unbound },
    );

    assert.equal(outcome.ok, false,
      "an unbound writer was reported as a successful write, so the class of defect can come back silently");
    assert.match(`${outcome.reason ?? ""}`, /no profile writer is bound/,
      "the refusal does not name the missing binding, so the next reader looks for a permission problem instead");
    assert.equal(agent.readProfile().name, "Original",
      "the unbound owner wrote the profile anyway, so the refusal is not the whole story");
  } finally {
    await release(world, agent);
  }
});

// ---------------------------------------------------------------------------
// The limits of the capability. These are asserted against the schema, so they
// hold whatever the prompt says. An agent may change its own identity and
// nothing else: it cannot name another agent, it cannot change its picture from
// this route, and it cannot touch a group's membership.
// ---------------------------------------------------------------------------

test("the profile route can only ever reach this agent's own three fields", () => {
  const shape = sandUpdateStateParameters.shape;
  for (const forbidden of ["agent_id", "target_id", "target_agent", "id_of", "group", "group_id", "member", "members", "avatar", "avatarShape", "avatarColor", "projectRoot"]) {
    assert.equal(forbidden in shape, false,
      `the profile tool now accepts "${forbidden}", so an agent reached past its own identity with one call`);
  }
  assert.deepEqual(Object.keys(OPERATIONS.profile), ["set"],
    "the profile target grew a second action, so it can now do something the host has not been asked to support");

  // What reaching somebody else costs: the separate tool that takes an id.
  const rejected = sandUpdateStateParameters.safeParse({
    target: "profile", action: "set", name: "Renamed", agent_id: "00000000-0000-0000-0000-000000000000",
  });
  assert.equal(rejected.success ? rejected.data.agent_id : undefined, undefined,
    "an agent id passed to the profile tool was kept instead of dropped, so the route is not self-only in fact");
});

test("group membership is not a target of this tool", () => {
  for (const forbidden of ["group", "groups", "membership", "roster", "team"]) {
    assert.equal(TARGETS.includes(forbidden), false,
      `update_state grew a "${forbidden}" target, so membership changed over a tool that was scoped to one agent's own state`);
  }
  assert.deepEqual(TARGETS.includes("avatar"), true,
    "the avatar target is gone, so picture editing was folded into the profile route and the two now answer differently");
});

test("the avatar keeps its own target and its own rules", () => {
  assert.deepEqual(Object.keys(OPERATIONS.avatar).sort(), ["clear", "set"],
    "the avatar target changed shape, so the one image route that already worked is no longer the one being tested");
  assert.equal("path" in sandUpdateStateParameters.shape, true,
    "the avatar route lost its parameter, so a picture can no longer be installed at all");
  assert.equal("avatar" in sandUpdateStateParameters.shape, false,
    "an `avatar` field appeared on the profile route, so the picture and the identity are now written by one call");
  assert.match(OPERATIONS.avatar.set, /path to an image/i,
    "the avatar target no longer says it takes a path, so the model is told to pass something the host will not read");
});

// ---------------------------------------------------------------------------
// Static guards. Each counts what it found, because a guard that finds nothing
// passes without having looked.
// ---------------------------------------------------------------------------

test("the production call site binds the profile writer to updateAgent on this agent's own id", () => {
  const source = readFileSync(
    path.join(repoRoot, "source", "host", "host-runner-composition.ts"),
    "utf8",
  );
  const anchor = source.indexOf('method(memory, "createAgentState")');
  assert.notEqual(anchor, -1,
    "the composer no longer mentions createAgentState, so this guard is looking at nothing");
  const site = source.slice(anchor);
  const bindings = site.split("updateOwnProfile:").length - 1;
  assert.equal(bindings, 1,
    `expected the composer to bind updateOwnProfile exactly once, found ${bindings}`);
  const bound = site.slice(site.indexOf("updateOwnProfile:"), site.indexOf("updateOwnProfile:") + 400);
  assert.match(bound, /updateAgent/,
    "the bound writer does not name updateAgent, so the agent's own rename no longer shares the host path the UI uses");
  assert.match(bound, /session\.id/,
    "the bound writer does not carry this agent's own id, so a self-rename would write somebody else's profile");
});

test("the state owner no longer reaches for a profile file writer that nobody binds", () => {
  const source = readFileSync(
    path.join(repoRoot, "source", "host", "extensions", "memory", "agent-state.ts"),
    "utf8",
  );
  for (const phantom of ["deps.readProfile(", "deps.writeProfile("]) {
    const hits = source.split(phantom).length - 1;
    assert.equal(hits, 0,
      `the state owner calls ${phantom} again, and no caller in the repository supplies it`);
  }
  assert.match(source, /updateOwnProfile\(/,
    "the state owner does not name the injected writer, so this guard cannot tell a repaired file from an empty one");
});

test("the writer and the tool agree on the shape of a state-write result", () => {
  const writer = readFileSync(
    path.join(repoRoot, "source", "host", "extensions", "memory", "agent-state.ts"),
    "utf8",
  );
  const tool = readFileSync(
    path.join(repoRoot, "source", "host", "runner", "tools", "sand-state-tool.ts"),
    "utf8",
  );
  assert.match(writer, /ok: true; detail: string/, "the owner answers with a shape the tool does not read");
  assert.match(writer, /ok: false; reason: string/, "the owner refuses with a shape the tool does not read");
  assert.match(tool, /outcome\.detail/, "the tool stopped reading the success field the owner writes");
  assert.match(tool, /outcome\.reason/, "the tool stopped reading the refusal field the owner writes");
});