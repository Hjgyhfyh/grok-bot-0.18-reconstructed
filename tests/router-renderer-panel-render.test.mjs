import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

import { parse } from "acorn";

import { COMPONENT_SOURCE } from "../scripts/lib/router-renderer-patch.mjs";

// `scripts/lib/router-renderer-patch.mjs` injects `COMPONENT_SOURCE` into the
// original renderer bundle. Until now nothing ever parsed or ran that text, so a
// syntax error in it and an infinite effect loop in it both shipped green. These
// tests parse it with acorn, apply static rules to every `useEffect`, and then
// execute it against a miniature React runtime.

const ast = parse(COMPONENT_SOURCE, { ecmaVersion: "latest" });

// ---------------------------------------------------------------------------
// Minimal ESTree plumbing
// ---------------------------------------------------------------------------

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw", "value"]);

function* childNodes(node) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item != null && typeof item === "object" && typeof item.type === "string") yield item;
    } else if (value != null && typeof value === "object" && typeof value.type === "string") {
      yield value;
    }
  }
}

function walk(node, visit) {
  if (node == null || typeof node !== "object" || typeof node.type !== "string") return;
  if (visit(node) === false) return;
  for (const child of childNodes(node)) walk(child, visit);
}

function buildParents(root) {
  const parents = new Map();
  walk(root, node => {
    for (const child of childNodes(node)) parents.set(child, node);
  });
  return parents;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const COMPARISON_OPERATORS = new Set(["===", "!==", "==", "!=", ">", "<", ">=", "<="]);

function isFunctionNode(node) {
  return node != null && typeof node.type === "string" && FUNCTION_TYPES.has(node.type);
}

function patternIdentifiers(node, into = new Set()) {
  if (node == null) return into;
  if (node.type === "Identifier") into.add(node.name);
  else if (node.type === "ObjectPattern") for (const property of node.properties) patternIdentifiers(property.type === "Property" ? property.value : property.argument ?? property, into);
  else if (node.type === "ArrayPattern") for (const element of node.elements) patternIdentifiers(element, into);
  else if (node.type === "AssignmentPattern") patternIdentifiers(node.left, into);
  else if (node.type === "RestElement") patternIdentifiers(node.argument, into);
  return into;
}

function rootIdentifier(node) {
  let current = node;
  while (current != null) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") current = current.object;
    else if (current.type === "CallExpression") current = current.callee;
    else return null;
  }
  return null;
}

function inferKind(node) {
  if (node == null) return "unknown";
  switch (node.type) {
    case "Literal":
      return typeof node.value === "boolean" ? "boolean"
        : typeof node.value === "string" ? "string"
          : typeof node.value === "number" ? "number"
            : "unknown";
    case "TemplateLiteral":
      return "string";
    case "UnaryExpression":
      return node.operator === "!" ? "boolean" : "number";
    case "BinaryExpression":
      return COMPARISON_OPERATORS.has(node.operator) ? "boolean" : "number";
    case "LogicalExpression": {
      const left = inferKind(node.left);
      return left === inferKind(node.right) ? left : "unknown";
    }
    case "ConditionalExpression": {
      const consequent = inferKind(node.consequent);
      return consequent === inferKind(node.alternate) ? consequent : "unknown";
    }
    case "ArrayExpression":
      return "array";
    case "ObjectExpression":
      return "object";
    case "SequenceExpression":
      return inferKind(node.expressions[node.expressions.length - 1]);
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      const body = node.body;
      if (body.type !== "BlockStatement") return inferKind(body);
      const statements = body.body;
      const returns = statements.filter(statement => statement.type === "ReturnStatement");
      if (statements.length !== 1 || returns.length !== 1) return "unknown";
      return inferKind(returns[0].argument);
    }
    default:
      return "unknown";
  }
}

function describe(node) {
  return COMPONENT_SOURCE.slice(node.start, node.end);
}

function components() {
  return ast.body.filter(node => node.type === "FunctionDeclaration");
}

function useStateSlots(component) {
  const slots = [];
  walk(component, node => {
    if (node.type !== "VariableDeclarator") return;
    if (node.id.type !== "ArrayPattern" || node.id.elements.length < 2) return;
    const initializer = node.init;
    const isUseState = initializer != null && initializer.type === "CallExpression"
      && ((initializer.callee.type === "MemberExpression" && initializer.callee.property.name === "useState")
        || (initializer.callee.type === "Identifier" && initializer.callee.name === "useState"));
    if (!isUseState) return;
    const [value, setter] = node.id.elements;
    if (value.type !== "Identifier" || setter.type !== "Identifier") return;
    slots.push({ value: value.name, setter: setter.name, initializer: initializer.arguments[0] ?? null, at: node });
  });
  return slots;
}

function useEffectCalls(component) {
  const calls = [];
  walk(component, node => {
    if (node.type !== "CallExpression") return;
    const isUseEffect = node.callee.type === "MemberExpression" && node.callee.property.name === "useEffect";
    if (!isUseEffect) return;
    calls.push(node);
  });
  return calls;
}

function assignedNames(node) {
  const names = new Set();
  walk(node, current => {
    if (current.type === "AssignmentExpression") for (const name of patternIdentifiers(current.left)) names.add(name);
    else if (current.type === "UpdateExpression" && current.argument.type === "Identifier") names.add(current.argument.name);
  });
  return names;
}

const GUARD_TYPES = new Set([
  "IfStatement", "ConditionalExpression", "LogicalExpression", "SwitchStatement",
  "SwitchCase", "CatchClause", "WhileStatement", "DoWhileStatement", "ForStatement",
  "ForInStatement", "ForOfStatement",
]);

function isGuarded(node, component, parents) {
  let current = node;
  while (current != null && current !== component) {
    if (GUARD_TYPES.has(current.type)) return true;
    current = parents.get(current);
  }
  return false;
}

function enclosingFunction(node, parents) {
  let current = parents.get(node);
  while (current != null) {
    if (isFunctionNode(current)) return current;
    current = parents.get(current);
  }
  return null;
}

const parents = buildParents(ast);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("the injected panel source parses as JavaScript", () => {
  assert.equal(ast.type, "Program");
  assert.ok(ast.body.length > 5, `expected a populated program, parsed ${ast.body.length} top-level statements`);
  assert.ok(
    components().length >= 5,
    `expected the panel components to survive parsing, found ${components().length} top-level functions`,
  );
});

test("the parser used above really rejects broken input", () => {
  // Guards the parse test from passing on an empty or truncated source.
  assert.throws(() => parse("function RRouterPanel(){return a.jsx(Te,{", { ecmaVersion: "latest" }));
  assert.throws(() => parse(COMPONENT_SOURCE.slice(0, COMPONENT_SOURCE.length - 20), { ecmaVersion: "latest" }));
});

// ---------------------------------------------------------------------------
// Static rules over every useEffect
// ---------------------------------------------------------------------------

test("every useEffect passes an explicit dependency array", () => {
  const calls = components().flatMap(component => useEffectCalls(component));
  assert.ok(calls.length >= 4, `expected the panel to contain several effects, found ${calls.length}`);
  for (const call of calls) {
    assert.equal(
      call.arguments.length,
      2,
      `useEffect with ${call.arguments.length} arguments runs on EVERY render: ${describe(call.arguments[0]).slice(0, 120)}`,
    );
    assert.equal(call.arguments[1].type, "ArrayExpression", `useEffect dependency list must be an array literal: ${describe(call)}`);
  }
});

test("no useEffect dependency is assigned inside its own effect body", () => {
  for (const component of components()) {
    const stateValues = new Set(useStateSlots(component).map(slot => slot.value));
    for (const call of useEffectCalls(component)) {
      const assigned = assignedNames(call.arguments[0]);
      const dependencies = call.arguments[1].elements;
      for (const dependency of dependencies) {
        assert.notEqual(
          dependency.type,
          "ArrayExpression",
          `a freshly allocated array dependency has a new identity on every render: ${describe(dependency)}`,
        );
        assert.notEqual(
          dependency.type,
          "ObjectExpression",
          `a freshly allocated object dependency has a new identity on every render: ${describe(dependency)}`,
        );
        const name = rootIdentifier(dependency);
        if (name == null) continue;
        assert.ok(
          !assigned.has(name),
          `useEffect depends on ${JSON.stringify(name)} but also assigns it inside the effect body, ` +
            `so every run invalidates its own dependencies and the effect loops forever`,
        );
      }
      if (dependencies.length === 0) {
        const reads = new Set();
        walk(call.arguments[0], node => {
          if (node.type !== "Identifier") return;
          reads.add(node.name);
        });
        const readsState = [...reads].filter(name => stateValues.has(name));
        assert.deepEqual(
          readsState,
          [],
          `an effect with an empty dependency list that reads component state ${JSON.stringify(readsState)} ` +
            "never re-runs and shows stale data",
        );
      }
    }
  }
});

test("no state is set to a freshly allocated array or object on every render", () => {
  for (const component of components()) {
    const setters = new Set(useStateSlots(component).map(slot => slot.setter));
    walk(component, node => {
      if (node.type !== "CallExpression") return;
      if (node.callee.type !== "Identifier" || !setters.has(node.callee.name)) return;
      if (enclosingFunction(node, parents) !== component) return;
      const argument = node.arguments[0];
      if (argument == null) return;
      assert.ok(
        !["ArrayExpression", "ObjectExpression"].includes(argument.type) || isGuarded(node, component, parents),
        `rendering ${component.id.name} always calls ${node.callee.name}(${describe(argument).slice(0, 80)}); ` +
          "a new identity every render re-renders this component forever",
      );
    });
  }
});

test("a boolean state flag is only ever set to a boolean, and is always cleared again", () => {
  for (const component of components()) {
    for (const slot of useStateSlots(component)) {
      if (inferKind(slot.initializer) !== "boolean") continue;
      const values = [];
      walk(component, node => {
        if (node.type !== "CallExpression") return;
        if (node.callee.type !== "Identifier" || node.callee.name !== slot.setter) return;
        values.push({ at: node, kind: inferKind(node.arguments[0]) });
      });
      assert.ok(values.length > 0, `${component.id.name} declares the boolean flag ${slot.setter} but never sets it`);
      for (const value of values) {
        assert.equal(
          value.kind,
          "boolean",
          `${component.id.name} sets the boolean flag ${slot.setter} to ${describe(value.at.arguments[0])}; ` +
            "a truthy string locks the control forever instead of clearing it",
        );
      }
      if (values.some(value => value.kind === "boolean" && value.at.arguments[0].value === true)) {
        assert.ok(
          values.some(value => value.kind === "boolean" && value.at.arguments[0].value === false),
          `${component.id.name} raises the boolean flag ${slot.setter} but never lowers it, so the control stays disabled`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Executing the injected source against a miniature React runtime
// ---------------------------------------------------------------------------

const EXPORTED = [
  "RRouterProviders", "RRouterOptions", "RRouterEmptyUsage", "RRouterIsKeyed",
  "RRouterCredentialTitle", "RRouterCredentialLabel", "RRouterCredentialDescription",
  "RRouterModelState", "RRouterModelHost", "RRouterModelProbe", "RRouterModelOptions",
  "RRouterModelReason", "RRouterModelListing", "RRouterModelAbsent", "RRouterModelStatusText",
  "RRouterModelSelect", "RRouterState", "RRouterSecrets", "RRouterNumber",
  "RRouterCredential", "RBoxRuntime", "RRouterPanel", "RRouterUsageSummary", "RRouterUsage",
];

function createHookRuntime() {
  const state = { values: [], inits: [], calls: [], cursor: 0 };
  state.de = {
    useState(initial) {
      const slot = state.cursor;
      state.cursor += 1;
      if (slot >= state.values.length) {
        state.inits[slot] = typeof initial === "function" ? initial() : initial;
        state.values[slot] = state.inits[slot];
      }
      const setValue = (...args) => {
        state.calls.push({ slot, args });
        state.values[slot] = typeof args[0] === "function" ? args[0](state.values[slot]) : args[0];
      };
      return [state.values[slot], setValue];
    },
    useEffect() {},
    useLayoutEffect() {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: initial => ({ current: initial }),
  };
  return state;
}

function createBridge() {
  const bridge = { setInferenceRouter: [], setBoxRuntime: [], upserts: [], events: [] };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) {
      bridge.events.push(event);
      return true;
    },
    desktop: {
      agent: {
        getInferenceRouter: async () => ({ provider: "custom", usage: null, local: null, endpoint: null, error: null }),
        setInferenceRouter: async (provider, endpoint) => {
          bridge.setInferenceRouter.push({ provider, endpoint });
          if (bridge.failNextSet) throw new Error("settings store rejected the endpoint");
          return { provider, endpoint, usage: null, local: null };
        },
        listInferenceRouterModels: async () => ({ endpoint: "", models: [] }),
        getBoxRuntime: async () => ({ mode: "remote", status: null }),
        setBoxRuntime: async mode => {
          bridge.setBoxRuntime.push(mode);
          return { mode, status: null };
        },
      },
      secrets: {
        list: async () => ({ keys: [] }),
        upsert: async value => { bridge.upserts.push(value); },
      },
    },
  };
  return { bridge, window };
}

// The injected source is a fragment of the minified original bundle: its UI
// primitives (`se`, `ie`, `re`, `Te`, `ye`, `oe`, `Na`, ...) are free variables
// that the real renderer chunk supplies. They are discovered from the AST and
// stubbed as component tags, so a future rename does not break this harness and
// a genuinely new free variable shows up in the tree instead of throwing.
const PROVIDED_GLOBALS = new Set([
  "a", "de", "window", "k", "CustomEvent", "console", "setTimeout", "clearTimeout",
  "URL", "Intl", "__routerPanels", "Object", "Array", "JSON", "Math", "Promise",
  "String", "Number", "Boolean", "Error", "TypeError", "Date", "RegExp", "Map",
  "Set", "WeakMap", "Symbol", "globalThis", "undefined", "NaN", "Infinity",
  "isNaN", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
]);

function boundNames() {
  const names = new Set();
  walk(ast, node => {
    if (node.type === "VariableDeclarator") for (const name of patternIdentifiers(node.id)) names.add(name);
    else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id?.name != null) names.add(node.id.name);
      for (const parameter of node.params) for (const name of patternIdentifiers(parameter)) names.add(name);
    } else if (node.type === "CatchClause") {
      for (const name of patternIdentifiers(node.param)) names.add(name);
    }
  });
  return names;
}

function collectReferences(node, names) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, names);
    return;
  }
  if (typeof node.type !== "string") return;
  if (node.type === "Identifier") {
    names.add(node.name);
    return;
  }
  if (node.type === "MemberExpression") {
    collectReferences(node.object, names);
    if (node.computed) collectReferences(node.property, names);
    return;
  }
  if (node.type === "Property") {
    if (node.computed) collectReferences(node.key, names);
    collectReferences(node.value, names);
    return;
  }
  for (const child of childNodes(node)) collectReferences(child, names);
}

function freeComponentTags() {
  const referenced = new Set();
  collectReferences(ast, referenced);
  const bound = boundNames();
  return [...referenced].filter(name => !bound.has(name) && !PROVIDED_GLOBALS.has(name)).sort();
}

function evaluatePanelSource(runtime = createHookRuntime()) {
  const { bridge, window } = createBridge();
  const panels = {};
  const sandbox = {
    __routerPanels: panels,
    de: runtime.de,
    a: {
      jsx: (type, props) => ({ type, props: props ?? {} }),
      jsxs: (type, props) => ({ type, props: props ?? {} }),
      Fragment: "Fragment",
    },
    k: (...names) => names.join(" "),
    window,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    URL,
    Intl,
    setTimeout,
    clearTimeout,
    console,
  };
  for (const tag of freeComponentTags()) sandbox[tag] = tag;
  createContext(sandbox);
  const assignments = EXPORTED.map(name => `__routerPanels.${name}=${name};`).join("");
  runInContext(`${COMPONENT_SOURCE}\n;${assignments}`, sandbox, { filename: "router-panel-source.js" });
  return { panels, bridge, runtime };
}

function collectElements(node, out = [], seen = new Set()) {
  if (node == null || typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, out, seen);
    return out;
  }
  if (typeof node.type === "string" && node.props != null && typeof node.props === "object") {
    out.push(node);
    for (const value of Object.values(node.props)) collectElements(value, out, seen);
    return out;
  }
  for (const value of Object.values(node)) collectElements(value, out, seen);
  return out;
}

function inputNamed(elements, label) {
  const found = elements.filter(element => element.props["aria-label"] === label);
  assert.equal(found.length, 1, `expected exactly one input labelled ${JSON.stringify(label)}, found ${found.length}`);
  return found[0];
}

function buttonLabelled(elements, label) {
  const found = elements.filter(element => element.props.children === label);
  assert.ok(found.length >= 1, `expected a button labelled ${JSON.stringify(label)}`);
  return found[0];
}

// Values produced inside the vm carry that realm's prototypes, so they are copied
// into host objects before any structural comparison.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// One evaluated copy of the injected source, shared by every execution test. The
// `de` global has to be the very runtime object the panel calls into, so the
// runtime is created first and handed to the evaluator.
const harness = evaluatePanelSource();
harness.saved = [];

test("the injected panel source executes and exposes its router components", () => {
  const { panels } = harness;
  assert.equal(typeof panels.RRouterPanel, "function");
  assert.equal(typeof panels.RRouterUsage, "function");
  assert.equal(typeof panels.RRouterCredential, "function");
  assert.deepEqual(
    Array.from(panels.RRouterProviders, provider => provider.value),
    ["claude-code", "codex", "openrouter", "custom"],
    "the Cursor provider is gone: no entry may route a turn into an account-backed provider that cannot answer",
  );
  assert.equal(
    panels.RRouterProviders.some(provider => provider.kind === "account"),
    false,
    "no provider may claim an account-backed credential now that the Cursor entry is removed",
  );
  assert.equal(panels.RRouterIsKeyed(panels.RRouterProviders.find(p => p.value === "custom")), true);
  assert.equal(panels.RRouterCredentialTitle(panels.RRouterProviders.find(p => p.value === "openrouter")), "OpenRouter account");
});

const CUSTOM_PROVIDER_STATE = {
  provider: "custom",
  usage: null,
  local: null,
  endpoint: { baseUrl: "https://api.example.com/v1", modelId: "my-model" },
  error: null,
};

// `reset` mounts a fresh component, so every test starts from the stored settings
// instead of inheriting the previous test's edits. Passing `reset: false` re-renders
// the same component, which is what a React state update looks like.
function renderCustomCredential(state = CUSTOM_PROVIDER_STATE, { reset = true } = {}) {
  // React rewinds its hook cursor on every render and keeps the slot values;
  // `reset` additionally drops the slots, which is a fresh mount.
  harness.runtime.cursor = 0;
  if (reset) {
    harness.runtime.values.length = 0;
    harness.runtime.inits.length = 0;
    harness.saved.length = 0;
  }
  harness.runtime.calls.length = 0;
  const provider = harness.panels.RRouterProviders.find(entry => entry.value === "custom");
  const saved = harness.saved;
  const tree = harness.panels.RRouterCredential({
    provider,
    state,
    keys: ["OPENAI_COMPATIBLE_API_KEY"],
    onSaved: () => saved.push(true),
  });
  return { elements: collectElements(tree), provider, saved };
}

function busySlot() {
  const slot = harness.runtime.inits.findIndex(value => value === false);
  assert.ok(slot >= 0, "the custom credential must declare a boolean busy flag initialised to false");
  return slot;
}

test("the custom credential renders its base URL, model id and an enabled Save button", () => {
  const { elements } = renderCustomCredential();
  assert.equal(inputNamed(elements, "Endpoint base URL").props.value, "https://api.example.com/v1");
  assert.equal(inputNamed(elements, "Endpoint model id").props.value, "my-model");
  assert.equal(inputNamed(elements, "OPENAI_COMPATIBLE_API_KEY").props.value, "");
  assert.equal(buttonLabelled(elements, "Save").props.disabled, false);
});

test("editing the endpoint inputs writes through component state", () => {
  const mounted = renderCustomCredential().elements;
  inputNamed(mounted, "Endpoint model id").props.onChange({ currentTarget: { value: "edited-model" } });
  const afterModel = renderCustomCredential(undefined, { reset: false }).elements;
  assert.equal(inputNamed(afterModel, "Endpoint model id").props.value, "edited-model");
  assert.equal(inputNamed(afterModel, "Endpoint base URL").props.value, "https://api.example.com/v1");

  inputNamed(afterModel, "Endpoint base URL").props.onChange({ currentTarget: { value: "https://edited.example/v1" } });
  const afterBase = renderCustomCredential(undefined, { reset: false }).elements;
  assert.equal(inputNamed(afterBase, "Endpoint base URL").props.value, "https://edited.example/v1");
  assert.equal(inputNamed(afterBase, "Endpoint model id").props.value, "edited-model");

  inputNamed(afterBase, "OPENAI_COMPATIBLE_API_KEY").props.onChange({ currentTarget: { value: "sk-typed-by-user" } });
  const afterKey = renderCustomCredential(undefined, { reset: false }).elements;
  assert.equal(inputNamed(afterKey, "OPENAI_COMPATIBLE_API_KEY").props.value, "sk-typed-by-user");
});

test("saving the custom endpoint raises and then clears the busy flag", async () => {
  harness.bridge.failNextSet = false;
  harness.bridge.setInferenceRouter.length = 0;
  harness.bridge.upserts.length = 0;
  harness.bridge.events.length = 0;
  const { elements, saved } = renderCustomCredential();
  inputNamed(elements, "OPENAI_COMPATIBLE_API_KEY").props.onChange({ currentTarget: { value: "sk-typed-by-user" } });

  const slot = busySlot();
  const button = buttonLabelled(renderCustomCredential(undefined, { reset: false }).elements, "Save");
  assert.equal(button.props.disabled, false);
  await button.props.onClick();

  const calls = harness.runtime.calls.filter(call => call.slot === slot);
  assert.ok(calls.length >= 2, `the busy flag must be raised before the await and cleared after it, saw ${calls.length} writes`);
  for (const call of calls) {
    assert.ok(
      typeof call.args[0] === "boolean",
      `the busy flag is boolean state, but it was set to ${JSON.stringify(call.args[0])}; ` +
        "a truthy string keeps the Save button disabled forever",
    );
  }
  assert.ok(calls.some(call => call.args[0] === true), `the busy flag was never raised: ${JSON.stringify(calls.map(c => c.args[0]))}`);
  assert.ok(calls.some(call => call.args[0] === false), `the busy flag was never cleared: ${JSON.stringify(calls.map(c => c.args[0]))}`);
  assert.equal(harness.runtime.values[slot], false, "the busy flag must be false once the save resolves");

  assert.deepEqual(plain(harness.bridge.setInferenceRouter), [{
    provider: "custom",
    endpoint: { baseUrl: "https://api.example.com/v1", modelId: "my-model" },
  }]);
  assert.deepEqual(plain(harness.bridge.upserts), [{ OPENAI_COMPATIBLE_API_KEY: "sk-typed-by-user" }]);
  assert.equal(saved.length, 1, "the panel must be told to refresh the stored key list");
  assert.equal(harness.bridge.events.length, 1);
  assert.equal(harness.bridge.events[0].type, "sand-router-provider-changed");
  assert.equal(harness.bridge.events[0].detail.error, null);
});

test("a failed save still clears the busy flag", async () => {
  harness.bridge.failNextSet = true;
  harness.bridge.events.length = 0;
  const { elements } = renderCustomCredential();
  const button = buttonLabelled(elements, "Save");
  await button.props.onClick();
  harness.bridge.failNextSet = false;

  const slot = busySlot();
  const writes = harness.runtime.calls.filter(call => call.slot === slot).map(call => call.args[0]);
  assert.ok(writes.includes(true), "the busy flag must be raised before the request");
  assert.equal(harness.runtime.values[slot], false, "the busy flag must be cleared even when the save fails");
  assert.equal(harness.bridge.events.length, 1);
  assert.match(String(harness.bridge.events[0].detail.error), /settings store rejected the endpoint/);
});
