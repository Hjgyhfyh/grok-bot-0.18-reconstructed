/**
 * Minimal MCP stdio client.
 *
 * Counterpart to `mcp-stdio-core.mjs`. It starts the process described by an
 * `McpServerConfig` (the exact shape from
 * `source/shared/node/mcp/mcp-display-runtime.ts:2`), performs the
 * `initialize` handshake, and exposes `listTools` / `callTool`.
 *
 * Two uses:
 *   1. `node local-mcp/mcp-stdio-client.mjs --config <file.json> --list` lets
 *      the user verify a server by hand, with no account and no network, before
 *      wiring it into Grok Bot.
 *   2. `tests/mcp-local-stdio-plumbing.test.mjs` drives it to prove the
 *      transport really works end to end.
 *
 * stdio servers inherit a filtered environment. `McpServerConfig.env` is merged
 * on top, because that is the only supported way to hand a server a token; see
 * the README for why secrets belong in the environment and not in argv.
 */

import { spawn } from "node:child_process";

import { createLineDecoder, PROTOCOL_VERSION } from "./mcp-stdio-core.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Environment variables that must not leak into a child MCP server process. */
export const BLOCKED_ENV_KEYS = ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"];

/**
 * Builds the child environment for a stdio MCP server.
 *
 * `env` is applied last so a config can deliberately re-add a blocked key.
 */
export function buildChildEnv(serverEnv, baseEnv = process.env) {
  const childEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (BLOCKED_ENV_KEYS.includes(key)) continue;
    if (typeof value === "string") childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(serverEnv ?? {})) {
    childEnv[key] = String(value);
  }
  return childEnv;
}

/**
 * Validates a value against the subset of JSON Schema these servers use:
 * required properties and primitive types. A full validator is not needed and
 * would be a dependency this repository does not have.
 *
 * @returns {string[]} human-readable problems; empty when valid.
 */
export function validateArguments(schema, args) {
  const problems = [];
  const properties = schema?.properties ?? {};
  for (const required of schema?.required ?? []) {
    if (args[required] === undefined || args[required] === null) {
      problems.push(`missing required argument "${required}"`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const declared = properties[key];
    if (declared == null || value === undefined) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const expected = Array.isArray(declared.type)
      ? declared.type.find((entry) => entry === actual || (entry === "integer" && actual === "number"))
      : declared.type;
    if (expected != null && actual !== expected && !(expected === "integer" && actual === "number")) {
      problems.push(`argument "${key}" should be ${expected}, received ${actual}`);
    }
  }
  return problems;
}

/**
 * Starts an MCP server described by `{ command, args, env }` and returns a
 * connected client.
 *
 * @param {{ command: string, args?: string[], env?: Record<string,string> }} server
 * @param {{ clientName?: string, clientVersion?: string, timeoutMs?: number }} [options]
 */
export async function connectStdioServer(server, options = {}) {
  if (typeof server?.command !== "string" || server.command.length === 0) {
    throw new Error('stdio MCP config requires a non-empty "command" string');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new StdioMcpClient(server, timeoutMs);
  await client.start();
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: options.clientName ?? "grokbot-local-mcp-client",
      version: options.clientVersion ?? "1.0.0",
    },
  });
  client.notify("notifications/initialized", {});
  return client;
}

class StdioMcpClient {
  #child = null;
  #decoder = createLineDecoder();
  #pending = new Map();
  #nextId = 1;
  #closed = false;

  constructor(server, timeoutMs) {
    this.server = server;
    this.timeoutMs = timeoutMs;
  }

  start() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.server.command, this.server.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(this.server.env),
        windowsHide: true,
      });
      this.#child = child;
      this.stderr = "";

      child.on("error", (error) => this.#failAll(new Error(`failed to start MCP server: ${error.message}`)));
      child.on("exit", (code, signal) => {
        if (this.#closed) return;
        this.#failAll(new Error(`MCP server exited early (code ${code ?? "null"}, signal ${signal ?? "null"}): ${this.stderr.trim().slice(0, 500)}`));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { this.stderr += chunk; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        for (const raw of this.#decoder.push(chunk)) this.#dispatch(raw);
      });

      const onSpawnFailure = (error) => reject(error);
      child.once("error", onSpawnFailure);
      child.once("spawn", () => {
        child.off("error", onSpawnFailure);
        resolve();
      });
    });
  }

  #dispatch(raw) {
    if (!raw.ok) {
      this.#failAll(new Error(`MCP server sent invalid JSON: ${raw.error?.message ?? "parse failure"}`));
      return;
    }
    const message = raw.message;
    if (message == null || message.jsonrpc !== "2.0") return;
    // Responses only. Server-initiated requests are not part of this subset.
    if (message.id === undefined || message.id === null) return;
    const entry = this.#pending.get(message.id);
    if (entry === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error != null) {
      entry.reject(new Error(`${entry.method} failed: ${message.error.message ?? "unknown error"}`));
      return;
    }
    entry.resolve(message.result);
  }

  #failAll(error) {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  request(method, params) {
    if (this.#closed || this.#child == null) return Promise.reject(new Error("MCP client is closed"));
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    if (this.#closed || this.#child == null) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools() {
    return (await this.request("tools/list", {})).tools ?? [];
  }

  async callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  /** Renders a `tools/call` result as plain text for console output. */
  static render(result) {
    if (result == null) return "";
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks.map((block) => (block?.type === "text" ? block.text : JSON.stringify(block))).join("\n");
    return result.isError === true ? `[error] ${text}` : text;
  }

  async close() {
    this.#closed = true;
    this.#failAll(new Error("MCP client closed"));
    if (this.#child == null) return;
    const child = this.#child;
    this.#child = null;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.stdin.end();
      // A server that ignores stdin EOF must not hang the client forever.
      setTimeout(() => { child.kill(); resolve(); }, 2_000).unref?.();
    });
  }
}

/**
 * Reads a config file holding `{ "mcpServers": { <name>: <McpServerConfig> } }`
 * or a bare `{ <name>: <McpServerConfig> }`, and returns the chosen entry.
 *
 * This is the same envelope Grok Bot pushes to its box, see
 * `source/shared/node/mcp/tools-discovery.ts:162-163`.
 */
export function readServerConfigFile(contents, serverName) {
  let parsed;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`config file is not valid JSON: ${error.message}`);
  }
  const servers = parsed != null && typeof parsed === "object" && parsed.mcpServers != null
    ? parsed.mcpServers
    : parsed;
  if (servers == null || typeof servers !== "object") {
    throw new Error('config file must contain an object, optionally under an "mcpServers" key');
  }
  const names = Object.keys(servers);
  const chosen = serverName ?? names[0];
  if (chosen === undefined) throw new Error("config file declares no servers");
  const entry = servers[chosen];
  if (entry == null) throw new Error(`config file has no server named "${chosen}" (found: ${names.join(", ") || "none"})`);
  return { name: chosen, config: entry };
}

/**
 * Resolves `--args <json>` or `--args-file <path>` into a plain object.
 *
 * `--args-file` exists because PowerShell mangles quoted JSON passed to a native
 * command: a message containing spaces arrives with its quotes stripped, and the
 * call fails with "Unterminated string" before MCP is ever involved. On Windows
 * prefer a file, or pass JSON without spaces.
 */
function resolveArgs(argv, readFileSync) {
  if (argv.includes("--args-file")) {
    const path = argv[argv.indexOf("--args-file") + 1];
    if (path === undefined) throw new Error("--args-file needs a path");
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  }
  const raw = argv.includes("--args") ? argv[argv.indexOf("--args") + 1] : "{}";
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`--args is not valid JSON (${error.message}); on PowerShell pass --args-file <path> instead`);
  }
}

/** CLI entry point: `--config <file> [--server <name>] [--list | --call <tool> [--args <json> | --args-file <path>]]` */
async function main(argv) {
  const configPath = argv[argv.indexOf("--config") + 1];
  if (configPath === undefined) {
    process.stderr.write('usage: node local-mcp/mcp-stdio-client.mjs --config <file.json> [--server <name>] [--list | --call <tool> [--args <json> | --args-file <path>]]\n');
    process.exitCode = 2;
    return;
  }
  const { readFileSync } = await import("node:fs");
  const { name, config } = readServerConfigFile(readFileSync(configPath, "utf8"), argv.includes("--server") ? argv[argv.indexOf("--server") + 1] : undefined);
  if (config.url !== undefined) {
    throw new Error(`server "${name}" uses a remote transport; this client only speaks stdio ({ command, args, env })`);
  }
  const client = await connectStdioServer(config);
  try {
    const tools = await client.listTools();
    if (!argv.includes("--call")) {
      process.stdout.write(`${JSON.stringify({ server: name, toolCount: tools.length, tools: tools.map((tool) => ({ name: tool.name, description: tool.description })) }, null, 2)}\n`);
      return;
    }
    const toolName = argv[argv.indexOf("--call") + 1];
    const declared = tools.find((tool) => tool.name === toolName);
    if (declared === undefined) throw new Error(`server "${name}" has no tool "${toolName}" (has: ${tools.map((tool) => tool.name).join(", ")})`);
    let args;
    try {
      args = resolveArgs(argv, readFileSync);
    } catch (error) {
      throw new Error(`arguments rejected: ${error.message}`);
    }
    const problems = validateArguments(declared.inputSchema, args);
    if (problems.length > 0) throw new Error(`arguments rejected: ${problems.join("; ")}`);
    const result = await client.callTool(toolName, args);
    process.stdout.write(`${StdioMcpClient.render(result)}\n`);
    // A tool that returned isError is a failed call, and a scheduled job must be
    // able to notice. Exiting 0 here would make a failed digest look delivered.
    if (result?.isError === true) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv[1] != null && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}