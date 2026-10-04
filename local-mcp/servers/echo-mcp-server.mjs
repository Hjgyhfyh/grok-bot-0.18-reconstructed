/**
 * `echo` MCP server — the transport proof.
 *
 * Needs no credentials, no network and no account. If a `tools/list` and
 * `tools/call` round-trip works here, the MCP stdio transport itself is sound
 * and any failure the user sees with a real server is a configuration problem,
 * not a broken protocol.
 *
 * Run it by hand:
 *   node local-mcp/servers/echo-mcp-server.mjs
 *
 * Verify it through the client:
 *   node local-mcp/mcp-stdio-client.mjs --config local-mcp/examples/echo.config.json --list
 *   node local-mcp/mcp-stdio-client.mjs --config local-mcp/examples/echo.config.json \
 *     --call echo --args '{"message":"hello"}'
 */

import { serveStdio } from "../mcp-stdio-core.mjs";

serveStdio({
  name: "echo",
  version: "1.0.0",
  instructions: "A no-credential MCP server used to prove that stdio MCP transport works.",
  tools: [
    {
      name: "echo",
      description: "Return the given message unchanged. Useful for verifying that a tool call really reaches the server and returns.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Text to echo back." },
        },
        required: ["message"],
      },
    },
    {
      name: "add",
      description: "Add two numbers. A second tool proves the client can select among several.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number", description: "First addend." },
          b: { type: "number", description: "Second addend." },
        },
        required: ["a", "b"],
      },
    },
  ],
  onCall(toolName, args) {
    switch (toolName) {
      case "echo":
        return String(args.message);
      case "add": {
        const a = Number(args.a);
        const b = Number(args.b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("add expects finite numbers");
        return String(a + b);
      }
      default:
        throw new Error(`unhandled tool: ${toolName}`);
    }
  },
});