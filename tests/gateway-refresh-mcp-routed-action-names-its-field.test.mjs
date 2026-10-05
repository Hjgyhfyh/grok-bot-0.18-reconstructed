import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The baseline these tests read the defect from. It is a fixed commit, not HEAD:
// reading HEAD only proves anything while the fix is uncommitted, and once it is
// committed HEAD holds the fixed code and every falsification inverts.
const DEFECT_BASELINE = "18fe9fc";


/**
 * A misspelled `routedAction` reloaded every MCP server and answered `200`.
 *
 * `refreshMcp` is three commands wearing one name. `routedAction: "list-tools"`
 * lists routed tools, `"execute-tool"` executes one, `{completion}` finishes a
 * desktop OAuth handshake, and an absent `routedAction` with an absent
 * `completion` reloads the whole server list. That last one is not a lost
 * request — it is the desktop's own call. `refreshHostMcp` in
 * `source/electron-main/mcp/mcp-desktop.ts` sends exactly
 * `completion == null ? {} : {completion}`, and seven IPC handlers use it
 * (`sand:mcp-install`, `sand:mcp-update-plugin-install`, `sand:mcp-remove`,
 * `sand:mcp-uninstall-plugin`, `sand:mcp-auth`, `sand:mcp-rename-account`,
 * `sand:mcp-remove-account`), because the desktop mutates MCP state through its
 * own `SandMcpManager` and the host owns a second manager that caches the
 * account config and the live clients. So `{}` is load-bearing and stays.
 *
 * The discriminator is what had no guard. Anything that was neither of the two
 * legal strings fell past both `if`s onto the restart line, so:
 *
 *   `POST /api/refreshMcp {"routedAction":"execute-tools"}`  one character of
 *   typo, and every MCP server reconnects. No tool runs. The caller is told
 *   `200`, which for a routed-tool client means "your tool answered".
 *   `POST /api/refreshMcp {"routedArgs":{…}}` names the arguments and loses the
 *   action, and the same reload happens for the same `200`.
 *
 * A caller cannot tell those apart from a successful restart, and neither the
 * status nor the body names the field. The rest of this file already has the
 * answer for the same mistake — `requireFields`, `requireText`, `requireObject`
 * raise `SandGatewayRequestError`, which `statusForCommandError` answers `400`
 * — and this command was the one place in the MCP block that read a
 * discriminator without it.
 *
 * Both new refusals fail against the pre-fix code, which reloads the servers and
 * answers `200` for each of them. The first four tests fail against a fix that
 * went too far and refused the desktop's empty body, so the tests measure the
 * narrow repair and not just any refusal.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// See the note in `gateway-request-error-is-400.test.mjs`: pointing this at a
// copy of `source/` runs the same assertions against a different tree. It is not
// set by `npm test`, so the suite always measures the working tree.
const sourceRoot = process.env.GROK_GATEWAY_SOURCE_ROOT
  ? path.resolve(process.env.GROK_GATEWAY_SOURCE_ROOT)
  : repoRoot;

// The falsification hook this file needs is stronger than a copied tree: it must
// run the *committed* `host-gateway-api.ts` while every other module stays the
// working tree's, so the only difference between the two runs is the command
// under test. `onLoad` answers that path from `git show HEAD:…` at build time.
// Nothing is written, nothing is checked out, the tree is never touched.
const useGitHeadApi = process.env.GROK_GATEWAY_HEAD_OVERRIDE === "1";

const headApiPlugin = {
  name: "grok-head-host-gateway-api",
  setup(bundler) {
    bundler.onLoad({ filter: /host-gateway-api\.ts$/ }, (args) => {
      if (!useGitHeadApi) return null;
      const relative = path.relative(repoRoot, args.path).split(path.sep).join("/");
      // The harness pins git config through the environment; a child git must not
      // inherit it. See the session rule: `Remove-Item env:GIT_CONFIG_COUNT`.
      const env = { ...process.env };
      delete env.GIT_CONFIG_COUNT;
      const contents = execFileSync("git", ["show", `${DEFECT_BASELINE}:${relative}`], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { contents, loader: "ts" };
    });
  },
};

// `host-gateway-api.ts` imports the refusal class from `gateway-server.ts` and the
// `400` branch is `instanceof`, so the two are bundled into one file. Two
// bundles would mean two copies of the class and every refusal would miss the
// branch and pass for the wrong reason.
const directory = mkdtempSync(path.join(os.tmpdir(), "grok-refresh-mcp-routed-action-"));
await build({
  stdin: {
    contents: [
      `export { SandGatewayRequestError, statusForCommandError } from "./source/host/gateway-server.js";`,
      `export { createHostGatewayApi } from "./source/host/host-gateway-api.js";`,
    ].join("\n"),
    resolveDir: sourceRoot,
    sourcefile: "refresh-mcp-entry.ts",
    loader: "ts",
  },
  outfile: path.join(directory, "refresh-mcp.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "silent",
  plugins: [headApiPlugin],
});
const { SandGatewayRequestError, statusForCommandError, createHostGatewayApi } = await import(
  pathToFileURL(path.join(directory, "refresh-mcp.mjs")).href + "?" + Date.now()
);
test.after(() => rmSync(directory, { recursive: true, force: true }));

/**
 * The MCP extension double, plus a ledger of everything `refreshMcp` did.
 *
 * `management.restart` is the expensive thing under test — it is
 * `manager.reloadServers()` behind `onServersMutated`, and every MCP server
 * reconnects when it runs. Everything else is cheap, and is counted only so a
 * test can say which branch ran.
 */
function createHost(body) {
  const calls = { restart: 0, listTools: 0, createExecutor: 0, execute: 0, authCompletion: [], executed: [] };
  const mcp = {
    listTools: async () => {
      calls.listTools += 1;
      return [{ name: "search", providerIdentifier: "prov-1", toolName: "search_docs", description: "d", inputSchema: { toJson: () => ({ type: "object" }) } }];
    },
    createExecutor: () => {
      calls.createExecutor += 1;
      return {
        execute: async (_context, request) => {
          calls.execute += 1;
          calls.executed.push(request);
          return { ok: true };
        },
      };
    },
  };
  const blank = {};
  const api = createHostGatewayApi({
    extensions: {
      api: (id) => {
        if (id === "mcp") {
          return {
            mcp,
            management: {
              restart: async () => {
                calls.restart += 1;
                return [{ serverIdentifier: "srv-1", status: "connected", toolCount: 2 }];
              },
            },
          };
        }
        if (id === "telemetry") return { analytics: { markActive: () => {} } };
        return blank;
      },
    },
    hostEvents: { emit: () => {} },
    decorateForeverBoxStatus: (status) => status,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    forgetLocalToolPermission: () => {},
    handleDesktopMcpAuthCompletion: async (completion) => {
      calls.authCompletion.push(completion);
    },
  });
  return { calls, result: api.refreshMcp(body) };
}

const ROUTED_TOOL_ARGS = {
  name: "search",
  toolName: "search_docs",
  providerIdentifier: "prov-1",
  args: { query: "q" },
};

test("an empty body is the desktop's reload request and must still reload every MCP server", async () => {
  const { calls, result } = createHost({});
  await result;
  assert.equal(calls.restart, 1, "the marketplace install/remove path sends `{}` and depends on the reload happening");
  assert.equal(calls.listTools + calls.createExecutor, 0, "an empty body is a reload, not a routed request");
  assert.deepEqual(calls.authCompletion, [], "an empty body carries no OAuth completion");
});

test("an OAuth completion must be handed over and must not reload the server list", async () => {
  const completion = { serverName: "srv-1", code: "abc" };
  const { calls, result } = createHost({ completion });
  await result;
  assert.deepEqual(calls.authCompletion, [completion], "the desktop's pending OAuth exchange was dropped");
  assert.equal(calls.restart, 0, "finishing one server's handshake must not reconnect every server");
});

test("routedAction list-tools lists routed tools and does not reload", async () => {
  const { calls, result } = createHost({ routedAction: "list-tools" });
  const tools = await result;
  assert.equal(calls.listTools, 1, "the routed tool list was never read");
  assert.equal(calls.restart, 0, "asking for a tool list reloaded every MCP server instead");
  assert.equal(tools[0].name, "search", "the caller received something other than the routed tool list");
});

test("routedAction execute-tool runs the named tool and does not reload", async () => {
  const { calls, result } = createHost({ routedAction: "execute-tool", routedArgs: ROUTED_TOOL_ARGS });
  await result;
  assert.equal(calls.execute, 1, "the routed tool was never executed");
  assert.equal(calls.restart, 0, "executing one routed tool reloaded every MCP server instead");
  assert.equal(calls.executed[0].toolName, "search", "the executor was handed a tool other than the one the caller named");
  assert.equal(calls.executed[0].providerIdentifier, "prov-1", "the executor was handed a provider other than the one the caller named");
});

test("execute-tool without routedArgs names the three fields the tool needs", async () => {
  const { calls, result } = createHost({ routedAction: "execute-tool" });
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof SandGatewayRequestError, "a caller-caused refusal must be the class the gateway answers 400 for");
    for (const field of ["name", "toolName", "providerIdentifier"]) {
      assert.match(error.message, new RegExp(`"${field}"`), `the refusal did not name "${field}"`);
    }
    return true;
  });
  assert.equal(statusForCommandError(await result.catch((error) => error)), 400, "a caller's own missing field was answered with a status that says the host broke");
  assert.equal(calls.restart, 0, "a tool call that named no tool reloaded every MCP server instead");
});

// One character of typo, with every other field correct, so the only thing wrong
// is the discriminator. Before the fix this reloaded the whole server list.
test("a misspelled routedAction is refused by name and never reloads the server list", async () => {
  const { calls, result } = createHost({ routedAction: "execute-tools", routedArgs: ROUTED_TOOL_ARGS });
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof SandGatewayRequestError, "the refusal must be the class the gateway answers 400 for");
    assert.match(error.message, /"routedAction"/, "the refusal did not name the field the caller got wrong");
    assert.match(error.message, /"execute-tools"/, "the refusal did not quote the value that arrived");
    assert.match(error.message, /"list-tools"/, "the refusal did not say which values are legal");
    assert.match(error.message, /"execute-tool"/, "the refusal did not say which values are legal");
    return true;
  });
  assert.equal(calls.restart, 0, "a typo in routedAction reloaded every MCP server and answered 200");
  assert.equal(calls.execute, 0, "a typo in routedAction also ran the tool it was not asked to run");
});

test("a routedAction of the wrong type is refused by name and never reloads the server list", async () => {
  const wrongTypes = [[42, "number"], [null, "null"], [["list-tools"], "an array"], [true, "boolean"], ["", "an empty string"], ["listTools", "listTools"]];
  for (const [routedAction, describedAs] of wrongTypes) {
    const { calls, result } = createHost({ routedAction });
    await assert.rejects(result, (error) => {
      assert.ok(error instanceof SandGatewayRequestError, `routedAction ${JSON.stringify(routedAction)} must be refused as the caller's own mistake`);
      assert.match(error.message, new RegExp(describedAs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `the refusal for ${JSON.stringify(routedAction)} did not say what arrived`);
      return true;
    });
    assert.equal(calls.restart, 0, `routedAction ${JSON.stringify(routedAction)} reloaded every MCP server and answered 200`);
  }
});

test("routedArgs without a routedAction is refused for the field it lost and never reloads", async () => {
  const { calls, result } = createHost({ routedArgs: ROUTED_TOOL_ARGS });
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof SandGatewayRequestError, "the refusal must be the class the gateway answers 400 for");
    assert.match(error.message, /"routedAction"/, "the refusal did not name the action the caller lost");
    return true;
  });
  assert.equal(calls.restart, 0, "a routed tool call that lost its action reloaded every MCP server and answered 200");
  assert.equal(calls.execute, 0, "a routed tool call that lost its action also ran the tool");
});

/**
 * The static half of the proof: `{}` must stay legal because the shipped
 * desktop sends it, and that is a fact about the bundle, not a preference.
 *
 * The 0.18 host bundle says so in its own comment next to `refreshMcp` — "the
 * desktop's marketplace UI mutates MCP state through its OWN SandMcpManager …
 * reload it here so a server the user just added or authenticated in the
 * marketplace is reconnected and surfaced to the agent without a host restart"
 * — and the source that produces it is one ternary. A counter, not a bare
 * match: a guard that finds nothing has proved nothing.
 */
test("the desktop itself sends the empty body that this command treats as a reload", () => {
  const desktop = readFileSync(path.join(sourceRoot, "source", "electron-main", "mcp", "mcp-desktop.ts"), "utf8");
  const senders = desktop.match(/refreshMcp\(completion == null \? \{\} : \{ completion \}\)/g) ?? [];
  assert.equal(senders.length, 1, "the desktop's refreshHostMcp no longer sends `{}` for a plain reload, so this file's first test is guarding a body no caller sends");
  const handlers = desktop.match(/refreshHostMcp\(\)/g) ?? [];
  assert.ok(handlers.length >= 5, `expected the marketplace IPC handlers to reload the host MCP, found ${handlers.length} — the empty-body leg is not load-bearing after all`);
});