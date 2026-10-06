import {
  McpArgs,
  McpError,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult
} from "../../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import { Value, type JsonValue } from "@bufbuild/protobuf";
import { mcpExecutorResource, mcpStateExecutorResource } from "../../../packages/agent-exec/mcp.js";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../packages/agent-exec/remote.js";
import { createContext } from "../../../packages/context/core.js";
import { recordMcpExecErrorClass } from "../../../shared/node/mcp/mcp-diagnostics.js";
import {
  boxLoadMcpServers,
  boxMcpResourceAccessor,
  type CapableBox
} from "../../box/box-capabilities.js";

export class SandBoxMcpExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandBoxMcpExecError";
  }
}

export interface BoxMcpTool {
  name: string;
  providerIdentifier: string;
  toolName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface BoxMcpExecPort {
  loadServers(configJson: string): Promise<void>;
  listTools(
    serverIdentifiers: readonly string[],
    options?: { kickOnly?: boolean }
  ): Promise<Array<{
    serverIdentifier: string;
    status: string;
    statusDetail?: string;
    toolCount: number;
    tools: Array<BoxMcpTool & { clientKey: string }>;
  }>>;
  executeTool(args: McpArgs): Promise<McpResult>;
}

export function errorLabel(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** Mirrors `toJsonValue` in `packages/agent/tools/mcp/mcp.ts:74`: what a `Value` can carry. */
function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    for (const entry of value) {
      const jsonValue = toJsonValue(entry);
      if (jsonValue === undefined) return undefined;
      values.push(jsonValue);
    }
    return values;
  }
  if (typeof value !== "object") return undefined;
  const record: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const jsonValue = toJsonValue(entry);
    if (jsonValue !== undefined) record[key] = jsonValue;
  }
  return record;
}

/**
 * The `McpArgs` the box is asked for.
 *
 * `McpArgs.args` is a `map<string, Value>`. Two callers reach this port and they
 * hold two different things in that map. A turn builds it in `buildMcpArgs`
 * (`packages/agent/tools/mcp/mcp.ts:216-228`) and holds real `Value` messages;
 * the routed gateway command hands over whatever the HTTP body carried, which is
 * plain JSON.
 *
 * Plain JSON does not fail loudly. `ExecServerMessage` encodes a plain value into
 * a `Value` as an empty one, so the map entry survives and the value does not:
 * measured against a live `BoxExecRuntime` and the repository's own `echo` MCP
 * server, `{"args":{"a":19,"b":23}}` serialized to 43 bytes where the identical
 * call from a turn serialized to 67, and the box answered the first with
 * `google.protobuf.Value must have a value` while the second returned `42`. The
 * tool never ran.
 *
 * The check for "already a `Value`" is the same duck-typing `toJsonArgs` uses in
 * the other direction, so a turn's arguments pass through untouched.
 */
export function toBoxMcpArgs(args: McpArgs): McpArgs {
  const values: Record<string, Value> = {};
  for (const [key, value] of Object.entries(args.args ?? {})) {
    if (typeof value === "object" && value !== null && "toJson" in value && typeof (value as Value).toJson === "function") {
      values[key] = value as Value;
      continue;
    }
    const json = toJsonValue(value);
    if (json !== undefined) values[key] = Value.fromJson(json);
  }
  return new McpArgs({ ...args, args: values });
}

function errorResult(message: string): McpResult {
  return new McpResult({
    result: { case: "error", value: new McpError({ error: message }) }
  });
}

type McpAccessor = ResourceAccessor<RemoteExecManager>;

export function createBoxSandMcpExec(box: CapableBox): BoxMcpExecPort {
  const ctx = createContext().withName("sandBoxMcp");
  return {
    async loadServers(configJson) {
      await boxLoadMcpServers(box, ctx, configJson);
    },
    async listTools(serverIdentifiers, options) {
      const accessor = await boxMcpResourceAccessor(box, ctx) as McpAccessor;
      const result = await accessor.get(mcpStateExecutorResource).execute(
        ctx,
        new McpStateExecArgs({
          serverIdentifiers: [...serverIdentifiers],
          kickOnly: options?.kickOnly === true
        })
      );
      if (result.result.case !== "success") {
        throw new SandBoxMcpExecError(
          `Box MCP tool discovery failed: ${result.result.case ?? "empty result"}`
        );
      }
      const requested = new Set(serverIdentifiers);
      return result.result.value.servers
        .filter(server => requested.size === 0 || requested.has(server.serverIdentifier))
        .map(server => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status ?? "connected",
          ...(server.errorMessage == null || server.errorMessage.length === 0
            ? {}
            : { statusDetail: server.errorMessage }),
          toolCount: server.tools.length,
          tools: server.tools.map(tool => ({
            name: tool.name,
            providerIdentifier: tool.providerIdentifier,
            toolName: tool.toolName,
            clientKey: server.serverIdentifier,
            ...(tool.description.length === 0 ? {} : { description: tool.description }),
            ...(tool.inputSchema == null ? {} : { inputSchema: tool.inputSchema.toJson() })
          }))
        }));
    },
    async executeTool(args) {
      try {
        const accessor = await boxMcpResourceAccessor(box, ctx) as McpAccessor;
        return await accessor.get(mcpExecutorResource).execute(ctx, toBoxMcpArgs(args));
      } catch (error) {
        recordMcpExecErrorClass(args.toolCallId, error);
        return errorResult(
          `Box MCP execution failed for "${args.name}": ${errorLabel(error)}`
        );
      }
    }
  };
}
