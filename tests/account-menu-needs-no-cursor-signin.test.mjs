import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

import {
  COMPONENT_SOURCE,
  patchOriginalAccountCardSignIn,
  patchOriginalAccountMenuSignIn,
  patchOriginalAccountRow,
  patchOriginalAccountSlot,
  patchOriginalSettingsPanel,
  patchOriginalSettingsRegistry,
  patchOriginalSignInGate,
  patchOriginalThreadSurfaces,
} from "../scripts/lib/router-renderer-patch.mjs";

/**
 * Four patches took the Cursor sign-in out of the boot gate, the account chip, the Settings
 * account row and the account card, and then a fifth took it out of the composer. The
 * account menu in the app shell was never looked at, and it is the one the user is looking
 * at most: the chip in the agents sidebar footer opens it.
 *
 * What shipped: `Xln` builds that menu, and one of its items was decided by three lines.
 * `P = s === "logged-in"` gates "Log out"; `J = s === "logged-out" && r && !i` gates
 * "Sign in"; `o` is `onSignIn`, and `Rct` hands `Xln` `() => { t.login() }` for it. The
 * store's `login` is `login: () => x(() => n.loginCursor(), !0)` — a real browser OAuth
 * against Cursor. So the chip, relabelled "Local" by the account-chip patch, opened a menu
 * whose one remaining action bought an account this build has no route for:
 * `no-cursor-provider` gives `RRouterProviders` no `cursor` entry, so the Router panel
 * offers claude-code, codex, openrouter and custom and nothing routes through it. The
 * account card one chunk over had already been deleted for exactly that reason.
 *
 * The obvious defence is that the item is unreachable, and that defence is false, which is
 * what made it worth shipping unnoticed. The store's initial state is the module constant
 * `a$n = {kind:"logged-out"}`, and `l$n` writes `isLoaded: !0` on BOTH settle paths — the
 * one where `getCursorAuthStatus()` resolves and the one where it rejects. `J` is therefore
 * true from the first settled frame of every launch, signed out, which is the only state
 * this build is ever in. Counting string literals would not have caught it; the tests below
 * pin the gate itself, so the next agent re-checks the arithmetic instead of the spelling.
 *
 * What the tests now prove: the item was genuinely reachable before the patch, it is gone
 * after it, the patch refuses a drifted chunk rather than half-applying, the sibling "Log
 * out" survives byte for byte because a signed-in user must keep it, the memo slots keep
 * their indices, and the one remaining "Sign in" in the chunk is the onboarding step, which
 * has no render site at all.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(repoRoot, "src", "app", "dist", "renderer", "assets");
const REGISTRY_CHUNK = path.join(assetsRoot, "index-lA9cgT4O.js");
const PANEL_CHUNK = path.join(assetsRoot, "index-BoDVc20G.js");
const PATCH_MODULE = path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs");

// Baseline md5 prefixes for lines 5-11 of the patch module. These carry the whole
// Settings extension; a build that changes one silently changes the injected bytes
// while `verify` still compares against the record the same run produced.
const PROTECTED_LINES = {
  5: "ABBDC82204",
  6: "60F9ABAEF8",
  7: "4AF368A8ED",
  8: "A1CC810621",
  9: "4143D5C2BA",
  10: "5AFB1B34C9",
  11: "881C5D6D30",
};

const registryChunk = readFileSync(REGISTRY_CHUNK, "utf8");
const panelChunk = readFileSync(PANEL_CHUNK, "utf8");

// The registry chain, in the order `applyOriginalRendererRouterPatch` runs it, so the
// assertions below are about the bytes the package actually ships and not about one
// transform applied on its own.
const REGISTRY_TRANSFORMS = [
  patchOriginalSettingsRegistry,
  patchOriginalSignInGate,
  patchOriginalAccountSlot,
  patchOriginalAccountMenuSignIn,
  patchOriginalThreadSurfaces,
];
const PANEL_TRANSFORMS = [
  patchOriginalSettingsPanel,
  patchOriginalAccountRow,
  patchOriginalAccountCardSignIn,
];

const patchedRegistryChunk = REGISTRY_TRANSFORMS.reduce(
  (source, transform) => transform(source),
  registryChunk,
);

function occurrences(source, needle) {
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The shipped account-menu item, and the `J` gate and `onSelect` that decide it. */
const ACCOUNT_MENU_SIGN_IN =
  'fe=J?p.jsx(It.Section,{children:p.jsx(It.Item,{leading:p.jsx(bt,{name:"arrow-bracket-to-right",size:"base"}),onSelect:o,children:"Sign in"})}):null';
/** The sibling that must survive, because it is the one a signed-in user needs. */
const ACCOUNT_MENU_LOG_OUT =
  'Se=P?p.jsx(It.Section,{children:p.jsx(It.Item,{leading:p.jsx(bt,{name:"arrow-bracket-from-left",size:"base"}),onSelect:()=>{V()},children:"Log out"})}):null';

test("the shipped account menu really did offer a Cursor sign-in on every launch", () => {
  // Every assertion in this file rests on the item being present and reachable in the
  // original bytes. A zero here means upstream moved and the rest would pass for the
  // wrong reason.
  assert.equal(
    occurrences(registryChunk, ACCOUNT_MENU_SIGN_IN),
    1,
    "the account-menu sign-in item must be a single unambiguous anchor, or the patch is a no-op",
  );

  // The item is gated on `J`, and `J` is decided here. Pinned so a future reader can see
  // the branch rather than take the claim on trust.
  assert.ok(
    registryChunk.includes('const I=A,P=s==="logged-in",J=s==="logged-out"&&r&&!i;'),
    "the account menu must still gate 'Log out' on logged-in and 'Sign in' on logged-out",
  );

  // The menu is not dead code: the chip that opens it is mounted in the agents sidebar.
  assert.ok(
    registryChunk.includes(
      "Vs=p.jsx(Rct,{cursorAuth:t,hasUpdatePill:Ne,isCollapsed:Hn,onOpenSettings:Q,renderUpdatePill:Ae})",
    ),
    "the sidebar account chip that opens this menu must still be mounted, or there is no defect to fix",
  );

  // And the menu is wired to a real OAuth login, which is what makes the item a lie rather
  // than a dead label.
  assert.ok(
    registryChunk.includes("B=()=>{t.login()}"),
    "the chip must still hand the menu a handler that calls the Cursor login",
  );
  assert.ok(
    registryChunk.includes("login:()=>x(()=>n.loginCursor(),!0)"),
    "that handler must still reach the desktop Cursor login, or the item was harmless",
  );
  assert.ok(
    registryChunk.includes(
      "I=O=>p.jsx(Xln,{authStatus:t.status.kind,isAuthLoaded:t.isLoaded,isAuthPending:t.isPending,onSignIn:y,onLogOut:f,onOpenSettings:h,children:O})",
    ),
    "the menu must still receive authStatus, isLoaded, isPending and onSignIn, or the gate above means nothing",
  );
});

test("the gate cannot save the item: logged-out and loaded is this build's steady state", () => {
  // `J` is `s === "logged-out" && r && !i`. `s` is the store's status kind and `r` is
  // `isLoaded`. Both settle paths are pinned here, because the patch is only justified if
  // the branch was live, and "logged-out and loaded" is precisely the state this build
  // boots into on every launch.
  assert.ok(
    registryChunk.includes('const a$n={kind:"logged-out"}'),
    "the cursor auth store must still start out logged-out, or the gate argument is stale",
  );
  assert.ok(
    registryChunk.includes("isLoaded:!1,isPending:!1}"),
    "the store must still start not-loaded, so the loaded half of the gate is settled by the fetch",
  );
  assert.ok(
    registryChunk.includes('f({status:N,isLoaded:E,isPending:N.kind==="logging-in",...I})'),
    "the resolve path must still stamp isLoaded, so a successful status fetch satisfies `r`",
  );
  assert.ok(
    registryChunk.includes("if(N?.preserveError===!0){f({isLoaded:!0});return}"),
    "a fetch that fails while preserving an error must still stamp isLoaded",
  );
  assert.ok(
    registryChunk.includes("f({error:YWe(I),isLoaded:!0})"),
    "a fetch that fails outright must still stamp isLoaded, so `J` is true on the error path too",
  );
});

test("the patched account menu offers no Cursor sign-in", () => {
  assert.equal(
    occurrences(patchedRegistryChunk, ACCOUNT_MENU_SIGN_IN),
    0,
    "the account menu still renders a 'Sign in' item wired to the Cursor OAuth login",
  );
  assert.equal(
    occurrences(patchedRegistryChunk, 'children:"Sign in"'),
    1,
    "exactly one 'Sign in' label may remain, and it must be the unmounted onboarding step",
  );
  assert.ok(
    patchedRegistryChunk.includes("fe=null,e[56]=J,e[57]=o,e[58]=fe):fe=e[58]"),
    "the deleted branch must keep the compiler's memo slots 56-58, or every later e[n] shifts",
  );
  // `J` and `o` stay bound on purpose: dropping the destructuring would change the prop
  // object's shape for a sibling consumer and is not what this patch is for.
  assert.ok(
    patchedRegistryChunk.includes("onSignIn:o"),
    "the menu must still accept onSignIn; only the item that used it is removed",
  );
});

test("the sibling 'Log out' item survives byte for byte", () => {
  // Deleting the wrong half of this menu would lock a signed-in user out of the app.
  // `P` gates it on `logged-in`, so this build never renders it and the patch must not
  // touch it.
  assert.equal(
    occurrences(registryChunk, ACCOUNT_MENU_LOG_OUT),
    1,
    "the guard must find the sign-out item it is about to insist on keeping",
  );
  assert.equal(
    occurrences(patchedRegistryChunk, ACCOUNT_MENU_LOG_OUT),
    1,
    "the sign-out item must survive the account-menu patch untouched",
  );
  assert.ok(
    registryChunk.includes("qon={title:\"Sign out?\""),
    "the sign-out confirmation copy must still be defined for a signed-in user",
  );
});

test("the patch refuses a drifted upstream chunk instead of half-applying", () => {
  assert.throws(
    () => patchOriginalAccountMenuSignIn(registryChunk.replace(ACCOUNT_MENU_SIGN_IN, "")),
    /account menu sign-in anchor is missing or ambiguous/,
    "an upstream move that drops the menu item must fail the build, not ship a stale copy",
  );
  const at = registryChunk.indexOf(ACCOUNT_MENU_SIGN_IN);
  const duplicated = registryChunk.slice(0, at) + ACCOUNT_MENU_SIGN_IN + registryChunk.slice(at);
  assert.equal(
    occurrences(duplicated, ACCOUNT_MENU_SIGN_IN),
    2,
    "the drift fixture must really hold two copies, or the guard test proves nothing",
  );
  assert.throws(
    () => patchOriginalAccountMenuSignIn(duplicated),
    /account menu sign-in anchor is missing or ambiguous/,
    "a duplicated menu item must be rejected rather than patched at the first match only",
  );
});

test("the one 'Sign in' label left in the chunk is the onboarding step, and it has no render site", () => {
  // The onboarding landing step `gjn` renders an autofocused "Sign in" button and still
  // exists in the chunk. It is unreachable only because the gate patch stopped rendering
  // its parent, which is a claim worth pinning: counting definitions would prove nothing.
  const at = patchedRegistryChunk.indexOf('children:"Sign in"');
  assert.ok(at > 0, "the remaining 'Sign in' label must be findable, or this test guards nothing");
  assert.ok(
    patchedRegistryChunk.includes("onSignIn:r}=n,i=s.status.kind==="),
    "the remaining 'Sign in' must belong to the onboarding step gjn",
  );
  assert.ok(
    /function eDn\(/.test(patchedRegistryChunk),
    "the onboarding component is still compiled into the chunk; only its call site was removed",
  );
  assert.equal(
    occurrences(patchedRegistryChunk, "jsx(eDn"),
    0,
    "the onboarding sign-in screen is still rendered somewhere, so the gate patch has a second way in",
  );
});

test("the patch leaves the chunk parseable and the protected lines untouched", () => {
  assert.doesNotThrow(
    () => acorn.parse(patchedRegistryChunk, { ecmaVersion: "latest", sourceType: "module" }),
    "the patched registry chunk must stay parseable or the app boots to a syntax error",
  );
  const lines = readFileSync(PATCH_MODULE, "utf8").split("\n");
  for (const [number, expected] of Object.entries(PROTECTED_LINES)) {
    const actual = createHash("md5")
      .update(Buffer.from(lines[Number(number) - 1], "utf8"))
      .digest("hex")
      .slice(0, 10)
      .toUpperCase();
    assert.equal(actual, expected, `protected patch line ${number} drifted`);
  }
  assert.ok(
    COMPONENT_SOURCE.includes("Endpoint model list") && COMPONENT_SOURCE.includes("RRouterFallbackModels"),
    "the endpoint model picker is a separate injected feature and must survive a new patch",
  );
});

test("the transform is registered in the registry chain and the provenance record", () => {
  // A patch that is exported but never wired into `applyOriginalRendererRouterPatch` would
  // leave every assertion above green and ship the button. These are static guards, so
  // each one first proves it found the thing it is looking for.
  const patchModule = readFileSync(PATCH_MODULE, "utf8");

  assert.ok(
    patchModule.includes("patchOriginalAccountMenuSignIn"),
    "the transform must be exported, or nothing else in this file can hold",
  );
  const chainMatch = patchModule.match(/\["registry", registryCandidates\[0\], \[([^\]]*)\]\]/);
  assert.ok(chainMatch !== null, "the registry chunk must still carry an explicit transform list");
  assert.ok(
    chainMatch[1].includes("patchOriginalAccountMenuSignIn"),
    "the transform is exported but never run on the registry chunk, so the shipped button survives",
  );

  // The provenance record has a hard whitelist of top-level keys; a new one breaks the
  // packaged-artifact check. These two names must be appended inside the existing arrays.
  assert.ok(
    patchModule.includes('"account-menu-needs-no-cursor-signin"'),
    "the provenance record must name the feature this patch adds",
  );
  assert.ok(
    patchModule.includes('"account-menu-sign-in"'),
    "the provenance record must name the transformation this patch adds",
  );
  for (const key of ["schemaVersion", "mode", "chunks", "features", "transformations"]) {
    assert.ok(patchModule.includes(`${key}:`), `the provenance record must keep its ${key} field`);
  }
});

test("the account card button in the panel chunk is still gone, so the two patches agree", () => {
  // This patch removes the shell's door to the same sign-in. If the panel's door ever came
  // back, the two would contradict each other and the chip would offer a path the card
  // no longer admits to.
  const patchedPanelChunk = PANEL_TRANSFORMS.reduce(
    (source, transform) => transform(source),
    panelChunk,
  );
  assert.ok(
    panelChunk.includes("Sign In with Cursor"),
    "the guard must find the account card button in the original panel bytes, or it proves nothing",
  );
  assert.equal(
    occurrences(patchedPanelChunk, "Sign In with Cursor"),
    0,
    "the account card grew a Cursor sign-in button back",
  );
  assert.equal(
    occurrences(patchedPanelChunk, "Sign Out"),
    1,
    "the account card must still carry the one label it can render, or that card lost its only action",
  );
  assert.equal(
    occurrences(panelChunk, "Sign Out"),
    occurrences(patchedPanelChunk, "Sign Out"),
    "the account-card patch must not change how many sign-out labels the panel chunk carries",
  );
  assert.equal(
    occurrences(patchedRegistryChunk, ACCOUNT_MENU_LOG_OUT),
    1,
    "the shell menu's 'Log out' item is a different component and must be untouched by the panel patch",
  );
});
