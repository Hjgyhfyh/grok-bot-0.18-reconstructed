import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The routines prompt recommended a path that cannot work locally.
 *
 * Line 52 told the agent that when a listener is unavailable, "create a cron-only
 * scheduled routine instead of a listener" — and it said that with no
 * qualification at all, right next to a line that was honest about listeners
 * needing the user's Cursor account. Nothing in the prompt said the same about
 * schedules, so the agent was actively steering users toward a schedule that never
 * fires: there is no local timer in this build, `nextRunAt` is read in two places
 * and both of them only display it, and the only thing that wakes a routine is
 * the Cursor account scheduler.
 *
 * This test pins the honesty: every recommendation that substitutes a cron
 * schedule for a listener now carries the same account requirement that the
 * listener line already carried, and the prompt says outright that Grok Bot
 * cannot wake a routine by itself. A prompt that quietly goes back to promising
 * a local schedule fails here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-routine-prompt-"));
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

const { loaded, dispose } = await bundle([["host", "automations", "automation.ts"]]);
const {
  AUTOMATION_PROMPT_GUIDANCE_VERSION,
  renderAutomationsSystemPrompt,
} = loaded["automation.mjs"];

test.after(() => dispose());

const LOCATION = path.join(os.tmpdir(), "grok-routine-prompt-agents", "routines");
const prompt = renderAutomationsSystemPrompt([], LOCATION, "Europe/Moscow");

test("the prompt says a time-based schedule is the account's to run", () => {
  assert.match(
    prompt,
    /Time-based schedules are owned by that same Cursor account connection/,
    "a schedule is run by the Cursor account scheduler, and the prompt recommended one as the answer for a listener that could not connect",
  );
  assert.match(
    prompt,
    /no local timer that can wake one by itself/,
    "Grok Bot cannot wake a routine on its own, so a promise of an on-time wake has to name who does wake it",
  );
});

test("no recommendation substitutes a cron schedule for a listener without saying so", () => {
  const substitutions = prompt
    .split("\n")
    .filter(
      (line) =>
        line.includes("instead of a listener") || line.includes("cron routine instead"),
    );

  assert.ok(
    substitutions.length >= 3,
    "the deadline-enforcement, self-expiring and per-pull-request recommendations all substitute a schedule for a listener and must each carry the condition",
  );
  for (const line of substitutions)
    assert.match(
      line,
      /Cursor account (connection|requirement)/,
      `a schedule was recommended as a substitute without saying it needs the same account: ${line}`,
    );
});

test("the listener honesty that was already there is still there", () => {
  assert.match(
    prompt,
    /Event listeners fire through the user's Cursor account connections/,
    "the line that made listeners honest was dropped, which would leave the cron substitutions pointing at nothing",
  );
});

test("a schedule is never presented as a way around a missing connection", () => {
  assert.match(
    prompt,
    /a saved schedule is only a stored description until the account is back/,
    "without this the agent still reports a saved schedule as something that will fire on time",
  );
  assert.match(
    prompt,
    /will not fire until they connect it/,
    "the prompt has to tell the agent what to say to the user when the account is not connected",
  );
});

test("the guidance version moves when the guidance text moves", () => {
  assert.equal(
    AUTOMATION_PROMPT_GUIDANCE_VERSION,
    "backend_triggers_v5",
    "the version is attached to every routine lifecycle event, so it has to name the guidance that was actually live when the routine was written",
  );
});

test("the prompt still renders the routine list and its schedules", () => {
  const withRoutines = renderAutomationsSystemPrompt(
    [
      {
        id: "morning-digest",
        name: "Morning digest",
        prompt: "Summarise overnight alerts.",
        isEnabled: true,
        trigger: { type: "cron", schedule: "15 8 * * 1-5" },
        schedule: "15 8 * * 1-5",
      },
    ],
    LOCATION,
    "Europe/Moscow",
  );

  assert.match(withRoutines, /- Morning digest \[enabled\]/, "honesty must not cost the prompt its routine list");
  assert.match(withRoutines, /\(15 8 \* \* 1-5\)/, "the saved schedule is what the user needs to see to judge it");
});