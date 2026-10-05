import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

import {
  COMPONENT_SOURCE,
  patchOriginalSignInGate,
} from "../scripts/lib/router-renderer-patch.mjs";

/**
 * The sign-in gate, the account chip and the settings row were all patched to stop
 * asking for a Cursor account, and the chat composer was missed.
 *
 * What shipped: the composer's resting placeholder had four states, and the fourth
 * was the only one this build could ever reach. `s` is `isCursorSignedIn`, and the
 * account-chip patch deliberately leaves `isSignedIn:!1` alone because faking a
 * signed-in state is forbidden — so with no Cursor account that branch never fires,
 * and the first screen of the app opened on the literal instruction "Sign in to
 * Cursor in settings, then ask anything." Every other surface had been rewritten to
 * say the user did not need an account, and the one place they are actually typing
 * still told them to go and get one.
 *
 * The Plugins screen was reported as the place that still asked. It was checked and
 * it is honest: every prompt there belongs to a third-party connector or to git
 * credentials on the user's own machine, and each one is gated on a real failure.
 * The tests below pin that inventory too, so "plugins asks you to sign in" cannot
 * quietly become true again, and so a future agent cannot delete a connector's
 * working OAuth button on the strength of that report.
 *
 * What the tests now prove: the composer asks for no account, the patch cannot
 * half-apply if upstream moves the branch, the signed-in placeholder path is
 * preserved rather than replaced with invented copy, and the sign-in prompts that
 * legitimately remain are the ones backed by a real third-party account.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(repoRoot, "src", "app", "dist", "renderer", "assets");
const REGISTRY_CHUNK = path.join(assetsRoot, "index-lA9cgT4O.js");
const PLUGINS_CHUNK = path.join(assetsRoot, "view-Z6ralB4h.js");
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
const pluginsChunk = readFileSync(PLUGINS_CHUNK, "utf8");
const patchedRegistryChunk = patchOriginalSignInGate(registryChunk);

function occurrences(source, needle) {
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The shipped composer branch, signed-in state versus signed-out state. */
const COMPOSER_BRANCH =
  ':s?y!=null?x9n(y):l.length>0?"Add a message, or hit send.":U:"Sign in to Cursor in settings, then ask anything."';
/** What the patch leaves behind: one expression, no account state. */
const COMPOSER_PATCHED = ':y!=null?x9n(y):l.length>0?"Add a message, or hit send.":U';

test("the shipped composer really did name a Cursor sign-in as the precondition for typing", () => {
  // The guard has to find the thing it is about to inspect. A zero here means the
  // anchor moved, and every assertion below it would pass for the wrong reason.
  assert.equal(
    occurrences(registryChunk, COMPOSER_BRANCH),
    1,
    "the composer branch must be a single unambiguous anchor, or the patch is a no-op",
  );
  assert.ok(
    registryChunk.includes('"Sign in to Cursor in settings, then ask anything."'),
    "the fixture must really contain the sign-in instruction the patch removes",
  );
  assert.equal(
    occurrences(registryChunk, '"Sign in to Cursor in settings, then ask anything."'),
    1,
    "that instruction must appear exactly once, so no second copy is left asking for an account",
  );
});

test("the patched composer asks for no account at all", () => {
  assert.equal(
    patchedRegistryChunk.includes('"Sign in to Cursor in settings, then ask anything."'),
    false,
    "the composer still tells the user to sign in to Cursor before they may ask anything",
  );
  assert.equal(
    patchedRegistryChunk.includes("Sign in to Cursor"),
    false,
    "no spelling of the instruction may survive anywhere in the registry chunk",
  );
});

test("the patched composer keeps the resting placeholder a signed-in user already sees", () => {
  // The honest replacement is the branch that was already reachable, not new copy.
  // `U` is the caller's resting placeholder, falling back to the shipped default
  // `x1t` ("Ask anything, or drop a file."), which is what a signed-in user gets.
  assert.equal(
    occurrences(patchedRegistryChunk, COMPOSER_PATCHED),
    1,
    "the composer must land on the single expression both account states share",
  );
  assert.equal(
    patchedRegistryChunk.includes('"Add a message, or hit send."'),
    true,
    "the has-attachment state is unrelated to signing in and must survive byte for byte",
  );
  assert.equal(
    patchedRegistryChunk.includes('x9n(y)'),
    true,
    "the reply-target placeholder is a different feature and must survive byte for byte",
  );
  assert.ok(
    /x1t="Ask anything, or drop a file\."/.test(registryChunk),
    "the signed-in default this now falls back to must be the shipped string, not an assumption",
  );
});

test("the composer patch refuses a drifted upstream chunk instead of half-applying", () => {
  assert.throws(
    () => patchOriginalSignInGate(registryChunk.replace(COMPOSER_BRANCH, "")),
    /composer placeholder anchor is missing or ambiguous/,
    "an upstream move that drops the signed-out branch must fail the build, not ship a stale copy",
  );
  const at = registryChunk.indexOf(COMPOSER_BRANCH);
  const duplicated = registryChunk.slice(0, at) + COMPOSER_BRANCH + registryChunk.slice(at);
  assert.equal(
    occurrences(duplicated, COMPOSER_BRANCH),
    2,
    "the drift fixture must really hold two copies, or the guard test proves nothing",
  );
  assert.throws(
    () => patchOriginalSignInGate(duplicated),
    /composer placeholder anchor is missing or ambiguous/,
    "a duplicated composer branch must be rejected rather than patched at the first match only",
  );
});

test("the composer patch leaves the chunk parseable and the protected lines untouched", () => {
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

test("the onboarding sign-in screen has no render site left after the gate patch", () => {
  // `gjn` renders an autofocused "Sign in" button. It is unreachable only because
  // the gate patch stops rendering its parent, which is a claim worth pinning: the
  // function still exists in the chunk, so counting definitions proves nothing.
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

test("the Plugins screen asks for third-party connector auth only, and never for an account here", () => {
  // The report was that Plugins still asks the user to sign in. Every auth string
  // it renders belongs to somebody else's account or to the user's own git, so the
  // guard first proves it found them, then proves none of them names this app.
  assert.ok(
    pluginsChunk.includes('"Authenticate"'),
    "the guard must find the connector auth button, or it proves nothing",
  );
  assert.ok(
    pluginsChunk.includes('"Authorize"'),
    "the guard must find the add-account button, or it proves nothing",
  );
  assert.ok(
    pluginsChunk.includes("Complete GitHub auth to sync installed plugins"),
    "the guard must find the git-credential banner, or it proves nothing",
  );
  // Scoped to this app's own account. A bare "sign in" is deliberately NOT on this
  // list: `_l` reports a connector's OAuth failure as "Couldn't start sign-in",
  // which is that connector's sign-in and the only one this screen ever names.
  for (const forbidden of [
    "Sign In with Cursor",
    "Sign in to Cursor",
    "Cursor account",
    "Connect your",
    "Sign in to Grok Bot",
  ]) {
    assert.equal(
      pluginsChunk.includes(forbidden),
      false,
      `the Plugins screen tells the user to "${forbidden}", which this build has no use for`,
    );
  }
});

test("the one sign-in the Plugins screen names is a connector's, not this app's", () => {
  // The guard above has to have found something real to be worth anything, so the
  // single "sign-in" string in the chunk is pinned to the branch that emits it:
  // the result of starting a connector's OAuth flow.
  assert.equal(
    occurrences(pluginsChunk, "sign-in"),
    1,
    "the chunk must hold exactly one sign-in string; a second one needs the same scrutiny as the first",
  );
  assert.ok(
    pluginsChunk.includes('text:`Couldn\'t start sign-in: ${n.message}`'),
    "the only sign-in the Plugins screen names must be a connector OAuth failure",
  );
  assert.ok(
    pluginsChunk.includes('case"unreachable":return{kind:"error",text:`Couldn\'t start sign-in'),
    "that string belongs to the connector auth result mapper, so it can only be reached from a connector flow",
  );
});

test("the Plugins connector auth button is offered only when a connector really needs it", () => {
  // Deleting this button would be the other half of the same mistake the report
  // invites: it is gated on a genuine MCP `needsAuth` status and it starts a real
  // OAuth flow for that connector. It must stay.
  assert.ok(
    pluginsChunk.includes('if(s.status!=="needsAuth")return null'),
    "the connector auth button must stay gated on a connector that genuinely reports needsAuth",
  );
  assert.ok(
    pluginsChunk.includes('const o=d==null?"Authenticate":d.status==="waiting"?"Reopen":"Retry"'),
    "the button label must track the connector's real auth state rather than always asking to sign in",
  );
});

test("the Router panel keeps the local-provider prompts, because those accounts are real", () => {
  // Claude Code and Codex are the one case where a sign-in prompt is the truth:
  // `provider-session.ts` throws "Run `codex login`" and "Install and sign in to
  // Claude Code" when their credentials are missing, so the panel telling the user
  // to sign in is pointing at the actual fix rather than at a removed requirement.
  assert.ok(
    COMPONENT_SOURCE.includes('kind:"local",localKey:"claude-code"'),
    "the guard must find the Claude Code provider entry, or it proves nothing",
  );
  assert.ok(
    COMPONENT_SOURCE.includes('"Sign in with "'),
    "the local providers must keep naming the CLI login that actually restores their access",
  );
  const providerSession = readFileSync(
    path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts"),
    "utf8",
  );
  assert.ok(
    providerSession.includes("Codex is not signed in with ChatGPT. Run `codex login`"),
    "the prompt is only honest while the routed provider really fails without that login",
  );
  assert.ok(
    providerSession.includes("Install and sign in to Claude Code"),
    "the same holds for Claude Code, whose credentials are read from the user's own machine",
  );
});