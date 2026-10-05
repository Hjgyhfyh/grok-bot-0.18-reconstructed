import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The agent's own prompt promised six capabilities this build cannot perform, and nothing noticed
 * because every part of the product was individually healthy.
 *
 * `buildSandBaseSystemPrompt` had already been given a capability object — `tools.mcpTools`,
 * `tools.screenshot`, `tools.fileTransfer`, `tools.subagentManagement` — and used it to drop the
 * bullets describing those families when a turn does not carry them. Three more families had the
 * flag and did not use it:
 *
 *   - `mcpManagement` guards `UNAVAILABLE_TOOL_NAMES` in system-prompt-assembly.ts, which lists
 *     SearchPlugins and AuthenticateMcpServer as names that "must never reach the prompt" when
 *     that family is off. The base prompt emitted the entire "Managing plugins and MCP servers"
 *     and "Reaching services that have no connector" sections unconditionally anyway, so the two
 *     files contradicted each other inside one turn. Measured: SearchPlugins and
 *     AuthenticateMcpServer were named in a prompt whose toolset contained neither.
 *   - `boxDesktop` is false on the reconstructed box (`remoteBoxHasDesktop`), so Computer and
 *     request_box_help are never registered, yet "Reaching services that have no connector",
 *     the escalation ladder and the Auto-review section all taught the browser and the desktop.
 *   - `cloudAgent` was never consulted at all. `cloudAgentsEnabled` answers a different question
 *     — has a team admin switched cloud agents off? — and on a host with no account the answer is
 *     "no", so the prompt emitted "ALWAYS hand it to a Cursor cloud agent with the CloudAgent
 *     tool" for a tool `createCloudAgentTool` was never given dependencies for. Worse, the
 *     fallback branch blamed the user's team: "disabled by your team's admin". That is a second
 *     lie on top of the first, and it points the user at an admin who never disabled anything.
 *
 * WebSearch and WebFetch are a different defect and are covered separately below: both are
 * genuinely registered (the inference extension supplies `createWebSearch`/`createWebFetch`
 * unconditionally), so gating them by toolset would be wrong. They are terminal instead, and
 * neither the tool description nor the prompt said so.
 *
 * What was true about the halves: the toolset was built correctly and the credential error was
 * already reported honestly by `maybeNormalizeExecBoundaryError`. Only the prompt lied.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-agentpromise-"));
  const claudeSdkStub = path.join(directory, "claude-agent-sdk-stub.mjs");
  writeFileSync(
    claudeSdkStub,
    "export const query = () => { throw new Error('the Claude Code SDK is not under test'); };\n",
    "utf8",
  );
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      alias: { "@anthropic-ai/claude-agent-sdk": claudeSdkStub },
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "runner", "system-prompt.ts"],
  ["packages", "agent", "tools", "core", "web-search.ts"],
  ["packages", "agent", "tools", "core", "web-fetch.ts"],
]);
const {
  buildSandBaseSystemPrompt,
  resolveSandToolCapabilities,
  SAND_FULL_TOOL_CAPABILITIES,
} = loaded["system-prompt.mjs"];

test.after(() => dispose());

/**
 * The tools this build's turn really carries on a host with no Cursor account: the
 * inference extension registers WebSearch/WebFetch unconditionally, and nothing else that
 * needs an account is registered.
 */
const ACCOUNTLESS_TOOLSET = new Set([
  "SendMessage",
  "CreateAgent",
  "UpdateAgent",
  "SendToAgent",
  "ReactToMessage",
  "Task",
  "Shell",
  "Read",
  "ExternalShell",
  "ExternalRead",
  "WebSearch",
  "WebFetch",
]);

/**
 * Tool names that exist only behind a signed-in Cursor account or a monitor on the box.
 *
 * Matched as whole words. `Computer` as a bare substring matches the English word in "your own
 * computer", which is not the tool, and a substring probe here would have hidden the real defect
 * behind a pile of false positives.
 */
const ACCOUNT_GATED_TOOL_NAMES = [
  "SearchPlugins",
  "GetPlugin",
  "InstallPlugin",
  "UninstallPlugin",
  "AddMcpServer",
  "UninstallMcpServer",
  "GetMcpServerStatus",
  "SetMcpInstructions",
  "RestartMcpServers",
  "AuthenticateMcpServer",
  "RemoveMcpAccount",
  "RenameMcpAccount",
  "Computer",
  "request_box_help",
  "Screenshot",
  "GenerateImage",
  "CopyToBox",
  "CopyFromBox",
  "GetMcpTools",
  "CallMcpTool",
  "CheckSubagent",
  "MessageSubagent",
  "StopSubagent",
];

/**
 * The subset of those names the BASE PROMPT is responsible for.
 *
 * Measured against `buildSandBaseSystemPrompt` with every capability on, not guessed: the other
 * nine (GetPlugin, InstallPlugin, UninstallPlugin, AddMcpServer, UninstallMcpServer,
 * GetMcpServerStatus, RestartMcpServers, RemoveMcpAccount, RenameMcpAccount) are described only
 * in their own tool description and never appear in the base prompt, in any configuration. Those
 * are not the base prompt's to teach, so the accountless check below covers the fifteen it
 * really does name and this list is the contract for the wired case.
 */
const BASE_PROMPT_GATED_NAMES = [
  "SearchPlugins",
  "SetMcpInstructions",
  "AuthenticateMcpServer",
  "Computer",
  "request_box_help",
  "Screenshot",
  "GenerateImage",
  "CopyToBox",
  "CopyFromBox",
  "GetMcpTools",
  "CallMcpTool",
  "CheckSubagent",
  "MessageSubagent",
  "StopSubagent",
];

/** The one account-gated name that is allowed to appear: to say it is unavailable. */
const ALLOWED_DENIAL = "CloudAgent";

function namesWholeWord(text, name) {
  return new RegExp(`(?<![A-Za-z])${name}(?![A-Za-z])`).test(text);
}

/** Names the account-gated tool carries in a denial, so the denial is allowed through. */
function linesNaming(text, name) {
  return text
    .split("\n")
    .filter((line) => namesWholeWord(line, name));
}

test("the prompt for an accountless turn never teaches a tool that turn does not carry", () => {
  const capabilities = resolveSandToolCapabilities((name) => ACCOUNTLESS_TOOLSET.has(name));
  // A static guard must prove it found something, or it is not checking.
  assert.ok(
    capabilities.mcpManagement === false && capabilities.cloudAgent === false && capabilities.boxDesktop === false,
    `the accountless capability set resolved to ${JSON.stringify(capabilities)}, so this test is not exercising the accountless path`,
  );

  const prompt = buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: capabilities });

  const offenders = [];
  for (const name of ACCOUNT_GATED_TOOL_NAMES) {
    if (name === ALLOWED_DENIAL) continue;
    for (const line of linesNaming(prompt, name)) {
      offenders.push(`${name}: ${line.slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the prompt taught ${offenders.length} account-gated tool(s) to a turn carrying none: ${offenders.join(" | ")}`,
  );
});

test("a turn with a box desktop but no account still never learns about connectors", () => {
  // The accountless fixture above has `boxDesktop: false`, which drops the whole
  // "Reaching services that have no connector" section and so hides the SearchPlugins bullets
  // behind an outer gate. Falsifying proved that gap: un-gating the inner `mcpManagement` guard
  // left every test green. A box with a monitor but no Cursor account is a real configuration, and
  // in it the section renders while the connector tools inside it are still absent — so the inner
  // guard needs its own coverage rather than relying on an outer one that happens to hide it.
  const capabilities = {
    ...SAND_FULL_TOOL_CAPABILITIES,
    mcpManagement: false,
    cloudAgent: false,
  };
  const prompt = buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: capabilities });

  assert.ok(
    prompt.includes("Reaching services that have no connector"),
    "this configuration is supposed to keep the no-connector section, so it is not exercising what it claims to",
  );
  const offenders = ["SearchPlugins", "AuthenticateMcpServer", "GetMcpServerStatus", "InstallPlugin"]
    .filter((name) => linesNaming(prompt, name).length > 0);
  assert.deepEqual(
    offenders,
    [],
    `a box with a desktop but no account still taught ${offenders.join(", ")}, so the inner gate is doing nothing`,
  );
});

test("cloud agents are named only to say they are unavailable, and the reason is the account", () => {
  const capabilities = resolveSandToolCapabilities((name) => ACCOUNTLESS_TOOLSET.has(name));
  const prompt = buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: capabilities });

  const mentions = linesNaming(prompt, "CloudAgent");
  assert.equal(
    mentions.length,
    1,
    `expected exactly one CloudAgent mention in an accountless prompt, got ${mentions.length}: ${mentions.join(" | ")}`,
  );
  assert.ok(
    namesWholeWord(mentions[0], "not available"),
    `the one CloudAgent mention does not deny the tool: ${mentions[0]}`,
  );
  assert.ok(
    /signed-in Cursor account/.test(mentions[0]),
    `the denial blames the wrong thing: it must name the missing account, got: ${mentions[0]}`,
  );
});

test("a team-disabled cloud agent host still says the team disabled it, not that an account is missing", () => {
  // The two reasons must stay apart. Collapsing them into one message is how a user ends up
  // arguing with an admin who never switched anything off.
  const capabilities = resolveSandToolCapabilities((name) => ACCOUNTLESS_TOOLSET.has(name));
  const teamDisabled = buildSandBaseSystemPrompt({ cloudAgentsEnabled: false, tools: capabilities });
  const accountless = buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: capabilities });

  assert.ok(
    teamDisabled.includes("disabled by your team's admin"),
    "a team-disabled host must keep telling the user their team disabled cloud agents",
  );
  assert.equal(
    /signed-in Cursor account/.test(teamDisabled),
    false,
    "a team-disabled host must not also claim the account is missing, which is a different fault with a different fix",
  );
  assert.equal(
    /your team's admin/.test(accountless),
    false,
    "an accountless host must not blame the user's team, who disabled nothing",
  );
});

test("a fully wired turn still gets every section the account-gated fix removed", () => {
  // The complement: the fix must not silence capabilities a real account unlocks. A prompt that
  // describes less makes an agent deny its own hands, which is the same class of bug.
  const prompt = buildSandBaseSystemPrompt({
    cloudAgentsEnabled: true,
    tools: SAND_FULL_TOOL_CAPABILITIES,
  });
  for (const name of BASE_PROMPT_GATED_NAMES) {
    assert.ok(
      namesWholeWord(prompt, name),
      `a fully wired turn is no longer told about ${name}, so an agent holding it would deny having it`,
    );
  }
  assert.ok(
    namesWholeWord(prompt, "CloudAgent"),
    "a fully wired turn must still be told how to launch a cloud agent",
  );
  assert.ok(
    prompt.includes("ALWAYS hand it to a Cursor cloud agent"),
    "a fully wired turn lost its cloud-agent handoff instruction, so the gating removed more than the accountless case",
  );
  assert.ok(
    prompt.includes("Managing plugins and MCP servers"),
    "a fully wired turn lost the plugin-management section",
  );
  assert.ok(
    prompt.includes("Reaching services that have no connector"),
    "a fully wired turn lost the no-connector section",
  );
});

test("the escalation ladder is numbered without gaps when a family is missing", () => {
  // The template hard-coded "(4)" next to a `(tools.mcpTools ? "...(3)" : "")` fragment, so a turn
  // without MCP connectors rendered "(2) (3) the web". The model reads a ladder as a sequence, and
  // a gap makes it guess at a step that does not exist.
  for (const [label, capabilities] of [
    ["accountless", resolveSandToolCapabilities((name) => ACCOUNTLESS_TOOLSET.has(name))],
    ["fully wired", SAND_FULL_TOOL_CAPABILITIES],
  ]) {
    const prompt = buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: capabilities });
    const ladder = prompt.split("\n").find((line) => line.startsWith("- When a task needs data or an action from an external service"));
    assert.ok(ladder != null, `the ${label} prompt has no escalation ladder at all`);
    const numbers = [...ladder.matchAll(/\((\d+)\)/g)].map((match) => Number(match[1]));
    const ladderSteps = numbers.filter((number) => number <= 10);
    assert.deepEqual(
      ladderSteps,
      Array.from({ length: ladderSteps.length }, (_, index) => index + 1),
      `the ${label} escalation ladder skips or repeats a step: ${ladder.slice(0, 200)}`,
    );
  }
});

test("WebSearch and WebFetch say they need an account, because they are registered but terminal", () => {
  // Gating these two by toolset would be the wrong fix: the inference extension supplies
  // `createWebSearch`/`createWebFetch` unconditionally, so both tools really are in the toolset.
  // The defect is that both descriptions promised a working fetcher. `maybeNormalizeExecBoundaryError`
  // already turns the credential throw into a terminal error, so the model used to learn the
  // truth only after the call, then report to the user that web search was broken.
  const { createWebSearchTool } = loaded["web-search.mjs"];
  const { createWebFetchTool } = loaded["web-fetch.mjs"];
  const noopService = async () => {
    throw new Error("this test never executes the tool; it only reads its description");
  };

  for (const version of ["latest", "haiku", "cursor-0226", "dsv3-1205", "dsv3-1018", "gpt5-codex", "codex-cloud"]) {
    const tool = createWebSearchTool({
      webSearchService: noopService,
      promptVersion: version,
      conversationStartedDate: "2026-01-01",
    });
    // The description is produced per turn by `descriptionGenerator`, not read off a
    // `definition` field \u2014 the tool factories carry no `definition` at all.
    const description = tool.descriptionGenerator();
    assert.ok(
      /signed-in account/.test(description),
      `WebSearch (${version}) still describes a working search with no mention of the account it needs: ${description.slice(0, 160)}`,
    );
  }

  for (const version of ["latest", "cursor-0226", "gpt5-codex", "codex-cloud", "haiku"]) {
    const tool = createWebFetchTool({
      webFetchService: noopService,
      promptVersion: version,
    });
    const description = tool.descriptionGenerator();
    assert.ok(
      /signed-in account/.test(description),
      `WebFetch (${version}) still describes a working fetch with no mention of the account it needs: ${description.slice(0, 160)}`,
    );
  }
});

test("the prompt itself tells the agent that the web tools need an account", () => {
  // The tool description is one of two places the model reads. The base prompt is the other, and
  // it is the more authoritative of the two: it is the only one that survives a tool-description
  // edit by a future agent.
  const capabilities = resolveSandToolCapabilities((name) => ACCOUNTLESS_TOOLSET.has(name));
  const prompt = buildSandBaseSystemPrompt({ cloudAgentsEnabled: true, tools: capabilities });
  const webBullet = prompt
    .split("\n")
    .find((line) => line.startsWith("- The web (WebSearch, WebFetch)"));
  assert.ok(webBullet != null, "the prompt no longer introduces the web tools at all");
  assert.ok(
    /need a signed-in account/.test(webBullet),
    `the web bullet promises a working search without naming the account: ${webBullet}`,
  );
});
