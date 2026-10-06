import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { MethodKind, Struct, Value, type ServiceType } from "@bufbuild/protobuf";

import {
  POSIX_COMMAND_INTERPRETER_FALLBACK,
  WINDOWS_COMMAND_INTERPRETER_FALLBACK,
  isWindowsCommandInterpreter,
  readEnvName,
  withShellTextEnv,
} from "../packages/shell-exec/shell-env.js";
import { killProcessTree } from "../packages/local-exec/process-tree.js";
import { createShellOutputDecoder, resolveConsoleCodePageLabel } from "./shell-output-text.js";
import { ControlService } from "../packages/proto/generated/agent/v1/control_service_connect.js";
import { ExecService } from "../packages/proto/generated/agent/v1/exec_service_connect.js";
import {
  GetCapabilitiesResponse,
  LoadMcpServersResponse,
  PingResponse,
  UpdateEnvironmentVariablesResponse,
  type LoadMcpServersRequest,
  type UpdateEnvironmentVariablesRequest,
} from "../packages/proto/generated/agent/v1/control_service_pb.js";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientStreamClose,
  ExecClientThrow,
  type ExecServerMessage,
} from "../packages/proto/generated/agent/v1/exec_pb.js";
import { ExecStreamElement } from "../packages/proto/generated/agent/v1/exec_service_pb.js";
import {
  ListMcpResourcesError,
  ListMcpResourcesExecArgs,
  ListMcpResourcesExecResult,
  ListMcpResourcesExecResult_McpResource,
  ListMcpResourcesRejected,
  ListMcpResourcesSuccess,
  McpArgs,
  McpError,
  McpImageContent,
  McpResult,
  McpServerNotFound,
  McpStateError,
  McpStateExecArgs,
  McpStateExecResult,
  McpStateRejected,
  McpStateServer,
  McpStateSuccess,
  McpSuccess,
  McpTextContent,
  McpToolNotFound,
  McpToolResultContentItem,
  ReadMcpResourceError,
  ReadMcpResourceExecArgs,
  ReadMcpResourceExecResult,
  ReadMcpResourceNotFound,
  ReadMcpResourceRejected,
  ReadMcpResourceSuccess,
} from "../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import { McpToolDefinition } from "../packages/proto/generated/agent/v1/mcp_pb.js";
import {
  connectStdioServer,
  type StdioMcpClient,
  type StdioMcpClientOptions,
} from "../shared/node/mcp/mcp-stdio-client.js";
import type { LocalStdioServerConfig } from "../shared/node/mcp/local-mcp-config-provider.js";
import {
  BackgroundShellSpawnError,
  BackgroundShellSpawnResult,
  BackgroundShellSpawnSuccess,
  WriteShellStdinError,
  WriteShellStdinResult,
  WriteShellStdinSuccess,
  type BackgroundShellSpawnArgs,
  type WriteShellStdinArgs,
} from "../packages/proto/generated/agent/v1/background_shell_exec_pb.js";
import {
  ReadError,
  ReadFileNotFound,
  ReadInvalidFile,
  ReadPermissionDenied,
  ReadRejected,
  ReadResult,
  ReadSuccess,
  type ReadArgs,
} from "../packages/proto/generated/agent/v1/read_exec_pb.js";
import {
  ShellFailure,
  ShellResult,
  ShellSpawnError,
  ShellStream,
  ShellStreamExit,
  ShellStreamStart,
  ShellStreamStderr,
  ShellStreamStdout,
  ShellSuccess,
  ShellTimeout,
  type ShellArgs,
} from "../packages/proto/generated/agent/v1/shell_exec_pb.js";

// Recovered generated descriptors predate `satisfies ServiceType` and therefore
// widen MethodKind during TypeScript reconstruction. Re-declaring only the
// daemon-owned routes preserves their exact names/message types and restores the
// literal method kinds required by Connect's implementation type inference.
const BoxControlService = {
  typeName: ControlService.typeName,
  methods: {
    ping: { ...ControlService.methods.ping, kind: MethodKind.Unary },
    getCapabilities: { ...ControlService.methods.getCapabilities, kind: MethodKind.Unary },
    updateEnvironmentVariables: { ...ControlService.methods.updateEnvironmentVariables, kind: MethodKind.Unary },
    loadMcpServers: { ...ControlService.methods.loadMcpServers, kind: MethodKind.Unary },
  },
} as const satisfies ServiceType;

const BoxExecService = {
  typeName: ExecService.typeName,
  methods: { exec: { ...ExecService.methods.exec, kind: MethodKind.ServerStreaming } },
} as const satisfies ServiceType;

export const BOX_EXEC_DAEMON_HOST = "127.0.0.1";
export const BOX_EXEC_DAEMON_PORT = 1337;

/**
 * The daemon's bearer credential.
 *
 * It used to be the literal "local", which made command execution on this
 * machine available to anyone who had read a public repository: a live probe
 * answered 401 without a header and 404 with `Authorization: Bearer local`,
 * and 404 is what a *correct* token returns on a route the daemon does not
 * serve. The only holder of the credential must be the starter, and it already
 * exports one through SAND_BOX_EXEC_DAEMON_AUTH_TOKEN. When that variable is
 * absent the daemon mints its own random token, which no client can guess: the
 * daemon then refuses every caller rather than accepting every caller.
 */
export function resolveBoxExecDaemonAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN?.trim();
  return configured != null && configured.length > 0 ? configured : randomBytes(32).toString("base64url");
}

export const BOX_EXEC_DAEMON_AUTH_TOKEN = resolveBoxExecDaemonAuthToken();
export const BOX_TERMINAL_VIRTUAL_PREFIX = "/root/.cursor/projects/workspace/terminals/";

export interface BoxExecDaemonOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface BoxExecDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory: string;
  readonly ready: Promise<void>;
  isReady(): boolean;
  stop(): Promise<void>;
}

interface BackgroundProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly terminalPath: string;
  readonly startedAt: number;
  writeQueue: Promise<void>;
}

interface ProcessOutcome {
  readonly code: number;
  readonly signal: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

class PathRejectedError extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One command, the program that runs it, and the argv that program expects. */
export interface ShellInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * True when `candidate` is a shell this Windows box could actually start.
 *
 * `SHELL` is routinely inherited from a WSL or Git Bash profile, where it reads
 * `/bin/bash`; Node cannot spawn that, so the daemon would fail with `ENOENT` on
 * a value that looks perfectly valid. An absolute Windows path must exist on
 * disk, and a bare name is left to `PATH`.
 */
function isUsableWindowsShell(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")) return existsSync(candidate);
  return !candidate.includes("/") && !candidate.includes("\\");
}

/**
 * The program that runs one command on this box.
 *
 * WHAT CHANGED. This was `spawn("/bin/sh", ["-lc", command])` with no platform
 * branch at all. `/bin/sh` does not exist on Windows, so every command on this
 * platform failed with `ENOENT`, and the agent had no command line: it could not
 * read a file, list a directory, or run anything. The two symptoms it reported
 * were `Error: Command failed to spawn: Service temporarily unavailable. This may
 * be temporary; try again.` and `Error: Command failed to spawn: Aborted`, which
 * said nothing about a missing interpreter because nothing in this file named one.
 *
 * WHY `ComSpec` AND NOT POWERSHELL. Windows itself publishes `%ComSpec%` as the
 * path of the command interpreter, so it is the one value that is defined on a
 * stock Windows install and stays correct when the user changes their terminal.
 * `powershell.exe` may be absent entirely, and `getPowerShellExecutable` in
 * `packages/shell-exec/platform-shell.ts` throws when it is; a daemon that
 * cannot name its own interpreter would fail before it could report why.
 * PowerShell is also the slower of the two by an order of magnitude, and every
 * command the agent runs pays that. `packages/shell-exec/shell-env.ts` already
 * made this same choice for the host-side shell executor, and the two surfaces
 * must not disagree about what a command line is.
 *
 * WHAT IS NOT TOUCHED. The POSIX branch is byte-for-byte the old one: `/bin/sh`,
 * `-lc`, resolved by the box itself. `detached` and `kill` below already branch
 * on the platform, and the box this daemon was written for is Linux, so its
 * behaviour and its existing tests must not change.
 *
 * The environment is read from `env`, not from `process.env`, because that is the
 * block the child is spawned with, and because the host can rewrite it at any
 * time through `updateEnvironmentVariables`.
 */
export function resolveShellInvocation(platform: NodeJS.Platform, command: string, env: NodeJS.ProcessEnv = process.env): ShellInvocation {
  if (platform !== "win32") return { file: POSIX_COMMAND_INTERPRETER_FALLBACK, args: ["-lc", command] };
  const inherited = readEnvName(env, "SHELL")?.trim();
  const comSpec = readEnvName(env, "ComSpec")?.trim();
  const file = inherited !== undefined && isUsableWindowsShell(inherited)
    ? inherited
    : comSpec !== undefined && comSpec.length > 0 ? comSpec : WINDOWS_COMMAND_INTERPRETER_FALLBACK;
  // `cmd.exe` takes `/c`; every other shell this daemon spawns takes `-c`.
  return { file, args: [isWindowsCommandInterpreter(file) ? "/c" : "-c", command] };
}

/**
 * What to tell the user when no process was ever created.
 *
 * The refusal to say anything useful was the second half of the defect. The host
 * turned the resulting dead stream into `Service temporarily unavailable. This
 * may be temporary; try again.`, which is not what happened: no interpreter was
 * found, and the same request will fail identically every time. This names the
 * program, the reason, and the fact that nothing ran.
 */
export function describeShellInterpreterFailure(error: unknown, interpreter: string): string {
  const code = typeof error === "object" && error != null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
  const reason = code === "ENOENT" || code === "ENOTDIR"
    ? "that program does not exist on this box"
    : code === "EACCES" || code === "EPERM"
      ? "that program cannot be executed on this box"
      : code === undefined ? errorText(error) : `${code}: ${errorText(error)}`;
  return `The box could not start its shell interpreter "${interpreter}": ${reason}. The command did not run, and running it again will not change that.`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function terminalFrontmatter(args: BackgroundShellSpawnArgs, pid: number | undefined, startedAt: number): string {
  return `---\n${pid == null ? "" : `pid: ${pid}\n`}cwd: ${yamlString(args.workingDirectory)}\ncommand: ${yamlString(args.command)}\nstatus: running\nstarted_at: ${new Date(startedAt).toISOString()}\nrunning_for_ms: 0\n---\n`;
}

function terminalFooter(exitCode: number, startedAt: number): string {
  return `\n---\nexit_code: ${exitCode}\nelapsed_ms: ${Date.now() - startedAt}\nended_at: ${new Date().toISOString()}\n---\n`;
}

function client(id: number, execId: string, message: ExecClientMessage["message"], elapsedMs?: number): ExecStreamElement {
  return new ExecStreamElement({
    element: {
      case: "execClientMessage",
      value: new ExecClientMessage({ id, execId, message, ...(elapsedMs == null ? {} : { localExecutionTimeMs: elapsedMs }) }),
    },
  });
}

function control(id: number, message: ExecClientControlMessage["message"]): ExecStreamElement {
  return new ExecStreamElement({
    element: { case: "execClientControlMessage", value: new ExecClientControlMessage({ message }) },
  });
}

function close(id: number): ExecStreamElement {
  return control(id, { case: "streamClose", value: new ExecClientStreamClose({ id }) });
}

function thrown(id: number, error: unknown, errorCode = "BOX_EXEC_DAEMON_ERROR"): ExecStreamElement {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return control(id, {
    case: "throw",
    value: new ExecClientThrow({ id, error: normalized.message, ...(normalized.stack == null ? {} : { stackTrace: normalized.stack }), errorCode }),
  });
}

/**
 * Local stdio MCP servers on this box.
 *
 * WHAT CHANGED. `loadMcpServers` was `async () => new LoadMcpServersResponse()`.
 * It discarded the configuration the host pushed and answered with an empty
 * `loadedServerNames`, so the host recorded a successful push of a stdio config
 * and then discovered nothing on the box. `BoxExecRuntime.execute` had no arm for
 * `mcpArgs`, `mcpStateExecArgs`, `listMcpResourcesExecArgs` or
 * `readMcpResourceExecArgs`, so every MCP request left through `default:` as
 * `Unsupported ExecServerMessage case`, which the host turns into HTTP 500. A live
 * probe of the running box answered `listBoxMcpServers` with
 * `{"error":"Unsupported ExecServerMessage case: mcpStateExecArgs"}`.
 *
 * WHERE THE PROCESS RUNS, AND WHAT THAT COSTS. A stdio server is a child process.
 * It does not go through `resolvePath`, `assertRealPathAllowed` or
 * `PathRejectedError` — those constrain `Shell` and `Read`, and a process the
 * daemon starts on purpose is not a path operation. That is the whole honest
 * statement of this feature's security posture, and it rests on one property: the
 * model cannot write the configuration. The JSON arrives from
 * `tools-discovery.ts` (`{ mcpServers: {...} }`) built from
 * `%LOCALAPPDATA%\GrokBotLocalBox\mcp-servers.json`, which only the user edits by
 * hand. If the model could write that file it could hand itself
 * `{"command":"cmd","args":["/c", …]}` and no check in this file would help,
 * because the check has to run before the process exists.
 *
 * WHAT IS CHECKED HERE. Every absolute path in `command`/`args` — and every token
 * carrying a `..` segment, which used to skip the check entirely — is resolved and
 * run past `assertRealPathAllowed`, so a script outside the workspace roots is
 * refused and reported as a per-server `error` instead of being started.
 *
 * WHAT WAS STILL MISSING, AND IS NOT. `{"command":"cmd"}` resolved through PATH,
 * is not a path, and was started. The whole defence rested on the model being
 * unable to write the configuration, which is one property, checked in another
 * process, and true only for as long as that writer path stays shut.
 * `checkMcpLaunchAllowed` now also requires that a program named by PATH has its
 * script named by path, and refuses a command processor by name. It deliberately
 * does NOT refuse bare names as such: the user's own file runs servers as
 * `{"command":"node","args":["<box-workspace>\\mcp-servers\\…"]}`, and breaking
 * that would trade a real hole for a fake one. The rest of what is still open is
 * written down at `checkMcpLaunchAllowed` rather than left implied.
 *
 * SECRETS. `env` values are the supported way to hand a server a token and they
 * travel as plaintext JSON from the host. No value from `env` is logged, returned,
 * or allowed to reach an error string: every message built from a child's output is
 * passed through {@link redactSecrets} first, because a server that prints its own
 * environment into stderr would otherwise publish the token through
 * `McpStateServer.errorMessage`.
 */

/** How long a tool call or resource read may take before it is reported as failed. */
const MCP_REQUEST_TIMEOUT_MS = 60_000;

/** What the host is told about one configured server. Mirrors `McpStateServer.status`. */
type McpServerStatus = "connected" | "error";

/** One entry of the pushed configuration, or the reason it cannot become one. */
type DeclaredMcpServer = { readonly config: LocalStdioServerConfig } | { readonly problem: string };

/** One server the daemon is responsible for between two `loadMcpServers` calls. */
interface LiveMcpServer {
  readonly name: string;
  /** Identity of the entry this state was built from; a change rebuilds it. */
  readonly fingerprint: string;
  readonly config: LocalStdioServerConfig | null;
  client: StdioMcpClient | null;
  tools: Array<{ readonly name: string; readonly description?: string; readonly inputSchema?: unknown }>;
  status: McpServerStatus;
  errorMessage?: string;
}

/**
 * The `env` values of a configuration, the only secrets that exist here.
 *
 * Also used for an entry that has not become a live server yet: a refusal is
 * built before `LiveMcpServer` exists, and it quotes tokens out of the file, so
 * it must be redacted with the same list.
 */
function configSecrets(config: LocalStdioServerConfig): string[] {
  return Object.values(config.env ?? {}).map((value) => String(value));
}

function secretsOf(server: LiveMcpServer): string[] {
  return server.config == null ? [] : configSecrets(server.config);
}

/**
 * Removes every configured `env` value from a string that is about to be shown.
 *
 * Values shorter than four characters are left alone: replacing them would blank
 * out ordinary words in a path or a message and make the refusal unreadable, and a
 * three-character secret is not one worth protecting at the cost of the diagnosis.
 */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

/**
 * True when `token` names a file by path rather than an executable to find on PATH.
 *
 * `{"command": "node", "args": ["mcp/server.mjs"]}` is a bare name and is not
 * checkable; `{"command": "C:\\Windows\\System32\\cmd.exe"}` is and is.
 *
 * WHAT CHANGED. A token carrying a `..` segment used to answer `false` here and
 * skip `assertRealPathAllowed` entirely, so `{"command":"node","args":["..\\..\\..\\..\\Users\\me\\.ssh\\id_rsa"]}` was never resolved and never
 * refused. A `..` segment is a path whatever else the token is, so it now counts.
 */
function looksLikePathArgument(token: string): boolean {
  if (path.isAbsolute(token)) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  const slashed = token.replace(/\\/g, "/");
  if (slashed.startsWith("/")) return true;
  return slashed.split("/").some((segment) => segment === "..");
}

/**
 * Programs that cannot be a stdio MCP server, and are only ever the first half of
 * `{"command": "cmd", "args": ["/c", …]}`.
 *
 * WHY A LIST AND NOT A SHAPE. The daemon does not need these to be complete. A
 * stdio MCP server answers the MCP handshake on stdin and stdout; a command
 * processor does not, so an entry naming one can do nothing except run the string
 * in `args`. That makes every entry in this list an escape attempt and nothing
 * else, which is why they are refused even when the entry is otherwise well
 * formed. What the list cannot do is stop `node -e`, and it is not meant to: see
 * {@link checkMcpLaunchAllowed} for the rule that closes that shape.
 */
const COMMAND_PROCESSOR_NAMES: ReadonlySet<string> = new Set([
  "bash", "cmd", "command", "command.com", "cscript", "dash", "fish", "ksh",
  "mshta", "powershell", "pwsh", "regsvr32", "rundll32", "sh", "sh.exe", "wscript", "wsl", "zsh",
]);

/** The name of a program, without its directory and without `.exe`, lowercased. */
function programNameOf(token: string): string {
  const base = path.basename(token.replace(/\\/g, "/")).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/** `realpath` when the target exists, the plain resolution when it does not. */
async function canonicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Turns the pushed JSON into entries, keeping every bad entry as a reason.
 *
 * A malformed file never throws here: one broken entry becomes one server the
 * daemon reports as `error`, so the user sees which entry is wrong instead of
 * losing the whole configuration. Parse failures are the single exception and
 * carry no source text, because the source text is where the `env` tokens are.
 */
function parseMcpConfig(configJson: string): Map<string, DeclaredMcpServer> {
  const declared = new Map<string, DeclaredMcpServer>();
  if (configJson.trim().length === 0) return declared;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson.replace(/^﻿/, ""));
  } catch (error) {
    const position = /position (\d+)/.exec(String((error as Error).message))?.[1];
    throw new Error(`The MCP configuration pushed to the box is not valid JSON${position === undefined ? "" : ` (at byte ${position})`}.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('The MCP configuration pushed to the box must be a json object with an "mcpServers" key.');
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error('The MCP configuration pushed to the box has no "mcpServers" object.');
  }
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    declared.set(name, parseMcpEntry(name, value));
  }
  return declared;
}

/** One entry, or the reason it cannot be one. Never throws. */
function parseMcpEntry(name: string, value: unknown): DeclaredMcpServer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problem: `local MCP server "${name}" was ignored: the entry is not an object.` };
  }
  const entry = value as { command?: unknown; args?: unknown; env?: unknown; url?: unknown };
  if (entry.url !== undefined) {
    return { problem: `local MCP server "${name}" was ignored: a remote url is not served from this box.` };
  }
  if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
    return { problem: `local MCP server "${name}" was ignored: "command" must be a non-empty string.` };
  }
  const args = entry.args === undefined ? [] : entry.args;
  if (!Array.isArray(args) || args.some(item => typeof item !== "string")) {
    return { problem: `local MCP server "${name}" was ignored: "args" must be an array of strings.` };
  }
  const env: Record<string, string> = {};
  if (entry.env !== undefined) {
    if (typeof entry.env !== "object" || entry.env === null || Array.isArray(entry.env)) {
      return { problem: `local MCP server "${name}" was ignored: "env" must map names to string values.` };
    }
    for (const [key, item] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof item !== "string") {
        return { problem: `local MCP server "${name}" was ignored: "env.${key}" must be a string.` };
      }
      env[key] = item;
    }
  }
  return {
    config: {
      command: entry.command.trim(),
      ...(args.length === 0 ? {} : { args: args as string[] }),
      ...(entry.env === undefined ? {} : { env }),
    },
  };
}

/** Turns one `tools/call` result into the content items the protobuf carries. */
function mcpResultContent(result: unknown): McpToolResultContentItem[] {
  const blocks = Array.isArray((result as { content?: unknown })?.content)
    ? ((result as { content: unknown[] }).content)
    : [];
  const items: McpToolResultContentItem[] = [];
  for (const block of blocks) {
    const typed = block as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown };
    if (typed?.type === "text") {
      items.push(new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: String(typed.text ?? "") }) } }));
    } else if (typed?.type === "image") {
      items.push(new McpToolResultContentItem({
        content: { case: "image", value: new McpImageContent({ data: new Uint8Array(Buffer.from(String(typed.data ?? ""), "base64")), mimeType: String(typed.mimeType ?? "image/png") }) },
      }));
    } else if (block != null) {
      items.push(new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: JSON.stringify(block) }) } }));
    }
  }
  if (items.length === 0) items.push(new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: "" }) } }));
  return items;
}

/** `structuredContent` is optional on the wire and absent on most servers. */
function mcpStructuredContent(result: unknown): Struct | undefined {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  if (structured == null || typeof structured !== "object") return undefined;
  try {
    return Struct.fromJson(structured as Record<string, never>);
  } catch {
    return undefined;
  }
}

class BoxExecRuntime {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #foreground = new Set<ChildProcessWithoutNullStreams>();
  readonly #background = new Map<number, BackgroundProcess>();
  /** Every configured stdio server, keyed by the name the user wrote. */
  readonly #mcpServers = new Map<string, LiveMcpServer>();
  /** Starts in flight, so two concurrent listings cannot spawn the same server twice. */
  readonly #mcpStarting = new Map<string, Promise<LiveMcpServer>>();
  #nextShellId = 1;
  /**
   * The code page this box's command interpreter writes in, resolved once at
   * startup. `undefined` means the probe did not answer, and the output decoder
   * then behaves exactly as the shipped one did.
   */
  readonly #consoleCodePageLabel: string | undefined;

  constructor(readonly workspaceRoot: string, readonly terminalsDirectory: string, environment: NodeJS.ProcessEnv, consoleCodePageLabel?: string) {
    this.#environment = { ...environment };
    this.#consoleCodePageLabel = consoleCodePageLabel;
  }

  applyEnvironment(request: UpdateEnvironmentVariablesRequest): { applied: number; removed: number } {
    let removed = 0;
    if (request.replace) {
      for (const key of Object.keys(this.#environment)) {
        if (!(key in request.env)) {
          delete this.#environment[key];
          removed += 1;
        }
      }
    }
    for (const [key, value] of Object.entries(request.env)) this.#environment[key] = value;
    return { applied: Object.keys(request.env).length, removed };
  }

  resolvePath(requested: string): string {
    const logical = requested.length === 0 ? "/workspace" : requested;
    if (logical.startsWith(BOX_TERMINAL_VIRTUAL_PREFIX)) {
      const terminalName = logical.slice(BOX_TERMINAL_VIRTUAL_PREFIX.length);
      if (!/^\d+\.txt$/.test(terminalName)) throw new PathRejectedError(`Rejected terminal virtual path: ${requested}`);
      return path.join(this.terminalsDirectory, terminalName);
    }
    const mapped = logical === "/workspace"
      ? this.workspaceRoot
      : logical.startsWith("/workspace/")
        ? path.join(this.workspaceRoot, logical.slice("/workspace/".length))
        : path.isAbsolute(logical)
          ? logical
          : path.join(this.workspaceRoot, logical);
    const resolved = path.resolve(mapped);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
    throw new PathRejectedError(`Path escapes configured workspace root: ${requested}`);
  }

  assertRealPathAllowed(target: string, requested: string): void {
    for (const allowedRoot of [this.workspaceRoot, this.terminalsDirectory]) {
      const relative = path.relative(allowedRoot, target);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    }
    throw new PathRejectedError(`Resolved path escapes configured roots: ${requested}`);
  }

  async *execute(request: ExecServerMessage, signal: AbortSignal): AsyncGenerator<ExecStreamElement> {
    try {
      switch (request.message.case) {
        case "readArgs":
        case "redactedReadArgs": {
          const result = await this.read(request.message.value);
          const resultCase = request.message.case === "readArgs" ? "readResult" : "redactedReadResult";
          yield client(request.id, request.execId, { case: resultCase, value: result } as ExecClientMessage["message"]);
          break;
        }
        case "shellArgs":
        case "miniSweAgentBashArgs": {
          const result = await this.shell(request.message.value, signal);
          const resultCase = request.message.case === "shellArgs" ? "shellResult" : "miniSweAgentBashResult";
          yield client(request.id, request.execId, { case: resultCase, value: result } as ExecClientMessage["message"]);
          break;
        }
        case "shellStreamArgs":
          yield* this.shellStream(request, request.message.value, signal);
          break;
        case "backgroundShellSpawnArgs":
          yield client(request.id, request.execId, { case: "backgroundShellSpawnResult", value: await this.spawnBackground(request.message.value) });
          break;
        case "writeShellStdinArgs":
          yield client(request.id, request.execId, { case: "writeShellStdinResult", value: await this.writeStdin(request.message.value) });
          break;
        case "mcpArgs":
          yield client(request.id, request.execId, { case: "mcpResult", value: await this.callMcpTool(request.message.value) });
          break;
        case "mcpStateExecArgs":
          yield client(request.id, request.execId, { case: "mcpStateExecResult", value: await this.mcpState(request.message.value) });
          break;
        case "listMcpResourcesExecArgs":
          yield client(request.id, request.execId, { case: "listMcpResourcesExecResult", value: await this.listMcpResources(request.message.value) });
          break;
        case "readMcpResourceExecArgs":
          yield client(request.id, request.execId, { case: "readMcpResourceExecResult", value: await this.readMcpResource(request.message.value) });
          break;
        default:
          yield thrown(request.id, `Unsupported ExecServerMessage case: ${request.message.case ?? "unset"}`, "BOX_EXEC_UNSUPPORTED");
      }
    } catch (error) {
      yield thrown(request.id, error);
    } finally {
      yield close(request.id);
    }
  }

  async read(args: ReadArgs): Promise<ReadResult> {
    try {
      const target = this.resolvePath(args.path);
      const directInfo = await lstat(target);
      if (directInfo.isSymbolicLink()) throw new PathRejectedError(`Symbolic-link reads are not permitted: ${args.path}`);
      const canonical = await realpath(target);
      this.assertRealPathAllowed(canonical, args.path);
      const info = await stat(canonical);
      if (!info.isFile()) return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: "Path is not a regular file" }) } });
      if (args.encodingHint != null && args.encodingHint !== "utf8" && args.encodingHint !== "utf-8" && args.encodingHint !== "latin1") {
        return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: `Unsupported encoding hint: ${args.encodingHint}` }) } });
      }
      const data = await readFile(canonical);
      const text = data.toString(args.encodingHint === "latin1" ? "latin1" : "utf8");
      const lines = text.split("\n");
      const offset = Math.max(0, args.offset ?? 0);
      const limit = args.limit == null ? lines.length : Math.max(0, args.limit);
      const content = lines.slice(offset, offset + limit).join("\n");
      return new ReadResult({ result: { case: "success", value: new ReadSuccess({
        path: args.path,
        output: { case: "content", value: content },
        totalLines: lines.length,
        fileSize: BigInt(data.byteLength),
        truncated: offset > 0 || offset + limit < lines.length,
        rangeApplied: args.offset != null || args.limit != null,
      }) } });
    } catch (error) {
      if (error instanceof PathRejectedError) return new ReadResult({ result: { case: "rejected", value: new ReadRejected({ path: args.path, reason: error.message }) } });
      const code = typeof error === "object" && error != null && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return new ReadResult({ result: { case: "fileNotFound", value: new ReadFileNotFound({ path: args.path }) } });
      if (code === "EACCES" || code === "EPERM") return new ReadResult({ result: { case: "permissionDenied", value: new ReadPermissionDenied({ path: args.path }) } });
      if (code === "EISDIR" || code === "EINVAL" || code === "ENAMETOOLONG") return new ReadResult({ result: { case: "invalidFile", value: new ReadInvalidFile({ path: args.path, reason: errorText(error) }) } });
      return new ReadResult({ result: { case: "error", value: new ReadError({ path: args.path, error: errorText(error) }) } });
    }
  }

  async shell(args: ShellArgs, signal: AbortSignal): Promise<ShellResult> {
    let cwd: string;
    try {
      cwd = this.resolvePath(args.workingDirectory);
    } catch (error) {
      return new ShellResult({ result: { case: "spawnError", value: new ShellSpawnError({ command: args.command, workingDirectory: args.workingDirectory, error: errorText(error) }) } });
    }
    const outcome = await this.run(args.command, cwd, args.timeout > 0 ? args.timeout : undefined, signal);
    if (outcome.timedOut) return new ShellResult({ result: { case: "timeout", value: new ShellTimeout({ command: args.command, workingDirectory: args.workingDirectory, timeoutMs: args.timeout }) } });
    const common = {
      command: args.command,
      workingDirectory: args.workingDirectory,
      exitCode: outcome.code,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      executionTime: outcome.elapsedMs,
      interleavedOutput: `${outcome.stdout}${outcome.stderr}`,
      localExecutionTimeMs: outcome.elapsedMs,
    };
    return outcome.code === 0 && !outcome.aborted
      ? new ShellResult({ result: { case: "success", value: new ShellSuccess(common) } })
      : new ShellResult({ result: { case: "failure", value: new ShellFailure({ ...common, aborted: outcome.aborted }) } });
  }

  async *shellStream(request: ExecServerMessage, args: ShellArgs, signal: AbortSignal): AsyncGenerator<ExecStreamElement> {
    const cwd = this.resolvePath(args.workingDirectory);
    yield client(request.id, request.execId, { case: "shellStream", value: new ShellStream({ event: { case: "start", value: new ShellStreamStart() } }) });
    const { child, interpreter } = this.spawnShell(args.command, cwd);
    this.#foreground.add(child);
    const startedAt = Date.now();
    const events: Array<{ case: "stdout" | "stderr"; data: string }> = [];
    let wake: (() => void) | undefined;
    let done = false;
    let exitCode = 1;
    let exitSignal = "";
    // The child had no `error` listener at all. A process that cannot be created
    // emits `error` and then `close`, so `done` became true with an exit code of
    // 1 and no output: the stream ended in a way the caller reads as "the command
    // failed", and the reason — no interpreter — was never delivered. On the
    // shipped code this listener's absence also left the event unhandled, which
    // ends the daemon's own stream instead of answering it.
    let startFailure: string | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    // One decoder per channel: the UTF-8-or-legacy decision is a property of the
    // stream, not of a chunk. See `shell-output-text.ts` for why `String(data)`
    // made every Russian system message unreadable.
    const stdoutDecoder = createShellOutputDecoder(this.#consoleCodePageLabel);
    const stderrDecoder = createShellOutputDecoder(this.#consoleCodePageLabel);
    child.stdout.on("data", data => { events.push({ case: "stdout", data: stdoutDecoder.push(data) }); notify(); });
    child.stderr.on("data", data => { events.push({ case: "stderr", data: stderrDecoder.push(data) }); notify(); });
    child.once("error", error => { startFailure = describeShellInterpreterFailure(error, interpreter); notify(); });
    child.once("close", (code, childSignal) => {
      exitCode = code ?? 1;
      exitSignal = childSignal ?? "";
      // The character a stream ended in the middle of is flushed here. It used to
      // be lost silently because the whole output was one `String(data)` that the
      // consumer concatenated, so a split character simply never appeared.
      for (const [channel, decoder] of [["stdout", stdoutDecoder], ["stderr", stderrDecoder]] as const) {
        const rest = decoder.flush();
        if (rest.length > 0) events.push({ case: channel, data: rest });
      }
      done = true;
      notify();
    });
    const abort = () => this.kill(child);
    signal.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (args.timeout > 0) timer = setTimeout(() => this.kill(child), args.timeout);
    try {
      while (!done || events.length > 0) {
        while (events.length > 0) {
          const event = events.shift()!;
          yield client(request.id, request.execId, {
            case: "shellStream",
            value: new ShellStream({ event: event.case === "stdout"
              ? { case: "stdout", value: new ShellStreamStdout({ data: event.data }) }
              : { case: "stderr", value: new ShellStreamStderr({ data: event.data }) } }),
          });
        }
        if (!done) await new Promise<void>(resolve => { wake = resolve; });
      }
      // Reported before the exit event: `ShellStream` has no spawn-error arm, and
      // an exit code with no reason reads as a command that ran and failed.
      if (startFailure !== undefined) throw new Error(startFailure);
      yield client(request.id, request.execId, { case: "shellStream", value: new ShellStream({ event: { case: "exit", value: new ShellStreamExit({
        code: exitCode,
        cwd: args.workingDirectory,
        aborted: signal.aborted,
        localExecutionTimeMs: Date.now() - startedAt,
      }) } }) });
      void exitSignal;
    } finally {
      if (timer != null) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#foreground.delete(child);
      if (!done) this.kill(child);
    }
  }

  async spawnBackground(args: BackgroundShellSpawnArgs): Promise<BackgroundShellSpawnResult> {
    try {
      const cwd = this.resolvePath(args.workingDirectory);
      await mkdir(this.terminalsDirectory, { recursive: true });
      const shellId = this.#nextShellId++;
      const terminalPath = path.join(this.terminalsDirectory, `${shellId}.txt`);
      const startedAt = Date.now();
      const { child, interpreter } = this.spawnShell(args.command, cwd);
      // This used to answer `success` the instant `spawn` returned, so a command
      // whose interpreter does not exist was reported as a started background
      // shell with a `pid` the caller then waited on forever. The `spawn` event
      // fires on the next tick, before the child can write anything, so waiting
      // for it costs one tick and cannot lose the first chunk of output.
      const startFailure = await new Promise<Error | undefined>(resolve => {
        child.once("spawn", () => resolve(undefined));
        child.once("error", error => resolve(new Error(describeShellInterpreterFailure(error, interpreter))));
      });
      if (startFailure !== undefined) throw startFailure;
      const process: BackgroundProcess = {
        child,
        terminalPath,
        startedAt,
        writeQueue: writeFile(terminalPath, terminalFrontmatter(args, child.pid, startedAt)),
      };
      this.#background.set(shellId, process);
      const queueWrite = (data: string | Uint8Array) => {
        process.writeQueue = process.writeQueue.then(() => appendFile(terminalPath, data));
      };
      child.stdout.on("data", data => { queueWrite(data); });
      child.stderr.on("data", data => { queueWrite(data); });
      // The `error` listener above stays attached on purpose: a `ChildProcess`
      // with no listener for `error` takes the whole daemon down when it fires.
      child.on("error", error => { queueWrite(`${describeShellInterpreterFailure(error, interpreter)}\n`); });
      child.once("close", code => {
        this.#background.delete(shellId);
        queueWrite(terminalFooter(code ?? 1, startedAt));
      });
      return new BackgroundShellSpawnResult({ result: { case: "success", value: new BackgroundShellSpawnSuccess({ shellId, command: args.command, workingDirectory: args.workingDirectory, ...(child.pid == null ? {} : { pid: child.pid }) }) } });
    } catch (error) {
      return new BackgroundShellSpawnResult({ result: { case: "error", value: new BackgroundShellSpawnError({ command: args.command, workingDirectory: args.workingDirectory, error: errorText(error) }) } });
    }
  }

  async writeStdin(args: WriteShellStdinArgs): Promise<WriteShellStdinResult> {
    const running = this.#background.get(args.shellId);
    if (running == null) return new WriteShellStdinResult({ result: { case: "error", value: new WriteShellStdinError({ error: `Shell ${args.shellId} is not running` }) } });
    const before = Number((await stat(running.terminalPath)).size);
    await new Promise<void>((resolve, reject) => running.child.stdin.write(args.chars, error => error == null ? resolve() : reject(error)));
    return new WriteShellStdinResult({ result: { case: "success", value: new WriteShellStdinSuccess({ shellId: args.shellId, terminalFileLengthBeforeInputWritten: before }) } });
  }

  /**
   * Reconciles the running servers with the configuration the host pushed.
   *
   * A server already running the same entry is left alone, so a push on every tool
   * discovery does not restart a live process. A server the user deleted is closed
   * when `removeMissing` is set, which is the flag `box-mcp.ts` always sends. The
   * answer is the names that came up, and only those: a name in
   * `loadedServerNames` is what the host treats as connected.
   */
  async loadMcpServers(request: LoadMcpServersRequest): Promise<LoadMcpServersResponse> {
    const declared = parseMcpConfig(request.mcpConfigJson);
    for (const name of [...this.#mcpServers.keys()]) {
      if (declared.has(name) || !request.removeMissing) continue;
      await this.closeMcpServer(name);
    }
    const loadedServerNames: string[] = [];
    for (const [name, entry] of declared) {
      const server = await this.ensureMcpServer(name, entry);
      if (server.status === "connected") loadedServerNames.push(name);
    }
    return new LoadMcpServersResponse({ loadedServerNames });
  }

  /**
   * Reports one row per requested server, including the ones that are not usable.
   *
   * The host filters on `serverIdentifier`, which it built from the name in the
   * user's file (`mcp-manager.ts`: `serverIdentifier: name`), so that name is what
   * comes back — for the server row and for every tool's `providerIdentifier`.
   *
   * A name the box has never been told about is reported as `error` rather than
   * omitted: dropping it would let the host render an empty list that looks like
   * "this box has no MCP", which is the failure this whole change exists to stop.
   */
  async mcpState(args: McpStateExecArgs): Promise<McpStateExecResult> {
    const requested = new Set(args.serverIdentifiers);
    const names = requested.size === 0 ? [...this.#mcpServers.keys()] : [...requested];
    const servers: McpStateServer[] = [];
    for (const name of names) {
      const live = this.#mcpServers.get(name);
      if (live == null) {
        servers.push(new McpStateServer({
          serverName: name,
          serverIdentifier: name,
          status: "error",
          errorMessage: `No MCP server named "${name}" is configured on this box. The host pushes a configuration through LoadMcpServers before it asks for tools.`,
        }));
        continue;
      }
      // `kickOnly` is the host's "refresh what you already have" call
      // (`mcp-service.ts` sends it on every status follow-up). A failed refresh is
      // deliberately not promoted to `error`: the host re-asks on its own schedule,
      // and flipping the status here would make one slow answer look like a dead
      // connector. The next tool call reports the failure with the server's own text.
      if (args.kickOnly && live.client != null) void live.client.listTools().then(tools => { live.tools = tools; }, () => undefined);
      servers.push(new McpStateServer({
        serverName: live.name,
        serverIdentifier: live.name,
        status: live.status,
        ...(live.errorMessage == null ? {} : { errorMessage: live.errorMessage }),
        tools: live.tools.map(tool => new McpToolDefinition({
          name: `${live.name}-${tool.name}`,
          providerIdentifier: live.name,
          toolName: tool.name,
          description: tool.description ?? "",
          // Both forms are set: the host reads `inputSchema` and converts it back
          // through `toJson()`, other readers use the string.
          ...(tool.inputSchema === undefined ? {} : { inputSchema: Value.fromJson(tool.inputSchema as never) }),
          ...(tool.inputSchema === undefined ? {} : { inputSchemaJson: JSON.stringify(tool.inputSchema) }),
        })),
        instructions: [],
      }));
    }
    return new McpStateExecResult({ result: { case: "success", value: new McpStateSuccess({ servers }) } });
  }

  /**
   * Runs one tool on one server.
   *
   * Every failure is an answer, not a throw: the daemon has no approval surface, so
   * a refusal has to travel back as the protobuf's own `McpRejected` /
   * `McpToolNotFound` / `McpServerNotFound` arms, which is what the model reads.
   */
  async callMcpTool(args: McpArgs): Promise<McpResult> {
    const serverName = args.serverIdentifier !== "" ? args.serverIdentifier : args.providerIdentifier;
    const live = this.#mcpServers.get(serverName);
    if (live == null) {
      return new McpResult({ result: { case: "serverNotFound", value: new McpServerNotFound({ name: serverName, availableServers: [...this.#mcpServers.keys()] }) } });
    }
    if (live.client == null) {
      return new McpResult({ result: { case: "error", value: new McpError({ error: live.errorMessage ?? `MCP server "${serverName}" is not running on this box.` }) } });
    }
    const toolName = args.toolName !== "" ? args.toolName : args.name;
    const tool = live.tools.find(entry => entry.name === toolName);
    if (tool == null) {
      return new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: toolName, availableTools: live.tools.map(entry => entry.name) }) } });
    }
    const toolArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.args)) toolArgs[key] = value.toJson();
    try {
      const result = await live.client.callTool(tool.name, toolArgs);
      const structured = mcpStructuredContent(result);
      return new McpResult({
        result: {
          case: "success",
          value: new McpSuccess({
            content: mcpResultContent(result),
            // A tool that failed on its own terms is still a delivered answer; the
            // host shows the text and marks the call as an error result.
            isError: (result as { isError?: unknown })?.isError === true,
            ...(structured === undefined ? {} : { structuredContent: structured }),
          }),
        },
      });
    } catch (error) {
      return new McpResult({ result: { case: "error", value: new McpError({ error: redactSecrets(errorText(error), secretsOf(live)) }) } });
    }
  }

  /**
   * `resources/list` across the selected servers.
   *
   * A server that cannot answer is skipped, and the failure is only reported when
   * no selected server answered at all — otherwise one server without the method
   * would turn a listing that is otherwise correct into a failure the user cannot
   * act on.
   */
  async listMcpResources(args: ListMcpResourcesExecArgs): Promise<ListMcpResourcesExecResult> {
    const names = args.server == null || args.server === "" ? [...this.#mcpServers.keys()] : [args.server];
    const resources: ListMcpResourcesExecResult_McpResource[] = [];
    const problems: string[] = [];
    for (const name of names) {
      const live = this.#mcpServers.get(name);
      if (live?.client == null) continue;
      try {
        for (const entry of await live.client.listResources()) {
          resources.push(new ListMcpResourcesExecResult_McpResource({
            uri: entry.uri,
            server: name,
            ...(entry.name == null ? {} : { name: entry.name }),
            ...(entry.description == null ? {} : { description: entry.description }),
            ...(entry.mimeType == null ? {} : { mimeType: entry.mimeType }),
          }));
        }
      } catch (error) {
        problems.push(redactSecrets(`"${name}" could not list its resources: ${errorText(error)}`, secretsOf(live)));
      }
    }
    if (resources.length === 0 && problems.length > 0 && problems.length === names.length) {
      return new ListMcpResourcesExecResult({ result: { case: "error", value: new ListMcpResourcesError({ error: problems.join("; ") }) } });
    }
    return new ListMcpResourcesExecResult({ result: { case: "success", value: new ListMcpResourcesSuccess({ resources }) } });
  }

  /**
   * `resources/read` for one server.
   *
   * `downloadPath` is honoured through `resolvePath` and `assertRealPathAllowed`
   * like every other write this daemon performs. A path outside the roots is
   * refused as `rejected` rather than quietly dropped, because the host asked for
   * a file on disk and silence would leave it waiting for one that never arrives.
   */
  async readMcpResource(args: ReadMcpResourceExecArgs): Promise<ReadMcpResourceExecResult> {
    const live = this.#mcpServers.get(args.server);
    if (live?.client == null) {
      return new ReadMcpResourceExecResult({ result: { case: "notFound", value: new ReadMcpResourceNotFound({ uri: args.uri }) } });
    }
    let downloadPath: string | undefined;
    if (args.downloadPath != null && args.downloadPath !== "") {
      try {
        const target = await canonicalPath(this.resolvePath(args.downloadPath));
        this.assertRealPathAllowed(target, args.downloadPath);
        downloadPath = target;
      } catch (error) {
        const reason = error instanceof PathRejectedError
          ? error.message
          : `downloadPath could not be resolved: ${errorText(error)}`;
        return new ReadMcpResourceExecResult({ result: { case: "rejected", value: new ReadMcpResourceRejected({ uri: args.uri, reason }) } });
      }
    }
    try {
      const contents = await live.client.readResource(args.uri);
      const first = contents[0];
      if (first == null) {
        return new ReadMcpResourceExecResult({ result: { case: "notFound", value: new ReadMcpResourceNotFound({ uri: args.uri }) } });
      }
      const payload = typeof first.text === "string"
        ? { case: "text" as const, value: first.text }
        : { case: "blob" as const, value: new Uint8Array(Buffer.from(String(first.blob ?? ""), "base64")) };
      if (downloadPath !== undefined) await writeFile(downloadPath, payload.value);
      return new ReadMcpResourceExecResult({
        result: {
          case: "success",
          value: new ReadMcpResourceSuccess({
            uri: first.uri === "" ? args.uri : first.uri,
            ...(first.mimeType == null ? {} : { mimeType: first.mimeType }),
            ...(downloadPath === undefined ? {} : { downloadPath }),
            annotations: {},
            content: payload,
          }),
        },
      });
    } catch (error) {
      return new ReadMcpResourceExecResult({ result: { case: "error", value: new ReadMcpResourceError({ uri: args.uri, error: redactSecrets(errorText(error), secretsOf(live)) }) } });
    }
  }

  async stop(): Promise<void> {
    for (const child of this.#foreground) this.kill(child);
    for (const process of this.#background.values()) this.kill(process.child);
    this.#foreground.clear();
    this.#background.clear();
    for (const name of [...this.#mcpServers.keys()]) await this.closeMcpServer(name);
  }

  /**
   * Returns the live server for this entry, starting it only when the entry changed.
   *
   * `startMcpServer` never throws: a refused or broken entry becomes a server with
   * `status: "error"`, so one bad entry cannot take the rest of the file down and
   * the user is told which one is wrong.
   */
  private async ensureMcpServer(name: string, entry: DeclaredMcpServer): Promise<LiveMcpServer> {
    const fingerprint = JSON.stringify(entry);
    const existing = this.#mcpServers.get(name);
    if (existing != null && existing.fingerprint === fingerprint) return existing;
    if (existing != null) await this.closeMcpServer(name);
    const inFlight = this.#mcpStarting.get(name);
    if (inFlight != null) return await inFlight;
    const starting = this.startMcpServer(name, entry, fingerprint).then(server => {
      this.#mcpStarting.delete(name);
      this.#mcpServers.set(name, server);
      return server;
    });
    this.#mcpStarting.set(name, starting);
    return await starting;
  }

  private async startMcpServer(name: string, entry: DeclaredMcpServer, fingerprint: string): Promise<LiveMcpServer> {
    if ("problem" in entry) {
      return { name, fingerprint, config: null, client: null, tools: [], status: "error", errorMessage: entry.problem };
    }
    const refusal = await this.checkMcpLaunchAllowed(entry.config);
    if (refusal != null) {
      return { name, fingerprint, config: entry.config, client: null, tools: [], status: "error", errorMessage: refusal };
    }
    const options: StdioMcpClientOptions = {
      clientName: "grokbot-box-exec-daemon",
      timeoutMs: MCP_REQUEST_TIMEOUT_MS,
      // The child sees the daemon's own environment, which `updateEnvironmentVariables`
      // can rewrite, not a second copy captured when the daemon started.
      baseEnv: this.#environment,
    };
    const started: LiveMcpServer = { name, fingerprint, config: entry.config, client: null, tools: [], status: "error" };
    try {
      const client = await connectStdioServer(entry.config, options);
      started.tools = await client.listTools();
      started.client = client;
      started.status = "connected";
    } catch (error) {
      started.errorMessage = redactSecrets(`Could not start MCP server "${name}": ${errorText(error)}`, secretsOf(started));
    }
    return started;
  }

  /**
   * Decides whether one configured stdio entry may be started, and says why not.
   *
   * Two rules, in this order.
   *
   * 1. `command` MAY NOT BE A COMMAND PROCESSOR. `{"command":"cmd"}` was the hole:
   *    it is not a path, it resolved through PATH, and it started. This runs first
   *    because it is the only rule that can explain the entry: `cmd /c …` also
   *    trips rule 2 on its `/c`, and a user told their script escapes the roots
   *    would go looking in the wrong place.
   *
   * 2. EVERY PATH-LIKE TOKEN IS CONTAINED, AND A PROGRAM NAMED BY PATH MUST HAVE
   *    ITS SCRIPT NAMED BY PATH. The containment half is unchanged: each absolute
   *    path, and each token carrying a `..` segment, is resolved and run past
   *    `assertRealPathAllowed`. The second half is new, and it is deliberately NOT
   *    "refuse every bare name". The shipped product runs servers exactly that way —
   *    `{"command":"node","args":["<box-workspace>\\mcp-servers\\dsh-agent-mcp-server.mjs"]}`
   *    is the shape the user's own file has, and refusing it would break working
   *    configuration to punish a name that was never the defect.
   *
   *    So the daemon insists on the part that can actually be checked: when the
   *    program is a PATH name, its script must be an explicit path, and the
   *    containment half has already proved that path is inside the roots. One
   *    requirement closes every interpreter escape, because an inline program is
   *    never a path: `node -e …`, `python -c …`, and `cmd /c …`. A program given by
   *    absolute path is left exactly as it was.
   *
   * WHAT IS STILL NOT SOLVED, STATED PLAINLY. The operating system, not the
   * daemon, decides which file a bare name means, and a program outside
   * {@link COMMAND_PROCESSOR_NAMES} that is itself an escape hatch is not caught
   * by the shape rule. Closing that needs an explicit allowlist of launchable
   * programs — a capability decision about the sandbox model, not a daemon edit.
   *
   * Every message returned here quotes tokens out of the user's file, so it is
   * passed through {@link redactSecrets} with the entry's own `env` values before
   * it leaves this method. `env` is never printed here.
   */
  private async checkMcpLaunchAllowed(config: LocalStdioServerConfig): Promise<string | undefined> {
    if (COMMAND_PROCESSOR_NAMES.has(programNameOf(config.command))) {
      return redactSecrets(`This MCP server was refused and is not running: "${config.command}" is a command processor, and a stdio MCP server cannot be one, because everything in "args" would be handed to it as a command line. Name the program by its full path, or name a runtime and give the script's full path as the first argument.`, configSecrets(config));
    }
    for (const token of [config.command, ...(config.args ?? [])]) {
      if (!looksLikePathArgument(token)) continue;
      const target = await canonicalPath(token);
      try {
        this.assertRealPathAllowed(target, token);
      } catch (error) {
        if (error instanceof PathRejectedError) {
          return redactSecrets(`This MCP server was refused and is not running: ${error.message}. A script outside the box workspace root and terminals directory is not started. Copy it inside the roots, or ask for the daemon to be given more allowed roots.`, configSecrets(config));
        }
        throw error;
      }
    }
    if (!looksLikePathArgument(config.command)) {
      const args = config.args ?? [];
      if (args.length === 0 || !looksLikePathArgument(args[0] as string)) {
        return redactSecrets(`This MCP server was refused and is not running: "${config.command}" is not a path, so it is looked up on PATH, and nothing in this entry names the script it is supposed to run. Give "args" the script's full path first, inside the box workspace root.`, configSecrets(config));
      }
    }
    return undefined;
  }

  private async closeMcpServer(name: string): Promise<void> {
    const live = this.#mcpServers.get(name);
    this.#mcpServers.delete(name);
    this.#mcpStarting.delete(name);
    if (live?.client == null) return;
    // The name is removed before the await so a concurrent call cannot see a
    // half-closed server as connected.
    await live.client.close();
  }

  /**
   * Starts one command in a real interpreter, and reports which one.
   *
   * The program is returned next to the child because a spawn failure arrives
   * asynchronously on the child's `error` event, long after this call has
   * returned; only the name that was actually asked for can explain it.
   *
   * WHAT CHANGED, AND WHY. `windowsVerbatimArguments` was missing. Without it
   * Node builds a Windows command line out of `argv` and escapes the arguments,
   * and the command string — which is full of quotes the agent wrote — was
   * escaped a second time on its way to `cmd.exe /c`. Measured on this machine,
   * before and after, with `/c` identical:
   *
   *   `python -c "print(123)"`          exit 0, no output at all
   *                                    -> exit 0, `123`
   *   `python -c "import sys;print(1+1)"` exit 1, Python saw `"import`
   *                                    -> exit 0, `2`
   *   `echo "q1" > z1.txt`             wrote `\"q1\"`
   *                                    -> wrote `"q1"`
   *
   * The first of those is the worst kind of failure: it reported success, printed
   * nothing, and left the model believing the machine had done nothing. All three
   * appear in one user session's transcript journal — 18 Python SyntaxErrors and
   * 7 silently empty successes out of 154 shell calls.
   *
   * It changes only how the agent's own command string is tokenised. The program,
   * the environment, the working directory and every path check above it are
   * untouched, so nothing here widens what a command may reach.
   */
  private spawnShell(command: string, cwd: string): { child: ChildProcessWithoutNullStreams; interpreter: string } {
    const invocation = resolveShellInvocation(process.platform, command, this.#environment);
    return {
      interpreter: invocation.file,
      child: spawn(invocation.file, [...invocation.args], {
        cwd,
        // WHAT CHANGED, AND WHY. The environment handed to the child was
        // `this.#environment` verbatim, with no text defaults in it. This daemon
        // does not use `buildShellEnv` — it builds its own block — so the fill-in
        // that keeps a child program's output decodable never reached here.
        //
        // Measured on this box, where `chcp` is 65001 and `cmd.exe` therefore
        // writes UTF-8 while CPython picks CP1251 for its own stdout:
        //
        //   `python -c "print('Привет мир')"` -> `╧ЁштхЄьшЁ` (mojibake)
        //   `python -c "print('日本語')"`     -> exit 1, UnicodeEncodeError
        //
        // The defaults are applied HERE, at the spawn, and not into
        // `#environment`, because `applyEnvironment` deletes every key the host's
        // update does not mention when `replace` is set. A value stored in the
        // block would be removed by the first such update; one applied per spawn
        // survives it, and a value the host did set is still the host's.
        env: withShellTextEnv(this.#environment),
        detached: process.platform !== "win32",
        stdio: "pipe",
        windowsHide: true,
        ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
      }),
    };
  }

  /**
   * WHAT CHANGED, AND WHY. This was `child.kill("SIGTERM")`, which on Windows is
   * a `TerminateProcess` on exactly one pid: the `cmd.exe` this daemon spawned.
   * Everything below it kept running, and that leaked in two directions at once.
   *
   * 1. The orphan survived. `packages/local-exec/shell-core.ts` names this exact
   *    failure in its own comment — "`cmd.exe` dies and the `python` it started
   *    keeps running until something walks the tree" — and answers it with
   *    `killProcessTree`, which runs `taskkill /T /F` so the tree walks down from
   *    a shell that is still alive. That helper is what this now uses too.
   *
   * 2. The leak held the answer open. Node emits `close` on a child only after
   *    `exit` and after all three stdio streams reach EOF, and an orphan that
   *    inherited those pipes keeps them open. So a timeout or a cancel did not
   *    just leave a process behind: `shellStream`'s wait loop and `run()`'s
   *    `child.once("close")` both blocked until the orphan exited on its own.
   *    Measured through this daemon, with the route and the interpreter fixed and
   *    a grandchild whose own lifetime is 20 s:
   *
   *      shellStream, `timeout: 1500`  answered after 19 998 ms
   *      shellArgs,   `timeout: 1500`  answered after 19 992 ms
   *      shellStream, client abort     the orphan was still running 1.5 s later
   *
   *    With the shell tool's own 30 000 ms default, one command that leaves a
   *    server running makes the tool wait for that server.
   *
   * NOT WIDENED. This changes what a cancel reaches, and only in the direction the
   * cancel already pointed: the processes the shell was about to be killed as a
   * group instead of one at a time. The command, the interpreter, the environment,
   * the working directory and every path check above are untouched, and a command
   * that is never cancelled never reaches this method.
   *
   * The POSIX branch is unchanged and stays first: the daemon spawns `detached`
   * there, so the shell leads its own process group and `-pid` is the tree.
   * `killProcessTree` would reach the same place through `/proc`, but a daemon
   * that also runs on the Linux box it was written for does not need a second
   * answer to a question the group signal already answers.
   */
  private kill(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform !== "win32" && child.pid != null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      return;
    }
    const result = killProcessTree(child.pid);
    // `killProcessTree` reports `skipped` when there was no pid to name at all,
    // which happens when the spawn never got that far. The direct kill is the
    // only thing left then, and it is the behaviour this file had before.
    if (result.method === "skipped") {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  private async run(command: string, cwd: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<ProcessOutcome> {
    const { child, interpreter } = this.spawnShell(command, cwd);
    this.#foreground.add(child);
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stdoutDecoder = createShellOutputDecoder(this.#consoleCodePageLabel);
    const stderrDecoder = createShellOutputDecoder(this.#consoleCodePageLabel);
    child.stdout.on("data", data => { stdout += stdoutDecoder.push(data); });
    child.stderr.on("data", data => { stderr += stderrDecoder.push(data); });
    const abort = () => this.kill(child);
    signal.addEventListener("abort", abort, { once: true });
    const timer = timeoutMs == null ? undefined : setTimeout(() => { timedOut = true; this.kill(child); }, timeoutMs);
    try {
      const outcome = await new Promise<{ code: number; signal: string }>((resolve, reject) => {
        child.once("error", error => reject(new Error(describeShellInterpreterFailure(error, interpreter))));
        child.once("close", (code, childSignal) => resolve({ code: code ?? 1, signal: childSignal ?? "" }));
      });
      return { ...outcome, stdout: stdout + stdoutDecoder.flush(), stderr: stderr + stderrDecoder.flush(), elapsedMs: Date.now() - startedAt, timedOut, aborted: signal.aborted };
    } finally {
      if (timer != null) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#foreground.delete(child);
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error == null ? resolve() : reject(error)));
}

export async function startBoxExecDaemon(options: BoxExecDaemonOptions): Promise<BoxExecDaemonHandle> {
  const host = options.host ?? BOX_EXEC_DAEMON_HOST;
  const port = options.port ?? BOX_EXEC_DAEMON_PORT;
  const authToken = options.authToken ?? BOX_EXEC_DAEMON_AUTH_TOKEN;
  const requestedWorkspaceRoot = path.resolve(options.workspaceRoot);
  const requestedTerminalsDirectory = path.resolve(options.terminalsDirectory ?? path.join(tmpdir(), "sand-box-terminals"));
  await mkdir(requestedWorkspaceRoot, { recursive: true });
  await mkdir(requestedTerminalsDirectory, { recursive: true });
  const [workspaceRoot, terminalsDirectory] = await Promise.all([
    realpath(requestedWorkspaceRoot),
    realpath(requestedTerminalsDirectory),
  ]);
  await stat(workspaceRoot).then(info => {
    if (!info.isDirectory()) throw new Error(`workspaceRoot is not a directory: ${workspaceRoot}`);
  });
  const runtime = new BoxExecRuntime(workspaceRoot, terminalsDirectory, options.environment ?? process.env, await resolveConsoleCodePageLabel(options.environment ?? process.env));
  const adapter = connectNodeAdapter({
    routes(router) {
      router.service(BoxControlService, {
        ping: async () => new PingResponse(),
        // MCP support cannot be advertised here: `GetCapabilitiesResponse` has
        // exactly two fields, `computer_use_supported` and
        // `install_plugin_artifact_supported`, and neither of them is about MCP.
        // Reporting false for a field that means "this daemon runs MCP" would be a
        // lie the host cannot check, so the honest answer is to leave the schema
        // alone. MCP availability is observable instead, through `LoadMcpServers`
        // and `McpStateExecArgs`, and adding a capability bit is a change to the
        // generated descriptor, which is not this file's to make.
        getCapabilities: async () => new GetCapabilitiesResponse({ computerUseSupported: false, installPluginArtifactSupported: false }),
        updateEnvironmentVariables: async request => new UpdateEnvironmentVariablesResponse(runtime.applyEnvironment(request)),
        loadMcpServers: async request => await runtime.loadMcpServers(request),
      });
      router.service(BoxExecService, { exec: (request, context) => runtime.execute(request, context.signal) });
    },
  });
  let readyState = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }
    adapter(request, response);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); readyState = true; resolve(); });
  });
  await ready;
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Box exec daemon did not expose a TCP address");
  let stopped = false;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    workspaceRoot,
    terminalsDirectory,
    ready,
    isReady: () => readyState && !stopped,
    async stop() {
      if (stopped) return;
      stopped = true;
      readyState = false;
      await runtime.stop();
      await closeServer(server);
    },
  };
}
