/**
 * An agent's instructions were written, obeyed, and never once shown.
 *
 * The host half of an agent's brief was finished: `createAgent` and `updateAgent`
 * carry an `instructions` string, `splitAgentInstructions` lifts it out of the
 * profile object so the next `profile.json` write cannot rebuild it away, it lands
 * in `instructions.md` beside the profile, and `system-prompt-assembly` reads that
 * file on every prompt build — so an instruction typed at creation changed how the
 * agent behaved from its very first turn. Every one of those steps had a test.
 *
 * None of them was about seeing it. `buildSummary` builds the agent record from
 * `profile.json`, which by design carries no instructions, and returned a row with
 * `name` and `description` and nothing else; `resolveAgentProfile` answered the same
 * two fields plus two file paths. `AgentLifecycle.withAgentInstructions` did put the
 * text on the create and update answers, which is why the omission was invisible: the
 * one caller that echoed the text back was the caller that had just handed it over.
 * A second roster pass, a reopened dialog, a restarted host and every screen that
 * reads the roster reported an agent with no brief at all.
 *
 * The renderer could not have shown it either — there was no field to type into — so
 * this file covers the server half end to end, and the names it pins
 * (`instructions`, `instructionsError`) are the exact properties the renderer patch
 * reads off the row.
 *
 * What these tests do NOT prove: that the renderer draws them. That half is
 * `agent-instructions-renderer-field.test.mjs`, which is a statement about a bundle
 * and not about a running window.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agent-instructions-ui-"));
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
  ["host", "extensions", "session", "agent-session.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
  ["host", "extensions", "session", "session-summaries.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
  ["host", "extensions", "transcript", "profile-watch.ts"],
  ["host", "host-gateway-api.ts"],
  ["host", "runner", "system-prompt-assembly.ts"],
]);
const { SandAgentSessionStore } = loaded["agent-session.mjs"];
const { SandSessionMaterialization } = loaded["session-materialization.mjs"];
const { AgentLifecycle } = loaded["agent-lifecycle.mjs"];
const { ProfileWatch } = loaded["profile-watch.mjs"];
const { createHostGatewayApi } = loaded["host-gateway-api.mjs"];
const { minimalAgentSummary, readAgentInstructionsForSummary } = loaded["session-summaries.mjs"];
const {
  AGENT_INSTRUCTIONS_FILENAME,
  AGENT_INSTRUCTIONS_MAX_BYTES,
  readAgentInstructions,
} = loaded["system-prompt-assembly.mjs"];

test.after(() => dispose());

const INSTRUCTION = "Report every finding as one table row: project, verdict, what is missing.";

/**
 * The real store over the real materialization, so the roster is the one `listAgents`
 * answers with rather than a stand-in that counts directories.
 */
function makeStore(rootDir) {
  const store = new SandAgentSessionStore(rootDir);
  store.materialization = new SandSessionMaterialization({
    ctx: {},
    rootDir,
    createBlobWorkerPool: () => ({ connections: new Map(), closeAll: async () => {} }),
    createAgentStore: () => ({ dispose: async () => {} }),
    createMemoryStore: () => ({}),
    resolveUserTimeZone: () => undefined,
    agentExists: (agentId) => store.agentExists(agentId),
    getAgentDir: (agentId) => store.getAgentDir(agentId),
    readActiveAgentId: () => store.readActiveAgentId(),
    report: () => {},
  });
  return store;
}

/** The transcript manager as far as the lifecycle and the gateway are concerned. */
function makeTranscriptManager(rootDir) {
  const store = makeStore(rootDir);
  const calls = [];
  const sessionStore = {
    createSession: (profile, origin, purpose) => store.createSession(profile, origin, purpose),
    getAgentDir: (id) => store.getAgentDir(id),
    agentDirExists: (id) => store.agentDirExists(id),
    releaseSession: (id) => store.releaseSession(id),
    markSessionViewed: async () => {},
    getAgentProfileText: (id) => store.getAgentProfileText(id),
    writeAgentProfileFile: (id, profile) => store.writeAgentProfileFile(id, profile),
    updateAgentProfile: (id, profile) => store.updateAgentProfile(id, profile),
    summarizeOpenSession: async (session) => ({ id: session.id, ...(store.getAgentProfileText(session.id) ?? {}) }),
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
      replaceSession: async (session) => {
        tm.sessions.activeSession = session;
      },
      clearActiveTranscript: () => {},
    },
    roster: {
      emit: () => {},
      emitAgents: async () => {},
      emitAgentUpdate: async (id) => calls.push(["emitAgentUpdate", id]),
      emitProfileChanged: (id) => calls.push(["emitProfileChanged", id]),
      reserveSnapshotStamp: () => "stamp",
      finalizeSummaryForRpc: (summary) => summary,
    },
  };
  return { store, tm, calls, lifecycle: new AgentLifecycle(tm) };
}

/** The gateway surface, with the transcript extension backed by the real lifecycle. */
function makeGateway(lifecycle) {
  const transcript = {
    createAgent: (profile, origin, options) => lifecycle.createAgent(profile, origin, options),
    updateAgent: (agentId, profile) => lifecycle.updateAgent(agentId, profile),
  };
  const analytics = { markActive: () => {}, trackEvent: () => {} };
  return createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "transcript") return transcript;
        if (id === "telemetry") return { analytics, logs: { reportAgentOpen: () => {} } };
        return {};
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

/**
 * `ProfileWatch` over the same folder the store uses. `resolveAgentProfile` reads
 * nothing from the transcript manager; the file watcher needs a clock and the roster
 * emits, so both stand-ins live here rather than in the test bodies.
 */
function makeProfileWatch(store, calls = []) {
  return new ProfileWatch(
    {
      sessionStore: {
        getAgentDir: (id) => store.getAgentDir(id),
        getAgentProfileText: (id) => store.getAgentProfileText(id),
      },
      clock: {
        schedule: (ms, run) => {
          const timer = setTimeout(run, ms);
          return { dispose: () => clearTimeout(timer) };
        },
      },
      sessions: { activeSession: undefined },
      emitTimelineEvent: () => {},
    },
    new EventEmitter(),
    {
      emitAgents: async () => { calls.push(["emitAgents"]); },
      emitAgentUpdate: async (id) => { calls.push(["emitAgentUpdate", id]); },
    },
  );
}

function makeRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), "grok-agent-instructions-ui-root-"));
  const rootDir = path.join(base, "agents");
  mkdirSync(rootDir, { recursive: true });
  return { base, rootDir };
}

const dropRoot = (base) => {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
};

const agentDirOf = (rootDir, agentId) => path.join(rootDir, agentId);
const profilePathOf = (rootDir, agentId) => path.join(rootDir, agentId, "profile.json");
const rowFor = (rows, agentId) => rows.find((row) => row.id === agentId);

// ---------------------------------------------------------------------------

test("an instruction written at creation is on the roster row and in the resolved profile", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;

    // The create answer carried it before this patch existed — that echo is what hid
    // the gap. The claim under test is the SECOND read, the one the renderer makes.
    assert.equal(created.agent.instructions, INSTRUCTION,
      "the create answer no longer carries the instruction, so this test's premise is gone");

    const rows = await store.listAgents();
    const row = rowFor(rows, agentId);
    assert.ok(row != null,
      "the roster does not list an agent that was just created, so nothing downstream can be about its instructions");
    assert.equal(row.instructions, INSTRUCTION,
      "the roster row omits the agent's own brief, so every screen that reads the roster shows an agent with no instructions and no way to tell it is a mojibake of one");
    assert.equal(row.instructionsError, null,
      "a healthy agent reported an instruction read failure, so the error field cannot be used to mean a real failure");

    const single = await store.summarizeAgentById(agentId);
    assert.equal(single.instructions, INSTRUCTION,
      "the single-agent answer dropped the brief, so reopening one agent's dialog shows nothing while the roster shows it");

    const profile = makeProfileWatch(store).resolveAgentProfile({
      dbPath: path.join(agentDirOf(rootDir, agentId), "store.db"),
    });
    assert.equal(profile.instructions, INSTRUCTION,
      "the resolved profile answers a name and a description only, so the one field that decides what an agent IS is unreachable by anything that shows the user");
    assert.equal(profile.instructionsFilePath,
      path.join(agentDirOf(rootDir, agentId), AGENT_INSTRUCTIONS_FILENAME),
      "the resolved profile does not name the file the brief lives in, so a caller cannot point the user at it");

    // The field the renderer patch reads must be this name, not a synonym.
    assert.equal(readAgentInstructions(agentDirOf(rootDir, agentId)), INSTRUCTION,
      "the turn path and the summary path now read different bytes, so the prompt and the screen disagree");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an instruction survives a rename that says nothing about instructions", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;

    // The shape the renderer's own name handler sends: name and description only.
    const renamed = await api.updateAgent({
      id: agentId,
      profile: { name: "Сборщик идей", description: "Собирает идеи" },
    });
    assert.equal(renamed.name, "Сборщик идей",
      "the rename did not land, so this test is not exercising a rename at all");
    assert.equal(renamed.instructions, INSTRUCTION,
      "renaming an agent wiped its brief, so the two fields the dialog edits are not independent");

    const [row] = await store.listAgents();
    assert.equal(row.instructions, INSTRUCTION,
      "the brief survived the update answer but not the roster, so the screen contradicts the answer the save returned");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an instruction survives losing profile.json, because it does not live there", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;
    await store.releaseSession(agentId);

    await rm(profilePathOf(rootDir, agentId), { force: true });
    assert.equal(existsSync(profilePathOf(rootDir, agentId)), false,
      "the test proves nothing unless the profile really is gone from disk");

    const [row] = await store.listAgents();
    assert.equal(row.instructions, INSTRUCTION,
      "losing profile.json took the brief with it, so an agent whose profile was rebuilt came back without the thing that made it that agent");

    const profile = makeProfileWatch(store).resolveAgentProfile({
      dbPath: path.join(agentDirOf(rootDir, agentId), "store.db"),
    });
    assert.equal(profile.instructions, INSTRUCTION,
      "the resolved profile lost the brief while the summary kept it, so the two readers disagree about the same folder");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an instruction survives a restart of the host", async () => {
  const { base, rootDir } = makeRoot();
  const first = makeTranscriptManager(rootDir);
  let store = first.store;
  let agentId;
  try {
    const created = await makeGateway(first.lifecycle).createAgent({
      name: "Сборщик идей",
      description: "Собирает идеи",
      instructions: INSTRUCTION,
    });
    agentId = created.agent.id;
    await store.releaseSession(agentId);
    await store.closeWorkerPool();

    // A brand new store over the same folder, as after `Grok Bot.exe` is restarted.
    // Nothing from the first one is carried, including any read cache.
    store = makeStore(rootDir);
    const [row] = await store.listAgents();
    assert.equal(row.instructions, INSTRUCTION,
      "a restarted host showed the agent with no brief, so every restart silently reverted specialised agents to general ones");

    const profile = makeProfileWatch(store).resolveAgentProfile({
      dbPath: path.join(agentDirOf(rootDir, agentId), "store.db"),
    });
    assert.equal(profile.instructions, INSTRUCTION,
      "the resolved profile came back without the brief after a restart, so the prompt and the summary disagree depending on which one the caller asked");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an instruction written over the ceiling is reported, not shown as an empty box", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;

    // The case the host deliberately refuses: a file hand-edited past the ceiling.
    // `readAgentInstructions` throws so the TURN says so rather than quietly running
    // without instructions. The roster cannot throw — one bad file would take the
    // whole sidebar — so it has to carry the refusal instead of dropping it.
    writeFileSync(
      path.join(agentDirOf(rootDir, agentId), AGENT_INSTRUCTIONS_FILENAME),
      "x".repeat(AGENT_INSTRUCTIONS_MAX_BYTES + 1),
      "utf8",
    );

    const [row] = await store.listAgents();
    assert.equal(row.instructionsError != null, true,
      "an instruction file that cannot be read is reported as an agent with no instructions, which is the exact mojibake this patch exists to avoid");
    assert.equal(/over the \d+-byte limit/.test(row.instructionsError), true,
      "the refusal does not name the reason, so the user is told something is wrong without being told what");
    assert.equal(row.instructions, "",
      "a file that refused to be read still produced text, so the box shows an instruction the host never accepted");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an agent whose only identity is its instruction is not dropped from the roster", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    // No name, no description, no title: the shape `includeBlank: false` filters on.
    // `listAgents` asks for exactly that, so an agent created from a bare brief is
    // on disk, in the cap, and off every list — and the brief it exists for is the
    // one field the filter did not look at.
    const created = await api.createAgent({ instructions: INSTRUCTION });
    const agentId = created.agent.id;
    await store.releaseSession(agentId);

    const rows = await store.listAgents();
    const row = rowFor(rows, agentId);
    assert.ok(row != null,
      "an agent that exists only to hold a brief is filtered off the roster as blank, so the user cannot open the one thing they created");
    assert.equal(row.instructions, INSTRUCTION,
      "the agent is listed but its brief is not on the row, so the row says the agent exists and says nothing about what it is for");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("a cleared instruction is an empty string, and the row says so", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;

    const cleared = await api.updateAgent({ id: agentId, profile: { instructions: "" } });
    assert.equal(cleared.instructions, "",
      "clearing the brief left text behind, so the agent keeps running an order the user deleted");

    const [row] = await store.listAgents();
    assert.equal(row.instructions, "",
      "the roster row still shows a brief that was cleared, so the screen and the stored file disagree");
    assert.equal(row.instructionsError, null,
      "a deliberate clear is reported as a read failure, so the empty box looks like a broken file rather than a cleared field");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("the rendered row carries the exact properties the renderer patch reads", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;
    const [row] = await store.listAgents();

    // The injected renderer component destructures `agent` and reads exactly these.
    // A rename of either on this side renders a permanently empty box with no error,
    // which is why the names are asserted rather than assumed.
    for (const field of ["id", "name", "description", "instructions", "instructionsError", "isGroup"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(row, field),
        true,
        `the roster row has no "${field}" property, so the renderer patch reads undefined for it and cannot say which field is missing`,
      );
    }
    assert.equal(row.isGroup, false,
      "isGroup is not a boolean on the row, so the instructions field renders for a group room that has no brief of its own");
    assert.equal(typeof row.instructions, "string",
      "instructions is not a string, so the field cannot seed its text box");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("the brief is read from the file beside the profile, not from a copy in the store", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const api = makeGateway(lifecycle);
    const created = await api.createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;

    // A hand edit, the way a user edits a text file they can find. It must be
    // visible on the next pass and not only after a restart.
    writeFileSync(path.join(agentDirOf(rootDir, agentId), AGENT_INSTRUCTIONS_FILENAME), "Edited by hand.\n", "utf8");

    const [row] = await store.listAgents();
    assert.equal(row.instructions, "Edited by hand.",
      "the row answers from a cached copy of the brief, so an edit made on disk is invisible until the host restarts");

    const onDisk = readFileSync(path.join(agentDirOf(rootDir, agentId), AGENT_INSTRUCTIONS_FILENAME), "utf8");
    assert.equal(onDisk.trim(), row.instructions,
      "the row and the file on disk have drifted, so the screen shows something the agent was never told");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("the last-resort roster row still carries the brief", async () => {
  // `session-roster.ts` falls back to `minimalAgentSummary` when `buildSummary`
  // cannot answer for an agent. That is the row the user sees when something has
  // already gone wrong, so it is the worst place for the one field to be missing:
  // the agent would appear with a name and no brief, which reads as an agent that
  // has none rather than as a degraded read.
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  try {
    const created = await makeGateway(lifecycle).createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;
    const row = minimalAgentSummary({
      dirName: agentId,
      dbPath: path.join(agentDirOf(rootDir, agentId), "store.db"),
    });
    assert.equal(row.instructions, INSTRUCTION,
      "the degraded roster row drops the brief, so a user looking at a failing agent is shown one with no instructions and no way to tell the read failed");
    assert.equal(row.instructionsError, null,
      "the degraded roster row reports a read failure for a healthy agent, so the error field cannot be trusted to mean one");

    // And the pre-read form the funnel uses, so the two tiers cannot drift apart.
    const preRead = minimalAgentSummary({
      dirName: agentId,
      dbPath: path.join(agentDirOf(rootDir, agentId), "store.db"),
      instructions: readAgentInstructionsForSummary(agentDirOf(rootDir, agentId)),
    });
    assert.equal(preRead.instructions, row.instructions,
      "the funnel's pre-read form and the reading form disagree about the same folder, so the degraded row depends on which one the caller remembered to use");
  } finally {
    await store.closeWorkerPool();
    dropRoot(base);
  }
});

test("an instruction edited beside the running agent is picked up without a restart", async () => {
  const { base, rootDir } = makeRoot();
  const { store, lifecycle } = makeTranscriptManager(rootDir);
  const calls = [];
  let watch = null;
  try {
    const created = await makeGateway(lifecycle).createAgent({
      name: "Аудитор проектов",
      description: "Проверяет чужие проекты",
      instructions: INSTRUCTION,
    });
    const agentId = created.agent.id;
    await store.releaseSession(agentId);

    watch = makeProfileWatch(store, calls);
    watch.watchSessionProfile({
      id: agentId,
      dbPath: path.join(agentDirOf(rootDir, agentId), "store.db"),
    });
    calls.length = 0;

    // The watcher filters on the file names it cares about. `instructions.md` was not
    // one of them, so a brief edited beside a running agent stayed invisible: the
    // roster never re-read, the dialog never re-rendered, and the only way to see
    // the edit was to close the app and start it again.
    writeFileSync(path.join(agentDirOf(rootDir, agentId), AGENT_INSTRUCTIONS_FILENAME), "Edited beside the agent.\n", "utf8");

    const budgetMs = 5000;
    const deadline = Date.now() + budgetMs;
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    watch.stopWatchingProfile();

    assert.equal(calls.some((call) => call[0] === "emitAgentUpdate" && call[1] === agentId), true,
      `editing the instruction file beside a running agent emitted nothing in ${budgetMs} ms, so the screen keeps showing the previous brief until the app is restarted`);
  } finally {
    watch?.stopWatchingProfile();
    await store.closeWorkerPool();
    dropRoot(base);
  }
});
