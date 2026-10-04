/**
 * The user's own file of LOCAL stdio MCP servers, read only.
 *
 * Why this file exists. Grok Bot could describe an MCP server and could push a
 * stdio configuration to its computer, but it had exactly one source of server
 * definitions: the signed-in Cursor account. Every account read answers 401
 * without a token, so on a signed-out machine the server list was empty, no
 * stdio configuration was ever pushed, and `GetMcpTools`/`CallMcpTool` were
 * never created because the descriptor list was empty. A user who wants their
 * own notes server (`graphite`, `dsh`, anything) had nowhere to declare it.
 *
 * What it does. It reads ONE json file, validates every entry, and hands the
 * surviving `{ command, args, env }` records to `SandMcpDefinitionSource`
 * (`./mcp-definition-source.ts`) and to `SandMcpManager`, which merges them into
 * the display configuration. Everything downstream — the pushed config json
 * (`./tools-discovery.ts:162-163`), the per-server tool toggles, the custom
 * instructions — then works with no further change.
 *
 * WHAT THIS MODULE DELIBERATELY CANNOT DO: write. There is no save, no patch,
 * no append, no unlink — no import from `node:fs` other than `readFileSync`.
 * That is the whole security argument, and it is worth stating plainly.
 *
 * A local MCP server entry is a `command` plus optional `args`. Running it is
 * arbitrary code execution as the signed-in user, so the ability to write one
 * must never belong to the model. Today the product cannot run an arbitrary
 * local process through MCP at all, and that is the only protection standing:
 * `resolvePath`/`PathRejectedError` constrain the `Shell` and `Read` tools, but
 * they do not apply to a process started from configuration. If the model could
 * write this file it could hand itself `{"command":"cmd.exe","args":["/c",…]}`.
 * So the file is the user's, by hand, outside the app.
 *
 * Secrets. `env` is the supported way to hand a server a token, and that token
 * sits in this file in plaintext. Nothing here may echo a value: not in an
 * error message, not in a problem string, not in a log. `JSON.parse` failure
 * messages from V8 quote a slice of the source text, so only the byte position
 * is reported, never the message.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SandMcpConfigError } from "./mcp-config-error.js";

/** The one stdio shape a local file may declare. Matches `McpServerConfig`'s stdio arm. */
export interface LocalStdioServerConfig {
  readonly command: string;
  // Mutable and non-readonly on purpose: this type has to satisfy `McpServerConfig`'s
  // stdio arm, which `exactOptionalPropertyTypes` checks structurally. Fresh objects
  // are built for every read, so nothing here aliases anything a caller holds.
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

/** The whole file, after validation. `problems` never contains a value from the file. */
export interface LocalMcpSnapshot {
  /** Absolute path that was read. Reported so a user can find the file. */
  readonly path: string;
  /** Surviving entries, keyed by the name the user typed. */
  readonly servers: Readonly<Record<string, LocalStdioServerConfig>>;
  /** One line per rejected entry or unreadable file. Names and field names only. */
  readonly problems: readonly string[];
}

/**
 * Overrides the file location. An escape hatch for an operator and the only way
 * a test can point at a temporary file; unset in normal operation.
 */
export const LOCAL_MCP_CONFIG_ENV = "GROKBOT_LOCAL_MCP_CONFIG";

/** Directory under `%LOCALAPPDATA%` that holds the user's local MCP configuration. */
export const LOCAL_MCP_CONFIG_DIRECTORY = "GrokBotLocalBox";

/** File name inside {@link LOCAL_MCP_CONFIG_DIRECTORY}. */
export const LOCAL_MCP_CONFIG_FILE = "mcp-servers.json";

/** Human-readable location, used in refusals and in the installed-server listing. */
export const LOCAL_MCP_CONFIG_HINT = `%LOCALAPPDATA%\\${LOCAL_MCP_CONFIG_DIRECTORY}\\${LOCAL_MCP_CONFIG_FILE}`;

/**
 * How long one read is reused. The file is read on several hot paths
 * (`getUserServerConfigs`, `peekNames`, every listing) and a user editing it by
 * hand should see the change within a second, or immediately after
 * `RestartMcpServers`, which calls `invalidate()`.
 */
export const LOCAL_MCP_CONFIG_TTL_MS = 1_000;

/**
 * The identifier band reserved for local servers.
 *
 * Why a band and not `local:graphite`: `validateMcpServerId`
 * (`./mcp-server-id.ts:4`) accepts only `/^[1-9]\d*$/`, and that check stands on
 * every tool that takes a `server_id` — `SetMcpInstructions`, `GetMcpTools`
 * dispatch, `toggleMcpToolDisabled`. A synthetic `local:echo` is rejected there
 * and breaks five tools at once. This module deliberately keeps that rule and
 * stays inside it.
 *
 * Why the band is `[900000000, 999999999]`: inside it an id is a positive
 * decimal string with no leading zero, so `isMcpServerId` accepts it; it is
 * below `2_147_483_647`, so `parseInt32McpServerId` accepts it too; and it is
 * far above any id a backend account list hands out in practice, which is a
 * small ascending counter. The band is documented here, in
 * `mcp-service.ts` and in `sand-mcp-management-tools.ts`, and all three read
 * the same constant.
 */
export const LOCAL_MCP_SERVER_ID_MIN = 900_000_000;
export const LOCAL_MCP_SERVER_ID_MAX = 999_999_999;
const LOCAL_MCP_SERVER_ID_SPAN = LOCAL_MCP_SERVER_ID_MAX - LOCAL_MCP_SERVER_ID_MIN + 1;

/**
 * How far {@link localMcpServerIdForName} may walk the band looking for a free
 * id. Without a bound, a pathological input would spin through a hundred
 * million candidates instead of failing.
 */
const LOCAL_MCP_SERVER_ID_PROBE_LIMIT = 1_024;

/** Keys that would poison `Object.fromEntries` or an object literal downstream. */
const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Absolute path of the user's local MCP configuration.
 *
 * `%LOCALAPPDATA%` on Windows, and `~/GrokBotLocalBox` everywhere else so the
 * module still resolves a path on a machine where the variable is unset. The
 * directory is NOT created: a missing file is the normal case and must behave
 * exactly like an empty one.
 */
export function localMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[LOCAL_MCP_CONFIG_ENV];
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  const localAppData = env.LOCALAPPDATA;
  const base = typeof localAppData === "string" && localAppData.trim().length > 0
    ? localAppData.trim()
    : homedir();
  return join(base, LOCAL_MCP_CONFIG_DIRECTORY, LOCAL_MCP_CONFIG_FILE);
}

/** True when `rawId` sits in the band reserved for local servers. */
export function isLocalMcpServerId(rawId: string | undefined): boolean {
  if (typeof rawId !== "string" || !/^[0-9]+$/.test(rawId.trim())) return false;
  const parsed = Number(rawId.trim());
  return Number.isSafeInteger(parsed) && parsed >= LOCAL_MCP_SERVER_ID_MIN && parsed <= LOCAL_MCP_SERVER_ID_MAX;
}

/** 32-bit FNV-1a. Deterministic across processes, which is the only property needed. */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A stable id for one local server name.
 *
 * Stable means: the same name yields the same id in every process, for the life
 * of the installation, so a custom instruction or a disabled-tool list keyed by
 * it survives a restart. An allocation that counted entries would renumber every
 * local server the moment the user renamed one, silently detaching their saved
 * instructions.
 *
 * `taken` holds the ids already in use by account rows. A name is only walked
 * forward when its id is already occupied, which in practice never happens.
 */
export function localMcpServerIdForName(name: string, taken: ReadonlySet<string> = new Set<string>()): string {
  const start = LOCAL_MCP_SERVER_ID_MIN + (fnv1a32(name) % LOCAL_MCP_SERVER_ID_SPAN);
  for (let step = 0; step < LOCAL_MCP_SERVER_ID_PROBE_LIMIT; step += 1) {
    const candidate = String(LOCAL_MCP_SERVER_ID_MIN + ((start - LOCAL_MCP_SERVER_ID_MIN + step) % LOCAL_MCP_SERVER_ID_SPAN));
    if (!taken.has(candidate)) return candidate;
  }
  throw new SandMcpConfigError(
    `No free local MCP server identifier was left in the reserved range ${LOCAL_MCP_SERVER_ID_MIN}-${LOCAL_MCP_SERVER_ID_MAX}.`,
  );
}

/** One rejected entry: what is wrong, named by field and never by value. */
function problemWith(name: string, reason: string): string {
  return `local MCP server "${name}" was ignored: ${reason}.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns one raw entry into a stdio configuration, or explains why it cannot be
 * one. Returns the configuration or a reason; it never throws, so one bad entry
 * cannot take the rest of the file down with it.
 */
export function validateLocalStdioEntry(name: string, value: unknown): { config: LocalStdioServerConfig } | { reason: string } {
  if (!isPlainObject(value)) return { reason: "the entry is not an object" };
  if (value.url !== undefined) {
    // A remote server in this file would be an account server with a second,
    // unauthenticated, unmanageable source of truth. The account list owns those.
    return { reason: "a remote url is not read from this file; add it to the account instead" };
  }
  const { command, args, env, type } = value;
  if (type !== undefined && type !== "stdio") {
    return { reason: `type must be "stdio", not ${JSON.stringify(type)}` };
  }
  if (typeof command !== "string" || command.trim().length === 0) {
    return { reason: 'command must be a non-empty string, for example "command": "node" with "args": ["C:/notes/server.mjs"]' };
  }
  const parsedArgs = args === undefined ? [] : args;
  if (!Array.isArray(parsedArgs) || parsedArgs.some((entry) => typeof entry !== "string")) {
    return { reason: "args must be an array of strings when present" };
  }
  if (env !== undefined) {
    if (!isPlainObject(env) || Object.values(env).some((entry) => typeof entry !== "string")) {
      return { reason: "env must map names to string values when present" };
    }
  }
  return {
    config: {
      command: command.trim(),
      ...(parsedArgs.length === 0 ? {} : { args: parsedArgs as string[] }),
      ...(env === undefined ? {} : { env: env as Record<string, string> }),
    },
  };
}

/** Rejects the names that would break `Object.fromEntries` or a display row. */
function isUsableServerName(name: string): boolean {
  return name.length > 0
    && !RESERVED_SERVER_NAMES.has(name)
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("\0");
}

/**
 * Reads and validates the file. No cache, no write, no network.
 *
 * A missing file is not a problem: it is what a machine without local servers
 * looks like, and it must be indistinguishable from an empty one. Every other
 * failure becomes one `problems` line and no servers, so a broken file cannot
 * crash discovery or half-apply.
 */
export function readLocalMcpConfig(env: NodeJS.ProcessEnv = process.env): LocalMcpSnapshot {
  const file = localMcpConfigPath(env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path: file, servers: {}, problems: [] };
    return { path: file, servers: {}, problems: [`${file} could not be read (${code ?? "unknown error"}).`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    // The V8 message quotes the offending source text, which for this file can be
    // a token from `env`. Only the position is reported.
    const position = /position (\d+)/.exec(String((error as Error).message))?.[1];
    return {
      path: file,
      servers: {},
      problems: [`${file} is not valid JSON${position === undefined ? "" : ` (at byte ${position})`}.`],
    };
  }

  if (!isPlainObject(parsed)) {
    return { path: file, servers: {}, problems: [`${file} must contain a json object with an "mcpServers" key.`] };
  }
  const declared = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : null;
  if (declared === null) {
    return { path: file, servers: {}, problems: [`${file} has no "mcpServers" object.`] };
  }

  const servers: Record<string, LocalStdioServerConfig> = {};
  const problems: string[] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (!isUsableServerName(name)) {
      problems.push(problemWith(name, "the name is empty or contains a slash, a backslash, a null byte, or a reserved word"));
      continue;
    }
    const result = validateLocalStdioEntry(name, value);
    if ("reason" in result) problems.push(problemWith(name, result.reason));
    else servers[name] = result.config;
  }
  return { path: file, servers, problems };
}

export interface LocalMcpServerSource {
  /** Absolute path this source reads. */
  readonly path: string;
  /** Surviving entries, memoised for {@link LOCAL_MCP_CONFIG_TTL_MS}. */
  servers(): Readonly<Record<string, LocalStdioServerConfig>>;
  /** The whole read, including problems. */
  snapshot(): LocalMcpSnapshot;
  /** Forget the memo. Called by `RestartMcpServers` and on every account refresh. */
  invalidate(): void;
}

/**
 * A memoised reader. The same instance must be shared by the definition source
 * and the manager, otherwise the two can disagree about what is installed for up
 * to one TTL and a listing can name a server the pushed configuration does not
 * carry.
 */
export function createLocalMcpServerSource(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly ttlMs?: number;
} = {}): LocalMcpServerSource {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? LOCAL_MCP_CONFIG_TTL_MS;
  const empty: LocalMcpSnapshot = { path: localMcpConfigPath(env), servers: {}, problems: [] };
  let cached = empty;
  let readAtMs = Number.NEGATIVE_INFINITY;
  const read = (): LocalMcpSnapshot => {
    const at = now();
    if (at - readAtMs < ttlMs) return cached;
    readAtMs = at;
    cached = readLocalMcpConfig(env);
    return cached;
  };
  return {
    path: empty.path,
    servers: () => read().servers,
    snapshot: read,
    invalidate: () => {
      readAtMs = Number.NEGATIVE_INFINITY;
    },
  };
}