/**
 * Plugin search, second file: the two things the rerank module cannot prove about
 * itself.
 *
 * `plugin-search-jev.test.mjs` owns the degradation contract -- every failure path
 * returns the lexical list unchanged, at most one promotion, a shortlist of at
 * most four. That contract is untouched and is proven there.
 *
 * This file owns what happens AROUND the rerank:
 *
 *  1. the diagnostics. `PluginSearchOutcome` computes `skip`, `coverage`,
 *     `classifierUsed`, `attempts`, `failures`, `decidedInMs` and
 *     `promotedPluginId`, and the call site used to drop every one of them. That
 *     is why a `DecisionClientConfigError` and "the feature is not configured"
 *     looked identical -- to the agent and to whoever was debugging.
 *  2. what reaches stderr. The user's raw query used to be interpolated into three
 *     `console.warn` lines, so a pasted API key landed in the log verbatim.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolSourcePath = path.join(repoRoot, "source/host/runner/tools/sand-mcp-management-tools.ts");

/** Same two bundles as the rerank test: the tool module and the rerank module. */
async function loadPluginSearch() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-plugin-search-diag-"));
  await build({
    entryPoints: {
      tools: path.join(repoRoot, "source/host/runner/tools/sand-mcp-management-tools.ts"),
      jev: path.join(repoRoot, "source/host/runner/decisions/plugin-search-jev.ts"),
    },
    outdir: temporary,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const stamp = Date.now();
  const tools = await import(`${pathToFileURL(path.join(temporary, "tools.mjs")).href}?${stamp}`);
  const jev = await import(`${pathToFileURL(path.join(temporary, "jev.mjs")).href}?${stamp}`);
  return { tools, jev, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const { tools, jev, dispose } = await loadPluginSearch();
after(dispose);

beforeEach(() => {
  // The cooldown is module state, and it is what several tests below rely on.
  jev.resetPluginSearchDecisionClientCache();
});

// --- fixtures ----------------------------------------------------------------

function plugin(pluginId, name, displayName, category, description, skills = []) {
  return { pluginId, name, displayName, category, description, isInstalled: false, connectorCount: 1, skills: skills.map((skill) => ({ name: skill, description: "" })) };
}

/**
 * The same catalog the rerank test uses, for the same reason: "manage linear
 * issues" has to be a genuine zero-lexical-hit query here too, or the I4 scenario
 * is not the one under test.
 */
const CATALOG = [
  plugin("p-linear", "linear", "Linear", "planning", "Search, create and update tasks, projects and cycles in your Linear workspace.", ["triage"]),
  plugin("p-linear-triage", "linear-triage", "Linear Triage", "planning", "Work through the incoming Linear queue from one shared inbox.", ["triage"]),
  plugin("p-issues", "issue-tracker", "Issue Tracker", "planning", "Triage bugs and plan sprints in your team's tracker.", ["triage"]),
  plugin("p-issues-pro", "issue-tracker-pro", "Issue Tracker Pro", "planning", "Backlog grooming and release tracking for engineering teams.", ["backlog"]),
  plugin("p-notion", "notion", "Notion", "documents", "Read and write pages and databases in your Notion workspace.", []),
  plugin("p-word", "msword", "Microsoft Word", "documents", "Create and edit .docx word documents, reports and letters.", ["document editing"]),
];
const CATALOG_WITHOUT_LINEAR = CATALOG.filter((entry) => !entry.pluginId.startsWith("p-linear"));

/**
 * A catalog for the stderr tests, chosen so a pasted-credential query still
 * REACHES the classifier. The secret alone matches nothing, which returns
 * `no-shortlist` before any request is made and logs nothing -- true, but it
 * would prove nothing about the log lines. Here "track" scores 1 on a description
 * hit, which is weak enough to ask about and strong enough to build a shortlist.
 */
const SECRET_CATALOG = [plugin("p-widget", "widget", "Widget Tracker", "tools", "Track widgets and issues.")];

/** A request that is a pasted API key with one ordinary word in front of it. */
const SECRET = "sk-live-9f2b7c1d4e5a6b8c0d1e2f3a4b5c6d7e";
const SECRET_QUERY = `track ${SECRET}`;

/** Exactly the evidence the `SearchPlugins` call site builds. */
function evidenceFor(catalog, query) {
  const lexical = tools.rankPluginsLexically(catalog, query);
  return {
    query,
    tokens: tools.tokenizePluginQuery(query),
    all: catalog,
    lexical,
    tokenScoreOf: (entry, token) => tools.scorePluginForToken(entry, token),
  };
}

/** The full result text, exactly as the call site renders it. */
async function searchResultText(catalog, query, options = {}) {
  const evidence = evidenceFor(catalog, query);
  const outcome = await jev.searchPluginsWithJev(evidence, { log: () => {}, ...options });
  return { text: tools.describePluginSearchResult(query, evidence.lexical, outcome), outcome };
}

function decided(value, probabilities) {
  return { ok: true, value, probabilities, confidence: null, abstain: false, band: "decide", model: "jev-1.13.0", cached: false, decidedInMs: 1, fallback: false };
}

function failed(reason = "server_error") {
  return { ok: false, reason, detail: "HTTP 503 from https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0", cached: false, decidedInMs: 1, fallback: false };
}

function stubClient(answers) {
  const calls = [];
  return {
    calls,
    client: {
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      choose: async () => { throw new Error("choose() must not be used"); },
      judge: async (state, question, opts) => {
        calls.push({ state, question, opts });
        const pluginId = /Is plugin "([^"]+)"/.exec(question)?.[1] ?? "";
        const answer = answers[pluginId];
        return typeof answer === "function" ? answer() : (answer ?? failed());
      },
      score: async () => { throw new Error("score() must not be used"); },
      clearCache: () => {},
      cacheSize: 0,
    },
  };
}

// --- I2: the diagnostics reach the agent --------------------------------------

test("I2: the result says the classifier is not configured, instead of saying nothing at all", async () => {
  // The case the reviewer hit. `no-client` is what `resolvePluginSearchDecisionClient`
  // returns when `TYPESAFE_API_KEY` is unset -- and also what it returns when a key
  // IS set and `createHttpDecisionClient` throws a `DecisionClientConfigError`.
  const { text, outcome } = await searchResultText(CATALOG, "write word documents", { client: null });
  assert.equal(outcome.skip, "no-client");

  assert.match(text, /Provenance: LEXICAL\./, "the agent must be told the order is word-match only");
  assert.match(text, /^Why no re-rank: .*classifier is configured.*TYPESAFE_API_KEY/m, "the skip reason must be in the text the agent reads");
  // Both candidate causes are named, because the module cannot tell them apart and
  // pretending otherwise is the ambiguity this function exists to remove.
  assert.match(text, /TYPESAFE_API_KEY is unset, or it is set and was rejected/);
  assert.match(text, /Query coverage: 100% \(3 of 3 words appear somewhere in the catalog\)/);
});

test("I2: the four reasons the classifier can stay silent produce four DIFFERENT lines", async () => {
  // Before this change all four rendered as an identical plugin list with no
  // diagnostic, which is the whole complaint.
  // `beforeEach` clears the cooldown, and so must every step here: each of these
  // reasons is reachable only from a clean module state.
  const lines = {};
  lines["no-client"] = (await searchResultText(CATALOG, "write word documents", { client: null })).text;

  const evidence = evidenceFor(CATALOG, "write word documents");
  const opening = stubClient({});
  await jev.searchPluginsWithJev(evidence, { client: opening.client, log: () => {} }); // opens the cooldown
  const cooled = await jev.searchPluginsWithJev(evidence, { client: opening.client, log: () => {} });
  assert.equal(cooled.skip, "client-unavailable");
  lines["client-unavailable"] = tools.describePluginSearchResult("write word documents", evidence.lexical, cooled);

  jev.resetPluginSearchDecisionClientCache();
  lines["lexical-confident"] = (await searchResultText(CATALOG, "linear", { client: null })).text;

  jev.resetPluginSearchDecisionClientCache();
  const hanging = { ...stubClient({}).client, judge: () => new Promise(() => {}) };
  lines["deadline"] = (await searchResultText(CATALOG, "write word documents", { client: hanging })).text;

  const whyLines = Object.values(lines).map((text) => /^Why no re-rank: .*$/m.exec(text)?.[0]);
  for (const line of whyLines) assert.ok(line != null, "every non-promoting result carries a 'Why no re-rank' line");
  assert.equal(new Set(whyLines).size, 4, `these four must be distinguishable:\n${whyLines.join("\n")}`);

  assert.match(whyLines[0], /classifier is configured/);
  assert.match(whyLines[1], /paused for its cooldown/);
  assert.match(whyLines[2], /word match was already decisive/);
  assert.match(whyLines[3], /did not answer inside its deadline/);
});

test("I2: a classifier failure reports WHICH failure, not just that one happened", async () => {
  const stub = stubClient({ "p-word": () => failed("server_error"), "p-notion": () => failed("rate_limited") });
  const { text, outcome } = await searchResultText(CATALOG, "write word documents", { client: stub.client });
  assert.equal(outcome.skip, "failed");
  assert.equal(outcome.failures, "rate_limited, server_error");
  assert.match(text, /the classifier request failed, so ranking stayed lexical \(rate_limited, server_error\)/);
  // And the timing that was discarded: how many questions, and how long it took.
  assert.match(text, /2 classifier question\(s\) answered in \d+ms/);
});

test("I2: a promotion reports the promoted id and does NOT print a 'why it did not' line", async () => {
  const stub = stubClient({
    "p-word": () => decided(true, { true: 0.55, false: 0.4, unclear: 0.05 }),
    "p-notion": () => decided(true, { true: 0.96, false: 0.02, unclear: 0.02 }),
  });
  const { text, outcome } = await searchResultText(CATALOG, "write word documents", { client: stub.client });
  assert.equal(outcome.skip, "promoted");
  assert.equal(outcome.promotedPluginId, "p-notion");
  assert.match(text, /Provenance: RE-RANKED\..*plugin p-notion/s);
  assert.doesNotMatch(text, /^Why no re-rank:/m, "the classifier DID contribute, so there is nothing to explain away");
});

test("I2: the plugin list is byte-identical to what it was before diagnostics existed", async () => {
  // Backward compatibility: anything reading the leading `${n} plugin(s)...` line,
  // or the block of plugin entries under it, must see exactly the same text. The
  // diagnostics are appended AFTER that block, never interleaved with it.
  const { text, outcome } = await searchResultText(CATALOG, "linear", { client: null });
  const header = `2 plugin(s) matching "linear" (best first):`;
  const block = outcome.plugins.map((entry) => tools.describePluginSummary(entry)).join("\n");
  assert.ok(text.startsWith(`${header}\n${block}\n`), `the header and the plugin block changed:\n${text}`);
  assert.ok(text.length > `${header}\n${block}\n`.length, "diagnostics were appended after it, not dropped");
  // A description can contain a newline, so the block is compared whole rather
  // than line by line.
  assert.deepEqual(outcome.plugins.map((entry) => entry.pluginId), ["p-linear", "p-linear-triage"]);
});

test("I2: an empty result still leads with the old first line", async () => {
  const { text } = await searchResultText(CATALOG_WITHOUT_LINEAR, "manage linear issues", { client: null });
  assert.equal(text.split("\n")[0], `No plugins match "manage linear issues".`);
});

// --- I4: the inferred single hit is marked ------------------------------------

test("I4: one plugin promoted out of an EMPTY lexical result is marked INFERRED in the text", async () => {
  const stub = stubClient({
    "p-issues": () => decided(true, { true: 0.94, false: 0.04, unclear: 0.02 }),
    "p-issues-pro": () => decided(false, { true: 0.03, false: 0.93, unclear: 0.04 }),
  });
  const { text, outcome } = await searchResultText(CATALOG_WITHOUT_LINEAR, "manage linear issues", { client: stub.client });

  // The behaviour tests/plugin-search-jev.test.mjs already pins: the empty result
  // becomes exactly one plugin. Intentional. What was missing is that it LOOKED found.
  assert.equal(outcome.skip, "promoted");
  assert.equal(outcome.plugins.length, 1);
  assert.equal(text.split("\n")[0], `1 plugin(s) matching "manage linear issues" (best first):`);

  // The marker has to be in the RESULT TEXT, not in an internal field. An agent
  // that only sees the string is the thing this protects.
  assert.match(text, /Provenance: INFERRED, not matched\./);
  assert.match(text, /was INFERRED from the catalog, not found by matching it/);
  assert.match(text, /Do not present it as the plugin that matched/);
  assert.doesNotMatch(text, /Provenance: RE-RANKED/, "an inferred hit is not a re-rank of a word match: there was none");
});

test("I4: a real empty result is NOT marked INFERRED", async () => {
  // The converse must hold, or the marker stops meaning anything.
  const { text } = await searchResultText([plugin("p-only", "solitaire", "Solitaire", "games", "Play the card game.")], "manage linear issues", { client: null });
  assert.equal(text.split("\n")[0], `No plugins match "manage linear issues".`);
  assert.doesNotMatch(text, /INFERRED/);
  assert.match(text, /no catalog entry was a candidate|classifier is configured/);
});

test("I4: a found single hit is NOT marked INFERRED", async () => {
  const { text } = await searchResultText(CATALOG, "linear", { client: null });
  assert.equal(text.split("\n")[0], `2 plugin(s) matching "linear" (best first):`);
  assert.doesNotMatch(text, /INFERRED/);
});

test("I4: the SEARCH_PLUGINS call site actually renders through describePluginSearchResult", async () => {
  // Wiring guard. The provenance work above is only worth anything if the tool
  // calls the renderer; this pins that it does, without standing up the whole
  // agent tool-execution stack (Context, otel, protobuf) to call it for real.
  const source = await readFile(toolSourcePath, "utf8");
  const start = source.indexOf('id: "SEARCH_PLUGINS"');
  assert.ok(start > 0, "the SEARCH_PLUGINS tool definition was not found");
  // The one tool spec, from its id up to the id of the next tool.
  const spec = source.slice(start, source.indexOf('id: "', start + 1));
  assert.match(spec, /return describePluginSearchResult\(query, lexical, reranked\);/);
  assert.doesNotMatch(spec, /const plugins = reranked\.plugins;/, "the shape that discarded the diagnostics must not come back");
});

// --- I3: the user's query must not reach stderr -------------------------------

/**
 * Runs `body` with `console.warn` captured, and returns what would have gone to
 * stderr. The point is to test the DEFAULT sink: `searchPluginsWithJev` takes a
 * `log` override, and passing one would prove only that the injected sink is
 * clean, not the one production writes to.
 */
async function captureStderr(body) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    await body();
  } finally {
    console.warn = original;
  }
  return lines;
}

test("I3: a pasted secret never reaches stderr on the deadline path", async () => {
  const hanging = { ...stubClient({}).client, judge: () => new Promise(() => {}) };
  // The query really does reach the classifier: one weak lexical hit, one candidate.
  assert.deepEqual(evidenceFor(SECRET_CATALOG, SECRET_QUERY).lexical.map((entry) => entry.pluginId), ["p-widget"]);
  const lines = await captureStderr(async () => {
    await jev.searchPluginsWithJev(evidenceFor(SECRET_CATALOG, SECRET_QUERY), { client: hanging });
  });

  assert.ok(lines.length > 0, "the deadline path must still log something");
  for (const line of lines) {
    assert.equal(line.includes(SECRET), false, `the query was written to stderr verbatim: ${line}`);
    assert.equal(line.includes("sk-live"), false, "even a prefix of the credential leaked");
  }
  assert.match(lines[0], /^\[plugin-search\] classifier batch passed the \d+ms deadline/);
  // What the operator gets instead: the shape of the request, not its content.
  assert.match(lines[0], /kept the lexical result for a \d+-character request \(\d+ usable word\(s\)\)\.$/);
  assert.equal(lines[0].includes("\n"), false, "a log line must stay one line");
});

test("I3: a pasted secret never reaches stderr on the transport-failure path", async () => {
  const stub = stubClient({ "p-widget": () => failed("server_error") });
  const lines = await captureStderr(async () => {
    await jev.searchPluginsWithJev(evidenceFor(SECRET_CATALOG, SECRET_QUERY), { client: stub.client });
  });

  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.equal(line.includes(SECRET), false, `the query was written to stderr verbatim: ${line}`);
    assert.equal(line.includes("sk-live"), false);
  }
  assert.match(lines[0], /^\[plugin-search\] classifier unavailable \(server_error\); kept the lexical result for a \d+-character request/);
  // The reviewer's good news, pinned: `outcome.reason` is logged, `detail` is not,
  // so the response-body redaction in decision-client.ts cannot reach this file.
  assert.equal(lines[0].includes("HTTP 503"), false, "DecisionFailure.detail must never be logged");
});

test("I3: the caught error message is bounded to one line before it reaches stderr", async () => {
  const noisy = new Error(["first line", "second line", "x".repeat(400)].join("\n"));
  // A `tokenScoreOf` that throws is the cheapest way into the module's catch block.
  const evidence = { ...evidenceFor(SECRET_CATALOG, SECRET_QUERY), tokenScoreOf: () => { throw noisy; } };
  const lines = await captureStderr(async () => { await jev.searchPluginsWithJev(evidence, { client: null }); });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(SECRET), false);
  assert.equal(lines[0].includes("\n"), false, "a multi-line error must not become a multi-line log entry");
  assert.ok(lines[0].length < 300, `the line is ${lines[0].length} characters`);
  // Collapsed to one line, then cut at the documented bound, with the ellipsis
  // standing in for the 400-character tail.
  assert.match(lines[0], /^\[plugin-search\] classifier rerank threw \(first line second line x+…\); kept the lexical result\.$/);
  assert.equal(lines[0].includes("x".repeat(200)), false, "the tail was not cut");
});

test("I3: a successful search logs nothing at all", async () => {
  const stub = stubClient({
    "p-word": () => decided(true, { true: 0.96, false: 0.02, unclear: 0.02 }),
    "p-notion": () => decided(true, { true: 0.94, false: 0.04, unclear: 0.02 }),
  });
  const lines = await captureStderr(async () => {
    await jev.searchPluginsWithJev(evidenceFor(CATALOG, "write word documents"), { client: stub.client });
  });
  assert.deepEqual(lines, []);
});

// --- the malformed-catalog guard ----------------------------------------------

test("GUARD: a catalog record missing name/displayName/category/description does not crash the search", async () => {
  // `listPlugins` is fed by `toPluginSummary`, which types its result
  // `Record<string, unknown>` and copies these four fields straight off the REMOTE
  // marketplace catalog. A missing field is a wire-format surprise, not a type error.
  const malformed = [
    { pluginId: "p-broken", isInstalled: false, connectorCount: 1, skills: [] }, // no name, no displayName, no category, no description
    plugin("p-notion", "notion", "Notion", "documents", "Read and write pages and databases."),
  ];

  // Before the guard this threw `TypeError: Cannot read properties of undefined
  // (reading 'toLowerCase')` and took the whole tool down.
  assert.equal(tools.scorePluginForToken(malformed[0], "notion"), 0, "a record with no text fields scores 0 on every rung");
  assert.deepEqual(tools.rankPluginsLexically(malformed, "notion").map((entry) => entry.pluginId), ["p-notion"], "the healthy record still ranks");

  // And the whole tool result renders, with the broken record simply absent.
  const { text } = await searchResultText(malformed, "notion", { client: null });
  assert.match(text, /^1 plugin\(s\) matching "notion" \(best first\):/);
  assert.match(text, /- p-notion: Notion/);
  assert.equal(text.includes("undefined"), false, "no `undefined` leaks into the rendered record");
});

test("GUARD: a record with no skills array does not crash scoring", () => {
  const entry = { pluginId: "p-x", name: "x", displayName: "X", category: "c", description: "d" }; // no `skills`
  assert.equal(tools.scorePluginForToken(entry, "x"), 8, "the name rung still scores");
  assert.equal(tools.scorePluginForToken(entry, "zzz"), 0);
});

test("GUARD: a catalog with no displayName still sorts on the browse path", () => {
  // `rankPluginsLexically`'s comparator runs on EVERY record when the query has no
  // tokens, so an unguarded `localeCompare` is the same crash by another route.
  const catalog = [
    plugin("p-b", "bee", "Bee", "x", "b"),
    { pluginId: "p-a", isInstalled: false, connectorCount: 1, skills: [] }, // no displayName at all
  ];
  assert.deepEqual(tools.rankPluginsLexically(catalog, "").map((entry) => entry.pluginId), ["p-a", "p-b"]);
  assert.deepEqual(tools.rankPluginsLexically(catalog, "a of to").map((entry) => entry.pluginId), ["p-a", "p-b"]);
});

test("GUARD: the browse path RENDERS a malformed record instead of crashing on it", async () => {
  // The scorer guard alone was not enough: with no query every record is rendered,
  // and `getDefaultMcpCustomInstruction(undefined)` throws on `.trim()`. Guarding
  // the scorer but not the renderer would leave the same outage one line later.
  const malformed = { pluginId: "p-a", isInstalled: false, connectorCount: 1, skills: [] };
  const rendered = tools.describePluginSummary(malformed);
  assert.equal(rendered.includes("undefined"), false, `a raw undefined leaked into the rendered record: ${rendered}`);
  assert.match(rendered, /^- p-a: /);

  const { text } = await searchResultText([malformed, plugin("p-b", "bee", "Bee", "x", "b")], "", { client: null });
  assert.equal(text.includes("undefined"), false);
  assert.match(text, /2 plugin\(s\) available:/);
  // The missing fields render empty rather than as `undefined`, and the record is
  // still listed: a catalog the backend got wrong is still browsable.
  assert.match(text, /- p-a: {2}—/);
  assert.match(text, /- p-b: Bee — b/);
});

test("GUARD: a healthy catalog is bit-for-bit unaffected by the guard", () => {
  // The guard must not change a single score. This is the anti-regression check.
  assert.equal(tools.scorePluginForToken(CATALOG[0], "linear"), 8);
  assert.equal(tools.scorePluginForToken(CATALOG[0], "lin"), 5);
  assert.equal(tools.scorePluginForToken(CATALOG[0], "triage"), 3);
  assert.equal(tools.scorePluginForToken(CATALOG[0], "planning"), 2);
  assert.equal(tools.scorePluginForToken(CATALOG[0], "workspace"), 1);
  assert.equal(tools.scorePluginForToken(CATALOG[0], "nonesuch"), 0);
  assert.deepEqual(tools.rankPluginsLexically(CATALOG, "linear").map((entry) => entry.pluginId), ["p-linear", "p-linear-triage"]);
  assert.deepEqual(tools.rankPluginsLexically(CATALOG, "write word documents").map((entry) => entry.pluginId), ["p-word", "p-notion"]);
});

// --- the Cyrillic tokenizer must not regress ---------------------------------

test("the Cyrillic tokenizer fix is still in place", async () => {
  // `/[^\p{L}\p{N}]+/u`, NOT `/[^a-z0-9]+/`. With the ASCII class every Cyrillic
  // character is a delimiter, the query tokenizes to [], and a Russian search
  // silently returns the whole catalog in alphabetical order.
  assert.deepEqual(tools.tokenizePluginQuery("найди плагин для линейных задач"), ["найди", "плагин", "для", "линейных", "задач"]);
  assert.ok(tools.tokenizePluginQuery("задачи").length > 0, "a fully Cyrillic query must produce tokens");

  const russian = [
    plugin("p-linear-ru", "linear", "Линейные задачи", "планирование", "Поиск и обновление задач.", ["задачи"]),
    plugin("p-notion-ru", "notion", "Ноушен", "документы", "Чтение и запись страниц.", []),
  ];
  // The catalog is SEARCHED, not listed whole.
  assert.deepEqual(tools.rankPluginsLexically(russian, "найди плагин для линейных задач").map((entry) => entry.pluginId), ["p-linear-ru"]);

  // And the browse line says so rather than reporting a meaningless 0%.
  const { text } = await searchResultText(russian, "", { client: null });
  assert.match(text, /Query coverage: not measured — the request had no usable word, so this was a catalog browse\./);
  assert.match(text, /^Why no re-rank: the request had no word of 3\+ characters/m);
});

// --- the wrong premise, corrected in the source ------------------------------

test("the header no longer claims SearchPlugins runs per keystroke", async () => {
  const jevSource = await readFile(path.join(repoRoot, "source/host/runner/decisions/plugin-search-jev.ts"), "utf8");
  // An LLM tool call is roughly one call per agent turn, so the "re-dialed per
  // keystroke" mitigation that used to justify the cooldown never applied.
  assert.doesNotMatch(jevSource, /per keystroke/, "the header still rests on the per-keystroke premise");
  assert.match(jevSource, /TOOL CALL BY THE AGENT, not a search box/);
  assert.match(jevSource, /roughly once per agent turn/);
});

test("there is no SearchPlugins call site in frontend/, so the premise was never true", async () => {
  const { readdir, readFile: read } = await import("node:fs/promises");
  const root = path.join(repoRoot, "frontend", "src");
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const text = await read(full, "utf8");
      if (/SearchPlugins|rankPluginsLexically/.test(text)) offenders.push(path.relative(repoRoot, full));
    }
  };
  await walk(root);
  // If this ever starts failing, a UI search box exists and the per-keystroke
  // reasoning deserves to be revisited -- on evidence rather than on a hunch.
  assert.deepEqual(offenders, [], `these frontend files reference the plugin search: ${offenders.join(", ")}`);
});