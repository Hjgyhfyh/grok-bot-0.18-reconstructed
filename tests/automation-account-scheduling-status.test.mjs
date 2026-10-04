import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * A routine that could never fire looked exactly like a routine that was
 * configured and waiting.
 *
 * There is no local scheduler in this build: `nextRunAt` has two readers and both
 * of them only display it. A `@every 30s` routine was measured running for
 * fourteen and a half minutes with zero fires and not one `"trigger":"schedule"`
 * row in `runs.json`, because the only thing that actually wakes a routine is the
 * Cursor account scheduler — and that sync stops at its first line when there is
 * no credential. Scheduling evidence is only published from inside `reconcile`,
 * so with no credential every evidence lookup read "unknown", every listener
 * looked server-owned, `source.start()` was never called, and the relay status
 * stayed `{state:"idle"}` forever.
 *
 * The status a user sees must therefore say `error` with the reason. The tests
 * below pin both halves of that: the sync's own status, and the decision to let
 * a listener try locally when there is no account, which is what lets the relay
 * report its own auth failure instead of the whole path looking idle. They also
 * pin the case that must not change: with a working account, a routine that is
 * already enabled remotely is still not scheduled locally, so nothing fires
 * twice.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-routine-scheduling-"));
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
  for (const [name, file] of names)
    loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "automations", "sand-automation-cloud-sync.ts"],
  ["host", "automations", "automation-id.ts"],
]);
const { SandAutomationCloudSync } = loaded["sand-automation-cloud-sync.mjs"];
const { stableAutomationId } = loaded["automation-id.mjs"];

test.after(() => dispose());

const AGENT_ID = "agent-1";
const CRON_ROUTINE = {
  id: "morning-digest",
  name: "Morning digest",
  prompt: "Summarise overnight alerts.",
  isEnabled: true,
  trigger: { type: "cron", schedule: "15 8 * * 1-5" },
};
const SLACK_ROUTINE = {
  id: "deploy-watch",
  name: "Deploy watch",
  prompt: "Say what shipped.",
  isEnabled: true,
  trigger: { type: "slack", channel: "#eng", match: { kind: "mention" } },
};

/** A remote account that keeps whatever it is told, so a read-back converges. */
function createFakeClient() {
  const remote = new Map();
  return {
    remote,
    async listSandAutomations() {
      return { workflows: [...remote.values()].map((workflow) => ({ workflow })) };
    },
    async createSandAutomation(request) {
      remote.set(request.sandAutomationId, {
        automationId: request.sandAutomationId,
        description: request.description,
        enabled: request.enabled === true,
      });
      return {};
    },
    async updateSandAutomation(request) {
      remote.set(request.automationId, {
        automationId: request.automationId,
        description: request.description,
        enabled: request.enabled === true,
      });
      return {};
    },
    async deleteSandAutomation(request) {
      remote.delete(request.automationId);
      return {};
    },
  };
}

function createSync({ hasCredential, routines }) {
  const client = createFakeClient();
  const diagnostics = [];
  const failures = [];
  const sync = new SandAutomationCloudSync({
    client,
    hasCredential,
    listAgentIds: async () => [AGENT_ID],
    listAutomations: async () => routines.map((automation) => ({ agentId: AGENT_ID, automation })),
    reportDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    onFailure: (failure) => { failures.push(failure); },
    onRecovery: () => {},
    onSchedulingAuthorityChanged: () => {},
  });
  return { sync, client, diagnostics, failures };
}

test("without an account connection, saved routines are an error and not an idle panel", async () => {
  const { sync, diagnostics } = createSync({ hasCredential: () => false, routines: [CRON_ROUTINE] });

  await sync.reconcileNow();
  const status = sync.getStatus();

  assert.equal(
    status.state,
    "error",
    "a saved routine that nothing can fire must not be reported as an idle scheduler",
  );
  assert.match(
    status.detail,
    /Cursor account/,
    "the reason has to name the thing that is missing, or the user cannot act on it",
  );
  assert.match(
    status.detail,
    /nothing can fire|no .*routine runs/i,
    "the detail has to say the routines will not run, not merely that something is wrong",
  );
  assert.ok(
    diagnostics.some((entry) => entry.operation === "credential_missing"),
    "the gap was never recorded anywhere, so nothing outside this object could react to it",
  );
});

test("a connection check that finds nothing saved is not an error", async () => {
  const { sync } = createSync({ hasCredential: () => false, routines: [] });

  await sync.reconcileNow();

  assert.equal(
    sync.getStatus().state,
    "idle",
    "an agent with no routines has nothing to wait for, and crying error there trains the user to ignore it",
  );
});

test("a working account is not reported as an error", async () => {
  const { sync, client } = createSync({ hasCredential: () => true, routines: [CRON_ROUTINE] });

  await sync.reconcileNow();

  assert.equal(sync.getStatus().state, "idle");
  assert.equal(
    client.remote.size,
    1,
    "the routine was never handed to the account scheduler, so nothing could ever fire it",
  );
});

test("a listener tries locally when there is no account, so its failure can be reported", () => {
  const { sync } = createSync({ hasCredential: () => false, routines: [SLACK_ROUTINE] });

  assert.equal(
    sync.shouldScheduleLocally({ agentId: AGENT_ID, automation: SLACK_ROUTINE }),
    true,
    "with no credential no evidence is ever published, so the listener was treated as owned by the account, never started, and left the panel reading idle",
  );
});

test("a routine the account already owns is still not run locally", async () => {
  const { sync, client } = createSync({ hasCredential: () => true, routines: [SLACK_ROUTINE] });

  await sync.reconcileNow();

  assert.equal(
    client.remote.size,
    1,
    "the listener routine never reached the account, so this sync proved nothing about it",
  );
  assert.equal(
    sync.shouldScheduleLocally({ agentId: AGENT_ID, automation: SLACK_ROUTINE }),
    false,
    "a routine enabled on the account must not also be watched locally, or it fires twice",
  );
  assert.equal(
    stableAutomationId({ agentId: AGENT_ID, localId: SLACK_ROUTINE.id }),
    [...client.remote.keys()][0],
    "the local id has to survive the round trip, or evidence can never match a routine",
  );
});

test("a paused routine falls back to the local listener", async () => {
  const paused = { ...SLACK_ROUTINE, isEnabled: false };
  const { sync } = createSync({ hasCredential: () => true, routines: [paused] });

  await sync.reconcileNow();

  assert.equal(
    sync.shouldScheduleLocally({ agentId: AGENT_ID, automation: paused }),
    true,
    "a routine the account is not running has to be watched locally or its events go nowhere",
  );
});