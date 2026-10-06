import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// Two ways a write about an agent says nothing useful and answers 200 or 500.
//
// 1. `createAgent` reads the profile out of either shape — `{profile:{…}}` or the
//    flat root fields — and documents both. `updateAgent`, the rename, reads
//    `args.profile` and nothing else, so the flat shape is dropped on the floor.
//    Measured on a live box, on the same agent one call apart:
//
//      POST /api/updateAgent {"id":"<id>","profile":{"name":"QA-Flat-Renamed"}}  200 name "QA-Flat-Renamed"
//      POST /api/updateAgent {"id":"<id>","name":"QA-Flat-Name-Only"}             200 name "QA-Flat-Renamed"
//      POST /api/listAgents                                                       name "QA-Flat-Renamed"
//
//    `200` with the unchanged record is the worst of the three answers: a caller
//    cannot tell a rename that happened from a rename that was thrown away.
//    `createAgent` read the flat shape correctly, so the pair disagrees about a
//    request shape on the same command family, on the same surface.
//
//    Accepting the flat shape here too was the first fix and it was the wrong
//    one: it leaves one wire shape meaning two things across the family, and the
//    next field added to one form and not the other drifts with nothing to catch
//    it. The host now *refuses* the flat body with `400` and names the shape it
//    takes, so the caller can fix the call. `SandGatewayRequestError` is the
//    class the server already answers `400`: the request arrived and the host is
//    declining it — the agent is there, the body is wrong. Not `404` (which would
//    say the id names nothing) and not `500` (which would say the host broke).
//
//    The one caller in this repository that sent the flat shape is fixed rather
//    than broken: `avatar-editor/controller.ts` sent `{id, avatarShape,
//    avatarColor}` at the root, so picking a character was a no-op behind a
//    saved-looking dialog. It now sends the nested shape, and a test walks the
//    real controller to prove it.
//
// 2. `setAgentNotifyOnUpdates` and `setAgentHiddenFromSidebar` refuse an id that
//    is not on disk, and `updateAgent` refuses it too. `setAgentUnread` and
//    `setAgentAvatarBytes` do not, so a stale sidebar action reaches the store,
//    which cannot open a database that is not there, and the answer is the text
//    of a private helper plus the absolute sandbox path:
//
//      POST /api/setAgentUnread      {"id":"<deleted>","isUnread":true}  500
//      POST /api/setAgentAvatarBytes {"id":"<deleted>","pngBase64":"…"}   500
//        "Agent directory C:\Users\…\GrokBotLocalBox\agents\<id> does not
//         exist; call ensureAgentDbDirectory(…\store.db) before opening a store
//         for a new agent"
//
//    `500` means the server broke. `updateAgent` answers `404` for the same id in
//    the same state. The path is the user's own, so this is not a disclosure to
//    anyone else — it is a sentence that tells the person reading it to go and
//    call a function they cannot call, and it blames the server for a stale id
//    that will stay stale.
//
// Both answers are the host's to get right, and neither one writes anything: the
// directory is not rebuilt by either command, which the tests below also pin.
// Every test fails against the old code.

import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeBundleDirectory() {
  return path.join(os.tmpdir(), `grok-write-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

/**
 * One bundle for the host half and one for the renderer half.
 *
 * `statusForCommandError` decides `400` with `error instanceof
 * SandGatewayRequestError`, so the class has to be the same class the API raises
 * — one bundle, or the refusal arrives as a `500` and this file measures nothing.
 * The avatar editor is a separate module tree entirely, so it gets its own.
 */
async function buildEntries(entries) {
  const directory = makeBundleDirectory();
  mkdirSync(directory, { recursive: true });
  const loaded = {};
  const names = [];
  for (const [name, sources] of entries) {
    const outfile = path.join(directory, `${name}.mjs`);
    names.push([name, outfile]);
    await build({
      stdin: {
        contents: sources.map((source) => `export * from "${source}";`).join("\n"),
        resolveDir: repoRoot,
        sourcefile: `${name}-entry.ts`,
        loader: "ts",
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  for (const [name, file] of names)
    loaded[name] = await import(pathToFileURL(file).href + "?" + Date.now());
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await buildEntries([
  ["host", [
    "./source/host/gateway-server.ts",
    "./source/host/extensions/session/agent-errors.ts",
    "./source/host/extensions/transcript/agent-lifecycle.ts",
    "./source/host/host-gateway-api.ts",
  ]],
  ["editor", ["./frontend/src/recovered/features/agent-info/avatar-editor/controller.ts"]],
]);
const host = loaded["host"];
const { statusForCommandError } = host;
const { isAgentNotFoundError } = host;
const { AgentLifecycle } = host;
const { createHostGatewayApi } = host;
const { createAvatarEditorController } = loaded["editor"];

test.after(() => dispose());

const LIVE = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";

/** One agent on disk, the writes the lifecycle performs, and the gateway over it. */
function makeWorld() {
  const profile = { name: "Original", description: "Original description" };
  const writes = [];
  const dirs = new Set([LIVE]);
  const tm = {
    sessions: { activeSession: undefined },
    sessionStore: {
      agentDirExists: (id) => dirs.has(id),
      getAgentProfileText: () => ({ ...profile }),
      getAgentDir: (id) => path.join("root", id),
      updateAgentProfile: async (id, patch) => {
        writes.push(["updateAgentProfile", id, patch]);
        Object.assign(profile, patch);
        return { id, ...profile };
      },
      writeAgentProfileFile: (id, patch) => {
        writes.push(["writeAgentProfileFile", id, patch]);
        Object.assign(profile, patch);
      },
      summarizeOpenSession: async () => ({ id: LIVE, ...profile }),
      setSessionUnread: async (id, unread) => writes.push(["setSessionUnread", id, unread]),
      setAgentAvatarBytesById: async (id) => writes.push(["setAgentAvatarBytesById", id]),
    },
    roster: {
      emitAgentUpdate: async () => {},
      emitProfileChanged: () => {},
      reserveSnapshotStamp: () => "stamp",
      finalizeSummaryForRpc: (summary) => summary,
    },
  };
  const lifecycle = new AgentLifecycle(tm);
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "transcript") return {
          updateAgent: (agentId, profilePatch) => lifecycle.updateAgent(agentId, profilePatch),
          setAgentUnread: (agentId, unread, at) => lifecycle.setAgentUnread(agentId, unread, at),
          setAgentAvatarBytes: (agentId, bytes) => lifecycle.setAgentAvatarBytes(agentId, bytes),
          createAgent: async (fields) => {
            writes.push(["createAgent", fields]);
            return { agent: { id: LIVE, name: fields?.name }, transcript: [] };
          },
        };
        if (id === "telemetry") return { analytics: { markActive: () => {}, trackEvent: () => {} }, logs: {} };
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
  return { api, lifecycle, writes, profile, dirs };
}

async function captureError(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

test("a rename sent in the flat shape is refused by name, not swallowed", async () => {
  const { api, profile } = makeWorld();

  const error = await captureError(() => api.updateAgent({ id: LIVE, name: "Flat Rename" }));

  assert.equal(statusForCommandError(error), 400,
    "the flat body answered 200 and changed nothing, so a caller cannot tell a rename that happened from one that was thrown away");
  assert.equal(error?.name, "SandGatewayRequestError",
    "the refusal is not the class the server answers 400, so it arrives as a server fault");
  assert.match(String(error?.message ?? ""), /"profile"/,
    "the refusal does not name the shape it wants, so the caller has to guess where the name was supposed to go");
  assert.match(String(error?.message ?? ""), /"name"/,
    "the refusal names the command and not the field it choked on, so a caller holding six fields has to re-read the source to find which one was wrong");
  assert.equal(profile.name, "Original",
    "the refused request still wrote the name, so refusing it only moved the silence");
});

test("the status of a refused body is decided by the body alone, and a well-formed body about a missing agent is still 404", async () => {
  const { api } = makeWorld();

  // The body is checked before the id is looked up, the same order every other
  // gateway field check already uses — `requirePath(args, "id", …)` runs first.
  // So the same malformed body is the same `400` whether the agent is there or
  // not, which is what lets a caller fix its call without first finding out
  // whether it also got the id right.
  const flatOnLive = await captureError(() => api.updateAgent({ id: LIVE, name: "Flat Rename" }));
  const flatOnGone = await captureError(() => api.updateAgent({ id: GONE, name: "Flat Rename" }));
  const wellFormedOnGone = await captureError(() => api.updateAgent({ id: GONE, profile: { name: "x" } }));

  assert.equal(statusForCommandError(flatOnLive), 400,
    "a flat body about an agent that exists is a bad request, not a host fault");
  assert.equal(statusForCommandError(flatOnGone), 400,
    "the same malformed body answers a different status once the id happens to be stale, so the caller cannot tell what to fix");
  assert.equal(statusForCommandError(wellFormedOnGone), 404,
    "a well-formed body about an id that names nothing stopped answering 404, so a client retries an id that will never come back");
});

test("a profile that is not an object is refused with the field name, not passed down as [object Object]", async () => {
  const { api, profile, writes } = makeWorld();

  for (const [label, value] of [["an array", []], ["a string", "name"], ["null", null]]) {
    const error = await captureError(() => api.updateAgent({ id: LIVE, profile: value }));
    assert.equal(statusForCommandError(error), 400,
      `a profile that is ${label} was answered ${statusForCommandError(error)}, so a malformed body reaches the store`);
    assert.match(String(error?.message ?? ""), /"profile"/,
      `the refusal for ${label} does not name the field to fix`);
  }
  assert.equal(profile.name, "Original",
    "a malformed profile still reached the profile writer");
  assert.deepEqual(writes, [], "a malformed profile still reached the store");
});

test("the nested shape still renames, and a mixed request is refused rather than half-read", async () => {
  const { api, profile } = makeWorld();

  await api.updateAgent({ id: LIVE, profile: { name: "Nested Rename" } });
  assert.equal(profile.name, "Nested Rename",
    "the shape the renderer sends stopped working, so the fix traded one broken shape for another");

  await api.updateAgent({ id: LIVE, profile: { title: "Nested title" } });
  assert.equal(profile.title, "Nested title",
    "a field carried by the nested shape was dropped, so a title edit is the same silent no-op under a new name");
  assert.equal(profile.name, "Nested Rename",
    "an update that said nothing about the name blanked it, so the fields are not independent");
});

test("a request that carries neither shape still leaves the agent alone and answers its id", async () => {
  const { api, profile } = makeWorld();

  const unchanged = await api.updateAgent({ id: LIVE });

  assert.equal(profile.name, "Original",
    "a request with no profile at all overwrote the name, so the fallback wrote a blank instead of leaving the field alone");
  assert.equal(statusForCommandError(null), 500, "a successful call produced an error the mapping treats as a fault");
  assert.equal(unchanged?.id, LIVE, "the answer stopped naming the agent, so a caller cannot tell which record it is about");
});

test("createAgent still reads both shapes, so refusing one on updateAgent breaks no create", async () => {
  const { api } = makeWorld();

  const flat = await api.createAgent({ name: "Flat Create" });
  const nested = await api.createAgent({ profile: { name: "Nested Create" } });

  assert.equal(flat.agent.name, "Flat Create",
    "a create in the flat shape stopped working, so the refusal on updateAgent was applied to the wrong command");
  assert.equal(nested.agent.name, "Nested Create",
    "a create in the nested shape stopped working");
});

test("a stale unread toggle on a deleted agent is 404, not a 500 carrying the sandbox path", async () => {
  const { api, writes } = makeWorld();

  const error = await captureError(() => api.setAgentUnread({ id: GONE, isUnread: true }));

  assert.equal(statusForCommandError(error), 404,
    "a stale id answered 500, so a client shows a failure banner and retries an id that will never come back");
  assert.equal(isAgentNotFoundError(error), true,
    "the refusal is not the error the 404 branch recognises");
  assert.doesNotMatch(String(error?.message ?? ""), /[A-Za-z]:\\|ensureAgentDbDirectory/,
    "the refusal still carries a filesystem path or the name of a private helper, which is what the store raises when it is reached with an id it has never heard of");
  assert.equal(writes.some(([step]) => step === "setSessionUnread"), false,
    "the write reached the store for an agent that does not exist");
});

test("a stale avatar write on a deleted agent is 404, for the same reason", async () => {
  const { api, writes } = makeWorld();

  const error = await captureError(() => api.setAgentAvatarBytes({ id: GONE, pngBase64: "iVBORw0KGgo=" }));

  assert.equal(statusForCommandError(error), 404,
    "the avatar write answers 500 for an id that names nothing while its two siblings answer 404");
  assert.equal(writes.some(([step]) => step === "setAgentAvatarBytesById"), false,
    "the avatar write reached the store for an agent that does not exist");
});

test("both switches still work for an agent that is on disk", async () => {
  const { api, writes } = makeWorld();

  await api.setAgentUnread({ id: LIVE, isUnread: true });
  await api.setAgentAvatarBytes({ id: LIVE, pngBase64: "iVBORw0KGgo=" });

  assert.deepEqual(writes, [
    ["setSessionUnread", LIVE, true],
    ["setAgentAvatarBytesById", LIVE],
  ], "the refusal was widened past the ids that are actually on disk");
});

test("the avatar editor, which is the one caller that sent the flat shape, still saves a character", async () => {
  // The refusal above is only the right answer if the caller that used the flat
  // shape is fixed. This drives the real controller — the one that picked a
  // character, sent `{id, avatarShape, avatarColor}` at the root, and got `200`
  // with nothing written — against the real gateway surface.
  const { api, profile, writes } = makeWorld();
  const refusals = [];
  const controller = createAvatarEditorController({
    agent: { id: LIVE, isGroup: false, avatarDataUrl: null, avatarShape: null, avatarColor: null },
    desktop: { pickAvatarFile: async () => null, generateAgentAvatarImage: async () => null },
    roster: {
      setAgentAvatarBytes: async () => {},
      // The gateway itself, so a shape this controller gets wrong is refused by
      // the host and not by a hand-written stub that agrees with it.
      updateAgent: async (args) => {
        try {
          return await api.updateAgent(args);
        } catch (error) {
          refusals.push(error);
          throw error;
        }
      },
    },
  });

  const staged = await controller.stageCharacter({ avatarShape: "round", avatarColor: "#ff0000" });

  assert.equal(staged, true,
    "picking a character now fails, so refusing the flat shape broke the only caller that used it instead of fixing it");
  assert.deepEqual(refusals, [],
    "the controller still sends a body the host refuses, so the character was saved by nothing at all");
  assert.deepEqual(writes.find(([step]) => step === "updateAgentProfile"), ["updateAgentProfile", LIVE, {
    name: "Original",
    description: "Original description",
    avatarShape: "round",
    avatarColor: "#ff0000",
  }], "the shape and the colour never reached the profile writer, which is the defect the refusal replaced");
  assert.equal(profile.avatarShape, "round",
    "the stored record does not carry the shape, so the editor showed a saved dialog for an edit that changed nothing");
  controller.dispose();
});
