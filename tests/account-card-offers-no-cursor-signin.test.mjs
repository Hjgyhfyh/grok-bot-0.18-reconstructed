import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate as yieldToHost } from "node:timers";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

import {
  patchOriginalAccountRow,
  patchOriginalAccountCardSignIn,
  patchOriginalSettingsPanel,
} from "../scripts/lib/router-renderer-patch.mjs";

/**
 * The account card kept a button that started a Cursor browser sign-in.
 *
 * What shipped: the Settings "Account" section rendered the card component `Vs`, and beside the
 * avatar that card drew a pill button whose label came from two lines —
 * `let o="Sign In with Cursor",c="primary"` and `r?...:"Cancel"` — where `r` is
 * `l.kind==="logged-in"`. Nothing in this build ever puts the status there, because the account-chip
 * patch deliberately leaves `isSignedIn:!1` alone and faking a signed-in state is forbidden. So the
 * button could only ever say "Sign In with Cursor" or "Cancel", it sat on the one card the user
 * opens after every other surface had stopped asking for an account, and clicking it called
 * `t.login()` — a real OAuth flow for an account the router refuses to hand this build. There is no
 * `cursor` entry in the provider table.
 *
 * The other sign-in patches reworded strings, which is how this one was missed: the label sat in a
 * component nobody was reading rather than in the branch a grep for `Sign in to Cursor` found.
 *
 * These tests do not grep for the label. They locate the account card in the panel chunk by its
 * call site, compute its free identifiers from the AST, run the real shipped function in a sandbox
 * with stubs for those identifiers, and look at the element tree. So they prove what the user would
 * see in each account state, not that a string is absent from a file. The first test renders the
 * UNPATCHED chunk and requires the button to be there, which is what makes the rest of the file
 * mean anything: if the harness stopped finding the card, the "no button" assertions below would
 * pass for the wrong reason.
 *
 * The fifth test is the one that keeps a future edit honest. React's `useMemoCache` returns the
 * same array on a re-render, carrying the previous render's values forward, so the dependency test
 * around the button decides whether a cached `null` is reused. The patch moves `r` into that test;
 * this renders logged-out and then logged-in through one cache to prove the second render is not
 * handed the first render's null back.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_CHUNK = path.join(repoRoot, "src", "app", "dist", "renderer", "assets", "index-BoDVc20G.js");

const panelChunk = readFileSync(PANEL_CHUNK, "utf8");
// The whole panel transform chain, in the order `applyOriginalRendererRouterPatch` runs it, so the
// fixture is the chunk the build writes rather than one transform applied alone.
const patchedPanelChunk = [
  patchOriginalSettingsPanel,
  patchOriginalAccountRow,
  patchOriginalAccountCardSignIn,
].reduce((source, transform) => transform(source), panelChunk);

/** The shipped bytes the new anchors replace. Each occurs once in the panel chunk. */
const CARD_LABEL_SHIPPED =
  'let o="Sign In with Cursor",c="primary";r?(o="Sign Out",c="secondary"):i&&(o="Cancel",c="tertiary");';
const CARD_LABEL_PATCHED = 'let o="Sign Out",c="secondary";';
const CARD_ACTION_SHIPPED =
  'e[40]!==o||e[41]!==c||e[42]!==V||e[43]!==N||e[44]!==Y?(S=a.jsx(oe,{className:M,disabled:V,onClick:N,shape:"pill",size:"md",style:Y,variant:c,children:o}),e[40]=o,e[41]=c,e[42]=V,e[43]=N,e[44]=Y,e[45]=S):S=e[45];';
const CARD_ACTION_PATCHED =
  'e[40]!==r||e[41]!==c||e[42]!==V||e[43]!==N||e[44]!==Y?(S=r?a.jsx(oe,{className:M,disabled:V,onClick:N,shape:"pill",size:"md",style:Y,variant:c,children:o}):null,e[40]=r,e[41]=c,e[42]=V,e[43]=N,e[44]=Y,e[45]=S):S=e[45];';

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
// Finding the account card by shape, not by a hand-written minified name.
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

function patternIdentifiers(pattern, into = new Set()) {
  if (pattern == null) return into;
  if (pattern.type === "Identifier") into.add(pattern.name);
  else if (pattern.type === "RestElement") patternIdentifiers(pattern.argument, into);
  else if (pattern.type === "AssignmentPattern") patternIdentifiers(pattern.left, into);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) patternIdentifiers(property.type === "RestElement" ? property : property.value, into);
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) patternIdentifiers(element, into);
  }
  return into;
}

function declaredNames(node) {
  const names = new Set();
  walk(node, (current) => {
    if (current.type === "VariableDeclarator") {
      for (const name of patternIdentifiers(current.id)) names.add(name);
    } else if (current.type === "FunctionDeclaration" || current.type === "FunctionExpression" || current.type === "ArrowFunctionExpression") {
      if (current.id?.name != null) names.add(current.id.name);
      for (const parameter of current.params) for (const name of patternIdentifiers(parameter)) names.add(name);
    } else if (current.type === "CatchClause") {
      for (const name of patternIdentifiers(current.param)) names.add(name);
    }
  });
  return names;
}

// A reference is a value the card reads. `a.jsx` names no value in its property position, and a
// plain object key (`{dataUrl:E}`) is a key rather than a binding, so both are skipped; that is the
// same rule `freeComponentTags` in router-renderer-panel-render.test.mjs applies.
function referencedNames(node) {
  const names = new Set();
  collect(node, names);
  return names;
}

function collect(node, names) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, names);
    return;
  }
  if (typeof node.type !== "string") return;
  if (node.type === "Identifier") {
    names.add(node.name);
    return;
  }
  if (node.type === "MemberExpression") {
    collect(node.object, names);
    if (node.computed) collect(node.property, names);
    return;
  }
  if (node.type === "Property") {
    if (node.computed) collect(node.key, names);
    collect(node.value, names);
    return;
  }
  for (const child of childNodes(node)) collect(child, names);
}

function isJsxCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    ["jsx", "jsxs"].includes(node.callee.property?.name)
  );
}

function jsxProps(node) {
  const props = node.arguments[1];
  return props?.type === "ObjectExpression" ? props : null;
}

/** The component the Settings "Account" section renders, found by its `title:"Account"` row. */
function locateAccountCard(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const sites = [];
  walk(ast, (node) => {
    if (!isJsxCall(node)) return;
    const props = jsxProps(node);
    if (props == null) return;
    const titled = props.properties.find(
      (property) => property.type === "Property" && !property.computed && property.key?.name === "title" && property.value?.value === "Account",
    );
    if (titled == null) return;
    const card = props.properties.find(
      (property) => property.type === "Property" && !property.computed && property.key?.name === "children" && isJsxCall(property.value),
    );
    // The component the section renders is the call's first argument, not the callee's property.
    const component = card?.value.arguments[0];
    const name = component?.type === "Identifier" ? component.name : null;
    if (typeof name === "string") sites.push(name);
  });
  assert.deepEqual(sites, ["Vs"], "the Settings Account section must render exactly one card component, and this fixture expects Vs");
  const node = ast.body.find((entry) => entry.type === "FunctionDeclaration" && entry.id?.name === sites[0]);
  assert.ok(node, "the account card component must be declared at the top level of the chunk");
  return { ast, node, name: sites[0], source };
}

/** Globals the sandbox context already has; everything else the card names must be stubbed. */
const SANDBOX_GLOBALS = new Set([
  "Symbol", "Promise", "Object", "Array", "String", "Number", "Boolean", "Error", "TypeError",
  "Math", "JSON", "Date", "console", "Infinity", "NaN", "undefined", "globalThis",
]);

function freeNames(node) {
  const referenced = referencedNames(node);
  const bound = declaredNames(node);
  return [...referenced].filter((name) => !bound.has(name) && !SANDBOX_GLOBALS.has(name)).sort();
}

// ---------------------------------------------------------------------------
// The sandbox. Stubs are keyed by the free names computed above, never by hand.
// ---------------------------------------------------------------------------

const SENTINEL = Symbol.for("react.memo_cache_sentinel");

/** Stubs for everything the card reaches for outside its own scope. */
function cardStubs() {
  return {
    // React's memo cache. react-dom returns the SAME array on an update render, carrying the
    // previous values forward, so this stub does too; `reset()` returns it to mount semantics.
    H: { c: (size) => memoCache(size) },
    a: {
      jsx: (type, props) => ({ type, props: props ?? {} }),
      jsxs: (type, props) => ({ type, props: props ?? {} }),
      Fragment: "Fragment",
    },
    k: (...names) => names.join(" "),
    xe: (...names) => names.join(" "),
    Ee: { name: "name", meta: "meta", actionWeakBorder: "actionWeakBorder" },
    ke: { body2: "body2" },
    Ye: { medium: "medium" },
    Fe: () => ({
      resolveAccountDisplay: ({ displayName, email }) => ({ name: displayName ?? email ?? "Cursor", secondary: email ?? null }),
    }),
    Ve: () => () => true,
    Qe: "cursor.signOut",
    Gs: (authId) => (authId == null ? null : { subject: `subject-of-${authId}` }),
    Ws: "Avatar",
    Fs: "CopyEmail",
    oe: "Button",
    se: "Text",
  };
}

let previousCache = null;
function memoCache(size) {
  // react-dom: `current.data.map(array => array.slice())` on an update, a fresh sentinel array on
  // a mount. Both return an array the same length, so an out-of-order call is itself a defect.
  const next = previousCache == null ? Array.from({ length: size }, () => SENTINEL) : previousCache.slice();
  assert.equal(next.length, size, "the memo cache must keep the slot count the component declared");
  previousCache = next;
  return next;
}

function collectElements(node, out = [], seen = new Set()) {
  if (node == null || typeof node !== "object" || seen.has(node)) return out;
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

function pillButtons(tree) {
  return collectElements(tree).filter((element) => element.props.shape === "pill");
}

const cacheBySource = new Map();

/**
 * Runs the real shipped account card from `source`.
 *
 * Every render shares one memo cache, exactly as a mounted component instance would. Call `reset()`
 * between renders that are meant to be independent mounts.
 */
function accountCard(source) {
  const cached = cacheBySource.get(source);
  if (cached != null) return cached;
  const { node, name } = locateAccountCard(source);
  const free = freeNames(node);
  const stubs = cardStubs();
  const missing = free.filter((entry) => !(entry in stubs));
  assert.deepEqual(missing, [], `the account card reached for ${missing.join(", ")}, which this harness has no stub for; upstream moved a binding`);
  const sandbox = { ...stubs };
  vm.runInNewContext(`${source.slice(node.start, node.end)}\n;__accountCard = ${name};`, sandbox, {
    filename: "account-card.js",
  });
  const calls = { login: 0, cancelLogin: 0, logout: 0 };
  const harness = {
    calls,
    reset() {
      previousCache = null;
    },
    render(kind, { isPending = false, isLoaded = true } = {}) {
      const auth = {
        status: { kind, authId: "acct-1", displayName: "Ada Lovelace", email: "ada@example.com" },
        isPending,
        isLoaded,
        error: null,
        login: async () => {
          calls.login += 1;
        },
        cancelLogin: async () => {
          calls.cancelLogin += 1;
        },
        logout: async () => {
          calls.logout += 1;
        },
      };
      return sandbox.__accountCard({ auth });
    },
  };
  cacheBySource.set(source, harness);
  return harness;
}

// A fresh harness per source, with the memo cache reset, so one test's renders cannot leak into
// the next one's dependency slots.
function freshCard(source) {
  const harness = accountCard(source);
  harness.reset();
  harness.calls.login = 0;
  harness.calls.cancelLogin = 0;
  harness.calls.logout = 0;
  return harness;
}

// ---------------------------------------------------------------------------

test("the shipped account card really did offer a Cursor sign-in and a Cancel", () => {
  // The guard every other test below leans on. If the card stopped rendering a button at all, or
  // the harness stopped finding it, "the patched card has no button" would pass for free.
  assert.equal(
    occurrences(panelChunk, CARD_LABEL_SHIPPED),
    1,
    "the shipped label anchor must be a single unambiguous match, or the patch is a no-op",
  );
  const shipped = freshCard(panelChunk);
  const signedOut = pillButtons(shipped.render("logged-out"));
  assert.equal(signedOut.length, 1, "the shipped card must render exactly one pill button when nobody is signed in");
  assert.equal(
    signedOut[0].props.children,
    "Sign In with Cursor",
    "the button this task removes must be the one the shipped card renders",
  );
  const loggingIn = freshCard(panelChunk);
  const cancelling = pillButtons(loggingIn.render("logging-in"));
  assert.equal(cancelling.length, 1, "the shipped card must render exactly one pill button while a sign-in is in flight");
  assert.equal(cancelling[0].props.children, "Cancel", "the in-flight button must be the Cancel the shipped card renders");
});

test("the patched account card renders no button at all while no Cursor account is signed in", () => {
  const signedOut = freshCard(patchedPanelChunk);
  assert.deepEqual(
    pillButtons(signedOut.render("logged-out")).map((element) => element.props.children),
    [],
    "the account card still offers a button when nobody is signed in, so it still offers a Cursor sign-in",
  );
  const loggingIn = freshCard(patchedPanelChunk);
  assert.deepEqual(
    pillButtons(loggingIn.render("logging-in")).map((element) => element.props.children),
    [],
    "the account card still offers a Cancel button for a sign-in flow that can no longer be started",
  );
  const pending = freshCard(patchedPanelChunk);
  assert.deepEqual(
    pillButtons(pending.render("logged-out", { isPending: true })).map((element) => element.props.children),
    [],
    "an in-flight auth request must not conjure the button back either",
  );
});

test("the patched panel chunk names no Cursor sign-in anywhere", () => {
  assert.equal(
    patchedPanelChunk.includes("Sign In with Cursor"),
    false,
    "the account card still carries the Cursor sign-in label in its shipped bytes",
  );
  assert.equal(
    occurrences(patchedPanelChunk, CARD_LABEL_SHIPPED),
    0,
    "both not-signed-in labels must be gone, not one of them reworded",
  );
  assert.equal(
    occurrences(patchedPanelChunk, CARD_LABEL_PATCHED),
    1,
    "the only label the card may hold is the sign-out pair it already shipped",
  );
});

test("the account card still signs a signed-in user out", async () => {
  const signedIn = freshCard(patchedPanelChunk);
  const buttons = pillButtons(signedIn.render("logged-in"));
  assert.equal(buttons.length, 1, "a signed-in account must keep a button, or the card cannot be signed out of");
  assert.equal(buttons[0].props.children, "Sign Out", "the surviving button must be Sign Out, not the sign-in the patch removes");
  assert.equal(buttons[0].props.variant, "secondary", "Sign Out must keep the variant the shipped card gave it");
  await buttons[0].props.onClick();
  await new Promise((resolve) => yieldToHost(resolve));
  assert.equal(signedIn.calls.logout, 1, "clicking Sign Out must run the shipped logout path");
  assert.equal(signedIn.calls.login, 0, "a signed-out click must never start a browser sign-in, and this one is signed out");
  assert.equal(signedIn.calls.cancelLogin, 0, "a signed-in click must never cancel a sign-in that is not running");
});

test("a memo cache that survives a re-render cannot hide Sign Out behind the first render's null", async () => {
  // react-dom's `useMemoCache` returns the previous render's array on an update, so the dependency
  // test around the button decides whether the cached `null` is recomputed or handed straight back.
  // One harness, one cache, two renders in the order a user would see them.
  const card = freshCard(patchedPanelChunk);
  assert.deepEqual(
    pillButtons(card.render("logged-out")).map((element) => element.props.children),
    [],
    "the first render must leave the signed-out card with nothing to click, or this test proves nothing",
  );
  const afterSignIn = pillButtons(card.render("logged-in"));
  assert.equal(afterSignIn.length, 1, "the second render reused the first render's cached null, so Sign Out can never appear");
  assert.equal(afterSignIn[0].props.children, "Sign Out", "the button that reappears after a sign-in must be Sign Out");
  await afterSignIn[0].props.onClick();
  await new Promise((resolve) => yieldToHost(resolve));
  assert.equal(card.calls.logout, 1, "the reappeared button must still run the shipped logout path");
});

test("the patch refuses a drifted chunk instead of half-applying", () => {
  assert.throws(
    () => patchOriginalAccountCardSignIn(panelChunk.replace(CARD_ACTION_SHIPPED, "")),
    /account card action anchor is missing or ambiguous/,
    "an upstream move that drops the button must fail the build, not ship a card that can still sign in",
  );
  assert.throws(
    () => patchOriginalAccountCardSignIn(panelChunk.replace(CARD_LABEL_SHIPPED, "")),
    /account card label anchor is missing or ambiguous/,
    "an upstream move that drops the label branch must fail the build too",
  );
  const at = panelChunk.indexOf(CARD_ACTION_SHIPPED);
  const duplicated = panelChunk.slice(0, at) + CARD_ACTION_SHIPPED + panelChunk.slice(at);
  assert.equal(
    occurrences(duplicated, CARD_ACTION_SHIPPED),
    2,
    "the drift fixture must really hold two copies, or the guard test proves nothing",
  );
  assert.throws(
    () => patchOriginalAccountCardSignIn(duplicated),
    /account card action anchor is missing or ambiguous/,
    "a duplicated button anchor must be rejected rather than patched at the first match only",
  );
});

test("the patched panel chunk is still the panel chunk and still parses", () => {
  assert.doesNotThrow(
    () => acorn.parse(patchedPanelChunk, { ecmaVersion: "latest", sourceType: "module" }),
    "the patched panel chunk must stay parseable or the app boots to a syntax error",
  );
  assert.equal(
    occurrences(patchedPanelChunk, "function Sa(s){"),
    1,
    "the Router panel component this chunk carries must survive the account card patch",
  );
  assert.equal(
    occurrences(patchedPanelChunk, CARD_ACTION_PATCHED),
    1,
    "the account card button must be the gated one, with the signed-in flag in its dependency test",
  );
});
