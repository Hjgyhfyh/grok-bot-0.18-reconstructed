/**
 * Minimal Model Context Protocol stdio core, shared by every server in
 * `local-mcp/servers/`.
 *
 * Why this file exists: grok-bot-0.18-reconstructed has no MCP client at all.
 * `source/packages/agent-exec/mcp.ts` contains no `spawn`, no `child_process`
 * and no `command`/`args` handling, and `@modelcontextprotocol/sdk` is absent
 * from both `package.json` and `node_modules`. The schema in
 * `source/shared/node/mcp/mcp-display-runtime.ts:2` accepts `{ command, args,
 * env }`, but nothing in this repository ever starts such a process. The box
 * endpoint that would run it is a stub:
 * `source/box-exec-daemon/server.ts:472` answers `loadMcpServers` with an empty
 * `LoadMcpServersResponse` and ignores the config it was given.
 *
 * These modules are therefore deliberately standalone: plain `.mjs`, no build
 * step, no dependency. The user points `command`/`args` at them and can verify
 * a server by hand before wiring anything into the app.
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

/** JSON-RPC error codes used by this core. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

/**
 * Splits a byte stream into newline-delimited JSON messages.
 *
 * A partial trailing line is buffered rather than parsed, so a server that
 * writes a large tool description in chunks is not truncated mid-frame.
 *
 * @returns {{ push: (chunk: string) => unknown[], flush: () => unknown[] }}
 */
export function createLineDecoder() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const messages = [];
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) messages.push(parseLine(line));
        newline = buffer.indexOf("\n");
      }
      return messages;
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      return rest.length === 0 ? [] : [parseLine(rest)];
    },
  };
}

function parseLine(line) {
  try {
    return { ok: true, message: JSON.parse(line) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Builds a JSON-RPC success response. */
export function okResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/** Builds a JSON-RPC error response. */
export function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/** Renders an MCP tool result as the content block shape clients expect. */
export function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Normalises whatever a tool handler returned into the MCP `tools/call` result
 * shape, so handlers can return a plain string or a full result object.
 */
export function toCallResult(value) {
  if (typeof value === "string") return textResult(value);
  if (value != null && typeof value === "object" && Array.isArray(value.content)) return value;
  return textResult(JSON.stringify(value ?? null, null, 2));
}

/**
 * Runs an MCP server over stdio.
 *
 * @param {object} server
 * @param {string} server.name            Server name reported to the client.
 * @param {string} server.version         Server version reported to the client.
 * @param {Array<{ name: string, description: string, inputSchema: object }>} server.tools
 * @param {(toolName: string, args: object, extra: object) => Promise<unknown>} server.onCall
 * @param {Record<string, unknown>} [server.instructions] Optional text surfaced via `serverInfo`.
 * @param {NodeJS.ReadableStream} [server.input]  Defaults to `process.stdin`.
 * @param {NodeJS.WritableStream} [server.output] Defaults to `process.stdout`.
 * @returns {{ close: () => void }}
 */
export function serveStdio(server) {
  const { name, version, tools, onCall } = server;
  const input = server.input ?? process.stdin;
  const output = server.output ?? process.stdout;
  const decoder = createLineDecoder();

  const send = (payload) => {
    output.write(`${JSON.stringify(payload)}\n`);
  };

  const negotiate = (id, params) => {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
    send(okResponse(id, {
      // Echo a revision we understand; fall back to ours rather than failing the
      // handshake, because a newer client still speaks the same method names.
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name,
        version,
        ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
      },
    }));
  };

  const listTools = (id) => {
    send(okResponse(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      })),
    }));
  };

  const callTool = async (id, params) => {
    const toolName = params?.name;
    const known = tools.some((tool) => tool.name === toolName);
    if (!known) {
      send(errorResponse(id, JSON_RPC_ERRORS.methodNotFound, `Unknown tool: ${String(toolName)}`));
      return;
    }
    const args = params?.arguments ?? {};
    if (args == null || typeof args !== "object" || Array.isArray(args)) {
      send(errorResponse(id, JSON_RPC_ERRORS.invalidParams, "arguments must be an object"));
      return;
    }
    try {
      send(okResponse(id, toCallResult(await onCall(toolName, args, { serverName: name }))));
    } catch (error) {
      // A throwing tool is a tool-level failure, not a transport failure: the
      // client needs the result envelope with isError so it can show the message.
      send(okResponse(id, textResult(error instanceof Error ? error.message : String(error), true)));
    }
  };

  const handle = async (raw) => {
    if (!raw.ok) {
      send(errorResponse(null, JSON_RPC_ERRORS.parseError, "Invalid JSON"));
      return;
    }
    const message = raw.message;
    if (message == null || message.jsonrpc !== "2.0") {
      send(errorResponse(message?.id ?? null, JSON_RPC_ERRORS.invalidRequest, "Expected JSON-RPC 2.0"));
      return;
    }
    const { id, method, params } = message;
    // A request without an id is a notification and must never be answered.
    const isNotification = id === undefined || id === null;
    switch (method) {
      case "initialize":
        if (!isNotification) negotiate(id, params);
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
        return;
      case "ping":
        if (!isNotification) send(okResponse(id, {}));
        return;
      case "tools/list":
        if (!isNotification) listTools(id);
        return;
      case "tools/call":
        if (!isNotification) await callTool(id, params);
        return;
      case "resources/list":
        if (!isNotification) send(okResponse(id, { resources: [] }));
        return;
      case "prompts/list":
        if (!isNotification) send(okResponse(id, { prompts: [] }));
        return;
      default:
        if (!isNotification) {
          send(errorResponse(id, JSON_RPC_ERRORS.methodNotFound, `Unknown method: ${String(method)}`));
        }
    }
  };

  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    for (const raw of decoder.push(String(chunk))) void handle(raw);
  });
  input.on("end", () => {
    for (const raw of decoder.flush()) void handle(raw);
  });

  return { close: () => input.removeAllListeners("data") };
}