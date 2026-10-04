import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, localExecFileTooLargeMessage } from "../shared/local-exec-gateway.js";
import type { JsonValue } from "@bufbuild/protobuf";
import {
  buildLocalExecManager,
  escapesRoot,
  resolveLocalExecRoot,
  type LocalExecManagerRuntime,
} from "../host/local-exec/local-exec-machine.js";
import type {
  LocalExecDecodedMessage,
  LocalExecExecutor,
  LocalExecExecutorOutput,
} from "../host/local-exec/local-exec-provider.js";
import { backgroundShellExecutorResource } from "../packages/agent-exec/background-shell.js";
import { SimpleControlledExecManager } from "../packages/agent-exec/controlled.js";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientThrow,
  ExecServerMessage,
} from "../packages/proto/generated/agent/v1/exec_pb.js";
import {
  ExecServerAbort,
  ExecServerControlMessage,
} from "../packages/proto/generated/agent/v1/agent_service_pb.js";
import { lsExecutorResource } from "../packages/agent-exec/ls.js";
import { readExecutorResource } from "../packages/agent-exec/read.js";
import { RegistryResourceAccessor } from "../packages/agent-exec/resource-provider.js";
import { shellStreamExecutorResource } from "../packages/agent-exec/shell-stream.js";
import { createContext, type Context } from "../packages/context/core.js";
import { LocalBackgroundShellExecutor } from "../packages/local-exec/background-shell.js";
import { LocalLsExecutor } from "../packages/local-exec/ls.js";
import { LocalReadExecutor } from "../packages/local-exec/read.js";
import { BaseShellCoreExecutor } from "../packages/local-exec/shell-core.js";
import { LocalShellStreamExecutor } from "../packages/local-exec/shell-stream.js";
import type { SandboxRule } from "../packages/local-exec/shell-core.js";
import { ReadError, ReadResult } from "../packages/proto/generated/agent/v1/read_exec_pb.js";
import { ShellStream, ShellStreamStderr } from "../packages/proto/generated/agent/v1/shell_exec_pb.js";
import type { SandboxPolicy as ProtoSandboxPolicy } from "../packages/proto/generated/agent/v1/sandbox_pb.js";
import { createDefaultTerminalExecutor } from "../packages/shell-exec/index.js";

export type ProductionLocalExecExecutorFactory = () => LocalExecExecutor;

interface ShellResourceArgs {
  command: string;
  workingDirectory?: string;
  toolCallId?: string;
  conversationId?: string;
  requestedSandboxPolicy?: ProtoSandboxPolicy;
  closeStdin?: boolean;
}

interface PathResourceArgs {
  path: string;
  toolCallId?: string;
  offset?: number;
  limit?: number;
  encodingHint?: string;
  ignore?: readonly string[];
  timeoutMs?: number;
  sandboxPolicy?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireShellResourceArgs(value: unknown): asserts value is ShellResourceArgs {
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new TypeError("local-exec shell resource arguments require a string command");
  }
  if (value.workingDirectory !== undefined && typeof value.workingDirectory !== "string") {
    throw new TypeError("local-exec shell workingDirectory must be a string");
  }
}

function requirePathResourceArgs(value: unknown): asserts value is PathResourceArgs {
  if (!isRecord(value) || typeof value.path !== "string") {
    throw new TypeError("local-exec path resource arguments require a string path");
  }
}

export const PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS = Object.freeze([
  "managerRuntime.build",
  "codec.decodeServerMessage",
  "codec.toManagerMessage",
  "codec.isClientMessage",
  "codec.clientMessageToJson",
  "codec.controlMessageToJson",
  "codec.createAbortControl",
  "codec.createThrowControl",
  "createContext",
] as const);

export class ProductionLocalExecCompositionError extends Error {
  constructor(readonly missingBindings: readonly string[]) {
    super(`local-exec production runtime is missing mandatory bindings: ${missingBindings.join(", ")}`);
    this.name = "ProductionLocalExecCompositionError";
  }
}

/**
 * The shipped daemon binds the generated ExecServerMessage, ExecClientMessage,
 * and ExecClientControlMessage classes at this boundary. Keeping every codec
 * operation mandatory prevents JSON-shaped substitutes from being presented as
 * the production protobuf transport.
 */
export interface ProductionExecCodec<
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
> {
  decodeServerMessage(json: JsonValue): LocalExecDecodedMessage;
  toManagerMessage(message: LocalExecDecodedMessage): ServerMessage;
  isClientMessage(message: ClientMessage | ClientControlMessage): message is ClientMessage;
  clientMessageToJson(message: ClientMessage): JsonValue;
  controlMessageToJson(message: ClientControlMessage): JsonValue;
  createAbortControl(execId: number): ServerControlMessage;
  createThrowControl(execId: number, error: string): ClientControlMessage;
}

/** The exact surface used from the shipped SimpleControlledExecManager. */
export interface ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage> {
  handle(context: Context, message: ServerMessage): AsyncIterable<ClientMessage | ClientControlMessage>;
  handleControlMessage(message: ServerControlMessage): void;
}

export interface ProductionLocalExecRuntime<
  Context,
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
  Manager extends ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>,
> {
  /**
   * This builder must register the shipped shell-stream, background-shell,
   * read, and list resources and return SimpleControlledExecManager.
   */
  readonly managerRuntime: LocalExecManagerRuntime<Manager>;
  readonly codec: ProductionExecCodec<ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>;
  /**
   * Supplies the cancellable package Context used by the controlled manager.
   * The shipped no-op loggerKey binding has no recovered public key export;
   * the clean controlled manager owns its evidenced logger directly.
   */
  readonly createContext: (signal: AbortSignal) => Context;
}

export interface ProductionLocalExecExecutorOptions<
  Context,
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
  Manager extends ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>,
> {
  readonly runtime: ProductionLocalExecRuntime<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage, Manager>;
  readonly root?: string;
  readonly maxFileBytes?: number;
}

function requiredFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

export function assertProductionLocalExecRuntime(runtime: unknown): void {
  const value = runtime as {
    managerRuntime?: { build?: unknown };
    codec?: Record<string, unknown>;
    createContext?: unknown;
  } | null;
  const missing: string[] = [];
  if (!requiredFunction(value?.managerRuntime?.build)) missing.push("managerRuntime.build");
  for (const binding of PRODUCTION_LOCAL_EXEC_RUNTIME_BINDINGS.slice(1, -1)) {
    const method = binding.slice("codec.".length);
    if (!requiredFunction(value?.codec?.[method])) missing.push(binding);
  }
  if (!requiredFunction(value?.createContext)) missing.push("createContext");
  if (missing.length > 0) throw new ProductionLocalExecCompositionError(missing);
}

/**
 * Adapts the shipped generated codec and controlled-manager graph to the
 * recovered gateway provider. There are deliberately no codec or executor
 * fallbacks: production construction is impossible until both mandatory ports
 * are supplied by recovered package source.
 */
export function createProductionLocalExecExecutor<
  Context,
  ServerMessage,
  ClientMessage,
  ClientControlMessage,
  ServerControlMessage,
  Manager extends ProductionControlledExecManager<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage>,
>(options: ProductionLocalExecExecutorOptions<Context, ServerMessage, ClientMessage, ClientControlMessage, ServerControlMessage, Manager>): LocalExecExecutor {
  assertProductionLocalExecRuntime(options.runtime);
  const root = options.root ?? resolveLocalExecRoot();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES;
  const manager = buildLocalExecManager(root, maxFileBytes, options.runtime.managerRuntime);
  const { codec } = options.runtime;

  return {
    decodeServerMessage: (json): LocalExecDecodedMessage => codec.decodeServerMessage(json),
    execute: async function* (message: LocalExecDecodedMessage, signal: AbortSignal): AsyncIterable<LocalExecExecutorOutput> {
      const context = options.runtime.createContext(signal);
      for await (const output of manager.handle(context, codec.toManagerMessage(message))) {
        if (codec.isClientMessage(output)) {
          yield { kind: "client", message: codec.clientMessageToJson(output) };
        } else {
          yield { kind: "control", message: codec.controlMessageToJson(output) };
        }
      }
    },
    cancel: (execId): void => manager.handleControlMessage(codec.createAbortControl(execId)),
    throwControl: (error): JsonValue => codec.controlMessageToJson(codec.createThrowControl(0, error)),
  };
}

function contextFromSignal(signal: AbortSignal): Context {
  const [context, cancel] = createContext().withCancel();
  if (signal.aborted) cancel(signal.reason);
  else signal.addEventListener("abort", () => cancel(signal.reason), { once: true });
  return context;
}

class GatewayExecServerMessage implements LocalExecDecodedMessage {
  constructor(readonly generated: ExecServerMessage) {}

  get id(): number { return this.generated.id; }
  set id(value: number) { this.generated.id = value; }

  get message(): { readonly case?: string; readonly value?: Record<string, unknown> } {
    const { case: messageCase, value } = this.generated.message;
    if (messageCase === undefined) return {};
    if (!isRecord(value)) return { case: messageCase };
    return { case: messageCase, value };
  }
}

/**
 * The daemon's own permission service.
 *
 * Until now this graph was built from `MockPermissionsService` and
 * `MockIgnoreService`, imported from `../packages/local-exec/tests/common.js`.
 * That mock answered `allow` to every `shouldBlock*` question before it looked
 * at the request, so the shipped daemon had no permission check at all. A live
 * run of `SandLocalToolPermissionController` allowed `powershell -enc <base64>`,
 * `type %USERPROFILE%\.ssh\id_rsa` and reading `gateway.json`, and changing the
 * setting from "always" to "ask" changed nothing here, because this object never
 * asked. On top of that, a production bundle took a hard dependency on a file
 * inside a `tests/` directory: the product and the suite shipped one object.
 *
 * There is no recovered full permissions service in this tree, so this is the
 * minimal honest one, and its limits are stated rather than hidden:
 *
 *  - The one boundary enforced here is the local-exec root. Nothing that
 *    resolves outside it is allowed, whether it arrives as a read path, a write
 *    path, or a shell working directory.
 *  - The allow / ask / deny decision for a target *inside* the root is not made
 *    here. It is made upstream by `SandLocalToolPermissionController` from the
 *    `localToolPermission` setting, which reaches the daemon only through the
 *    gateway's `sendPrompt`. This service re-reads that setting so `never`
 *    closes the daemon too, but it cannot raise an interactive question: a
 *    daemon with no desktop attached has nowhere to ask. Anything beyond the
 *    root boundary needs the recovered upstream service.
 */
export type LocalExecPermissionBlock = { readonly kind: "block"; readonly reason: { readonly type: "permissionsConfig"; readonly isReadonly?: boolean } } | { readonly kind: "allow"; readonly policy?: SandboxRule };

export interface LocalExecPermissionsServiceOptions {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

const SAND_SETTINGS_PERMISSION_TTL_MS = 500;
const SAND_LOCAL_TOOLS_DISABLED_BLOCK_REASON = "local tools are switched off in the host settings (localToolPermission: never)";

function permissionSettingsPath(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.SAND_DATA_ROOT?.trim() || env.SAND_USER_DATA_DIR?.trim();
  return root == null || root.length === 0 ? undefined : resolve(root, "settings.json");
}

/** Reads `localToolPermission` out of the shared settings file, cached briefly. */
export class LocalExecPermissionSetting {
  private cached: { at: number; value: "always" | "ask" | "never" } | undefined;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly now: () => number = Date.now) {}
  async read(): Promise<"always" | "ask" | "never"> {
    const now = this.now();
    if (this.cached != null && now - this.cached.at < SAND_SETTINGS_PERMISSION_TTL_MS) return this.cached.value;
    const value = await this.readUncached();
    this.cached = { at: now, value };
    return value;
  }
  private async readUncached(): Promise<"always" | "ask" | "never"> {
    const file = permissionSettingsPath(this.env);
    if (file === undefined) return "always";
    try {
      const parsed: unknown = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      if (typeof parsed !== "object" || parsed === null) return "always";
      const raw = (parsed as Record<string, unknown>).localToolPermission;
      return raw === "never" || raw === "ask" || raw === "always" ? raw : "always";
    } catch {
      // A missing or unreadable settings file must not silently widen access,
      // but it must also not brick a box whose settings were never written.
      return "always";
    }
  }
}

export function createLocalExecPermissionsService(options: LocalExecPermissionsServiceOptions): {
  shouldBlockRead(path: string): Promise<boolean>;
  shouldBlockWrite(_ctx: unknown, path: string, _newContents: string): Promise<boolean>;
  shouldBlockMcp(_ctx: unknown, _args: unknown): Promise<boolean>;
  shouldBlockShellCommand(_ctx: unknown, _command: string, options: unknown, requestedPolicy?: SandboxRule): Promise<LocalExecPermissionBlock>;
  shouldEnforceShellInvariantBlocks(_ctx: unknown, options: unknown, _requestedPolicy?: SandboxRule): Promise<LocalExecPermissionBlock>;
  isShellCommandFullyAllowlisted(): Promise<boolean>;
  isMcpFullyAllowlisted(): Promise<boolean>;
  isWebFetchFullyAllowlisted(): Promise<boolean>;
  escapesRoot(path: string): boolean;
} {
  const root = resolve(options.root);
  const setting = new LocalExecPermissionSetting(options.env ?? process.env, options.now ?? Date.now);
  const refused: LocalExecPermissionBlock = { kind: "block", reason: { type: "permissionsConfig" } };
  const allow = (policy?: SandboxRule): LocalExecPermissionBlock =>
    policy === undefined ? { kind: "allow" } : { kind: "allow", policy };

  const escapes = (target: string): boolean => {
    if (typeof target !== "string" || target.trim().length === 0) return false;
    const resolved = isAbsolute(target) ? resolve(target) : resolve(root, target);
    if (!escapesRoot(root, resolved)) return false;
    // `resolve` has already collapsed `..`; a second pass over the relative
    // form catches the mixed-separator spelling that only Windows resolves.
    const viaRelative = relative(root, resolved);
    return escapesRoot(root, isAbsolute(viaRelative) ? resolved : resolve(root, viaRelative));
  };

  const workingDirectoryOf = (options: unknown): string | undefined => {
    if (typeof options !== "object" || options === null) return undefined;
    const value = (options as Record<string, unknown>).workingDirectory;
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };

  const shellDecision = async (options: unknown, policy?: SandboxRule): Promise<LocalExecPermissionBlock> => {
    const workingDirectory = workingDirectoryOf(options);
    if (workingDirectory !== undefined && escapes(workingDirectory)) return refused;
    if (await setting.read() === "never") return refused;
    return allow(policy ?? { type: "insecure_none" });
  };

  return {
    escapesRoot: escapes,
    shouldBlockRead: async (path) => escapes(path),
    shouldBlockWrite: async (_ctx, path) => escapes(path),
    shouldBlockMcp: async () => (await setting.read() === "never"),
    shouldBlockShellCommand: async (_ctx, _command, shellOptions, requestedPolicy) => shellDecision(shellOptions, requestedPolicy),
    shouldEnforceShellInvariantBlocks: async (_ctx, shellOptions, requestedPolicy) => shellDecision(shellOptions, requestedPolicy),
    // "Fully allowlisted" means a policy rule already covers this target. This
    // service has no rule set of its own, so it never claims one: answering
    // `true` here is what would skip the checks above.
    isShellCommandFullyAllowlisted: async () => false,
    isMcpFullyAllowlisted: async () => false,
    isWebFetchFullyAllowlisted: async () => false,
  };
}

export const LOCAL_EXEC_IGNORE_FILE_NAMES = [".cursorignore", ".gitignore"] as const;

/**
 * A minimal first-party ignore service. The mock answered `false` to every
 * question, which is not a security hole on its own - it shows more files, not
 * fewer - but it is still a test double in the shipped graph. This reads the
 * two ignore files that exist at the root and matches them with a small glob
 * translation. It is not the recovered upstream ignore service, and it does not
 * walk nested ignore files.
 */
export function createLocalExecIgnoreService(options: { readonly root: string }): {
  isCursorIgnored(path: string): Promise<boolean>;
  isGitIgnored(path: string): Promise<boolean>;
  isIgnoredByAny(path: string): Promise<boolean>;
  listCursorIgnoreFilesByRoot(root: string): Promise<readonly string[]>;
  isRepoBlocked(path: string): Promise<boolean>;
  getCursorIgnoreMapping(): Promise<Record<string, readonly string[]>>;
  getGitIgnoreMapping(): Promise<Record<string, readonly string[]>>;
  getRepoBlockExcludeGlobs(root: string): Promise<readonly string[]>;
} {
  const root = resolve(options.root);
  const loaded = new Map<string, readonly string[]>();

  function globToRegExp(pattern: string): RegExp {
    const anchored = pattern.startsWith("/");
    const body = anchored ? pattern.slice(1) : pattern.replace(/\/+$/, "");
    const source = body
      .split("")
      .map((character) => {
        if (character === "*") return "*";
        if (character === "?") return "?";
        return `\\${character}`;
      })
      .join("")
      .replace(/\*\*\*/g, "\u0001")
      .replace(/\*\*/g, "\u0002")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0002/g, ".*")
      .replace(/\u0001/g, ".*")
      .replace(/\?/g, "[^/]");
    return new RegExp(anchored ? `^${source}(/.*)?$` : `(^|/)${source}(/.*)?$`);
  }

  function relativeToRoot(path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, resolved);
    return rel.split(sep).join("/");
  }

  async function patternsFor(fileName: string): Promise<readonly string[]> {
    const cached = loaded.get(fileName);
    if (cached !== undefined) return cached;
    let patterns: readonly string[] = [];
    try {
      const text = (await readFile(resolve(root, fileName), "utf8")).replace(/^\uFEFF/, "");
      patterns = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line) => (line.startsWith("!") ? `!${line.slice(1).trim()}` : line));
    } catch {
      patterns = [];
    }
    loaded.set(fileName, patterns);
    return patterns;
  }

  async function matches(fileName: string, path: string): Promise<boolean> {
    const relativePath = relativeToRoot(path);
    if (relativePath === "" || relativePath.startsWith("..")) return false;
    let ignored = false;
    for (const pattern of await patternsFor(fileName)) {
      const negated = pattern.startsWith("!");
      const body = negated ? pattern.slice(1) : pattern;
      if (body.length === 0) continue;
      try {
        if (globToRegExp(body).test(relativePath)) ignored = !negated;
      } catch {
        // A pattern this translation cannot express is treated as no match
        // rather than as a hard failure of the whole file.
      }
    }
    return ignored;
  }

  return {
    isCursorIgnored: (path) => matches(".cursorignore", path),
    isGitIgnored: (path) => matches(".gitignore", path),
    isIgnoredByAny: async (path) => (await matches(".cursorignore", path)) || (await matches(".gitignore", path)),
    listCursorIgnoreFilesByRoot: async (listRoot) => [resolve(listRoot, ".cursorignore"), resolve(listRoot, ".gitignore")],
    isRepoBlocked: async () => false,
    getCursorIgnoreMapping: async () => ({ [root]: await patternsFor(".cursorignore") }),
    getGitIgnoreMapping: async () => ({ [root]: await patternsFor(".gitignore") }),
    getRepoBlockExcludeGlobs: async () => [],
  };
}

/**
 * Exact first-party resource graph emitted by local-exec-machine.ts. Stateful
 * terminal creation remains lazy inside createDefaultTerminalExecutor, so
 * construction and non-shell resources do not pretend that a missing native
 * shell binding exists.
 */
export function createDefaultProductionLocalExecExecutor(options: {
  readonly root?: string;
  readonly maxFileBytes?: number;
} = {}): LocalExecExecutor {
  const managerRuntime: LocalExecManagerRuntime<SimpleControlledExecManager> = {
    build(root, maxFileBytes, guards) {
      const permissionsService = createLocalExecPermissionsService({ root });
      const ignoreService = createLocalExecIgnoreService({ root });
      const terminalExecutor = createDefaultTerminalExecutor({
        env: { CURSOR_AGENT: "1", SAND_AGENT: "1" },
      }).clone(root);
      const shellCoreExecutor = new BaseShellCoreExecutor(terminalExecutor, root, root);
      const backgroundShellExecutor = new LocalBackgroundShellExecutor(
        permissionsService,
        shellCoreExecutor,
        ignoreService,
        root,
        undefined,
        undefined,
      );
      const shellStreamExecutor = new LocalShellStreamExecutor(
        permissionsService,
        shellCoreExecutor,
        ignoreService,
        backgroundShellExecutor.getManager(),
      );
      const readExecutor = new LocalReadExecutor(permissionsService, root);
      const lsExecutor = new LocalLsExecutor(permissionsService, ignoreService, root);
      const registry = new RegistryResourceAccessor();

      registry.register(shellStreamExecutorResource, {
        execute: (ctx: Context, argsValue: unknown) => (async function* () {
          requireShellResourceArgs(argsValue);
          const args = argsValue;
          const requested = args.workingDirectory ?? "";
          const resolution = await guards.resolveShellWorkingDirectory({ root, requested });
          args.workingDirectory = resolution.workingDirectory;
          if (resolution.fellBackToRoot) {
            yield new ShellStream({
              event: {
                case: "stderr",
                value: new ShellStreamStderr({ data: guards.missingWorkingDirectoryNotice({ requested, root }) }),
              },
            });
          }
          yield* shellStreamExecutor.execute(ctx, args);
        })(),
      });
      registry.register(backgroundShellExecutorResource, {
        execute: async (ctx: Context, argsValue: unknown) => {
          requireShellResourceArgs(argsValue);
          const args = argsValue;
          const resolution = await guards.resolveShellWorkingDirectory({ root, requested: args.workingDirectory ?? "" });
          args.workingDirectory = resolution.workingDirectory;
          return backgroundShellExecutor.execute(ctx, args);
        },
      });
      registry.register(readExecutorResource, {
        execute: async (ctx: Context, argsValue: unknown) => {
          requirePathResourceArgs(argsValue);
          const args = argsValue;
          const resolved = await guards.containPath({ root, path: args.path });
          const sizeBytes = await guards.regularFileSizeBytes(resolved);
          if (sizeBytes !== undefined && sizeBytes > maxFileBytes) {
            return new ReadResult({
              result: {
                case: "error",
                value: new ReadError({ path: resolved, error: localExecFileTooLargeMessage(sizeBytes, maxFileBytes) }),
              },
            });
          }
          return readExecutor.execute(ctx, args);
        },
      });
      registry.register(lsExecutorResource, {
        execute: async (ctx: Context, argsValue: unknown) => {
          requirePathResourceArgs(argsValue);
          const args = argsValue;
          await guards.containPath({ root, path: args.path });
          return lsExecutor.execute(ctx, args);
        },
      });
      return SimpleControlledExecManager.fromResources(registry);
    },
  };

  return createProductionLocalExecExecutor<
    Context,
    ExecServerMessage,
    ExecClientMessage,
    ExecClientControlMessage,
    ExecServerControlMessage,
    SimpleControlledExecManager
  >({
    runtime: {
      managerRuntime,
      codec: {
        decodeServerMessage: (json) => new GatewayExecServerMessage(ExecServerMessage.fromJson(json, { ignoreUnknownFields: true })),
        toManagerMessage: (message) => {
          if (!(message instanceof GatewayExecServerMessage)) {
            throw new TypeError("local-exec decoded message did not originate from the generated production codec");
          }
          return message.generated;
        },
        isClientMessage: (message): message is ExecClientMessage => message instanceof ExecClientMessage,
        clientMessageToJson: (message) => message.toJson(),
        controlMessageToJson: (message) => message.toJson(),
        createAbortControl: (execId) => new ExecServerControlMessage({
          message: { case: "abort", value: new ExecServerAbort({ id: execId }) },
        }),
        createThrowControl: (execId, error) => new ExecClientControlMessage({
          message: { case: "throw", value: new ExecClientThrow({ id: execId, error }) },
        }),
      },
      createContext: contextFromSignal,
    },
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  });
}
