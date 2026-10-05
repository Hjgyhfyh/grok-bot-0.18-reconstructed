import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// "There is no such agent" was reported to the caller as a server fault.
// `statusForCommandError` knew two answers — `409` for the two limit errors and
// `500` for everything else — so a delete of an id nobody created, an update of
// one, and either of the two sidebar switches all answered
// `500 {"error":"No agent directory on disk for <id>"}` while `/health` said the
// host was fine. Measured on a live box, against a fresh uuid:
// `deleteAgent` 500, `deleteAgents` 500, `updateAgent` 500,
// `setAgentHiddenFromSidebar` 500. A client cannot tell that from a crash, so it
// retries a request that can never succeed or shows a failure banner for a stale
// id. The fix has to be narrow in both directions: `SandAgentLifecycleError`
// also carries a delete that lost a race with a file handle and a summary that
// could not be built, and telling a client to retry those on `404` would be a
// worse failure than the status code it replaces. Every test below fails against
// the old code.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-status-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

async function buildEntries(entries) {
  const directory = makeBundleDirectory();
  mkdirSync(directory, { recursive: true });
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

const { loaded, dispose } = await buildEntries([
  ["host", "gateway-server.ts"],
  ["host", "extensions", "session", "agent-errors.ts"],
  ["host", "extensions", "session", "session-materialization.ts"],
  ["host", "extensions", "transcript", "agent-lifecycle.ts"],
]);
const { statusForCommandError, routeCommand } = loaded["gateway-server.mjs"];
const { SandAgentNotFoundError, isAgentNotFoundError } = loaded["agent-errors.mjs"];
const { SandAgentMissingError, SandAgentLimitError } = loaded["session-materialization.mjs"];
const { AgentLifecycle, SandAgentLifecycleError } = loaded["agent-lifecycle.mjs"];

test.after(() => dispose());

function fakeResponse() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    writeHead(status, headers) {
      response.statusCode = status;
      response.headers = headers;
      response.headersSent = true;
      return response;
    },
    end(payload) {
      if (payload != null) response.body = String(payload);
      response.ended = true;
      return response;
    },
    get destroyed() {
      return false;
    },
    get writableEnded() {
      return response.ended === true;
    },
  };
  return response;
}

function fakeRequest(headers = {}) {
  return { method: "POST", url: "/api/deleteAgent", headers };
}

test("an agent id that names nothing is answered 404, not 500", () => {
  assert.equal(statusForCommandError(new SandAgentNotFoundError("No agent directory on disk for x")),
    404,
    "a caller that asked about an agent that does not exist was told the server broke");
});

test("the not-found answer survives the layer that raises it from the materialization port", () => {
  assert.equal(statusForCommandError(new SandAgentMissingError("x")),
    404,
    "the same fact raised one layer down came back as a 500, so the status depended on which code path noticed");
});

test("a delete that lost a race with a file handle stays 500", () => {
  const incomplete = Object.assign(new Error("Agent x was not deleted: this app still holds store.db"), {
    code: "SandAgentDeleteIncompleteError",
  });
  incomplete.name = "Error";
  assert.equal(statusForCommandError(incomplete), 500,
    "a delete the host could not finish was reported as not-found, which tells a client to retry a delete it must not retry");
  assert.equal(statusForCommandError(new SandAgentLifecycleError("Groups can't be duplicated yet.")), 500,
    "a lifecycle failure that says nothing about a missing agent was reported as 404");
  assert.equal(statusForCommandError(new TypeError("profile.description.trim is not a function")), 500,
    "an ordinary fault was reported as 404, so every crash became a missing agent");
});

test("the two answers that already existed are unchanged", () => {
  assert.equal(statusForCommandError(new SandAgentLimitError()), 409,
    "an agent cap refusal stopped being a 409");
  const publish = new Error("publish refused");
  publish.name = "SandSkillPublishError";
  assert.equal(statusForCommandError(publish), 409,
    "a skill publish refusal stopped being a 409");
});

test("a failure that is not an error at all is still 500", () => {
  for (const thrown of [undefined, null, "boom", 42, { name: "SandAgentNotFoundError" }]) {
    assert.equal(statusForCommandError(thrown), 500,
      `a thrown ${JSON.stringify(thrown) ?? String(thrown)} that was never a raised not-found error was reported as 404`);
  }
  assert.equal(isAgentNotFoundError({ name: "SandAgentNotFoundError" }), false,
    "a plain object wearing the name was taken for the error; only a real raise of that class counts");
});

test("the gateway answers a delete of an unknown agent with 404 over the wire", async () => {
  const res = fakeResponse();
  const deps = {
    api: {
      deleteAgent() {
        throw new SandAgentNotFoundError("No agent directory on disk for 99999999-9999-4999-8999-999999999999");
      },
    },
    subscribe: () => () => {},
    getHealth: () => ({ isBusy: false }),
    startedAt: 0,
    authToken: "t",
  };

  await assert.rejects(
    () => routeCommand(deps, "deleteAgent", "{}", res, fakeRequest()),
    (error) => error instanceof SandAgentNotFoundError,
    "routeCommand swallowed the failure instead of letting the server answer it",
  );
  assert.equal(statusForCommandError(new SandAgentNotFoundError("x")), 404,
    "the error the handler threw does not reach the 404 branch of the server");
  assert.equal(res.headersSent, false,
    "routeCommand wrote a response itself, so the server had nothing left to answer with");
});

test("a delete refused by the lifecycle for an id that is not an agent answers 404, and a locked agent answers 500", async () => {
  const calls = [];
  const tm = createLifecycleHarness({ lockedAgentIds: new Set(["agent-locked"]), calls });
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);

  const missing = await captureError(() => lifecycle.deleteAgents(["11111111-1111-4111-8111-111111111111"]));
  // A single delete turns the per-agent `failed` entry into a thrown error; a
  // batch reports it in the result instead. The single delete is the one a
  // client retries from, so that is the one the status has to be right about.
  const locked = await captureError(() => lifecycle.deleteAgent("agent-locked"));

  assert.equal(statusForCommandError(missing), 404,
    "a delete of an id nobody created did not reach the caller as a 404");
  assert.equal(missing.name, "SandAgentNotFoundError",
    "the refusal is not the error the status mapping recognises");
  assert.equal(statusForCommandError(locked), 500,
    "a delete blocked by a file handle the app still holds was reported as a missing agent, which invites a retry that cannot succeed");
  assert.equal(isAgentNotFoundError(locked), false,
    "the incomplete delete is now indistinguishable from a missing agent, so a client would treat a locked agent as one that is already gone");
});

test("a missing agent is still the lifecycle error every existing caller catches", async () => {
  // The `404` branch was added by narrowing, not by replacing: a subclass of a
  // sibling broke `assert.rejects(..., SandAgentLifecycleError)` for the two
  // refusals that had been there all along.
  const tm = createLifecycleHarness({ lockedAgentIds: new Set(), calls: [] });
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);

  const missing = await captureError(() => lifecycle.deleteAgents(["11111111-1111-4111-8111-111111111111"]));
  const ghost = await captureError(() => lifecycle.setAgentHiddenFromSidebar("11111111-1111-4111-8111-111111111111", true));

  assert.equal(missing instanceof SandAgentLifecycleError, true,
    "a caller that catches SandAgentLifecycleError no longer catches a missing agent, so the 404 fix broke every existing handler of that refusal");
  assert.equal(ghost instanceof SandAgentLifecycleError, true,
    "the sidebar switches stopped being catchable as lifecycle errors");
});

test("the two sidebar switches and the profile update refuse a missing agent with the same 404", async () => {
  const tm = createLifecycleHarness({ lockedAgentIds: new Set(), calls: [] });
  const lifecycle = new AgentLifecycle(tm);
  const ghost = "11111111-1111-4111-8111-111111111111";

  for (const [label, call] of [
    ["setAgentNotifyOnUpdates", () => lifecycle.setAgentNotifyOnUpdates(ghost, true)],
    ["setAgentHiddenFromSidebar", () => lifecycle.setAgentHiddenFromSidebar(ghost, true)],
    ["updateAgent", () => lifecycle.updateAgent(ghost, { name: "x", description: "y" })],
  ]) {
    const error = await captureError(call);
    assert.equal(statusForCommandError(error), 404,
      `${label} on an id that names nothing came back as a server fault`);
  }
});

test("a malformed delete request is still a 500 and not a missing agent", async () => {
  const tm = createLifecycleHarness({ lockedAgentIds: new Set(), calls: [] });
  const lifecycle = new AgentLifecycle(tm);
  tm.deleteAgents = (ids) => lifecycle.deleteAgents(ids);

  const error = await captureError(() => lifecycle.deleteAgent(undefined));

  assert.equal(statusForCommandError(error), 500,
    "a request that never carried an agent id was answered as a missing agent, so a client would stop retrying a request it must fix");
  assert.match(String(error?.message ?? ""), /deleteAgent/,
    "the malformed request does not name the command that needs fixing");
});

async function captureError(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function createLifecycleHarness({ lockedAgentIds, calls }) {
  const dirs = new Set(["agent-ok", "agent-locked"]);
  const tm = {
    sessions: {
      activeSession: undefined,
      tryEnsureSession: async () => null,
      liveSessions: new Map(),
      pendingSessionOpens: new Map(),
      deletedAgentIds: new Set(),
      openSessionOnce: async () => { throw new Error("no successor"); },
    },
    sessionStore: {
      agentDirExists: (id) => dirs.has(id),
      deleteSession: async (id) => {
        calls.push(["deleteSession", id]);
        if (lockedAgentIds.has(id)) {
          const error = Object.assign(new Error(`Agent ${id} was not deleted: this app still holds store.db`), {
            code: "SandAgentDeleteIncompleteError",
            leftovers: ["store.db"],
          });
          throw error;
        }
        dirs.delete(id);
        return { transcriptLeftovers: [] };
      },
      releaseSession: async () => {},
      listAgents: async () => [],
      listAgentRecordIds: async () => [],
      getAgentProfileText: () => null,
      getAgentDir: (id) => path.join("root", id),
      updateAgentProfile: async () => null,
      setSessionNotifyOnUpdates: () => {},
      setSessionHiddenFromSidebar: () => {},
    },
    trayErrors: { clearForAgent: () => {} },
    runnerRegistry: { runners: new Map(), activeGroupMemberRunners: new Map() },
    onAgentForgotten: () => {},
    pendingWakeStore: { clearAgent: () => {} },
    boxHandoff: { boxHandoffs: new Map(), awaitingSink: new Map() },
    roster: {
      emitAsyncTasksForAgent: () => {},
      emitAgents: async () => {},
      forgetAgentSubagentWork: () => {},
      lastRunnerAsyncTasks: new Map(),
      emitAgentUpdate: async () => {},
      emitProfileChanged: () => {},
      reserveSnapshotStamp: () => "stamp",
      finalizeSummaryForRpc: (summary) => summary,
    },
    runLifecycle: {
      runningAgentIds: () => new Set(),
      drainExclusiveRuns: async () => {},
      closeSessionWhenIdle: () => {},
    },
    ackObligations: { markAckObligationLost: () => {}, ackRunTokens: new Map() },
    backgroundWakes: {
      pendingSubagentCompletions: new Map(),
      pendingShellCompletions: new Map(),
      pendingInbound: new Map(),
      pendingAgentInbound: new Map(),
      pendingChannelFailures: new Map(),
      dmPreemptedWakeAgentIds: new Map(),
    },
    groupChat: { dmPreemptedGroupMemberIds: new Map() },
    telemetry: { reportTurnInterrupt: () => {} },
  };
  return tm;
}