import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

import { parse } from "acorn";

import { COMPONENT_SOURCE } from "../scripts/lib/router-renderer-patch.mjs";

// The token ledger records cache reads and cache writes as two separate fields, because they
// are two different things: a read is a prompt served from cache and a write is a prompt stored
// into cache at full price. Both OpenAI-compatible executors leave the write count at zero
// because the OpenAI chat API reports reads only, which hid the merge in every test written
// against them. The Claude Code executor writes a real `cache_creation_input_tokens`
// (`provider-session.ts:369`), and the panel added the two fields together anyway:
//
//   cacheReadTokens: 900, cacheWriteTokens: 1400  ->  "Cache tokens: 2 300"
//
// 2300 is neither number the provider reported. A user reading it as cache savings overstates
// them by 2.5x; a user reading it as cache cost understates it by 64%. The Usage & Billing
// summary is worse: it prints the sum followed by the word "cached", so tokens that were
// written into the cache are reported as tokens that came out of it — the exact opposite of
// what happened. These tests pin that the two counts are shown separately, and that the
// summary labels only the read count as cached.

const ast = parse(COMPONENT_SOURCE, { ecmaVersion: "latest" });

function evaluatePanelSource() {
  const panels = {};
  const sandbox = {
    __routerPanels: panels,
    de: { useState: (value) => [value, () => {}], useEffect: () => {} },
    a: {
      jsx: (type, props) => ({ type, props: props ?? {} }),
      jsxs: (type, props) => ({ type, props: props ?? {} }),
      Fragment: "Fragment",
    },
    k: (...names) => names.join(" "),
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, desktop: { agent: {}, secrets: {} } },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    URL,
    Intl,
    setTimeout,
    clearTimeout,
    console,
  };
  // The usage rows render through the two display primitives and nothing else; the component
  // tag names are bound as their own names so a missing one fails loudly instead of silently
  // rendering as an unknown element.
  for (const tag of ["ie", "se", "re", "oe", "ye", "Te", "RBoxRuntime"]) sandbox[tag] = tag;
  createContext(sandbox);
  runInContext(`${COMPONENT_SOURCE}\n;__routerPanels.RRouterUsageRows=RRouterUsageRows;__routerPanels.RRouterUsageSummary=RRouterUsageSummary;`, sandbox, {
    filename: "router-usage-rows.js",
  });
  return panels;
}

const panels = evaluatePanelSource();

/** Every labelled row a component produced, as `[label, text]` with the text flattened. */
function rowsOf(node, out = [], seen = new Set()) {
  if (node == null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) rowsOf(item, out, seen);
    return out;
  }
  if (typeof node.type === "string" && node.props != null && typeof node.props === "object") {
    const text = flatten(node.props.children);
    if (typeof node.props.label === "string") out.push([node.props.label, text, flatten(node.props.description)]);
    for (const value of Object.values(node.props)) rowsOf(value, out, seen);
    return out;
  }
  for (const value of Object.values(node)) rowsOf(value, out, seen);
  return out;
}

function flatten(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (typeof node === "object" && node.props != null) return flatten(node.props.children);
  return "";
}

function rowLabelled(rows, needle) {
  const found = rows.filter(([label]) => label.toLowerCase().includes(needle));
  assert.equal(found.length, 1, `expected exactly one usage row whose label mentions ${JSON.stringify(needle)}, found ${found.length}`);
  return found[0];
}

// A ledger row in the shape the Claude Code route writes: the provider reported a real
// `cache_read_input_tokens` and a real `cache_creation_input_tokens`.
const LEDGER = {
  requests: 7,
  inputTokens: 2100,
  outputTokens: 50,
  cacheReadTokens: 900,
  cacheWriteTokens: 1400,
  lastUsedAt: "2026-10-06T00:00:00.000Z",
};

// The panel formats with `Intl.NumberFormat()` under whatever locale the host runs in, which
// is not the test's to choose. The expectation names the NUMBER; the formatter renders it.
const shown = (value) => new Intl.NumberFormat().format(value);

test("the injected usage rows show cache reads and cache writes as two separate numbers", () => {
  const rows = rowsOf(panels.RRouterUsageRows({ usage: LEDGER }));

  assert.deepEqual(
    rows.map(([label]) => label),
    ["Requests", "Input tokens", "Output tokens", "Cache read tokens", "Cache write tokens", "Last used"],
    "the Router panel must present a row per recorded count, so a reader can tell a cache read from a cache write",
  );

  assert.equal(
    rowLabelled(rows, "cache read")[1],
    shown(900),
    "the recorded cache read count must be shown as itself, not folded into a sum",
  );
  assert.equal(
    rowLabelled(rows, "cache write")[1],
    shown(1400),
    "the recorded cache write count must be shown as itself, not folded into a sum",
  );
});

test("no usage row shows a cache figure that matches neither recorded count", () => {
  const rows = rowsOf(panels.RRouterUsageRows({ usage: LEDGER }));
  const recorded = new Set([shown(900), shown(1400), shown(2100), shown(50), shown(7)]);

  for (const [label, text] of rows) {
    if (!label.toLowerCase().includes("cache")) continue;
    assert.ok(
      recorded.has(text),
      `the row ${JSON.stringify(label)} shows ${JSON.stringify(text)}, which is neither the cache read count (900) nor the cache write count (1400)`,
    );
  }
});

test("the compact usage summary labels only the cache read count as cached", () => {
  const rows = rowsOf(panels.RRouterUsageSummary({ provider: { label: "Claude Code" }, usage: LEDGER, current: true, divided: false }));
  const summary = rows.map(([, , description]) => description).filter((value) => value.length > 0).join(" ");
  const sum = shown(2300);

  assert.ok(
    summary.includes(`${shown(900)} cached`),
    `the cache read count must be the one reported as cached: ${JSON.stringify(summary)}`,
  );
  assert.ok(
    !summary.includes(`${sum} cached`),
    `the summary folds the cache write count into the cached figure: ${JSON.stringify(summary)}`,
  );
  assert.ok(
    summary.includes(`${shown(1400)} cache writes`),
    `a turn that wrote 1400 tokens into the cache must say so instead of hiding it inside the cached total: ${JSON.stringify(summary)}`,
  );
});

test("a provider that reports no cache activity still shows both counts as zero", () => {
  const rows = rowsOf(panels.RRouterUsageRows({ usage: { ...LEDGER, cacheReadTokens: 0, cacheWriteTokens: 0 } }));

  assert.equal(rowLabelled(rows, "cache read")[1], "0", "a provider that reported no cache read must show 0, not a missing row");
  assert.equal(rowLabelled(rows, "cache write")[1], "0", "a provider that reported no cache write must show 0, not a missing row");
});

test("the injected source parses and exposes both usage components", () => {
  assert.ok(ast.type === "Program", "COMPONENT_SOURCE must remain parseable; a syntax error ships green");
  assert.equal(typeof panels.RRouterUsageRows, "function");
  assert.equal(typeof panels.RRouterUsageSummary, "function");
});