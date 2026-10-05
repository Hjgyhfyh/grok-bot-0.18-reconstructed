import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Image generation is the one client-side capability the accountless configuration promises twice
 * and cannot deliver, and nothing noticed because the failure is silent rather than loud.
 *
 * `generate_image` is fully written: the tool, the service, the write-out, the render, the metrics.
 * What it does not have is a caller. `TurnToolsetHostFactoryProvider` declares an OPTIONAL
 * `createGenerateImageToolInputs` hook, and `createTurnToolsetFactoriesForTurn` only builds a
 * `generateImage` factory when some provider supplies that hook
 * (`turn-toolset.ts:1644-1646`). The production providers are built in `host-runner-composition.ts`
 * and `turn-agent-composition.ts`, and NEITHER supplies it — `createWebSearchToolInputs` sits a few
 * lines away in the same object literal and IS supplied. So the tool is absent from the toolset on
 * every host, and `generateImageService`, which `host-runner-composition.ts:2086` builds from the
 * Cursor client, is constructed and then handed to nothing.
 *
 * That is the first half of the defect and it is invisible in a passing suite, because an absent
 * tool cannot fail. It also meant nobody read the description: `getDescription` promised "Generate
 * an image file from a text description", with guidelines for aspect ratios and reference images and
 * no mention of the account, for a tool whose only service is `AiService.RunGenerateImage` over
 * connect-RPC to `https://api2.cursor.sh` with a Cursor bearer token
 * (`cursor-generate-image.ts` -> `cursor-inference.ts`). The routed local endpoint cannot help: the
 * `custom` provider only ever builds `createOpenAI(...).chat(...)`
 * (`provider-session.ts:424-447`), which is text, and no routed branch reaches the image service at
 * all — unlike `createCursorInferencePromptSession`, which checks the routed provider first
 * (`cursor-inference.ts:189-190`). Image generation is terminal without an account, and the only
 * honest place to say so before the first call is the description.
 *
 * What this test proves: the tool really is unwired (so the description is a contract nobody has
 * broken yet, not the crash someone is papering over), and the description says the account is
 * required in every prompt version that can reach a model.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every TypeScript file under `source`, as repo-relative posix paths. */
function sourceFiles(directory = path.join(repoRoot, "source"), found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(absolute, found);
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
    }
  }
  return found;
}

async function bundleGenerateImage() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-generateimage-"));
  const outfile = path.join(directory, "generate-image.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "packages", "agent", "tools", "core", "generate-image.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundleGenerateImage();
const { createGenerateImageTool } = loaded;

test.after(() => dispose());

test("no production toolset provider supplies createGenerateImageToolInputs, so the tool is never built", () => {
  const hook = "createGenerateImageToolInputs";
  // The two files that build a provider. A toolset is only ever assembled from one of these, so a
  // hook neither of them supplies is a hook no turn can have.
  const providers = [
    "source/host/host-runner-composition.ts",
    "source/host/runner/turn-agent-composition.ts",
  ];
  for (const file of providers) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    // Positive control, and a different marker per file because they are different kinds of
    // provider: one declares the interface, the other layers a per-turn provider over an existing
    // toolset. Without this, a file that stopped building a provider would make the absence check
    // below pass for the wrong reason.
    assert.ok(
      file.endsWith("turn-agent-composition.ts")
        ? text.includes("createTurnToolsetFactoriesForTurn(")
        : text.includes("TurnToolsetHostFactoryProvider"),
      `${file} no longer builds a toolset provider, so this check would prove nothing`,
    );
    assert.equal(
      text.includes(hook),
      false,
      `${file} now supplies ${hook}; the tool would go live against a Cursor-only service, so re-measure the account story before shipping that`,
    );
  }

  // The hook's own type and its own consumer are the only legitimate mentions anywhere in `source`.
  // `generate-image.ts` is excluded from the prose side of this: it names the hook in a comment
  // explaining why it is unsupplied, which is a mention of the hook, not a supplier of it.
  const declaring = sourceFiles().filter((file) =>
    readFileSync(path.join(repoRoot, file), "utf8").includes(hook),
  );
  assert.deepEqual(
    declaring,
    ["source/host/runner/tools/turn-toolset.ts", "source/packages/agent/tools/core/generate-image.ts"],
    `the generate-image wiring changed; re-measure whether the tool is reachable: ${declaring.join(", ")}`,
  );
});

test("the generateImageService the composition builds is handed to no tool", () => {
  const servicePath = path.join(repoRoot, "source/host/host-runner-composition.ts");
  const composition = readFileSync(servicePath, "utf8");
  assert.ok(
    composition.includes("\"createGenerateImageService\"") && composition.includes("generateImageService:"),
    "the production composition no longer builds a generateImageService at all, so this test is describing an older shape",
  );
  // `createGenerateImageService` on the attachments extension is the factory that builds it; the
  // key it is assigned to is `generateImageService`. Case-sensitive on purpose: the extension's own
  // method name differs only in case, and a case-insensitive scan cannot tell "the factory that
  // builds it" from "the property a tool would have to read".
  const holders = sourceFiles().filter((file) =>
    readFileSync(path.join(repoRoot, file), "utf8").includes("generateImageService"),
  );
  assert.deepEqual(
    holders,
    [
      "source/host/host-runner-composition.ts",
      "source/packages/agent/tools/core/generate-image.ts",
    ],
    `something now reads generateImageService; re-measure the account story before trusting this: ${holders.join(", ")}`,
  );
  // In `generate-image.ts` it is the dependency field the tool declares. Nowhere else is it read:
  // the composition sets it on runnerOptions and the toolset, the only consumer, never asks for it.
  // That is the whole of the absence — the service is built on every turn and goes nowhere.
  assert.ok(
    !readFileSync(path.join(repoRoot, "source/host/runner/tools/turn-toolset.ts"), "utf8").includes("generateImageService"),
    "turn-toolset.ts now names generateImageService; re-measure how the tool is wired before trusting this",
  );
});

test("GenerateImage says it needs an account, because its only service is Cursor cloud", () => {
  // The description is produced per turn by `descriptionGenerator`; the tool factory carries no
  // `definition` field to read it from.
  const noopService = async () => {
    throw new Error("this test never executes the tool; it only reads its description");
  };
  const resourceAccessor = { get: () => { throw new Error("never dereferenced by this test"); } };

  for (const version of ["latest", "haiku", "cursor-0226", "dsv3-1205", "dsv3-1018", "gpt5-codex", "codex-cloud"]) {
    const tool = createGenerateImageTool({
      resourceAccessor,
      generateImageService: noopService,
      promptVersion: version,
    });
    const description = tool.descriptionGenerator();
    assert.ok(
      /signed-in account/.test(description),
      `GenerateImage (${version}) still describes a working image generator with no mention of the account it needs: ${description.slice(0, 200)}`,
    );
    // The complement, and the reason a blanket rewrite of the description would be wrong: the tool
    // is fully usable on a host that HAS an account, so the invocation guidance must survive the
    // note. A description that only says "needs an account" denies a capability that a signed-in
    // user really has, which is the same bug wearing the other hat.
    for (const [guidance, why] of [
      ["aspect_ratio", "the aspect-ratio parameter the tool still accepts"],
      ["reference_image_paths", "the reference-image parameter the tool still accepts"],
      ["STRICT INVOCATION RULES", "the rules that keep the tool from being called needlessly"],
    ]) {
      assert.ok(
        description.includes(guidance),
        `GenerateImage (${version}) lost ${guidance} (${why}); the account note must be added to the description, not replace it`,
      );
    }
  }
});

test("the generate-image tool has exactly one image backend and it is the Cursor one", () => {
  // If a routed or local image backend ever appears, this fails and names it. That is the change
  // that would make the account note wrong, so it must not be discovered by a user instead.
  const servicePath = path.join(repoRoot, "source/shared/node/cursor-backend/cursor-generate-image.ts");
  const service = readFileSync(servicePath, "utf8");
  assert.ok(
    service.includes("runGenerateImage"),
    `cursor-generate-image.ts no longer calls RunGenerateImage: ${service.slice(0, 200)}`,
  );

  const backendUrl = readFileSync(path.join(repoRoot, "source/shared/node/cursor-token.ts"), "utf8");
  const endpoint = /DEFAULT_CURSOR_BACKEND_URL = "([^"]+)"/.exec(backendUrl)?.[1];
  assert.ok(endpoint != null && endpoint.length > 0, "the default Cursor backend URL could not be read, so this test proves nothing");
  assert.equal(
    endpoint,
    "https://api2.cursor.sh",
    "the image backend URL moved; re-measure whether image generation still needs a Cursor account",
  );

  // The routed local endpoint builds only a chat model, which cannot produce an image. If it ever
  // grows an image model, this is the assertion that must change.
  const providerSession = readFileSync(
    path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"),
    "utf8",
  );
  assert.equal(
    /\.imageModel\(/.test(providerSession),
    false,
    "the routed provider now builds an image model, so image generation is no longer terminal without an account and the description note is now a lie",
  );
});

test("avatar image generation is the same account-gated call, so it must not be faked", () => {
  // A second consumer of the same Cursor service, and the one place an image is generated for the
  // user rather than by the agent. It stops at the account, and it must keep stopping there: a local
  // fallback that "generates" an avatar without a backend would be exactly the faked signed-in state
  // this project forbids.
  //
  // The refusal does NOT come from `requireAccount()`. That reads a live service object which
  // `main-production-services.ts` builds unconditionally at startup (`account = ... createAccount`),
  // signed in or not, so it returns a working account whose `getStatus()` says logged-out. The
  // refusal is one call deeper: `getValidAccessToken` finds no stored access/refresh pair and
  // throws `SandAuthSignInRequiredError` (`account/cursor-auth.ts:281`). Naming the wrong leg here
  // would invite someone to "fix" `requireAccount` into throwing, which would break every other
  // caller that legitimately uses it while signed out.
  const adapter = readFileSync(
    path.join(repoRoot, "source/electron-main/adapters/avatar-images.ts"),
    "utf8",
  );
  assert.ok(
    adapter.includes("context.requireAccount().getAuthService()"),
    "avatar generation stopped going through requireAccount; if that was to make it work without an account, it needs reverting, not keeping",
  );
  assert.ok(
    adapter.includes("createCursorGenerateImageService"),
    "avatar generation no longer uses the Cursor image service; re-measure before trusting anything else here",
  );

  // The refusal leg itself, pinned so the corrected prose above cannot rot back into the wrong one.
  // With no credential the token read yields no pair and this throws before any Cursor call, which is
  // the honest terminal failure; the named error is what the box connector matches on.
  const cursorAuth = readFileSync(path.join(repoRoot, "source/electron-main/account/cursor-auth.ts"), "utf8");
  assert.ok(
    /accessToken == null \|\| refreshToken == null\) throw new SandAuthSignInRequiredError\(\)/.test(cursorAuth),
    "getValidAccessToken no longer refuses a missing credential by name; the honest terminal failure for every image path is now something else",
  );
  assert.ok(
    adapter.includes("getValidAccessToken(options)"),
    "the avatar adapter no longer routes through getValidAccessToken, so the refusal leg this test describes is no longer the one it reaches",
  );

  const mainEdge = readFileSync(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  assert.ok(
    mainEdge.includes("generateAgentAvatarImage"),
    "the renderer lost its generateAgentAvatarImage method; this test is describing an older edge",
  );
});