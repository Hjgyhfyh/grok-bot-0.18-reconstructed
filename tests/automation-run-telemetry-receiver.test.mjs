import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Every automation run ended in an HTTP 500.
 * `withAutomationRunAnalytics` copied `telemetry.reportAutomationRun` into a
 * local constant and then called that copy bare, so the method lost its
 * receiver. The shipped implementation, `StructuredLogTelemetry
 * .reportAutomationRun`, reaches `this.mapped`, so the call threw `TypeError:
 * Cannot read properties of undefined (reading 'mapped')` on every run — at the
 * very end of it, after the work was already done.
 *
 * Every other method in that facade goes through `forward()`, which calls
 * `telemetry[name](...)` and keeps `this`. This one method was the only
 * asymmetric one and the type system could not see it: `TelemetryService`
 * declares its methods as bare `ReportMethod`, so detaching one typechecks.
 *
 * The first test reads the shipped telemetry source and refuses to pass unless
 * `reportAutomationRun` there still needs `this`, so the double below can never
 * quietly stop being a faithful stand-in for it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-automation-telemetry-"));
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
  ["host", "extensions", "telemetry", "analytics-service.ts"],
]);
const { withAutomationRunAnalytics } = loaded["analytics-service.mjs"];

test.after(() => dispose());

/**
 * `reportAutomationRun` on the real service is a prototype method that calls
 * `this.mapped`. Anything that detaches it loses exactly this. The rest of the
 * double exists because the facade reads every method name at build time.
 */
class ClassShapedTelemetry {
  constructor() {
    this.received = [];
  }
  mapped(result) {
    this.received.push(result);
  }
  reportAutomationRun(report) {
    this.mapped({ event: "automation_run", report });
  }
  reportAgentError(report) {
    this.mapped({ event: "agent_error", report });
  }
}

const REPORT = {
  conversationId: "agent-1",
  automationId: "stable-automation-1",
  trigger: "schedule",
  outcome: "ok",
  isGroup: false,
  sentMessageCount: 2,
};

test("the shipped telemetry implementation is the one that needs a receiver", () => {
  const source = readFileSync(
    path.join(repoRoot, "source", "host", "extensions", "telemetry", "structured-log-telemetry.ts"),
    "utf8",
  );
  const method = /reportAutomationRun\([^)]*\)[^{]*\{[^}]*\}/.exec(source);

  assert.ok(method != null, "the shipped telemetry no longer declares reportAutomationRun, so this double proves nothing");
  assert.match(
    method[0],
    /this\.mapped\(/,
    "reportAutomationRun no longer reads this.mapped, so a detached copy would no longer throw and this test would be measuring nothing",
  );
});

test("reporting an automation run keeps the telemetry service as the receiver", () => {
  const telemetry = new ClassShapedTelemetry();
  const tracked = [];
  const wrapped = withAutomationRunAnalytics(telemetry, {
    trackEvent: (name, properties) => { tracked.push([name, properties]); },
  });

  assert.doesNotThrow(
    () => wrapped.reportAutomationRun(REPORT),
    "reporting an automation run threw, which surfaced to the caller as an HTTP 500 at the end of every run",
  );
  assert.equal(
    telemetry.received.length,
    1,
    "the report never reached the telemetry service, so the run was recorded nowhere",
  );
  assert.deepEqual(telemetry.received[0], { event: "automation_run", report: REPORT });
  assert.deepEqual(tracked, [
    [
      "sand.automation.run",
      {
        agent_id: "agent-1",
        automation_id: "stable-automation-1",
        trigger: "schedule",
        outcome: "ok",
        is_group: false,
        sent_message_count: 2,
      },
    ],
  ], "the analytics event and the telemetry report are both part of the same run record");
});

test("a report without a message count does not invent one", () => {
  const telemetry = new ClassShapedTelemetry();
  const tracked = [];
  const wrapped = withAutomationRunAnalytics(telemetry, {
    trackEvent: (name, properties) => { tracked.push(properties); },
  });

  wrapped.reportAutomationRun({ ...REPORT, sentMessageCount: null });

  assert.equal(
    "sent_message_count" in tracked[0],
    false,
    "a null count means nothing was sent, and reporting zero would make a silent run look like a delivery",
  );
});

test("the facade binds every method the same way, so none of them is special", () => {
  const telemetry = new ClassShapedTelemetry();
  const wrapped = withAutomationRunAnalytics(telemetry, { trackEvent: () => {} });

  assert.doesNotThrow(
    () => wrapped.reportAgentError({ source: "automation" }),
    "a forwarded method lost its receiver too, which means the asymmetry was never really about one method",
  );
  assert.equal(
    telemetry.received.length,
    1,
    "forward() calls telemetry[name](...), so a forwarded method keeps its receiver; reportAutomationRun must match it",
  );
});