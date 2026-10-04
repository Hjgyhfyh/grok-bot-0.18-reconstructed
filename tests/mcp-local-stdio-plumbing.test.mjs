import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Grok Bot could describe an MCP server but could not run one, and the setting
 * that looked like the place to configure them was never read.
 *
 * Two defects, both invisible until a real tool call was attempted.
 *
 * First, `mcpBoxServers` in the box settings file is a `string[]` of names that
 * nothing consumes. All eight references are store get/set and settings
 * pass-through; not one of them decides which servers to connect. Filling it in
 * therefore changed nothing while looking exactly like the correct action.
 *
 * Second, the schema accepts a stdio server, but no MCP client exists to spawn
 * it. `source/packages/agent-exec/mcp.ts` contains no `spawn` and no
 * `child_process`, `@modelcontextprotocol/sdk` is absent from `package.json`,
 * and the box endpoint that would run the server answers `loadMcpServers` with
 * an empty response while ignoring the configuration it was handed.
 *
 * The static guards below fail if the thing they inspect ever disappears, so a
 * future repair cannot quietly turn this file green by deleting the evidence.
 * The live tests then prove the replacement actually works: a real stdio server,
 * a real handshake, a real `tools/call` round trip, and the path guards on the
 * notes server.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-local-"));
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

function readDirSafe(directory) {
  try {
    return readdirSync(directory).map((name) => {
      const full = path.join(directory, name);
      return { name, isDirectory: () => statSync(full).isDirectory() };
    });
  } catch {
    return [];
  }
}

/** Recursively collects files under `directory`, bounded so a runaway tree fails instead of hanging. */
function listFiles(directory, ceiling = 20_000) {
  const found = [];
  const queue = [directory];
  while (queue.length > 0) {
    assert.ok(found.length < ceiling, `file walk exceeded ${ceiling} files and was stopped rather than hanging`);
    const current = queue.pop();
    for (const entry of readDirSafe(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else found.push(full);
    }
  }
  return found;
}

const importLocal = (relative) => import(pathToFileURL(path.join(repoRoot, "local-mcp", relative)).href);

test("the settings key that looks like MCP configuration is read by nothing that connects a server", () => {
  const files = listFiles(path.join(repoRoot, "source")).filter((file) => file.endsWith(".ts"));
  const hits = files.filter((file) => readFileSync(file, "utf8").includes("mcpBoxServers"));
  // A static guard that matches nothing would pass while proving nothing at all.
  assert.ok(hits.length > 0, "the guard found no references at all and cannot prove the key is dead");

  const connectionPath = ["shared/node/mcp/mcp-manager.ts", "shared/node/mcp/tools-discovery.ts"];
  const relativeHits = hits
    .map((file) => path.relative(path.join(repoRoot, "source"), file).split(path.sep).join("/"))
    .sort();
  for (const relative of relativeHits) {
    assert.ok(
      !connectionPath.includes(relative),
      `${relative} reads mcpBoxServers, so the key is no longer dead and this test is stale`,
    );
  }
  assert.deepEqual(
    relativeHits,
    ["host/extensions/settings/settings-service.ts", "shared/node/settings/sand-settings-store.ts"],
    "mcpBoxServers must stay confined to the settings store and its pass-through, or the key is being misused",
  );
});

test("the box endpoint that runs a stdio server actually reads the configuration it is given", () => {
  const server = readFileSync(path.join(repoRoot, "source", "box-exec-daemon", "server.ts"), "utf8");
  const matches = server.match(/loadMcpServers:\s*async[^,\n]*/g) ?? [];
  assert.ok(matches.length > 0, "the guard found no loadMcpServers handler and cannot judge what it does with a request");
  assert.ok(
    matches.every((handler) => /request|configJson|mcpConfig/.test(handler)),
    "a loadMcpServers handler ignores its request, so a configured stdio server is never started",
  );
  assert.doesNotMatch(
    server,
    /loadMcpServers:\s*async[^,\n]*new LoadMcpServersResponse/,
    "the handler still answers with an empty response, so the endpoint reports success while starting nothing",
  );
});

test("every MCP message the host can send is answered by the daemon instead of rejected", () => {
  const server = readFileSync(path.join(repoRoot, "source", "box-exec-daemon", "server.ts"), "utf8");
  const cases = server.match(/case\s+"[a-zA-Z]+"/g) ?? [];
  const answered = new Set(cases.map((c) => c.replace(/case\s+"|"/g, "")));
  // The host discovers, lists, calls, and reads MCP resources; each needs a branch.
  for (const kind of ["mcpArgs", "mcpStateExecArgs", "listMcpResourcesExecArgs", "readMcpResourceExecArgs"]) {
    assert.ok(answered.has(kind), `${kind} has no branch, so the daemon answers it with "Unsupported ExecServerMessage case"`);
  }
});

test("the agent-exec MCP module contains no process spawning, so no stdio server can be started", () => {
  const module = readFileSync(path.join(repoRoot, "source", "packages", "agent-exec", "mcp.ts"), "utf8");
  for (const marker of ["child_process", "StdioClientTransport", "spawn("]) {
    assert.equal(
      module.includes(marker),
      false,
      `mcp.ts now references ${marker}, so a real stdio client exists and this test is stale`,
    );
  }
});

test("a stdio configuration is classified as stdio and a url configuration as a remote transport", async () => {
  const { loaded, dispose } = await bundle([["shared", "node", "mcp", "mcp-validation.ts"]]);
  try {
    const { getTransport } = loaded["mcp-validation.mjs"];
    assert.equal(getTransport({ command: "node", args: ["server.mjs"] }), "stdio", "a command makes the server stdio");
    assert.equal(getTransport({ url: "https://example.test/mcp" }), "http", "a bare url defaults to streamable http");
    assert.equal(getTransport({ url: "https://example.test/sse", type: "sse" }), "sse", "type sse selects the sse transport");
    assert.equal(
      getTransport({ url: "https://example.test/mcp", type: "http" }),
      "http",
      "an explicit http type selects streamable http",
    );
  } finally {
    dispose();
  }
});

test("a stdio MCP server completes a real handshake and answers a real tool call", async () => {
  const { connectStdioServer } = await importLocal("mcp-stdio-client.mjs");
  const client = await connectStdioServer({
    command: process.execPath,
    args: [path.join(repoRoot, "local-mcp", "servers", "echo-mcp-server.mjs")],
  }, { clientName: "mcp-plumbing-test" });
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["add", "echo"],
      "the server advertised exactly the tools it declares",
    );
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `tool ${tool.name} reached the client without a description`);
      assert.equal(tool.inputSchema?.type, "object", `tool ${tool.name} reached the client with a usable schema`);
    }

    const echoed = await client.callTool("echo", { message: "mcp round trip" });
    assert.notEqual(echoed.isError, true, "a successful call must not be flagged as an error");
    assert.equal(
      echoed.content?.[0]?.text,
      "mcp round trip",
      "the tool call reached the server process and the result came back through stdio",
    );

    const summed = await client.callTool("add", { a: 2, b: 40 });
    assert.equal(summed.content?.[0]?.text, "42", "a second tool on the same server stayed selectable");

    // A protocol-level refusal must reject the call, not resolve to a result the
    // caller could mistake for a successful one.
    await assert.rejects(
      client.callTool("no_such_tool", {}),
      /Unknown tool: no_such_tool/,
      "an unknown tool must be refused by method rather than silently accepted",
    );
  } finally {
    await client.close();
  }
});

test("a server that is missing its configuration exits instead of answering with empty results", async () => {
  const { connectStdioServer } = await importLocal("mcp-stdio-client.mjs");
  const inherited = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    await assert.rejects(
      connectStdioServer({
        command: process.execPath,
        args: [path.join(repoRoot, "local-mcp", "servers", "telegram-mcp-server.mjs")],
        env: { TELEGRAM_BOT_TOKEN: "" },
      }, { timeoutMs: 20_000 }),
      /exited early/,
      "a server without its token must refuse to start rather than serve broken tools",
    );
  } finally {
    if (inherited !== undefined) process.env.TELEGRAM_BOT_TOKEN = inherited;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test("the notes server reads and writes a vault while refusing paths outside it", async () => {
  const { connectStdioServer, validateArguments } = await importLocal("mcp-stdio-client.mjs");
  const vault = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-vault-"));
  writeFileSync(path.join(vault, ".keep"), "", "utf8");
  const client = await connectStdioServer({
    command: process.execPath,
    args: [path.join(repoRoot, "local-mcp", "servers", "graphite-notes-mcp-server.mjs")],
    env: { GRAPHITE_VAULT: vault },
  }, { timeoutMs: 30_000 });
  try {
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name).sort(),
      ["append_note", "create_note", "list_folders", "list_notes", "read_note", "search_notes"],
      "the notes server advertised the full tool surface",
    );

    const created = await client.callTool("create_note", { title: "Probe", body: "first", folder: "Входящие" });
    assert.notEqual(created.isError, true, `creating a note failed: ${created.content?.[0]?.text}`);
    assert.match(
      String(created.content?.[0]?.text),
      /"mode": "created"/,
      "the server reported which write mode it used",
    );

    const read = await client.callTool("read_note", { path: "Входящие/Probe.md" });
    assert.match(
      String(read.content?.[0]?.text),
      /type: note/,
      "the note was written with the frontmatter shape Graphite itself uses",
    );

    const duplicated = await client.callTool("create_note", { title: "Probe", body: "again", folder: "Входящие" });
    assert.equal(duplicated.isError, true, "creating an existing note must fail instead of destroying it");

    const traversal = await client.callTool("read_note", { path: "../escape.md" });
    assert.equal(traversal.isError, true, "a path escaping the vault must be refused");
    assert.match(
      String(traversal.content?.[0]?.text),
      /escapes the vault/,
      "the refusal explains why the path was rejected",
    );

    const reserved = await client.callTool("read_note", { path: ".graphite/index.db" });
    assert.equal(reserved.isError, true, "Graphite's own metadata directory must not be reachable as a note");

    const listed = await client.callTool("list_notes", { folder: "Входящие" });
    assert.match(String(listed.content?.[0]?.text), /Входящие\/Probe\.md/, "the new note is listed under its folder");

    assert.deepEqual(
      validateArguments({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, {}),
      ['missing required argument "a"'],
      "the client refuses to send a call the schema forbids",
    );
  } finally {
    await client.close();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("the telegram server speaks the Bot API without the real Telegram being contacted", async () => {
  const { createTelegramStub } = await importLocal(path.join("test-support", "telegram-bot-api-stub.mjs"));
  const { connectStdioServer } = await importLocal("mcp-stdio-client.mjs");
  const stub = createTelegramStub(0);
  await stub.ready;
  const client = await connectStdioServer({
    command: process.execPath,
    args: [path.join(repoRoot, "local-mcp", "servers", "telegram-mcp-server.mjs")],
    env: { TELEGRAM_BOT_TOKEN: stub.validToken, TELEGRAM_API_BASE: `http://127.0.0.1:${stub.server.address().port}` },
  }, { timeoutMs: 30_000 });
  try {
    assert.equal((await client.listTools()).length, 5, "the telegram server advertised all five tools");

    const sent = await client.callTool("send_message", { chat_id: "42", text: "digest" });
    assert.notEqual(sent.isError, true, `sending failed: ${sent.content?.[0]?.text}`);
    assert.equal(stub.sent.length, 1, "exactly one message reached the stub API");
    assert.equal(stub.sent[0].text, "digest", "the message body arrived intact");
  } finally {
    await client.close();
    await new Promise((resolve) => stub.server.close(resolve));
  }

  const second = createTelegramStub(0);
  await second.ready;
  const rejecting = await connectStdioServer({
    command: process.execPath,
    args: [path.join(repoRoot, "local-mcp", "servers", "telegram-mcp-server.mjs")],
    env: {
      TELEGRAM_BOT_TOKEN: "not-the-stub-token",
      TELEGRAM_API_BASE: `http://127.0.0.1:${second.server.address().port}`,
    },
  }, { timeoutMs: 30_000 });
  try {
    const refused = await rejecting.callTool("get_me", {});
    assert.equal(refused.isError, true, "a rejected token must surface as a tool error, not a silent success");
    assert.match(String(refused.content?.[0]?.text), /rejected by Telegram/, "the refusal names the real cause");
  } finally {
    await rejecting.close();
    await new Promise((resolve) => second.server.close(resolve));
  }
});

test("the dsh server drives the harness and reports a failed task as a failure", async () => {
  const { connectStdioServer } = await importLocal("mcp-stdio-client.mjs");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-dsh-"));
  const harness = path.join(scratch, "harness");
  mkdirSync(harness, { recursive: true });
  const windows = process.platform === "win32";
  const stubCli = path.join(scratch, windows ? "dsh-stub.cmd" : "dsh-stub.sh");
  const failingCli = path.join(scratch, windows ? "dsh-fail.cmd" : "dsh-fail.sh");
  writeFileSync(
    stubCli,
    windows ? "@echo off\r\necho ARGS %*\r\necho agent-output\r\nexit /b 0\r\n" : "#!/bin/sh\necho \"ARGS $@\"\necho agent-output\nexit 0\n",
    "utf8",
  );
  writeFileSync(
    failingCli,
    windows ? "@echo off\r\necho task failed 1>&2\r\nexit /b 3\r\n" : "#!/bin/sh\necho task failed >&2\nexit 3\n",
    "utf8",
  );

  const run = async (cli, args) => {
    const client = await connectStdioServer({
      command: process.execPath,
      args: [path.join(repoRoot, "local-mcp", "servers", "dsh-agent-mcp-server.mjs")],
      env: { DSH_ROOT: harness, DSH_CLI: cli },
    }, { timeoutMs: 60_000 });
    try {
      return await client.callTool("dsh_run_task", args);
    } finally {
      await client.close();
    }
  };

  try {
    const ok = await run(stubCli, { task: "write a test", profile: "web" });
    assert.notEqual(ok.isError, true, `the successful run was reported as an error: ${ok.content?.[0]?.text}`);
    const text = String(ok.content?.[0]?.text);
    assert.match(text, /ARGS --profile web headless write a test/, "launcher flags precede the headless task text");
    assert.match(text, /agent-output/, "the agent's own output reached the caller");

    const failed = await run(failingCli, { task: "write a test" });
    assert.equal(failed.isError, true, "a non-zero exit from dsh must not look like success");
    assert.match(String(failed.content?.[0]?.text), /exited 3/, "the failure reports the exit code the harness returned");

    const empty = await run(stubCli, { task: "   " });
    assert.equal(empty.isError, true, "an empty task must be refused before dsh is started");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});