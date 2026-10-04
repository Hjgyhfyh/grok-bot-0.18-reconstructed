import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * The `custom` inference provider used to be suspected of building a toolset
 * and then never putting it on the wire, which would have made every agent
 * report that it had no tools. It does not: `customExecutor` converts the turn's
 * tool definitions into an `ai` ToolSet and hands them to `streamText`, and the
 * `ai` package serialises them into the `tools` key of the POST body. Nothing
 * dropped them, so nothing caught the near miss.
 *
 * These tests drive the real executor against a loopback OpenAI-compatible
 * endpoint and assert on the bytes that actually arrive, because a code reading
 * of the call chain cannot prove what `@ai-sdk/openai` puts on the wire and a
 * healthy-looking ToolSet proves nothing about the request.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-tools-wire-"));
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
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "inference", "provider-session.ts"],
]);
const { createProviderPromptSession, runRoutedProviderText } = loaded["provider-session.mjs"];

test.after(() => dispose());

const TOUCHED_ENV = [
  "SAND_DATA_ROOT",
  "SAND_USER_DATA_DIR",
  "OPENAI_COMPATIBLE_API_KEY",
];

const savedEnv = new Map();
for (const name of TOUCHED_ENV) {
  savedEnv.set(name, process.env[name]);
  delete process.env[name];
}
test.after(() => {
  for (const name of TOUCHED_ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The three tool families whose presence the user's report turned on. */
const DEFINITIONS = [
  { name: "SendMessage", description: "Send the user a message", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "CreateAgent", description: "Create another agent", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "ReactToMessage", description: "React to a message", inputSchema: { type: "object", properties: { emoji: { type: "string" } } } },
];

/**
 * A loopback stand-in for an OpenAI-compatible `/chat/completions`. It records
 * the request body verbatim and answers with the smallest valid SSE stream the
 * `ai` package accepts, so the executor completes instead of hanging.
 */
async function startEndpoint() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "probe-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "ok" }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Points `getSandRootDir()` at a private directory holding a settings file that
 * names the loopback endpoint. The host re-reads that file on every turn, so
 * the executor under test resolves its base URL from here exactly as it does in
 * the box.
 */
function useEndpoint(baseUrl) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-tools-root-"));
  writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      version: 1,
      inferenceProvider: "custom",
      inferenceCustomEndpoint: { baseUrl, modelId: "probe-model" },
    }),
    "utf8",
  );
  process.env.SAND_DATA_ROOT = root;
  process.env.OPENAI_COMPATIBLE_API_KEY = "probe-key";
  return () => rmSync(root, { recursive: true, force: true });
}

/**
 * Drains the stream the way the product does. `streamText` only settles
 * `result.response` once its `fullStream` has been consumed, so a test that
 * awaits the response alone waits forever instead of failing.
 */
async function drain(result) {
  for await (const _part of result.fullStream) {
    // The parts themselves are not what these tests are about; the bytes that
    // left the process are.
  }
  await result.response;
}

test("the custom provider puts every turn tool into the POST body it sends to the endpoint", async (t) => {
  const endpoint = await startEndpoint();
  const restoreRoot = useEndpoint(endpoint.baseUrl);
  t.after(async () => {
    restoreRoot();
    await endpoint.close();
  });

  const executor = createProviderPromptSession("custom").getExecutor();
  executor.appendMessages([{ role: "user", content: "Что ты умеешь?" }]);
  await drain(executor.stream(undefined, "probe-invocation", DEFINITIONS));

  assert.equal(endpoint.requests.length, 1, "the executor issued exactly one inference request for one turn");
  const body = JSON.parse(endpoint.requests[0].body);
  assert.equal(endpoint.requests[0].url, "/v1/chat/completions", "the tools reach the chat-completions route, not some other one");
  assert.equal(body.model, "probe-model", "the turn ran against the model the settings file named");
  assert.equal(body.tool_choice, "auto", "the endpoint is allowed to pick a tool, so a missing tools array would be the only reason it cannot");
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    DEFINITIONS.map((definition) => definition.name),
    "the agent that claims to have no tools must actually have every tool of its turn on the wire",
  );
  assert.deepEqual(
    body.tools.map((tool) => Object.keys(tool.function).sort()),
    body.tools.map(() => ["description", "name", "parameters"]),
    "each tool carries a name, a description and a JSON-schema parameter block, which is the shape an OpenAI-compatible endpoint requires",
  );
});

test("the OpenCode session header is sent only to the host it belongs to", async (t) => {
  const endpoint = await startEndpoint();
  const restoreRoot = useEndpoint(endpoint.baseUrl);
  t.after(async () => {
    restoreRoot();
    await endpoint.close();
  });

  const executor = createProviderPromptSession("custom").getExecutor();
  executor.appendMessages([{ role: "user", content: "hello" }]);
  await drain(executor.stream(undefined, "probe-invocation", DEFINITIONS));

  assert.equal(
    endpoint.requests[0].headers["x-opencode-session"],
    undefined,
    "a user-supplied OpenAI-compatible host is not opencode.ai and must not be sent OpenCode's private routing header",
  );
});

test("the one-shot routed text helper carries the same tool list onto the wire", async (t) => {
  const endpoint = await startEndpoint();
  const restoreRoot = useEndpoint(endpoint.baseUrl);
  t.after(async () => {
    restoreRoot();
    await endpoint.close();
  });

  await runRoutedProviderText(
    "custom",
    [{ role: "user", content: "hello" }],
    { tools: DEFINITIONS, sessionId: "probe-session" },
  );

  const body = JSON.parse(endpoint.requests[0].body);
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    DEFINITIONS.map((definition) => definition.name),
    "the router's direct text helper must advertise the tools it was handed instead of quietly answering as plain text",
  );
});

/**
 * The MCP usage pair is the one tool surface that is genuinely missing, and the
 * drop is not in the provider. `buildTurnTools` attaches the connector
 * MANAGEMENT tools unconditionally and the connector USAGE tools only when a
 * per-turn MCP projection or a dynamic-tool registry exists:
 * source/host/runner/tools/turn-toolset.ts:1476 against :1483. The box never
 * projects `mcp` and `grok_bot_dynamic_tools` defaults to false
 * (source/shared/node/experiments/experiment-config.gen.ts:146), so an agent
 * can install a connector and has no `GetMcpTools`/`CallMcpTool` to use it,
 * while the shipped system prompt tells it both names exist.
 *
 * The repair is not in the provider layer: source/host/host-runner-composition.ts
 * must project `mcp` for the turn, and this file must build the pair from that
 * projection. Until it does, this obligation is unmet.
 */
test.todo("an agent offered the MCP connector management tools is also offered GetMcpTools and CallMcpTool");