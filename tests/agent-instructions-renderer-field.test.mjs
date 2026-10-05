/**
 * An agent's instructions were stored correctly and had no box to live in.
 *
 * The host half is proved in `agent-instructions-reach-the-interface.test.mjs`: the
 * text reaches `instructions.md`, survives a rename, a lost profile and a restart,
 * and comes back on the roster row under `instructions`. None of that is visible.
 * The agent dialog is `h3n` in `index-lA9cgT4O.js`, and it is the one surface that
 * already edits the other two things an agent IS — it renders "Name", "Title" and
 * "Description" through the same `Uwe` field and commits each through `updateAgent`.
 * Instructions were the fourth field and they were absent, with no error: the dialog
 * rendered, the agent obeyed the brief, and the screen showed three short boxes and
 * no sign that a fourth existed. A user who wrote one could not read it back, could
 * not change it, and could not delete it.
 *
 * The tests here are about a bundle and not about a running window. They prove the
 * patch finds its two anchors in the shipped chunk exactly once each, that it
 * refuses a chunk where either is missing or duplicated instead of half-applying,
 * that the chunk it produces still parses, and — by executing the injected code
 * against a miniature React — that the field it renders seeds from the property the
 * server sends and saves a patch that leaves the other two fields alone.
 *
 * What they do NOT prove: that a live window paints this. That is what a window is
 * for, and this suite cannot see one.
 */
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

import {
  AGENT_INSTRUCTIONS_COMPONENT_SOURCE,
  patchOriginalAgentInstructionsField,
  patchOriginalSettingsRegistry,
  patchOriginalSignInGate,
  patchOriginalAccountSlot,
  patchOriginalThreadSurfaces,
} from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_CHUNK = path.join(repoRoot, "src", "app", "dist", "renderer", "assets", "index-lA9cgT4O.js");
const PANEL_CHUNK = path.join(repoRoot, "src", "app", "dist", "renderer", "assets", "index-BoDVc20G.js");

/** The shipped bytes this patch anchors on. Each occurs once in the registry chunk. */
const SETTINGS_HEAD =
  'function h3n(n){const e=he.c(31),{agent:t,onNameChange:s,onTitleChange:r,onDescriptionChange:i}=n,o=Qe().roster,{run:l,isPending:c}=lr(o.setAgentNotifyOnUpdates),u=S.useId();';
const DESCRIPTION_FIELD =
  'let N;e[13]!==t.description||e[14]!==i?(N=p.jsx(Uwe,{ariaLabel:"Agent description",initialValue:t.description,isMultiline:!0,onCommit:i,placeholder:"What this agent is for"}),e[13]=t.description,e[14]=i,e[15]=N):N=e[15];';

const registryChunk = readFileSync(REGISTRY_CHUNK, "utf8");
const panelChunk = readFileSync(PANEL_CHUNK, "utf8");
// The whole registry transform chain, in the order `applyOriginalRendererRouterPatch`
// runs it, so this test exercises the chunk as the build writes it rather than one
// transform applied alone.
const patchedRegistryChunk = [
  patchOriginalSettingsRegistry,
  patchOriginalSignInGate,
  patchOriginalAccountSlot,
  patchOriginalThreadSurfaces,
  patchOriginalAgentInstructionsField,
].reduce((source, transform) => transform(source), registryChunk);

function occurrences(source, needle) {
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Minimal ESTree plumbing. The free-variable list is computed from the AST rather
// than written by hand: a hand-written list goes stale the moment this patch is
// touched, and then it proves nothing.
// ---------------------------------------------------------------------------

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw", "value"]);

function* childNodes(node) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && typeof item === "object" && typeof item.type === "string") yield item;
      }
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

function patternIdentifiers(pattern, into = new Set()) {
  if (pattern == null) return into;
  if (pattern.type === "Identifier") into.add(pattern.name);
  else if (pattern.type === "RestElement") patternIdentifiers(pattern.argument, into);
  else if (pattern.type === "AssignmentPattern") patternIdentifiers(pattern.left, into);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) patternIdentifiers(property.type === "RestElement" ? property : property.value, into);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) patternIdentifiers(element, into);
  return into;
}

/** Names this source declares: variables, function names, parameters, catch names. */
function declaredNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator") {
      for (const name of patternIdentifiers(node.id)) names.add(name);
    } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id?.name != null) names.add(node.id.name);
      for (const parameter of node.params) for (const name of patternIdentifiers(parameter)) names.add(name);
    } else if (node.type === "CatchClause") {
      for (const name of patternIdentifiers(node.param)) names.add(name);
    }
  });
  return names;
}

/** Every identifier this source reads, including inside member expressions. */
function collectReferences(node, names) {
  if (node == null || typeof node !== "object") return names;
  if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, names);
    return names;
  }
  if (typeof node.type !== "string") return names;
  if (node.type === "Identifier") {
    names.add(node.name);
    return names;
  }
  // `S.useState` reads `S`; `useState` is a property of it, not a name in scope.
  // Same for a shorthand `{name}`: the key is a property, the value is the variable.
  if (node.type === "MemberExpression") {
    collectReferences(node.object, names);
    if (node.computed) collectReferences(node.property, names);
    return names;
  }
  if (node.type === "Property") {
    if (node.computed) collectReferences(node.key, names);
    collectReferences(node.value, names);
    return names;
  }
  for (const child of childNodes(node)) collectReferences(child, names);
  return names;
}

/** Names this source reads that it does not declare, minus the language globals. */
function freeNames(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest" });
  const declared = declaredNames(ast);
  const referenced = collectReferences(ast, new Set());
  return [...referenced].filter((name) => !declared.has(name) && !LANGUAGE_GLOBALS.has(name)).sort();
}

const LANGUAGE_GLOBALS = new Set([
  "undefined", "null", "true", "false", "Object", "Array", "JSON", "Math", "Promise",
  "String", "Number", "Boolean", "Error", "TypeError", "Date", "RegExp", "Map", "Set",
  "Symbol", "globalThis", "NaN", "Infinity",
]);

// ---------------------------------------------------------------------------
// A miniature React, shaped like the bundle's own bindings.
// ---------------------------------------------------------------------------

function createHookRuntime() {
  const state = [];
  let index = 0;
  const de = {
    // A render pass starts over: without this the second pass would allocate new
    // state slots and the setState from the first pass would never be read back.
    begin() { index = 0; },
    useState(initial) {
      const slot = index;
      index += 1;
      if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial;
      return [state[slot], (next) => {
        state[slot] = typeof next === "function" ? next(state[slot]) : next;
      }];
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  return de;
}

/** `lr` as the bundle defines it: a run that answers `{ok,value}` / `{ok,error}`. */
function createMutationWrapper() {
  return (fn) => ({
    run: async (...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    isPending: false,
  });
}

/**
 * Renders `RpAgentInstructions` the way React would.
 *
 * React calls a component during reconciliation, not inside `jsx()`, so the stubs
 * answer with a marked node and the walker invokes them. The returned `render` can
 * be called again after a save: that is how a `setState` from a `useCallback` is
 * observed, and a harness that only ever rendered once would make every assertion
 * about a post-save message vacuous.
 */
function createFieldRenderer({ agent, roster, runtime = createHookRuntime() }) {
  const sandbox = {
    S: { ...runtime, useRef: (initial) => ({ current: initial }) },
    p: {
      jsx: (type, props) => ({ type, props: props ?? {} }),
      jsxs: (type, props) => ({ type, props: props ?? {} }),
      Fragment: "Fragment",
    },
    lr: createMutationWrapper(),
    Uwe: function UweStub(props) { return { role: "field", props }; },
    vt: function TextStub(props) { return { role: "text", props }; },
  };
  const context = createContext(sandbox);
  runInContext(
    `${AGENT_INSTRUCTIONS_COMPONENT_SOURCE}\n;__field=RpAgentInstructions;`,
    context,
    { filename: "agent-instructions-source.js" },
  );

  const render = () => {
    runtime.begin();
    const tree = context.__field({ agent, roster });
    const nodes = [];
    const visit = (node) => {
      if (node == null || typeof node === "boolean") return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (typeof node !== "object") return;
      if (typeof node.type === "function") {
        visit(node.type(node.props ?? {}));
        return;
      }
      const role = typeof node.role === "string" ? node.role : String(node.type);
      nodes.push({ role, props: node.props ?? {} });
      visit(node.props?.children);
    };
    visit(tree);
    return {
      tree,
      nodes,
      fields: nodes.filter((node) => node.role === "field").map((node) => node.props),
      texts: nodes.filter((node) => node.role === "text").map((node) => node.props),
    };
  };
  return render;
}

function renderInstructionsField(options) {
  return createFieldRenderer(options)();
}

// `Uwe` takes `ariaLabel` and maps it to the DOM `aria-label` itself, so the stub
// records the prop the patch passes, not the attribute the user sees.
const fieldNamed = (fields, label) => fields.filter((field) => field.ariaLabel === label);
const textValues = (texts) => texts.map((text) => text.children);
/** Every string anywhere in the rendered tree, whatever element carries it. */
const allStrings = (nodes) => nodes.flatMap((node) => {
  if (typeof node.props?.children === "string") return [node.props.children];
  if (Array.isArray(node.props?.children)) return node.props.children.filter((child) => typeof child === "string");
  return [];
});

// ---------------------------------------------------------------------------

test("the agent settings dialog carries an Instructions field after the patch", () => {
  assert.equal(occurrences(registryChunk, SETTINGS_HEAD), 1,
    "the settings component anchor is not a single unambiguous match in the shipped chunk, so the patch would be a no-op or would hit the wrong one");
  assert.equal(occurrences(registryChunk, DESCRIPTION_FIELD), 1,
    "the description field anchor is not a single unambiguous match, so the instructions field has nowhere to be attached");
  assert.equal(patchedRegistryChunk.includes(SETTINGS_HEAD), false,
    "the shipped settings component is untouched, so the dialog still renders exactly the three fields it always did");

  assert.equal(patchedRegistryChunk.includes("p.jsx(RpAgentInstructions,{agent:t,roster:o})"), true,
    "the patched dialog never renders the instructions field, so a brief written on the server is still not shown");
  assert.equal(patchedRegistryChunk.includes('children:"Instructions"'), true,
    "the field is rendered with no label, so a user with four boxes on screen cannot tell which one is the brief");
  assert.equal(patchedRegistryChunk.includes('ariaLabel:"Agent instructions"'), true,
    "the field has no accessible name, so it cannot be found by a screen reader or by a test that looks for what a user is told");
});

test("the instructions field re-renders when the stored brief changes", () => {
  // `h3n`'s nodes are memoised against `he.c(31)`. A row that comes back with the
  // same name and the same description and a DIFFERENT brief compares equal on every
  // existing slot, so React reuses the identical element and never re-renders the
  // field: the save succeeds, the host writes the file, and the box keeps showing
  // the previous text until the dialog is closed and reopened.
  assert.equal(patchedRegistryChunk.includes("function h3n(n){const e=he.c(32)"), true,
    "the settings component still sizes its memo cache for 31 slots, so the injected dependency reads a slot React never filled with its -1 sentinel");
  assert.equal(patchedRegistryChunk.includes("e[14]!==i||e[31]!==t.instructions"), true,
    "the description node does not depend on the stored brief, so the field is never rebuilt when a save changes it");
  assert.equal(patchedRegistryChunk.includes('initialValue:e.instructions??""'), true,
    "the field is not seeded from the stored brief, so the extra dependency re-renders a box that still holds nothing");
});

test("the field renders the stored brief and saves it without touching the other fields", async () => {
  const saves = [];
  const agent = {
    id: "agent-1",
    name: "Аудитор проектов",
    description: "Проверяет чужие проекты",
    instructions: "Report every finding as one table row.",
    instructionsError: null,
    isGroup: false,
  };
  const roster = { updateAgent: async (id, patch) => { saves.push({ id, patch }); return { ok: true }; } };
  const { fields, nodes } = renderInstructionsField({ agent, roster });

  const rendered = fieldNamed(fields, "Agent instructions");
  assert.equal(rendered.length, 1,
    "the brief is not rendered as one editable field, so there is no box to type into");
  assert.equal(rendered[0].initialValue, "Report every finding as one table row.",
    "the box is empty for an agent that has a brief, so the user reads the agent as having none");
  assert.equal(rendered[0].isMultiline, true,
    "the field is single-line, so the one field meant for free text cannot hold a paragraph");
  assert.equal(allStrings(nodes).includes("Instructions"), true,
    "the field has no visible label, so a user cannot tell which of the boxes is the brief");
  assert.equal(allStrings(nodes).includes("Read by this agent on every turn."), true,
    "the field gives no hint about when the brief takes effect, so a user who typed one has no way to know whether the agent already follows it");

  // Trailing whitespace and CRLF are what a textarea hands over on Windows.
  await rendered[0].onCommit("  Always answer in Russian.\r\nNever answer in English.\r\n  ");
  assert.equal(saves.length, 1,
    "the field commits nothing, so typing a brief and leaving the box changes nothing anywhere");
  // The save object is built inside the sandbox, so its prototype is the sandbox's
  // `Object.prototype` and `deepStrictEqual` would fail on identity rather than on
  // content. Each field is compared on its own, which is also what says what went
  // wrong when it is wrong.
  assert.deepEqual(Object.keys(saves[0].patch).sort(), ["description", "instructions", "name"],
    "the save carries fields beyond the three this dialog owns, so an instruction edit writes something the dialog never offered to change");
  assert.equal(saves[0].id, "agent-1",
    "the save names no agent, so it edits whichever agent the dialog happened to be open for");
  assert.equal(saves[0].patch.name, "Аудитор проектов",
    "the save does not restate the name, so a host that treats the patch as the whole profile blanks the agent's name on every instruction edit");
  assert.equal(saves[0].patch.description, "Проверяет чужие проекты",
    "the save does not restate the description, so an instruction edit blanks the one line that says what the agent is for");
  assert.equal(saves[0].patch.instructions, "Always answer in Russian.\nNever answer in English.",
    "the saved text keeps the CRLF and the trailing newline a textarea hands over, so the next comparison never matches and every blur writes again");
});

test("an unchanged brief is not written back, and a refused save is reported", async () => {
  const saves = [];
  const agent = {
    id: "agent-1",
    name: "А",
    description: "",
    instructions: "Always answer in Russian.\nNever answer in English.",
    instructionsError: null,
    isGroup: false,
  };
  const roster = { updateAgent: async (id, patch) => { saves.push({ id, patch }); return { ok: true }; } };

  const render = createFieldRenderer({ agent, roster });
  render();
  // The same text, typed again and normalised differently: without the normalisation
  // this compares unequal to the stored value and writes on every blur, forever.
  await fieldNamed(render().fields, "Agent instructions")[0].onCommit(
    "Always answer in Russian.\r\nNever answer in English.",
  );
  assert.equal(saves.length, 0,
    "re-typing a brief that did not change writes to the agent, which churns the roster and makes a read look like an edit");

  const refusal = new Error("Agent instructions are 13000 bytes, over the 12288-byte limit. Nothing was written.");
  const refuseRender = createFieldRenderer({
    agent,
    roster: { updateAgent: async () => { throw refusal; } },
  });
  refuseRender();
  await fieldNamed(refuseRender().fields, "Agent instructions")[0].onCommit("A much longer brief.");

  const reported = textValues(refuseRender().texts).map(String).filter((value) => value.startsWith("Not saved: "));
  assert.equal(reported.length, 1,
    "a refused save is not reported at all, so a brief the host rejected looks exactly like a saved one");
  assert.equal(reported[0].includes("12288-byte limit"), true,
    `the refusal does not carry the host's own sentence, so the user is told something failed without being told what: ${reported[0]}`);
  assert.equal(reported[0].includes("Not saved: null"), false,
    "the refusal reports a null error, which names no reason at all");
});

test("a brief the host could not read is shown as a refusal, not as an empty box", () => {
  const agent = {
    id: "agent-1",
    name: "Аудитор проектов",
    description: "",
    instructions: "",
    instructionsError: "Agent instructions are 13000 bytes, over the 12288-byte limit. Nothing was written.",
    isGroup: false,
  };
  const { fields, texts } = renderInstructionsField({ agent, roster: { updateAgent: async () => ({}) } });

  assert.equal(fieldNamed(fields, "Agent instructions").length, 0,
    "an instruction file that could not be read renders an empty editable box, which is indistinguishable from an agent with no brief");
  assert.equal(
    textValues(texts).some((value) => String(value).includes("over the 12288-byte limit")),
    true,
    "the host's own refusal is not shown, so the user is shown an empty box instead of the sentence that says why",
  );
});

test("a group room is offered no brief of its own", () => {
  const tree = renderInstructionsField({
    agent: { id: "g", name: "Team", description: "", instructions: "", instructionsError: null, isGroup: true },
    roster: { updateAgent: async () => ({}) },
  }).tree;
  assert.equal(tree, null,
    "the instructions field renders for a group room, which has no brief file to write and no field to hold it");
});

test("the injected code reads only bindings this chunk really provides", () => {
  const free = freeNames(AGENT_INSTRUCTIONS_COMPONENT_SOURCE);
  assert.deepEqual(free, ["S", "Uwe", "lr", "p", "vt"],
    "the injected code reaches a free variable the registry chunk does not define, so opening an agent dialog throws before anything renders");

  for (const name of free) {
    const declared = new RegExp(`(?:^|[,;{}\\s(])(?:var|let|const|function)\\s${name}\\b`).test(registryChunk);
    assert.equal(declared, true,
      `"${name}" is used by the injected code but is not a top-level binding of the registry chunk, so the field cannot render`);
  }
  assert.equal(occurrences(registryChunk, "function RpAgentInstructions"), 0,
    "the registry chunk already defines RpAgentInstructions, so the injected declaration would be a duplicate");
  assert.equal(occurrences(registryChunk, "RpAgentInstructionsLabel"), 0,
    "the registry chunk already defines the injected label constant, so the injected declaration would be a duplicate");
});

test("the patch refuses a drifted chunk instead of half-applying", () => {
  assert.throws(
    () => patchOriginalAgentInstructionsField(registryChunk.replace(SETTINGS_HEAD, "")),
    /agent settings head anchor is missing or ambiguous/,
    "a build that renames the settings component would ship a dialog with no instructions field and no error",
  );
  assert.throws(
    () => patchOriginalAgentInstructionsField(registryChunk.replace(DESCRIPTION_FIELD, "")),
    /agent settings description field anchor is missing or ambiguous/,
    "a build that reshapes the description field would ship the injected component with nothing rendering it",
  );

  const at = registryChunk.indexOf(SETTINGS_HEAD);
  const duplicated = registryChunk.slice(0, at) + SETTINGS_HEAD + registryChunk.slice(at);
  assert.equal(occurrences(duplicated, SETTINGS_HEAD), 2,
    "the drift fixture must really hold two copies, or the guard test proves nothing");
  assert.throws(
    () => patchOriginalAgentInstructionsField(duplicated),
    /agent settings head anchor is missing or ambiguous/,
    "a duplicated anchor must be rejected rather than patched at the first match only",
  );
});

test("the patched registry chunk is still a parseable module and still one chunk", () => {
  assert.doesNotThrow(
    () => acorn.parse(AGENT_INSTRUCTIONS_COMPONENT_SOURCE, { ecmaVersion: "latest" }),
    "the injected source must parse on its own, or the registry chunk is a syntax error at load",
  );
  assert.doesNotThrow(
    () => acorn.parse(patchedRegistryChunk, { ecmaVersion: "latest", sourceType: "module" }),
    "the patched registry chunk must stay parseable",
  );
  assert.equal(patchedRegistryChunk.length > registryChunk.length, true,
    "the patch added no bytes, so nothing reached the chunk and the whole transformation is a silent no-op");

  // The panel chunk must not have picked any of this up: the provenance record lists
  // exactly two chunks and a third entry is rejected by the packaged-artifact check.
  assert.equal(panelChunk.includes("RpAgentInstructions"), false,
    "the injected code reached the panel chunk too, which would make the build record name a chunk it should not");
  assert.equal(occurrences(panelChunk, SETTINGS_HEAD), 0,
    "the settings component anchor also occurs in the panel chunk, so chunk selection becomes ambiguous");
});
