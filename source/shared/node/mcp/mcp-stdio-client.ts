/**
 * Minimal MCP stdio client, ported into the build.
 *
 * Why this file exists twice. `local-mcp/mcp-stdio-client.mjs` is the standalone
 * copy: plain `.mjs`, no build step, no dependency, runnable by the user as
 * `node local-mcp/mcp-stdio-client.mjs --config <file> --list` to check a server
 * by hand before wiring it into Grok Bot. That copy lives outside `source/`, so
 * esbuild never sees it and it never reaches `app.asar` — the transport the
 * product depends on existed only as a developer script. This is the same client
 * inside `source/`, so the host bundle (`source/host/extensions/mcp/`) and the
 * box-exec daemon bundle (`source/box-exec-daemon/`) can both carry it.
 *
 * It is a client, not the SDK. `@modelcontextprotocol/sdk` is absent from
 * `package.json`, from `package-lock.json` and from `node_modules` (zero matches),
 * and adding it is not this change's decision to make.
 *
 * WHAT THIS CLIENT IS NOT ALLOWED TO DO: write. It starts exactly the process
 * described by an `McpServerConfig` the user put in a file by hand. It never
 * creates, patches or deletes that file — see `./local-mcp-config-provider.ts`
 * for why the ability to write one must never belong to the model.
 *
 * stdio servers inherit a filtered environment. `env` is merged on top, because
 * that is the only supported way to hand a server a token; secrets belong in the
 * environment and not in argv, where every process on the machine can read them.
 */

import { spawn } from "node:child_process";

import { createLineDecoder, PROTOCOL_VERSION } from "./mcp-stdio-core.js";
import type { LocalStdioServerConfig } from "./local-mcp-config-provider.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Environment variables that must not leak into a child MCP server process.
 *
 * `NODE_OPTIONS` can inject `--require`, and `ELECTRON_RUN_AS_NODE` re-points a
 * packaged binary at Node with a different module resolution. Both turn "run the
 * user's notes server" into "run something else first".
 */
export const BLOCKED_ENV_KEYS: readonly string[] = ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"];

/**
 * Builds the child environment for a stdio MCP server.
 *
 * `env` is applied last so a config can deliberately re-add a blocked key.
 */
export function buildChildEnv(
  serverEnv: Readonly<Record<string, string>> | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
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
 * @returns human-readable problems; empty when valid.
 */
export function validateArguments(schema: any, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const properties: Record<string, any> = schema?.properties ?? {};
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
      ? declared.type.find((entry: string) => entry === actual || (entry === "integer" && actual === "number"))
      : declared.type;
    if (expected != null && actual !== expected && !(expected === "integer" && actual === "number")) {
      problems.push(`argument "${key}" should be ${expected}, received ${actual}`);
    }
  }
  return problems;
}

export interface McpToolDescription {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: any;
}

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly timeoutMs?: number;
}

/** A connected stdio MCP server. `close()` is idempotent. */
export interface StdioMcpClient {
  listTools(): Promise<McpToolDescription[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

interface PendingRequest {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
}

class StdioMcpClientImpl implements StdioMcpClient {
  private child: ReturnType<typeof spawn> | null = null;
  private readonly decoder = createLineDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private stderr = "";

  constructor(
    private readonly server: LocalStdioServerConfig,
    private readonly timeoutMs: number,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.server.command, [...(this.server.args ?? [])], {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(this.server.env),
        windowsHide: true,
      });
      this.child = child;
      this.stderr = "";

      child.on("error", (error) => this.failAll(new Error(`failed to start MCP server: ${error.message}`)));
      child.on("exit", (code, signal) => {
        if (this.closed) return;
        this.failAll(new Error(`MCP server exited early (code ${code ?? "null"}, signal ${signal ?? "null"}): ${this.stderr.trim().slice(0, 500)}`));
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        this.stderr += String(chunk);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        for (const raw of this.decoder.push(String(chunk))) this.dispatch(raw);
      });

      const onSpawnFailure = (error: Error): void => reject(error);
      child.once("error", onSpawnFailure);
      child.once("spawn", () => {
        child.off("error", onSpawnFailure);
        resolve();
      });
    });
  }

  private dispatch(raw: { ok: boolean; message?: any; error?: Error }): void {
    if (!raw.ok) {
      this.failAll(new Error(`MCP server sent invalid JSON: ${raw.error?.message ?? "parse failure"}`));
      return;
    }
    const message = raw.message;
    if (message == null || message.jsonrpc !== "2.0") return;
    // Responses only. Server-initiated requests are not part of this subset.
    if (message.id === undefined || message.id === null) return;
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error != null) {
      entry.reject(new Error(`${entry.method} failed: ${message.error.message ?? "unknown error"}`));
      return;
    }
    entry.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params?: unknown): Promise<any> {
    if (this.closed || this.child == null) return Promise.reject(new Error("MCP client is closed"));
    const child = this.child;
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed || this.child == null) return;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async listTools(): Promise<McpToolDescription[]> {
    return (await this.request("tools/list", {})).tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("MCP client closed"));
    if (this.child == null) return;
    const child = this.child;
    this.child = null;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.stdin?.end();
      // A server that ignores stdin EOF must not hang the client forever.
      setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000).unref?.();
    });
  }
}

/** Renders a `tools/call` result as plain text, the way the standalone CLI prints it. */
export function renderStdioToolResult(result: any): string {
  if (result == null) return "";
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((block: any) => (block?.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n");
  return result.isError === true ? `[error] ${text}` : text;
}

/**
 * Starts the process a user's configuration describes and completes the
 * `initialize` handshake.
 *
 * A config with no `command` is refused here rather than spawned: this is the
 * only place a local MCP server becomes a running process, and it runs only what
 * the user wrote down.
 */
export async function connectStdioServer(
  server: LocalStdioServerConfig,
  options: StdioMcpClientOptions = {},
): Promise<StdioMcpClient> {
  if (typeof server?.command !== "string" || server.command.length === 0) {
    throw new Error('stdio MCP config requires a non-empty "command" string');
  }
  const client = new StdioMcpClientImpl(server, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  await client.start();
  try {
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
  } catch (error) {
    await client.close();
    throw error;
  }
}