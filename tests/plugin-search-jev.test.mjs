/**
 * Plugin search: the lexical first pass, and the Jev rerank that only runs when
 * that pass is weak.
 *
 * The proof obligations are the degradation ones. `SearchPlugins` promises
 * natural-language relevance; a classifier that is slow, down, unsure or absent
 * must never turn a working lexical search into an empty list or an error.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The tool module and the rerank module are bundled separately: the tool module
 * pulls in the protobuf runtime and zod, and neither needs the other's module
 * state.
 */
async function loadPluginSearch() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-plugin-search-"));
  const toolOut = path.join(temporary, "tools.mjs");
  const jevOut = path.join(temporary, "jev.mjs");
  await build({
    entryPoints: {
      tools: path.join(repoRoot, "source/host/runner/tools/sand-mcp-management-tools.ts"),
      jev: path.join(repoRoot, "source/host/runner/decisions/plugin-search-jev.ts"),
      decisions: path.join(repoRoot, "source/host/runner/decisions/decision-client.ts"),
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
  const tools = await import(`${pathToFileURL(toolOut).href}?${stamp}`);
  const jev = await import(`${pathToFileURL(jevOut).href}?${stamp}`);
  const decisions = await import(`${pathToFileURL(path.join(temporary, "decisions.mjs")).href}?${stamp}`);
  return { tools, jev, decisions, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const { tools, jev, decisions, dispose } = await loadPluginSearch();
test.after(dispose);

// --- catalog fixture ---------------------------------------------------------

function plugin(pluginId, name, displayName, category, description, skills = []) {
  return { pluginId, name, displayName, category, description, isInstalled: false, connectorCount: 1, skills: skills.map((skill) => ({ name: skill, description: "" })) };
}

/**
 * A catalog that names its plugins after their products, as the marketplace does.
 *
 * Nothing here contains the literal token "manage", "linear" or "issues" except
 * where a test wants it to, which is what makes "manage linear issues" a real
 * zero-lexical-hit query rather than an accident of the fixture.
 */
const CATALOG = [
  plugin("p-linear", "linear", "Linear", "planning", "Search, create and update tasks, projects and cycles in your Linear workspace.", ["triage", "cycle planning"]),
  plugin("p-linear-triage", "linear-triage", "Linear Triage", "planning", "Work through the incoming Linear queue from one shared inbox.", ["triage"]),
  plugin("p-issues", "issue-tracker", "Issue Tracker", "planning", "Triage bugs and plan sprints in your team's tracker.", ["triage"]),
  plugin("p-issues-pro", "issue-tracker-pro", "Issue Tracker Pro", "planning", "Backlog grooming and release tracking for engineering teams.", ["backlog"]),
  plugin("p-notion", "notion", "Notion", "documents", "Read and write pages and databases in your Notion workspace.", []),
  plugin("p-word", "msword", "Microsoft Word", "documents", "Create and edit .docx word documents, reports and letters.", ["document editing"]),
  plugin("p-github", "github", "GitHub", "development", "Open pull requests, review diffs and browse repositories.", ["code review"]),
];

/**
 * The same catalog with the two Linear entries removed: no name, skill, category
 * or description contains "linear", "manage" or "issues". This is the state the
 * reported regression describes.
 */
const CATALOG_WITHOUT_LINEAR = CATALOG.filter((entry) => !entry.pluginId.startsWith("p-linear"));

/** Everything `SearchPlugins` computes before any classifier call. */
function evidenceFor(catalog, query) {
  const tokens = tools.tokenizePluginQuery(query);
  return {
    query,
    tokens,
    all: catalog,
    lexical: tools.rankPluginsLexically(catalog, query),
    tokenScoreOf: (entry, token) => tools.scorePluginForToken(entry, token),
  };
}

const ids = (plugins) => plugins.map((entry) => entry.pluginId);

// --- classifier stubs --------------------------------------------------------

function decided(value, probabilities, band = "decide") {
  return { ok: true, value, probabilities, confidence: null, abstain: false, band, model: "jev-1.13.0", cached: false, decidedInMs: 1, fallback: false };
}

function abstained() {
  return { ok: false, reason: "abstained", abstain: true, abstainValue: "unclear", probabilities: { unclear: 0.7 }, confidence: null, band: "uncertain", model: "jev-1.13.0", cached: false, decidedInMs: 1, fallback: false };
}

function failed(reason = "server_error", detail = "HTTP 503 from https://api.typesafe.ai/v1/systemone") {
  return { ok: false, reason, detail, model: "jev-1.13.0", cached: false, decidedInMs: 1, fallback: false };
}

/** A client stub that answers from `answers`, and records every call. */
function stubClient(answers) {
  const calls = [];
  return {
    calls,
    client: {
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      choose: async () => { throw new Error("choose() must not be used by plugin search"); },
      judge: async (state, question, opts) => {
        calls.push({ state, question, opts });
        const pluginId = /Is plugin "([^"]+)"/.exec(question)?.[1] ?? "";
        const answer = answers[pluginId];
        return typeof answer === "function" ? answer() : (answer ?? abstained());
      },
      score: async () => { throw new Error("score() must not be used by plugin search"); },
      clearCache: () => {},
      cacheSize: 0,
    },
  };
}

const silent = { log: () => {} };

beforeEach(() => {
  // The cooldown is module state on purpose (it protects a dead endpoint); every
  // test starts outside a cooldown window.
  jev.resetPluginSearchDecisionClientCache();
});

// --- the trigger -------------------------------------------------------------

test("the trigger reads the lexical numbers: an exact name match with a clear lead is not sent to the classifier", async () => {
  // "linear" scores 8 on p-linear (whole-name equality) and 5 on p-linear-triage
  // (substring), so the top score is 8 and the spread is 3: one full rung.
  const evidence = evidenceFor(CATALOG, "linear");
  assert.deepEqual(ids(evidence.lexical), ["p-linear", "p-linear-triage"]);
  assert.equal(jev.PLUGIN_SEARCH_EXACT_NAME_SCORE, 8);
  assert.equal(jev.PLUGIN_SEARCH_CONFIDENT_SPREAD, 3);
  assert.equal(jev.isLexicalPluginRankingConfident(evidence), true);

  const stub = stubClient({});
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(stub.calls.length, 0, "a confident lexical ranking must not reach the network");
  assert.equal(outcome.skip, "lexical-confident");
  assert.equal(outcome.classifierUsed, false);
  assert.deepEqual(ids(outcome.plugins), ["p-linear", "p-linear-triage"]);
});

test("a weak lexical ranking does reach the classifier, over a shortlist of at most four candidates", async () => {
  // "write word documents" scores 6 on p-word (5 for a name substring plus 1 for
  // the description) and 1 on p-notion. The top score is below 8, so the ranking
  // is not decisive.
  const evidence = evidenceFor(CATALOG, "write word documents");
  assert.deepEqual(ids(evidence.lexical), ["p-word", "p-notion"]);
  assert.equal(jev.isLexicalPluginRankingConfident(evidence), false);
  assert.equal(jev.pluginSearchTokenCoverage(evidence), 3 / 3);

  const stub = stubClient({});
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(outcome.classifierUsed, true);
  assert.equal(outcome.attempts, 2);
  assert.ok(stub.calls.length <= jev.PLUGIN_SEARCH_JEV_MAX_CANDIDATES, `asked ${stub.calls.length} questions`);
  for (const call of stub.calls) assert.match(call.question, /^Is plugin "p-[a-z-]+" \([^)]+\) the one the user wants\?$/);
});

test("a query with no usable tokens is never sent to the classifier", async () => {
  const evidence = evidenceFor(CATALOG, "a of to");
  assert.deepEqual(evidence.tokens, []);
  // With no tokens the lexical pass lists the whole catalog, sorted by display name.
  assert.deepEqual(ids(evidence.lexical).slice().sort(), ids(CATALOG).slice().sort());

  const stub = stubClient({});
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(stub.calls.length, 0);
  assert.equal(outcome.skip, "no-query-tokens");
  assert.deepEqual(ids(outcome.plugins).slice().sort(), ids(CATALOG).slice().sort());
});

// --- the reported regression -------------------------------------------------

test('REGRESSION: "manage linear issues" returns nothing lexically when the catalog has no literal match', () => {
  const evidence = evidenceFor(CATALOG_WITHOUT_LINEAR, "manage linear issues");
  assert.deepEqual(evidence.tokens, ["manage", "linear", "issues"]);
  // This is the bug: the tool answered `No plugins match "manage linear issues".`
  assert.deepEqual(evidence.lexical, []);
  // Two thirds of the query is text the catalog does not contain. That is what a
  // natural-language query looks like in the data.
  assert.equal(jev.pluginSearchTokenCoverage(evidence), 0);
});

test('REGRESSION: "manage linear issues" reaches the classifier and promotes the issue-tracking plugin', async () => {
  const evidence = evidenceFor(CATALOG_WITHOUT_LINEAR, "manage linear issues");
  const stub = stubClient({
    "p-issues": () => decided(true, { true: 0.94, false: 0.04, unclear: 0.02 }),
    "p-issues-pro": () => decided(false, { true: 0.03, false: 0.93, unclear: 0.04 }),
  });
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });

  assert.equal(outcome.classifierUsed, true);
  assert.equal(outcome.skip, "promoted");
  assert.equal(outcome.promotedPluginId, "p-issues");
  assert.deepEqual(ids(outcome.plugins), ["p-issues"], "an empty lexical result becomes one plugin instead of none");
});

test('REGRESSION: "manage linear issues" is answered lexically, with no network call, when the catalog does name Linear', async () => {
  const evidence = evidenceFor(CATALOG, "manage linear issues");
  assert.equal(jev.isLexicalPluginRankingConfident(evidence), true);
  const stub = stubClient({});
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(stub.calls.length, 0);
  assert.equal(outcome.skip, "lexical-confident");
  assert.deepEqual(ids(outcome.plugins), ["p-linear", "p-linear-triage"]);
});

test("the relaxed shortlist reaches plugins the literal tokens miss", () => {
  const evidence = evidenceFor(CATALOG_WITHOUT_LINEAR, "manage linear issues");
  // "issu" is the 4-character prefix of "issues", and "Issue Tracker" contains it.
  assert.deepEqual(ids(jev.pluginSearchShortlist(evidence)), ["p-issues", "p-issues-pro"]);
});

// --- degradation -------------------------------------------------------------

test("DEGRADES: a lexical hit survives a classifier transport failure", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const stub = stubClient({
    "p-word": () => failed("server_error"),
    "p-notion": () => failed("rate_limited", "HTTP 429"),
  });
  const logs = [];
  const outcome = await jev.searchPluginsWithJev(evidence, { client: stub.client, log: (message) => logs.push(message) });

  assert.equal(outcome.skip, "failed");
  assert.equal(outcome.classifierUsed, true);
  assert.equal(outcome.promotedPluginId, undefined);
  assert.equal(outcome.failures, "rate_limited, server_error");
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"], "the lexical order must survive a classifier outage untouched");
  assert.ok(logs.some((line) => line.includes("classifier unavailable")), "the outage is reported, not swallowed silently");
});

test("DEGRADES: a lexical hit survives an abstention", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const stub = stubClient({ "p-word": abstained, "p-notion": abstained });
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });

  assert.equal(outcome.skip, "abstained");
  assert.equal(outcome.promotedPluginId, undefined);
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
});

test('DEGRADES: a `band:"uncertain"` answer does not drop a lexically-valid plugin', async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const stub = stubClient({
    // Jev says "this is relevant" but the band says the answer is not safe to act
    // on. It must change nothing -- not a promotion, and above all not a drop.
    "p-word": () => decided(true, { true: 0.7, false: 0.25, unclear: 0.05 }, "uncertain"),
    "p-notion": () => decided(false, { true: 0.1, false: 0.8, unclear: 0.1 }, "uncertain"),
  });
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });

  assert.equal(outcome.skip, "no-decide");
  assert.equal(outcome.promotedPluginId, undefined);
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
  assert.equal(outcome.plugins.length, evidence.lexical.length, "no plugin may be dropped on an uncertain band");
});

test('DEGRADES: every candidate answering false keeps the lexical list', async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const stub = stubClient({
    "p-word": () => decided(false, { true: 0.02, false: 0.95, unclear: 0.03 }),
    "p-notion": () => decided(false, { true: 0.05, false: 0.9, unclear: 0.05 }),
  });
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(outcome.skip, "no-relevant");
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
});

test("DEGRADES: a thrown client leaves the lexical result intact", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const exploding = {
    ...stubClient({}).client,
    judge: async () => { throw new Error("socket hang up"); },
  };
  const logs = [];
  const outcome = await jev.searchPluginsWithJev(evidence, { client: exploding, log: (message) => logs.push(message) });
  assert.equal(outcome.skip, "failed");
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
  assert.ok(logs.some((line) => line.includes("classifier unavailable (network_error)")));
});

test("DEGRADES: a null client keeps search purely lexical", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: null });
  assert.equal(outcome.skip, "no-client");
  assert.equal(outcome.classifierUsed, false);
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
});

test("DEGRADES: a shortlist of zero candidates makes no request", async () => {
  const catalog = [plugin("p-only", "solitaire", "Solitaire", "games", "Play the card game.", [])];
  const evidence = evidenceFor(catalog, "manage linear issues");
  assert.deepEqual(evidence.lexical, []);
  assert.deepEqual(jev.pluginSearchShortlist(evidence), []);

  const stub = stubClient({});
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(stub.calls.length, 0);
  assert.equal(outcome.skip, "no-shortlist");
  assert.deepEqual(outcome.plugins, []);
});

test("a failure opens a cooldown, so a dead endpoint is not re-dialed on the next turns", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const stub = stubClient({ "p-word": () => failed("network_error"), "p-notion": () => failed("network_error") });
  await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(stub.calls.length, 2);

  const second = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(stub.calls.length, 2, "the second search must not repeat the calls");
  assert.equal(second.skip, "client-unavailable");
  assert.deepEqual(ids(second.plugins), ["p-word", "p-notion"]);
});

// --- the wire format ---------------------------------------------------------

test("the wire request is one binary question per candidate, with the documented instructions", async () => {
  const evidence = evidenceFor(CATALOG_WITHOUT_LINEAR, "manage linear issues");
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, init, body });
    const questionId = Object.keys(body.questions)[0];
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { [questionId]: { choice: "true", probabilities: { true: 0.93, false: 0.05, unclear: 0.02 }, confidence: 0.94 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = decisions.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", model: "jev-1.13.0", timeoutMs: 5_000, fetchImpl });
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client });

  assert.equal(outcome.skip, "promoted");
  assert.equal(outcome.promotedPluginId, "p-issues");
  assert.equal(sent.length, 2, "one request per shortlist candidate, asked concurrently");

  // `buildJudgeQuestion` drops its `question` argument from the question object,
  // and the cache key is built from that object. If the candidate did not also
  // appear in `state`, both requests would share one key and the second would be
  // served the first one's answer: one request instead of two, silently.
  const states = sent.map((request) => request.body.state);
  assert.equal(new Set(states).size, 2, "each candidate needs its own state, or its own cache key");
  assert.deepEqual(states.map((state) => /^Plugin under test: (\S+)/m.exec(state)?.[1]), ["p-issues", "p-issues-pro"]);

  for (const request of sent) {
    assert.equal(request.url, "http://127.0.0.1:8080/systemone");
    assert.equal(request.body.model, "jev-1.13.0", "the model is pinned");
    const questionId = Object.keys(request.body.questions)[0];
    const question = request.body.questions[questionId];
    assert.equal(question.type, "choice");
    // The instructions the model reads: the caller's text plus the question about
    // this one candidate. The question is part of the hashed question object, which
    // is what keeps the two candidates from sharing one cache key.
    assert.equal(question.instructions.startsWith(jev.PLUGIN_SEARCH_JEV_INSTRUCTIONS), true);
    assert.match(question.instructions, /\nQuestion: Is plugin "(p-issues|p-issues-pro)" \([^)]+\) the one the user wants\?$/);
    assert.equal(question.criteria.true, jev.PLUGIN_SEARCH_JEV_TRUE_DESCRIPTION);
    assert.equal(question.criteria.false, jev.PLUGIN_SEARCH_JEV_FALSE_DESCRIPTION);
    assert.equal(question.criteria.unclear, jev.PLUGIN_SEARCH_JEV_ABSTAIN.description);
    // true / false / abstain == three options, so the shape is BINARY (2
    // substantive options), not the multiWay shape that measured ECE 0.305.
    assert.deepEqual(Object.keys(question.criteria).sort(), ["false", "true", "unclear"]);
    assert.match(request.body.state, /^User request: manage linear issues\nPlugin under test: p-[a-z-]+ \([^)]+\)\nCatalog entries:\n/);
    assert.match(request.body.state, /id=p-issues \|/);
  }
});

test("the per-request timeout is what bounds the wait, and it degrades to the lexical list", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  // A fetch that hangs until its signal fires, which is exactly the case the
  // explicit timeout exists for.
  const fetchImpl = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
  });
  const client = decisions.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", model: "jev-1.13.0", fetchImpl });

  const startedAt = performance.now();
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client, timeoutMs: 25 });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome.skip, "failed");
  assert.equal(outcome.failures, "timeout");
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
  assert.ok(elapsedMs < 1_000, `the batch must not wait for the ${jev.PLUGIN_SEARCH_JEV_DEADLINE_MS}ms deadline when the requests time out first (took ${Math.round(elapsedMs)}ms)`);
});

test("the deadline guard caps the worst case even if the transport never settles", async () => {
  const evidence = evidenceFor(CATALOG, "write word documents");
  const fetchImpl = () => new Promise(() => {}); // never resolves, never rejects, ignores the signal
  const client = decisions.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", model: "jev-1.13.0", timeoutMs: 3_600_000, fetchImpl });

  const startedAt = performance.now();
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client, timeoutMs: 3_600_000 });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome.skip, "deadline");
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
  // A deadline timer fires AT the deadline, and the clock that measures it starts
  // after the timer was armed. The two readings differ by however long that took,
  // so an exact lower bound is a coin flip that only lands green on a quiet
  // machine. The guard's job is to wait no SHORTER than its deadline; the margin
  // below is the arithmetic of two clocks, not a slackened requirement.
  const clockMarginMs = 50;
  assert.ok(elapsedMs >= jev.PLUGIN_SEARCH_JEV_DEADLINE_MS - clockMarginMs, `expected to wait the full ${jev.PLUGIN_SEARCH_JEV_DEADLINE_MS}ms guard (waited ${Math.round(elapsedMs)}ms)`);
  assert.ok(elapsedMs < jev.PLUGIN_SEARCH_JEV_DEADLINE_MS + 1_000, `the guard must cap the wait (waited ${Math.round(elapsedMs)}ms)`);
});

test("promotion moves one plugin to the front and leaves the rest of the lexical order untouched", async () => {
  // "write word documents" scores 6 on p-word and 1 on p-notion, so the ranking is
  // weak and the shortlist is the lexical order.
  const evidence = evidenceFor(CATALOG, "write word documents");
  assert.deepEqual(ids(evidence.lexical), ["p-word", "p-notion"]);
  assert.equal(jev.isLexicalPluginRankingConfident(evidence), false);

  const stub = stubClient({
    "p-word": () => decided(true, { true: 0.55, false: 0.4, unclear: 0.05 }),
    "p-notion": () => decided(true, { true: 0.96, false: 0.02, unclear: 0.02 }),
  });
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(outcome.skip, "promoted");
  assert.deepEqual(ids(outcome.plugins), ["p-notion", "p-word"], "the more confident answer wins; nothing is dropped");
});

test("an absent TYPESAFE_API_KEY disables the classifier instead of failing the search", () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    jev.resetPluginSearchDecisionClientCache();
    assert.equal(jev.resolvePluginSearchDecisionClient(), null);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    jev.resetPluginSearchDecisionClientCache();
  }
});

test("a Russian query tokenizes instead of collapsing to nothing", async () => {
  // The old split was /[^a-z0-9]+/, which DELETED every Cyrillic character. The
  // query tokenized to [], rankPluginsLexically took its "no tokens" branch, and the
  // tool answered with the whole catalog in alphabetical order whatever was typed.
  const query = "найди плагин для линейных задач";
  const tokens = tools.tokenizePluginQuery(query);
  assert.deepEqual(tokens, ["найди", "плагин", "для", "линейных", "задач"]);
  assert.ok(tokens.length > 0, "a fully Cyrillic query must produce tokens");

  const russianCatalog = [
    plugin("p-linear-ru", "linear", "Линейные задачи", "планирование", "Поиск и обновление задач в рабочем пространстве.", ["задачи"]),
    plugin("p-notion-ru", "notion", "Ноушен", "документы", "Чтение и запись страниц и баз данных.", []),
    plugin("p-github-ru", "github", "Гитхаб", "разработка", "Pull request и ревью изменений.", []),
  ];
  const evidence = evidenceFor(russianCatalog, query);
  // The catalog is searched, not listed whole: before the fix this was all three.
  assert.deepEqual(ids(evidence.lexical), ["p-linear-ru"]);

  // "задач" is a 5 against the display name and nothing reaches 8, so the classifier
  // is asked. It abstains, and the lexical answer survives untouched.
  const stub = stubClient({});
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client: stub.client });
  assert.equal(outcome.skip, "abstained");
  assert.deepEqual(ids(outcome.plugins), ["p-linear-ru"]);

  // A Cyrillic whole-name match is decisive exactly like a Latin one, and costs no request.
  const exact = evidenceFor([plugin("p-tasks", "задачи", "Задачи", "планирование", "Список задач.", []), ...russianCatalog], "задачи");
  // 8 for the whole-name match on p-tasks, 5 for the substring on p-linear-ru: a
  // spread of one full rung, so lexical already decided.
  assert.deepEqual(ids(exact.lexical), ["p-tasks", "p-linear-ru"]);
  const exactStub = stubClient({});
  const exactOutcome = await jev.searchPluginsWithJev(exact, { ...silent, client: exactStub.client });
  assert.equal(exactStub.calls.length, 0);
  assert.equal(exactOutcome.skip, "lexical-confident");
  assert.deepEqual(ids(exactOutcome.plugins), ["p-tasks", "p-linear-ru"]);
});

test("the search layer always passes its own timeout, so the client default cannot decide how long a search waits", async () => {
  assert.ok(jev.PLUGIN_SEARCH_JEV_TIMEOUT_MS <= 2_000, `plugin search budget is ${jev.PLUGIN_SEARCH_JEV_TIMEOUT_MS}ms`);
  assert.ok(jev.PLUGIN_SEARCH_JEV_DEADLINE_MS < 5_000, `plugin search deadline is ${jev.PLUGIN_SEARCH_JEV_DEADLINE_MS}ms`);

  // A transport that never answers. The caller here sets NO timeoutMs, so the only
  // thing that can end this wait is the search layer's own per-call budget: if it
  // ever stopped passing one, the client default would decide, and this would hang.
  const evidence = evidenceFor(CATALOG, "write word documents");
  const fetchImpl = async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
  });
  const client = decisions.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", model: "jev-1.13.0", fetchImpl });

  const startedAt = performance.now();
  const outcome = await jev.searchPluginsWithJev(evidence, { ...silent, client });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome.skip, "failed");
  assert.equal(outcome.failures, "timeout");
  assert.deepEqual(ids(outcome.plugins), ["p-word", "p-notion"]);
  assert.ok(elapsedMs < decisions.DEFAULT_DECISION_TIMEOUT_MS, `the search layer must bound the wait itself (took ${Math.round(elapsedMs)}ms, client default is ${decisions.DEFAULT_DECISION_TIMEOUT_MS}ms)`);
});
