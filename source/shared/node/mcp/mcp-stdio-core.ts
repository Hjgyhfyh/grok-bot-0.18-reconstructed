/**
 * Minimal Model Context Protocol stdio wire primitives, ported into the build.
 *
 * Why this file exists twice. `local-mcp/mcp-stdio-core.mjs` is the standalone
 * copy a user can run with a bare `node`, with no build step and no dependency.
 * That copy is outside `source/`, so esbuild never sees it and it never reaches
 * `app.asar`: the servers under `local-mcp/servers/` could talk to a hand-written
 * client but nothing shipped could talk back. This is the same wire code inside
 * `source/`, where the host bundle and the box-exec daemon bundle can import it.
 *
 * Keep the two in step. The `.mjs` form is the readable reference and the one the
 * user runs; this form is the one that ships. A guard in
 * `tests/local-mcp-config-source.test.mjs` proves the shipped graph still carries
 * this module.
 *
 * Wire format is the MCP stdio transport: UTF-8 JSON-RPC 2.0 messages separated
 * by newlines on stdin/stdout. This is NOT LSP `Content-Length` framing.
 *
 * References:
 *   - schema:        source/shared/node/mcp/mcp-display-runtime.ts:2
 *   - transport:     source/shared/node/mcp/mcp-validation.ts:3
 *   - pushed format: source/shared/node/mcp/tools-discovery.ts:162-163
 */

/** Protocol revision this implementation speaks. */
export const PROTOCOL_VERSION = "2024-11-05";

/** JSON-RPC error codes used by the stdio transport. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonRpcEnvelope {
  readonly ok: boolean;
  readonly message?: any;
  readonly error?: Error;
}

/**
 * Splits a byte stream into newline-delimited JSON messages.
 *
 * A partial trailing line is buffered rather than parsed, so a server that
 * writes a large tool description in chunks is not truncated mid-frame.
 */
export function createLineDecoder(): {
  push(chunk: string): JsonRpcEnvelope[];
  flush(): JsonRpcEnvelope[];
} {
  let buffer = "";
  const parseLine = (line: string): JsonRpcEnvelope => {
    try {
      return { ok: true, message: JSON.parse(line) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  };
  return {
    push(chunk: string): JsonRpcEnvelope[] {
      buffer += chunk;
      const messages: JsonRpcEnvelope[] = [];
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) messages.push(parseLine(line));
        newline = buffer.indexOf("\n");
      }
      return messages;
    },
    flush(): JsonRpcEnvelope[] {
      const rest = buffer.trim();
      buffer = "";
      return rest.length === 0 ? [] : [parseLine(rest)];
    },
  };
}

/** Builds a JSON-RPC success response. */
export function okResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** Builds a JSON-RPC error response. */
export function errorResponse(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/** Renders an MCP tool result as the content block shape clients expect. */
export function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Normalises whatever a tool handler returned into the MCP `tools/call` result
 * shape, so handlers can return a plain string or a full result object.
 */
export function toCallResult(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return textResult(value);
  if (value != null && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return value as Record<string, unknown>;
  }
  return textResult(JSON.stringify(value ?? null, null, 2));
}