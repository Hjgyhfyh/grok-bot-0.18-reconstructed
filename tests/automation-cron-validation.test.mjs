import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The cron matcher was right and the validation around it was not.
 * `parseCronField` fed every token through `Number()`, and `Number("")` is `0`,
 * so a field of `-5` became the range 0..5 and `1-2-3` became the range 1..2.
 * A malformed schedule was accepted, expanded to something plausible, saved, and
 * then fired at times nobody wrote down.
 *
 * `parseEveryIntervalMs` had no upper bound at all. `@every 999999999999d` is a
 * finite number of milliseconds, so it was accepted, added to "now", and handed
 * to `new Date(...)`, which threw `RangeError: Invalid time value` — inside
 * `formatTimestamp`, whose fallback line calls `toLocaleString()` on the same
 * invalid Date and throws again.
 *
 * The matcher itself is deliberately untouched, so the tests below also pin it:
 * valid expressions are compared against an oracle written independently here,
 * over a bounded window, so a validation fix cannot quietly become a matcher
 * rewrite.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-cron-validation-"));
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

const { loaded, dispose } = await bundle([["shared", "automation-schedule.ts"]]);
const {
  MAX_EVERY_INTERVAL_MS,
  compileCronMatcher,
  computeNextRunAt,
  formatTimestamp,
  nextCronRun,
  parseCronField,
  parseEveryIntervalMs,
} = loaded["automation-schedule.mjs"];

test.after(() => dispose());

/** Independent field reader for the oracle below. Unknown shapes never occur there. */
function oracleFieldMatches(field, value, min, max) {
  for (const part of field.split(",")) {
    const [range = "*", stepPart] = part.split("/");
    const step = stepPart == null ? 1 : Number(stepPart);
    const [from, to] = range === "*" ? [min, max] : range.split("-").map(Number);
    const last = to == null ? from : to;
    for (let candidate = from; candidate <= last; candidate += step)
      if (candidate === value) return true;
  }
  return false;
}

/** Scan minute by minute in UTC. Written from the cron rules, not from the module. */
function oracleNextRun(expression, afterMs, windowDays) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.split(" ");
  const domRestricted = dayOfMonth !== "*";
  const dowRestricted = dayOfWeek !== "*";
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let cursor = start; cursor < start + windowDays * 86_400_000; cursor += 60_000) {
    const at = new Date(cursor);
    if (!oracleFieldMatches(minute, at.getUTCMinutes(), 0, 59)) continue;
    if (!oracleFieldMatches(hour, at.getUTCHours(), 0, 23)) continue;
    if (!oracleFieldMatches(month, at.getUTCMonth() + 1, 1, 12)) continue;
    const dom = oracleFieldMatches(dayOfMonth, at.getUTCDate(), 1, 31);
    const dow = oracleFieldMatches(dayOfWeek, at.getUTCDay() === 0 && dayOfWeek.includes("7") ? 7 : at.getUTCDay(), 0, 7);
    const dayMatches = domRestricted && dowRestricted ? dom || dow : (domRestricted ? dom : true) && (dowRestricted ? dow : true);
    if (dayMatches) return cursor;
  }
  return null;
}

test("a range with no start is rejected instead of starting at zero", () => {
  assert.equal(
    parseCronField("-5", 0, 59),
    null,
    "Number(\"\") is 0, so the half-written range -5 was accepted as the minutes 0 through 5",
  );
});

test("a range with three parts is rejected instead of losing one", () => {
  assert.equal(
    parseCronField("1-2-3", 0, 59),
    null,
    "the extra segment was dropped without a word, so a typo looked like a valid schedule",
  );
});

test("an empty list segment is rejected instead of widening to every value", () => {
  assert.equal(
    parseCronField("1,2,", 0, 59),
    null,
    "a trailing comma silently turned into *, so 1,2, was stored as every minute of the hour",
  );
});

test("an interval beyond the horizon is rejected before it reaches a Date", () => {
  assert.equal(
    parseEveryIntervalMs("@every 999999999999d"),
    null,
    "an unbounded interval was accepted, and every timestamp it produced threw RangeError",
  );
  assert.equal(MAX_EVERY_INTERVAL_MS, 366 * 86_400_000, "the bound has to be the same horizon the cron search uses");
  assert.equal(parseEveryIntervalMs("@every 366d"), MAX_EVERY_INTERVAL_MS, "the longest interval a routine can express must still work");
  assert.equal(parseEveryIntervalMs("@every 367d"), null, "the first interval past the bound must be refused");
});

test("a refused interval cannot produce an unprintable timestamp", () => {
  const after = Date.UTC(2026, 2, 1, 12, 0, 0);
  const next = computeNextRunAt("@every 999999999999d", after);

  assert.equal(next, null, "an interval this large is not a schedule, it is an invalid Date");
  assert.doesNotThrow(
    () => formatTimestamp(next),
    "formatTimestamp is called on whatever nextRunAt holds, and an invalid Date threw RangeError there",
  );
});

test("ordinary intervals are untouched", () => {
  assert.equal(parseEveryIntervalMs("@every 30s"), 30_000);
  assert.equal(parseEveryIntervalMs("@every 5m"), 300_000);
  assert.equal(parseEveryIntervalMs("@every 2h"), 7_200_000);
  assert.equal(parseEveryIntervalMs("@every 1d"), 86_400_000);
  assert.equal(parseEveryIntervalMs("@every 0s"), null, "zero was already refused and must stay refused");
  assert.equal(computeNextRunAt("@every 30m", 1_000), 1_801_000, "a plain interval is still measured from the anchor");
});

test("valid cron expressions still mean what they say", () => {
  const after = Date.UTC(2026, 2, 1, 12, 0, 0);
  const expressions = [
    ["0 7 * * *", 40],
    ["32 * * * *", 40],
    ["30 9 * * 1", 40],
    ["0 9 * * 1-5", 40],
    ["*/30 9-17 * * 1-5", 40],
    // A yearly schedule is the one case that needs the search horizon, so the
    // oracle is given the same year the product searches.
    ["15 8 1 1 *", 400],
  ];

  for (const [expression, windowDays] of expressions) {
    const matcher = compileCronMatcher(expression);
    assert.notEqual(matcher, null, `${expression} stopped parsing`);
    assert.equal(
      nextCronRun(matcher, after, (date) => ({
        year: date.getUTCFullYear(),
        minute: date.getUTCMinutes(),
        hour: date.getUTCHours(),
        month: date.getUTCMonth() + 1,
        dayOfMonth: date.getUTCDate(),
        dayOfWeek: date.getUTCDay(),
      })),
      oracleNextRun(expression, after, windowDays),
      `${expression} no longer fires at the minute an independent reading of cron gives`,
    );
  }
});

test("out-of-range values are still refused rather than clamped", () => {
  assert.equal(parseCronField("60", 0, 59), null, "minute 60 does not exist");
  assert.equal(parseCronField("24", 0, 23), null, "hour 24 does not exist");
  assert.equal(parseCronField("0", 1, 31), null, "day 0 does not exist");
  assert.equal(parseCronField("*/0", 0, 59), null, "a zero step would never advance");
  assert.equal(parseCronField("*/2/3", 0, 59), null, "a field cannot carry two steps");
  assert.deepEqual([...parseCronField("*/15", 0, 59)].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parseCronField("5-7", 0, 59)], [5, 6, 7]);
});