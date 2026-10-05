import { spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, win32 } from "node:path";

import { createSpan, reportEvent } from "../context/otel.js";
import type { Context } from "../context/core.js";
import { createWritableIterable } from "../utils/writable-iterable.js";
import { attachShellOutputStreams } from "./output-limiter.js";
import { resolveSandboxPolicyForWorkspace } from "./sandbox/policy-merge.js";
import { captureSandboxDenies } from "./sandbox/macos/seatbelt.js";
import { spawnWithSignal } from "./core.js";
import { buildShellCommandArgs, buildShellEnv, resolveSpawnShell } from "./shell-env.js";
import { shouldEnableSudoAskpass, transformSudoCommand } from "./sudo.js";
import { KnownShellExecutor } from "./types.js";
import { initBashState } from "./bash.js";
import { LazyTerminalExecutor } from "./lazy.js";
import { initPowerShellState } from "./powershell.js";
import { initZshState } from "./zsh.js";
import { initZshLightState } from "./zsh-light.js";

export type TerminalEvent =
  | { readonly type: "stdout" | "stderr"; readonly data: Buffer }
  | { readonly type: "suppressed_output" }
  | { readonly type: "stdin_ready"; readonly stdin: ChildProcessWithoutNullStreams["stdin"] | undefined; readonly pid: number | undefined }
  | { readonly type: "sandbox_denies"; readonly events: readonly unknown[] }
  | { readonly type: "exit"; readonly code: number | null; readonly data: ""; readonly aborted: boolean };

type SandboxPolicySources = NonNullable<Parameters<typeof resolveSandboxPolicyForWorkspace>[1]>;
type OutputLimiterOptions = Parameters<typeof attachShellOutputStreams>[0]["outputLimiterOptions"];

export interface TerminalExecuteOptions {
  readonly signal?: AbortSignal;
  readonly workingDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pipeStdin?: boolean;
  readonly sandboxPolicy?: unknown;
  readonly sandboxWorkspaceRoot?: string;
  readonly bufferOutputEvents?: boolean;
  readonly outputLimiterOptions?: unknown;
}

export interface TerminalExecutor {
  getCwd(): Promise<string>;
  clone(workingDirectory?: string): TerminalExecutor;
  execute(ctx: Context, command: string, options?: TerminalExecuteOptions): AsyncIterable<TerminalEvent>;
}

export interface DefaultTerminalExecutorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly shellArgs?: readonly string[];
  readonly userTerminalHint?: string;
  readonly statefulFactories?: Partial<Record<KnownShellExecutor.Zsh | KnownShellExecutor.ZshLight | KnownShellExecutor.Bash | KnownShellExecutor.PowerShell, (options?: DefaultTerminalExecutorOptions) => Promise<TerminalExecutor>>>;
}

export class NaiveTerminalExecutor implements TerminalExecutor {
  constructor(private readonly cwd: string, private readonly options: DefaultTerminalExecutorOptions = {}) {}
  async getCwd(): Promise<string> { return this.cwd; }
  clone(workingDirectory?: string): TerminalExecutor { return new NaiveTerminalExecutor(workingDirectory ?? this.cwd, this.options); }
  async *execute(ctx: Context, command: string, options: TerminalExecuteOptions = {}): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("NaiveTerminalExecutor.execute"));
    const iterable = createWritableIterable<TerminalEvent>();
    const pipeStdin = options.pipeStdin ?? false;
    const spawnShell = resolveSpawnShell(this.options.shell);
    const env = buildShellEnv({ overrides: options.env, shell: spawnShell });
    const transformedCommand = shouldEnableSudoAskpass(env) ? transformSudoCommand(command) : command;
    const cwd = options.workingDirectory ?? this.cwd;
    const sandboxWorkspaceRoot = options.sandboxWorkspaceRoot ?? cwd;
    const resolvedPolicy = await resolveSandboxPolicyForWorkspace(sandboxWorkspaceRoot, options.sandboxPolicy as SandboxPolicySources | undefined);
    const sandboxPolicy = resolvedPolicy.policy.type !== "insecure_none"
      ? { ...resolvedPolicy.policy, sandboxWorkspaceRoot }
      : resolvedPolicy.policy;
    const child = spawnWithSignal(spawnShell, buildShellCommandArgs(spawnShell, this.options.shellArgs, transformedCommand), {
      env,
      // WHAT CHANGED. `cwd` was computed on the line above and never handed to
      // the spawn, so the child inherited this process's own working directory
      // and every relative path in the command landed somewhere else. The four
      // sibling executors — `bash.ts`, `zsh.ts`, `zsh-light.ts`,
      // `powershell.ts` — all pass `cwd` here; this one did not.
      //
      // This is not a widening of anything. `cwd` is the directory the caller
      // already resolved and the permissions service already checked, so
      // passing it makes the process match the decision that was already made.
      // Naming it also keeps the macOS seatbelt policy anchored to the directory
      // the command was approved for instead of to the daemon's.
      cwd,
      // Use 'ignore' for stdin unless interactive, to prevent background processes from inheriting an open stdin pipe.
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
      // WHAT CHANGED, AND WHY. `windowsVerbatimArguments` was missing, and this
      // is the one executor that hands the agent's own command string to an
      // interpreter as the last argv element. Without it Node builds a Windows
      // command line out of `argv` and escapes the arguments, so the command —
      // which is full of quotes the agent wrote — was escaped a SECOND time on
      // its way to `cmd.exe /c`. `cmd.exe` does not understand backslash-escaped
      // quotes, so it toggled quote state at every `\"` and delivered a
      // truncated argument to the program.
      //
      // Measured on this machine through this executor, before and after, `/c`
      // identical:
      //
      //   `python -c "import sys;print(sys.executable)"` exit 1, Python saw `"import`
      //                                                     -> exit 0, the real path
      //   `python -c "print(123)"`                         exit 0, NO OUTPUT AT ALL
      //                                                     -> exit 0, `123`
      //
      // The second is the worst kind of failure: it reported success, printed
      // nothing, and left the model believing the machine had done nothing.
      // Both appear in the live agent transcript — `echo %CD% && python -c
      // "import sys;print(sys.executable)"` printed the right working directory
      // and then a SyntaxError for `"import` — which is what the user reported as
      // the agent's access to the computer intermittently dropping. It is
      // intermittent because it depends on the command: `echo`, `dir`, `mkdir`
      // and `cd` carry no quotes and are unaffected, while every `python -c`,
      // `node -e`, `git commit -m "..."` and `powershell -Command "..."` does.
      //
      // It is set HERE and not in the shared `spawnWithSignal`, because that is
      // what the four sibling executors would get too, and it would be wrong for
      // them: `powershell.ts` passes `-File <script path>` and `bash.ts` /
      // `zsh.ts` pass `-ilc <script text>`, both of which rely on Node quoting a
      // path argument. Only this executor's last argument is the raw command line
      // that an interpreter re-parses for itself.
      //
      // It changes only how the agent's own command string is tokenised. The
      // program, the environment, `cwd` and every path check above it are
      // untouched, so nothing here widens what a command may reach.
      ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
    }, sandboxPolicy, options.signal);
    child.on("spawn", async () => {
      try {
        await iterable.write({ type: "stdin_ready", stdin: child.stdin ?? undefined, pid: child.pid });
      } catch {
        // The consumer may have closed the iterable before spawn was observed.
      }
    });
    const outputPump = attachShellOutputStreams({
      stdout: child.stdout,
      stderr: child.stderr,
      writable: iterable,
      bufferOutputEvents: options.bufferOutputEvents,
      outputLimiterOptions: options.outputLimiterOptions as OutputLimiterOptions | undefined,
    });
    child.on("error", (error) => {
      iterable.throw(error);
    });
    child.on("exit", async (code) => {
      reportEvent(span.ctx, "exit");
      await outputPump.flush();
      if (sandboxPolicy.captureDenies ?? false) {
        try {
          const denyEvents = await captureSandboxDenies(child);
          if (denyEvents && denyEvents.length > 0) {
            await iterable.write({ type: "sandbox_denies", events: denyEvents });
          }
        } catch {
          // Sandbox diagnostics are best-effort after process exit.
        }
      }
      try {
        await iterable.write({
          type: "exit",
          code,
          data: "",
          aborted: options.signal?.aborted ?? false,
        });
        iterable.close();
      } catch {
        iterable.close();
      }
    });
    yield* iterable;
  }
}

export function createNaiveTerminalExecutor(options: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  return new NaiveTerminalExecutor(process.cwd(), options);
}

const COMMAND_PROBE_TIMEOUT_MS = 2_000;
const commandProbeCache = new Map<string, boolean>();

function defaultCommandProbe(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true, timeout: COMMAND_PROBE_TIMEOUT_MS }).error === undefined;
}

let commandProbe: (command: string) => boolean = defaultCommandProbe;

/**
 * Replaces the probe used by `getSuggestedShell`. Passing `null` restores the
 * real probe. This seam exists so the Windows probe budget can be asserted in a
 * test without spawning real `bash --version` processes.
 */
export function setShellCommandProbe(probe: ((command: string) => boolean) | null): void {
  commandProbe = probe ?? defaultCommandProbe;
  commandProbeCache.clear();
}

/**
 * `getSuggestedShell` runs per shell-tool call and each call used to spawn up to
 * four `--version` probes synchronously on the event loop. Results are cached per
 * command, and the cache is cleared when the process-level probe is swapped.
 */
export function commandExists(command: string): boolean {
  const cached = commandProbeCache.get(command);
  if (cached !== undefined) return cached;
  const result = commandProbe(command);
  commandProbeCache.set(command, result);
  return result;
}

function detectGitBashFromEnvironment(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform !== "win32" || !env.MSYSTEM) return undefined;
  const executablePath = env.EXEPATH;
  if (executablePath) { const normalized = executablePath.replace(/[\\/]+$/, ""); const base = win32.basename(normalized).toLowerCase(); return base === "bash.exe" ? normalized : base === "bin" ? win32.join(normalized, "bash.exe") : win32.join(normalized, "bin", "bash.exe"); }
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

export function getSuggestedShell(userTerminalHint: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): KnownShellExecutor {
  if (userTerminalHint === KnownShellExecutor.ZshLight) return KnownShellExecutor.ZshLight;
  const shell = userTerminalHint || env.SHELL || ""; const windows = platform === "win32"; const gitBash = windows && !userTerminalHint ? detectGitBashFromEnvironment(platform, env) : undefined;
  const isGitBash = gitBash !== undefined || /git.*bash\.exe$/i.test(shell) || /program.*git.*bin.*bash\.exe$/i.test(shell); const bashIsOkay = !windows || isGitBash;
  if (shell.includes("zsh")) return KnownShellExecutor.Zsh;
  if (shell.includes("bash") && bashIsOkay) return KnownShellExecutor.Bash;
  if (shell.includes("pwsh") || shell.includes("powershell")) return KnownShellExecutor.PowerShell;
  if (gitBash) return KnownShellExecutor.Bash;
  if (windows) {
    // Windows can host PowerShell and Git Bash. `zsh` has no supported Windows
    // build, and a bare `bash` on Windows is usually WSL or a shim that hangs,
    // so neither is probed here. That bounds the Windows probe budget at two.
    if (commandExists("pwsh") || commandExists("powershell")) return KnownShellExecutor.PowerShell;
    return KnownShellExecutor.Naive;
  }
  if (commandExists("zsh")) return KnownShellExecutor.Zsh;
  if (commandExists("bash") && bashIsOkay) return KnownShellExecutor.Bash;
  if (commandExists("pwsh") || commandExists("powershell")) return KnownShellExecutor.PowerShell;
  return KnownShellExecutor.Naive;
}

export function createDefaultTerminalExecutor(options: DefaultTerminalExecutorOptions = {}): TerminalExecutor {
  let effective = options; const gitBashPath = options.userTerminalHint ? undefined : detectGitBashFromEnvironment(); if (gitBashPath) effective = { ...options, userTerminalHint: gitBashPath };
  const suggested = getSuggestedShell(effective.userTerminalHint ?? "");
  if (suggested === KnownShellExecutor.Naive) return createNaiveTerminalExecutor(effective);
  const override = effective.statefulFactories?.[suggested];
  if (override !== undefined) return new LazyTerminalExecutor(() => override(effective));
  switch (suggested) {
    case KnownShellExecutor.Zsh:
      return new LazyTerminalExecutor(() => initZshState(effective));
    case KnownShellExecutor.Bash:
      return new LazyTerminalExecutor(() => initBashState(effective));
    case KnownShellExecutor.PowerShell:
      return new LazyTerminalExecutor(() => initPowerShellState());
    case KnownShellExecutor.ZshLight:
      return new LazyTerminalExecutor(() => initZshLightState(effective));
    default:
      return createNaiveTerminalExecutor(effective);
  }
}
