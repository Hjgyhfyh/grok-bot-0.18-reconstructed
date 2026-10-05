import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The deadline a `taskkill` may take before `local-exec` stops waiting for it
 * and falls back to killing the one process it can always name. A cancel path
 * that can hang forever is worse than one that leaks a single grandchild, so
 * this number is a ceiling on the whole `taskkill` call, not a retry budget.
 */
export const TASKKILL_DEADLINE_MS = 5_000;

/**
 * How long a cancelled shell is given to publish its pid before the direct kill
 * is allowed to go ahead without it.
 *
 * The order matters. `taskkill /T` walks the tree by walking down from a live
 * process, so the shell has to still be running when `taskkill` looks. Holding
 * the direct kill back for this long keeps that true for a cancel that arrives
 * while the process is still being created. Past the ceiling the direct kill
 * goes ahead and the tree may leak, which is what this file's callers did before
 * there was a guard at all.
 */
export const SHELL_PID_GRACE_MS = 2_000;

/** How long a POSIX process group is given to act on SIGTERM before SIGKILL. */
export const POSIX_FORCE_KILL_AFTER_MS = 1_000;

export interface ProcessTreeDeps {
  /** Defaults to the running host. Exists so the branch can be asserted on any machine. */
  readonly platform?: NodeJS.Platform;
  readonly spawnSync?: typeof spawnSync;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Reads the process group of `pid`, or `undefined` when the host cannot say. */
  readonly readProcessGroup?: (pid: number) => number | undefined;
  /** Runs a command and returns its stdout. Used only where `/proc` does not exist. */
  readonly runCommand?: (file: string, args: readonly string[]) => string;
  readonly taskkillDeadlineMs?: number;
  readonly forceKillAfterMs?: number;
}

export type ProcessTreeKillMethod =
  /** Windows `taskkill /T /F`: the process and everything below it. */
  | "taskkill-tree"
  /** POSIX `kill(-pgid)`: the whole group, because the shell leads its own. */
  | "posix-group"
  /** Only the named process. What the host did before this file existed. */
  | "direct"
  /** Nothing to kill: the pid was never known, or had already gone. */
  | "skipped";

export interface ProcessTreeKillResult {
  readonly method: ProcessTreeKillMethod;
  readonly pid: number;
  readonly taskkillStatus?: number | null;
  readonly detail?: string;
}

/**
 * Process group of a pid, from `/proc/<pid>/stat`, or `undefined` when there is
 * no `/proc` to read.
 *
 * The second field is the executable name in parentheses, and an executable name
 * may itself contain spaces and parentheses, so the fields are counted from the
 * last `)` rather than from the start of the line. `pgrp` is field 5 of what
 * remains, which is field 3 of the whitespace-separated tail.
 */
export function readProcessGroupFromProc(
  pid: number,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
): number | undefined {
  let stat: string;
  try {
    stat = readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const commEnd = stat.lastIndexOf(")");
  if (commEnd === -1) return undefined;
  const pgrp = Number(stat.slice(commEnd + 1).trim().split(/\s+/)[2]);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/**
 * Process group of a pid from `ps`, for the POSIX hosts that have no `/proc`.
 *
 * macOS is the one that matters: without this the group branch could never run
 * there, because the only other source of the answer is a file that does not
 * exist, and a shell that leads no group must not be signalled by negative pid.
 * Anything unexpected here returns `undefined`, which is the same answer `/proc`
 * gives when it cannot be read, and both of them mean "kill one process" — what
 * the host did before this file existed.
 */
export function readProcessGroupFromPs(
  pid: number,
  run: (file: string, args: readonly string[]) => string = (file, args) => spawnSync(file, args, { encoding: "utf8", windowsHide: true }).stdout,
): number | undefined {
  let output: string;
  try {
    output = run("ps", ["-o", "pgid=", "-p", String(pid)]);
  } catch {
    return undefined;
  }
  if (typeof output !== "string") return undefined;
  const pgid = Number(output.trim().split(/\s+/)[0]);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function signalProcessTree(
  target: number,
  group: boolean,
  deps: { readonly kill: (pid: number, signal: NodeJS.Signals) => void; readonly forceKillAfterMs: number },
): ProcessTreeKillResult {
  const send = (signal: NodeJS.Signals): boolean => {
    try {
      deps.kill(group ? -target : target, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!send("SIGTERM")) return { method: "direct", pid: target, detail: "SIGTERM reached nothing" };
  const escalation = setTimeout(() => send("SIGKILL"), deps.forceKillAfterMs);
  escalation.unref?.();
  return { method: group ? "posix-group" : "direct", pid: target };
}

/**
 * Kills `pid` and every process below it, and returns which way it did it.
 *
 * Windows has no process groups. `child.kill()` is a `TerminateProcess` on one
 * pid, so `cmd.exe` dies and the `python` it started keeps running. The only
 * thing on this host that knows the whole tree is `taskkill /T`, and it learns
 * the tree by walking down from a process that is still alive — which is why
 * this function is synchronous and why `createShellProcessGuard` calls it
 * before the direct kill rather than alongside it.
 *
 * POSIX is the mirror image: `kill(-pgid)` is the tree, but only for a process
 * that leads its own group. Signalling `-pid` for a process that does not lead
 * one targets *the caller's own group*, so the leadership check is not a
 * nicety. When the host cannot answer the question — no `/proc`, or the shell
 * was not spawned detached — the result is a direct kill, which is what the host
 * already did, and never a group signal aimed at the wrong processes.
 */
export function killProcessTree(pid: number | undefined, deps: ProcessTreeDeps = {}): ProcessTreeKillResult {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { method: "skipped", pid: pid ?? 0, detail: "no pid to kill" };
  }
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? defaultKill;
  const forceKillAfterMs = deps.forceKillAfterMs ?? POSIX_FORCE_KILL_AFTER_MS;

  if (platform === "win32") {
    const run = deps.spawnSync ?? spawnSync;
    const outcome = run("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: deps.taskkillDeadlineMs ?? TASKKILL_DEADLINE_MS,
    });
    if (outcome.error === undefined && outcome.status === 0) {
      return { method: "taskkill-tree", pid, taskkillStatus: outcome.status };
    }
    return signalProcessTree(pid, false, { kill, forceKillAfterMs });
  }

  let pgrp: number | undefined;
  if (deps.readProcessGroup !== undefined) {
    try {
      pgrp = deps.readProcessGroup(pid);
    } catch {
      pgrp = undefined;
    }
  } else {
    pgrp = readProcessGroupFromProc(pid);
    if (pgrp === undefined && platform !== "linux") {
      // Linux always has `/proc`, so nothing there means the pid is gone and a
      // second lookup would only cost a process. macOS and the BSDs have no
      // `/proc` at all and need the other source.
      pgrp = readProcessGroupFromPs(pid, deps.runCommand);
    }
  }
  return signalProcessTree(pid, pgrp === pid, { kill, forceKillAfterMs });
}

export interface ShellProcessGuard {
  /** The signal to hand to the terminal executor. */
  readonly signal: AbortSignal | undefined;
  /** Call with the pid the terminal reported, so a later cancel can name the tree. */
  observePid(pid: number | undefined): void;
  /** Call when the terminal stream ends, so no listener outlives the command. */
  release(): void;
}

/**
 * Turns "the caller cancelled" into "the whole tree dies, and only after that
 * the shell itself is killed".
 *
 * `shell-exec` answers an abort with `child.kill()`, which on Windows kills one
 * process. Starting `taskkill` alongside it loses: the direct kill removes the
 * parent in microseconds and `taskkill /T` then finds nothing to walk down
 * from, which was measured — the grandchild was still alive afterwards. So this
 * guard hands the terminal executor its own `AbortController` and releases it
 * only after the tree is gone. Nothing outside `local-exec` changes, and a shell
 * that is never cancelled never sees a second controller.
 *
 * A cancel that arrives before the terminal has reported its pid waits
 * `pidWaitMs` for one. Waiting forever would hang the caller; not waiting at all
 * is the leak this guard exists to close.
 */
export function createShellProcessGuard(
  request: AbortSignal | undefined,
  killTree: (pid: number) => void,
  options: { readonly pidWaitMs?: number } = {},
): ShellProcessGuard {
  if (request === undefined) return { signal: undefined, observePid: () => {}, release: () => {} };
  const downstream = new AbortController();
  const pidWaitMs = options.pidWaitMs ?? SHELL_PID_GRACE_MS;
  let pid: number | undefined;
  let cancelled = false;
  let released = false;
  let treeKilled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  // "Released" means the direct kill is allowed to happen. It is reached three
  // ways: the caller cancelled and the pid is already known, the caller
  // cancelled and the pid arrived during the grace window, or the terminal
  // stream ended without either having happened.
  const release = (): void => {
    if (released) return;
    released = true;
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    request.removeEventListener("abort", onAbort);
    if (!cancelled) return;
    if (!treeKilled && pid !== undefined) {
      treeKilled = true;
      killTree(pid);
    }
    downstream.abort();
  };

  function onAbort(): void {
    if (cancelled) return;
    cancelled = true;
    if (pid !== undefined) {
      release();
      return;
    }
    graceTimer = setTimeout(release, pidWaitMs);
    graceTimer.unref?.();
  }

  // A signal that is already aborted has to reach the executor already aborted,
  // because `spawnWithSignal` answers that with a child that never spawns and
  // no pid ever arrives to name a tree with.
  if (request.aborted) {
    cancelled = true;
    released = true;
    downstream.abort();
    return { signal: downstream.signal, observePid: () => {}, release: () => {} };
  }
  request.addEventListener("abort", onAbort, { once: true });
  return {
    signal: downstream.signal,
    observePid(value: number | undefined): void {
      if (value === undefined || released) return;
      pid = value;
      if (cancelled) release();
    },
    release,
  };
}