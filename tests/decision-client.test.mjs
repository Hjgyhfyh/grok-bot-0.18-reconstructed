import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDecisionClientModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-decision-client-"));
  const output = path.join(temporary, "decision-client.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/runner/decisions/decision-client.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

/** A `choice` response that matches whatever question the client actually sent. */
function choiceResponse({ choice, probabilities, confidence, model = "jev-1.13.0" }) {
  return { choice, probabilities, ...(confidence === undefined ? {} : { confidence }), model };
}

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** Build a 200 response whose `answers` key is the question id the client sent. */
function answered(init, answer, model = "jev-1.13.0") {
  const body = JSON.parse(init.body);
  const questionId = Object.keys(body.questions)[0];
  return jsonResponse({ model: answer.model ?? model, answers: { [questionId]: answer }, usage: { inputTokens: 42, outputTokens: 1 } });
}

/** Install a stub fetch for the duration of `run`, then restore the real one. */
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const ABSTAIN = { value: "unclear", description: "The state does not settle the question." };

test("choose() and judge() refuse to build a question without an abstain option", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let calls = 0;
    await withStubbedFetch(async (_url, init) => { calls += 1; return answered(init, choiceResponse({ choice: "a", probabilities: { a: 1 } })); }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      assert.throws(() => client.choose("state", [{ value: "a", description: "A" }], {}), module.DecisionClientInputError);
      assert.throws(() => client.choose("state", [], { abstain: ABSTAIN }), module.DecisionClientInputError);
      assert.throws(() => client.choose("state", [{ value: "a", description: "A" }], { abstain: undefined }), module.DecisionClientInputError);
      assert.throws(() => client.judge("state", "Is it safe?", {}), module.DecisionClientInputError);
      // The contract builder refuses the same thing without any client at all.
      assert.throws(() => module.buildChoiceQuestion({ options: [{ value: "a", description: "A" }], abstain: undefined }), module.DecisionClientInputError);
      assert.throws(
        () => module.buildChoiceQuestion({ options: [{ value: "a", description: "A" }, { value: "a", description: "A again" }], abstain: ABSTAIN }),
        /listed twice/,
      );
    });
    // A refused call must not reach the endpoint.
    assert.equal(calls, 0);
  } finally {
    await loaded.dispose();
  }
});

test("the cache answers a repeated question with cached: true and never calls the endpoint twice", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let calls = 0;
    // The service is not deterministic: 50 identical requests produced 15 different
    // answers. The stub flips its answer on every call to prove the cache is what
    // keeps the caller on one answer.
    const stub = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      // The same stub serves choose (allow/block) and judge (true/false).
      const judge = Object.hasOwn(body.questions[Object.keys(body.questions)[0]].criteria, "true");
      return answered(init, judge
        ? { choice: "true", probabilities: { true: 0.73, false: 0.27 }, confidence: 0.91 }
        : { choice: "block", probabilities: { block: 0.73, allow: 0.27 }, confidence: 0.91 });
    };
    await withStubbedFetch(stub, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", cache: { ttlMs: 60_000 } });
      const opts = { abstain: ABSTAIN };
      const options = [{ value: "allow", description: "Safe to run." }, { value: "block", description: "Unsafe to run." }];
      const first = await client.choose("user asked to delete files", options, opts);
      const second = await client.choose("user asked to delete files", options, opts);
      assert.equal(first.ok, true);
      assert.equal(first.cached, false);
      assert.equal(second.ok, true);
      assert.equal(second.cached, true);
      assert.equal(second.value, first.value);
      assert.deepEqual(second.probabilities, first.probabilities);
      assert.equal(client.cacheSize, 1);
      assert.equal(calls, 1);

      // A different option set is a different question and must hit the endpoint again.
      await client.choose("user asked to delete files", [{ value: "allow", description: "Safe." }, { value: "block", description: "Unsafe." }], opts);
      assert.equal(calls, 2);

      // Concurrent identical calls share one in-flight request.
      const parallel = await Promise.all([
        client.judge("same state", "Is it safe?", opts),
        client.judge("same state", "Is it safe?", opts),
        client.judge("same state", "Is it safe?", opts),
      ]);
      assert.equal(calls, 3);
      assert.deepEqual(parallel.map((outcome) => outcome.cached), [false, true, true]);

      // `cache: false` bypasses the cache in both directions.
      const before = calls;
      const uncached = await client.judge("same state", "Is it safe?", { ...opts, cache: false });
      assert.equal(uncached.ok, true);
      assert.equal(uncached.cached, false);
      assert.equal(calls, before + 1);
    });
  } finally {
    await loaded.dispose();
  }
});

test("a rate limit, a timeout, a down loopback endpoint, malformed JSON and a missing answers object all resolve to a failure with no value", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    const cases = [
      {
        name: "429",
        expected: "rate_limited",
        stub: async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
      },
      {
        name: "500",
        expected: "server_error",
        stub: async () => new Response("boom", { status: 503, statusText: "Service Unavailable" }),
      },
      {
        name: "401 without a usable key",
        expected: "unauthorized",
        stub: async () => new Response("no key", { status: 401, statusText: "Unauthorized" }),
      },
      {
        name: "timeout",
        expected: "timeout",
        stub: (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
        }),
      },
      {
        name: "loopback down",
        expected: "network_error",
        stub: async () => { throw new TypeError("fetch failed"); },
      },
      {
        name: "malformed json",
        expected: "malformed_json",
        stub: async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
      },
      {
        name: "missing answers",
        expected: "missing_answers",
        stub: async () => jsonResponse({ model: "jev-1.13.0", usage: { inputTokens: 1 } }),
      },
      {
        name: "answer for another question",
        expected: "missing_answers",
        stub: async () => jsonResponse({ model: "jev-1.13.0", answers: { other: { choice: "allow" } } }),
      },
      {
        name: "choice outside the option set",
        expected: "invalid_answer",
        stub: async (_url, init) => answered(init, { choice: "invented" }),
      },
    ];
    for (const testCase of cases) {
      await withStubbedFetch(testCase.stub, async () => {
        const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", model: "jev-1.13.0", timeoutMs: 25 });
        const outcome = await client.judge("state", "Is it safe?", { abstain: ABSTAIN });
        assert.equal(outcome.ok, false, testCase.name);
        assert.equal(outcome.reason, testCase.expected, testCase.name);
        assert.ok(module.isDecisionFailure(outcome), `${testCase.name} must be a DecisionFailure`);
        // The safety property: a classifier failure is never readable as a value.
        assert.equal("value" in outcome, false, `${testCase.name} must not carry a value`);
        assert.equal(outcome.cached, false);
        assert.equal(outcome.fallback, false);
        assert.equal(outcome.model, "jev-1.13.0");
        assert.ok(outcome.detail.length > 0);
        assert.throws(() => module.requireDecision(outcome), module.DecisionUnavailableError);
      });
    }

    // Caller cancellation is reported apart from a client timeout.
    const controller = new AbortController();
    await withStubbedFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080", timeoutMs: 5_000 });
      const promise = client.judge("state", "Is it safe?", { abstain: ABSTAIN, signal: controller.signal });
      controller.abort();
      const outcome = await promise;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, "aborted");
    });
  } finally {
    await loaded.dispose();
  }
});

test("an explicit fallback turns a failure into a visible, never-auto-accepted decision", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    await withStubbedFetch(async () => new Response("slow down", { status: 429 }), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const outcome = await client.judge("state", "Is it safe?", { abstain: ABSTAIN, fallback: () => false });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.fallback, true);
      assert.equal(outcome.fallbackReason, "rate_limited");
      assert.equal(outcome.band, "uncertain");
      assert.deepEqual(outcome.probabilities, {});
      assert.equal(outcome.confidence, null);
      // A failure is never cached, so a later success is still possible.
      assert.equal(client.cacheSize, 0);
    });
  } finally {
    await loaded.dispose();
  }
});

test("probabilities come back raw and unrounded, and the returned model is propagated with drift reported", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    const events = [];
    const probabilities = { allow: 0.1234567890123, block: 0.8765432109876, unclear: 1e-9 };
    await withStubbedFetch(async (_url, init) => answered(init, choiceResponse({ choice: "block", probabilities, confidence: 0.8765432109876, model: "jev-1.13.0-shadow-7" })), async () => {
      const client = module.createHttpDecisionClient({
        baseUrl: "http://127.0.0.1:8080",
        model: "jev-1.13.0",
        onEvent: (event) => { events.push(event); },
      });
      const outcome = await client.choose("state", [{ value: "allow", description: "Safe." }, { value: "block", description: "Unsafe." }], { abstain: ABSTAIN });
      assert.equal(outcome.ok, true);
      // No rounding, no renorm, no invented keys: exactly what the service sent.
      assert.deepEqual({ ...outcome.probabilities }, probabilities);
      assert.equal(outcome.probabilities.allow, 0.1234567890123);
      assert.equal(outcome.confidence, 0.8765432109876);
      // The model string the SERVICE returned, not the one we asked for.
      assert.equal(outcome.model, "jev-1.13.0-shadow-7");
      assert.notEqual(outcome.model, client.model);
      const responseEvent = events.find((event) => event.type === "response");
      assert.equal(responseEvent.requestedModel, "jev-1.13.0");
      assert.equal(responseEvent.returnedModel, "jev-1.13.0-shadow-7");
      assert.equal(responseEvent.drift, true);
    });

    // A response with no model field falls back to the pinned model instead of "undefined".
    await withStubbedFetch(async (_url, init) => answered(init, { choice: "true", probabilities: { true: 0.95, false: 0.05, unclear: 0 }, confidence: 0.95 }, ""), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const outcome = await client.judge("state", "Is it safe?", { abstain: ABSTAIN });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.model, "jev-1.13.0");
      assert.equal(outcome.value, true);
      assert.equal(outcome.band, "decide");
    });
  } finally {
    await loaded.dispose();
  }
});

test("the band policy escalates eagerly as the option set grows and honours the abstain floor", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    const probabilities = { true: 0.95, false: 0.03, unclear: 0.02 };
    const answeredStub = (choice, probs) => async (_url, init) => answered(init, choiceResponse({ choice, probabilities: probs, confidence: probs[choice] }));
    await withStubbedFetch(answeredStub("true", probabilities), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      // Binary at 0.95 confidence clears the 0.90 band and auto-accepts.
      const binary = await client.judge("state", "Is it safe?", { abstain: ABSTAIN });
      assert.equal(binary.ok, true);
      assert.equal(binary.value, true);
      assert.equal(binary.band, "decide");

      // The same option set, but the caller asks for a stricter band: escalate.
      const strict = await client.judge("state", "Is it safe?", { abstain: ABSTAIN, cache: false, band: { thresholds: { binary: 0.99 } } });
      assert.equal(strict.ok, true);
      assert.equal(strict.band, "uncertain");
    });

    // The same 0.62 confidence on a four-way question does not auto-accept.
    const fourWay = [
      { value: "allow", description: "Safe." },
      { value: "block", description: "Unsafe." },
      { value: "ask", description: "Ask a human." },
      { value: "retry", description: "Retry later." },
    ];
    const fourWayProbabilities = { allow: 0.62, block: 0.2, ask: 0.1, retry: 0.03, unclear: 0.05 };
    await withStubbedFetch(answeredStub("allow", fourWayProbabilities), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const multiWay = await client.choose("state", fourWay, { abstain: ABSTAIN });
      assert.equal(multiWay.ok, true);
      assert.equal(multiWay.band, "uncertain");
      // An explicit per-call threshold overrides the default. `cache: false` is required while the
      // band policy is not part of the cache key: the cached Decision stores the band it was
      // classified with, so without it a relaxed verdict would be replayed against a stricter
      // policy. See the TODO above `cacheKey` in decision-client.ts.
      const relaxed = await client.choose("state", fourWay, { abstain: ABSTAIN, cache: false, band: { thresholds: { multiWay: 0.6 } } });
      assert.equal(relaxed.ok, true);
      assert.equal(relaxed.band, "decide");
    });

    // 10% of the mass on the abstain option escalates even at a high confidence.
    await withStubbedFetch(
      async (_url, init) => answered(init, choiceResponse({ choice: "true", probabilities: { true: 0.88, false: 0.02, unclear: 0.1 }, confidence: 0.99 })),
      async () => {
        const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
        const outcome = await client.judge("state", "Is it safe?", { abstain: ABSTAIN });
        assert.equal(outcome.ok, true);
        assert.equal(outcome.band, "uncertain");
      },
    );

    // A model that takes the abstain option returns NO value at all.
    await withStubbedFetch(
      async (_url, init) => answered(init, choiceResponse({ choice: "unclear", probabilities: { true: 0.2, false: 0.1, unclear: 0.7 }, confidence: 0.7 })),
      async () => {
        const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
        const outcome = await client.judge("state", "Is it safe?", { abstain: ABSTAIN });
        assert.equal(outcome.ok, false);
        assert.equal(outcome.reason, "abstained");
        assert.equal(outcome.abstain, true);
        assert.equal(outcome.abstainValue, "unclear");
        assert.equal("value" in outcome, false);
        assert.equal(outcome.probabilities.unclear, 0.7);
        assert.ok(module.isDecisionAbstained(outcome));
      },
    );
  } finally {
    await loaded.dispose();
  }
});

test("the ordinal score primitive returns the raw fractional index and never auto-decides by default", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    const rubric = ["harmful", "neutral", "useful"];
    let captured;
    await withStubbedFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      const questionId = Object.keys(captured.questions)[0];
      return jsonResponse({ model: "jev-1.13.0", answers: { [questionId]: { score: 2.5 } } });
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const outcome = await client.score("state", rubric);
      assert.equal(outcome.ok, true);
      // Raw fractional index, no rounding and no invented probabilities.
      assert.equal(outcome.value, 2.5);
      assert.deepEqual({ ...outcome.probabilities }, {});
      assert.equal(outcome.confidence, null);
      assert.equal(outcome.band, "uncertain");
      assert.equal(captured.model, "jev-1.13.0");
      assert.deepEqual(captured.questions[Object.keys(captured.questions)[0]].criteria, rubric);
    });
    // A score outside the rubric is a failure, never a clamped index.
    await withStubbedFetch(async (_url, init) => answered(init, { score: 9 }), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const outcome = await client.score("state", rubric);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, "invalid_answer");
      assert.equal("value" in outcome, false);
    });
    assert.throws(() => module.buildScoreQuestion({ rubric: ["only one"] }), module.DecisionClientInputError);
  } finally {
    await loaded.dispose();
  }
});

test("the http client sends the pinned model, the bearer key, and refuses an unauthenticated remote or a floating alias", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let captured;
    await withStubbedFetch(async (_url, init) => {
      captured = { url: _url, init };
      return answered(init, choiceResponse({ choice: "allow", probabilities: { allow: 1 }, confidence: 1 }));
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "https://api.typesafe.ai/v1/", apiKey: "secret-key", model: "jev-1.13.0" });
      const outcome = await client.choose("state", [{ value: "allow", description: "Safe." }], { abstain: ABSTAIN, id: "review-42" });
      assert.equal(outcome.ok, true);
      assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(captured.init.method, "POST");
      assert.equal(captured.init.headers.authorization, "Bearer secret-key");
      assert.equal(captured.init.headers["content-type"], "application/json");
      const body = JSON.parse(captured.init.body);
      assert.equal(body.model, "jev-1.13.0");
      assert.equal(body.state, "state");
      assert.equal(Object.keys(body.questions)[0], "review-42");
      // The abstain option really is on the wire.
      assert.deepEqual(Object.keys(body.questions["review-42"].criteria).sort(), ["allow", "unclear"]);
    });
    // Loopback needs no key; a remote base URL without one is a config error, not an anonymous request.
    const loopback = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:9001" });
    assert.equal(loopback.baseUrl, "http://127.0.0.1:9001/systemone");
    assert.throws(() => module.createHttpDecisionClient({ baseUrl: "https://api.typesafe.ai/v1" }), module.DecisionClientConfigError);
    assert.throws(() => module.createHttpDecisionClient({ baseUrl: "https://api.typesafe.ai/v1", apiKey: "k", model: "jev-latest" }), /floating alias/);
    assert.throws(() => module.createHttpDecisionClient({ baseUrl: "ftp://127.0.0.1" }), module.DecisionClientConfigError);
    assert.equal(module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:9001" }).model, "jev-1.13.0");
  } finally {
    await loaded.dispose();
  }
});

test("judge() puts its question on the wire, so two questions over one state are different calls", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    const bodies = [];
    await withStubbedFetch(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return answered(init, choiceResponse({ choice: "true", probabilities: { true: 0.95, false: 0.03, unclear: 0.02 }, confidence: 0.96 }));
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const first = await client.judge("shared state", 'Is plugin "p-linear" the one the user wants?', { abstain: ABSTAIN });
      const second = await client.judge("shared state", 'Is plugin "p-github" the one the user wants?', { abstain: ABSTAIN });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      // Two questions, one state, two requests: before the fix the question never
      // reached the question object, both calls hashed to one cache key, and the
      // second was served the first one's answer marked `cached`.
      assert.equal(bodies.length, 2, "a different question is a different call");
      assert.equal(second.cached, false, "the second answer must not be the first one replayed");
      const questions = bodies.map((body) => body.questions[Object.keys(body.questions)[0]]);
      assert.match(questions[0].instructions, /Question: Is plugin "p-linear"/);
      assert.match(questions[1].instructions, /Question: Is plugin "p-github"/);
      assert.notEqual(questions[0].instructions, questions[1].instructions);
    });
  } finally {
    await loaded.dispose();
  }
});

test("cancelling one caller does not take the answer away from another caller waiting on the same question", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let requests = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const canceller = new AbortController();
    await withStubbedFetch(async (_url, init) => {
      requests += 1;
      // The first request is bound to `canceller`'s signal; the second caller must
      // not be waiting on it, or cancelling the first would decide the second.
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        gate.then(resolve);
      });
      return answered(init, choiceResponse({ choice: "true", probabilities: { true: 0.96, false: 0.03, unclear: 0.01 }, confidence: 0.97 }));
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      // Caching stays ON here, so merging is available and only the signal differs.
      const cancelled = client.judge("state", "Is it safe?", { abstain: ABSTAIN, signal: canceller.signal });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const survivor = client.judge("state", "Is it safe?", { abstain: ABSTAIN });
      canceller.abort();
      const cancelledOutcome = await cancelled;
      release();
      const survivorOutcome = await survivor;

      assert.equal(requests, 2, "the second caller must run its own request, not join a cancellable one");
      assert.equal(cancelledOutcome.ok, false);
      assert.equal(cancelledOutcome.reason, "aborted");
      assert.equal(survivorOutcome.ok, true, "the other caller's cancel must not decide this caller's answer");
      assert.equal(survivorOutcome.value, true);
    });
  } finally {
    await loaded.dispose();
  }
});

test("a caller without a fallback never receives the first caller's fallback value", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let requests = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await withStubbedFetch(async () => {
      requests += 1;
      await gate;
      return jsonResponse({ error: "upstream down" }, { status: 503 });
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      // Caching stays ON, so merging is available and only the fallback differs.
      const withFallback = client.judge("state", "Is it safe?", { abstain: ABSTAIN, fallback: () => false });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const withoutFallback = client.judge("state", "Is it safe?", { abstain: ABSTAIN });
      release();
      const first = await withFallback;
      const second = await withoutFallback;

      assert.equal(requests, 2, "a caller that supplied a fallback must not lend it to one that did not");
      assert.equal(first.ok, true);
      assert.equal(first.fallback, true);
      assert.equal(first.value, false);
      assert.equal(second.ok, false, "the caller without a fallback must see the failure");
      assert.equal(second.reason, "server_error");
    });
  } finally {
    await loaded.dispose();
  }
});

test("cache:false removes a call from request merging, not just from the cache", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let requests = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await withStubbedFetch(async (_url, init) => {
      requests += 1;
      await gate;
      return answered(init, choiceResponse({ choice: "true", probabilities: { true: 0.96 }, confidence: 0.97 }));
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const uncached = client.judge("state", "Is it safe?", { abstain: ABSTAIN, cache: false });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const alsoUncached = client.judge("state", "Is it safe?", { abstain: ABSTAIN, cache: false });
      release();
      await Promise.all([uncached, alsoUncached]);
      assert.equal(requests, 2, "two cache:false calls are two calls");
    });
  } finally {
    await loaded.dispose();
  }
});

test("concurrent identical calls still share one request when nothing about them differs", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    let requests = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await withStubbedFetch(async (_url, init) => {
      requests += 1;
      await gate;
      return answered(init, choiceResponse({ choice: "true", probabilities: { true: 0.96 }, confidence: 0.97 }));
    }, async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const first = client.judge("state", "Is it safe?", { abstain: ABSTAIN });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = client.judge("state", "Is it safe?", { abstain: ABSTAIN, id: "a-different-log-id" });
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(requests, 1, "the deduplication the cache key exists for must survive the fix");
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(b.cached, true);
    });
  } finally {
    await loaded.dispose();
  }
});

test("ternary and multiWay have no default threshold: an unmeasured confidence cannot auto-decide", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    assert.equal(module.DEFAULT_DECISION_BAND_THRESHOLDS.ternary, undefined);
    assert.equal(module.DEFAULT_DECISION_BAND_THRESHOLDS.multiWay, undefined);
    const threeWay = [
      { value: "allow", description: "Safe." },
      { value: "block", description: "Unsafe." },
      { value: "ask", description: "Ask a human." },
    ];
    const probabilities = { allow: 0.8, block: 0.15, ask: 0.03, unclear: 0.02 };
    await withStubbedFetch(async (_url, init) => answered(init, choiceResponse({ choice: "allow", probabilities, confidence: 0.99 })), async () => {
      const client = module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" });
      const outcome = await client.choose("state", threeWay, { abstain: ABSTAIN });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.band, "uncertain", "0.99 confidence is not evidence when the calibration was never measured");
      // A caller that measured its own shape can still opt in explicitly.
      const opted = await client.choose("state", threeWay, { abstain: ABSTAIN, cache: false, band: { thresholds: { ternary: 0.8 } } });
      assert.equal(opted.band, "decide");
    });
  } finally {
    await loaded.dispose();
  }
});

test("the default timeout is a ceiling a person can feel, not a quarter of a minute", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    assert.ok(module.DEFAULT_DECISION_TIMEOUT_MS <= 5_000, `default timeout is ${module.DEFAULT_DECISION_TIMEOUT_MS}ms`);
  } finally {
    await loaded.dispose();
  }
});

test("an error body echoing the API key never reaches a detail or a failure event", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    const key = "sk-live-SUPERSECRET-abc123";
    const events = [];
    await withStubbedFetch(
      async () => jsonResponse({ error: `invalid api key: ${key}` }, { status: 401 }),
      async () => {
        const client = module.createHttpDecisionClient({
          baseUrl: "https://api.typesafe.ai/v1",
          apiKey: key,
          model: "jev-1.13.0",
          onEvent: (event) => events.push(event),
        });
        const outcome = await client.judge("state", "Is it safe?", { abstain: ABSTAIN });
        assert.equal(outcome.ok, false);
        assert.equal(outcome.reason, "unauthorized");
        // The remote service is not obliged to keep our secrets out of its own
        // error text, so this detail is attacker-influenced and must be scrubbed
        // before anything logs it.
        assert.equal(JSON.stringify(outcome).includes(key), false, `the key leaked into the outcome: ${outcome.detail}`);
        assert.equal(JSON.stringify(events).includes(key), false, "the key leaked into an event");
        assert.match(outcome.detail, /\[redacted\]/);
      },
    );
  } finally {
    await loaded.dispose();
  }
});

test("a base URL carrying credentials is refused, and never echoed", async () => {
  const loaded = await loadDecisionClientModule();
  try {
    const { module } = loaded;
    // The sibling validateRemoteMcpUrl already forbids URL credentials; this layer
    // must not be the one place they get through.
    assert.throws(
      () => module.createHttpDecisionClient({ baseUrl: "https://user:hunter2@api.typesafe.ai/v1", apiKey: "k" }),
      module.DecisionClientConfigError,
    );
    assert.throws(
      () => module.createHttpDecisionClient({ baseUrl: "http://u:p@127.0.0.1:8080" }),
      module.DecisionClientConfigError,
    );
    // Loopback without credentials still constructs, so the rule is not "no URLs with an @".
    assert.equal(module.createHttpDecisionClient({ baseUrl: "http://127.0.0.1:8080" }).baseUrl, "http://127.0.0.1:8080/systemone");
  } finally {
    await loaded.dispose();
  }
});