import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import { createContext } from "../../packages/context/core.js";
import { findSystemErrno } from "../../shared/system-errno.js";
import { queryPowerShellUtf8 } from "../../shared/node/powershell-utf8.js";
import { pingBoxClassified } from "./box-remote-accessor.js";
import type { ErasedProductionBoxGeneratedPorts } from "./production.js";
import { DEFAULT_AUTH_TOKEN, EXEC_DAEMON_PORT } from "./loopback-sand-box.js";

export const BOX_EXEC_DAEMON_ENTRY_RELATIVE = "../box-exec-daemon/main.cjs";
export const BOX_EXEC_DAEMON_START_TIMEOUT_MS = 20_000;
export const BOX_EXEC_DAEMON_STOP_TIMEOUT_MS = 5_000;
/**
 * How long a starting host waits for the port its evicted predecessor held.
 *
 * `acquireHostLock` with the outcome "took-over" SIGTERMs the running host and,
 * if that is not enough, SIGKILLs it. The listening socket of that host's
 * exec-daemon is released by the OS only once the owning process has actually
 * exited, which is later than the moment `process.kill` returns. A host that
 * probed the port in that window read "already bound" and refused to start, so
 * the double launch left the user with no app at all: the old one dead by
 * design, the new one dead on a message that was no longer true when it printed.
 * The wait is narrow on purpose. It is only spent on the takeover path, it ends
 * as soon as the port is free, and it is capped so a foreign listener becomes a
 * named refusal rather than a hang.
 */
export const BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS = 5_000;
export const BOX_EXEC_DAEMON_PORT_RELEASE_POLL_MS = 100;

export interface OwnedBoxExecDaemon {
  readonly pid: number;
  readonly entryPath: string;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export interface BoxExecDaemonProcessOptions {
  readonly entryPath: string;
  readonly generated: ErasedProductionBoxGeneratedPorts;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly terminalsDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /**
   * The lock result of the host that is starting, exactly as
   * `acquireHostLock` returned it. Only a takeover can leave the port behind,
   * so this is what turns the release wait on. Passing nothing keeps the old
   * behaviour: probe once, refuse immediately.
   */
  readonly previousHost?: { readonly outcome?: string; readonly previousPid?: number };
  readonly portReleaseTimeoutMs?: number;
  readonly previousHostPid?: number;
  readonly log?: Pick<Console, "log" | "error">;
}

/** The result of waiting for the port the evicted host was holding. */
export interface BoxExecDaemonPortRelease {
  readonly released: boolean;
  readonly waitedMs: number;
  readonly holderPid: number | null;
  readonly previousHostPid: number | null;
}

export interface BoxExecDaemonPortReleaseOptions {
  readonly host?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly previousHostPid?: number | null;
  /**
   * Whether THIS start killed the host that owned the port. The log line says
   * "evicted its predecessor" only when that is true; on a stale lock it said
   * so anyway, naming a kill that never happened.
   */
  readonly evicted?: boolean;
  readonly isPortBound?: (host: string, port: number) => Promise<boolean>;
  readonly holderPidFor?: (host: string, port: number) => number | null;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: Pick<Console, "log" | "error">;
}

/**
 * A port the host needs is held by something it may not touch.
 *
 * The old message was the bare "127.0.0.1:1337 is already bound". That names no
 * process, so the operator reading it after a failed double launch could not
 * tell a dying predecessor from a program that has nothing to do with this app.
 */
export class BoxExecDaemonPortHeldError extends Error {
  readonly holderPid: number | null;
  readonly previousHostPid: number | null;

  constructor(
    readonly target: string,
    holderPid: number | null,
    previousHostPid: number | null = null,
    /**
     * Whether THIS start killed a live host to get here. It did not, when the
     * lock outcome was `reclaimed-dead`: the pid in `host.lock` was already dead
     * before the start, and the old message called that "evicted" anyway - so it
     * named the live host as the culprit and compared the holder against a
     * process this start never touched.
     */
    readonly evicted = true,
  ) {
    super(
      `refusing contaminated box exec-daemon startup: ${target} is already bound` +
        (holderPid == null
          ? " by a process this host cannot name"
          : ` by pid ${holderPid}`) +
        (previousHostPid == null
          ? ""
          : evicted
            ? `, after this host evicted its predecessor pid ${previousHostPid}`
            : `, after this start found predecessor pid ${previousHostPid} already dead`) +
        (holderPid != null && previousHostPid != null && holderPid !== previousHostPid
          ? evicted
            ? "; the holder is NOT the host this start evicted, so it is a foreign listener and this host will not stop it"
            : "; the holder is a listener this host cannot claim, so it is left running"
          : holderPid != null && previousHostPid != null
            ? "; the holder is the predecessor this start evicted, so its socket outlived the wait above"
            : ""),
    );
    this.name = "BoxExecDaemonPortHeldError";
    this.holderPid = holderPid;
    this.previousHostPid = previousHostPid;
  }
}

/**
 * How long to wait for the port, given the outcome of the lock acquisition.
 *
 * Kept as one function so the decision is made once and can be asserted on
 * directly, instead of being re-spelled at every call site.
 */
export function resolveBoxExecDaemonPortReleaseBudget(
  previousHost: { readonly outcome?: string; readonly previousPid?: number } | undefined,
): { readonly timeoutMs: number; readonly previousHostPid: number | null } {
  return {
    // "took-over" is the only outcome that kills a live host, and only a killed
    // host can leave a listening socket behind. Every other outcome either
    // found no live holder or found a dead one, so a wait there would only
    // delay a refusal that is already owed.
    timeoutMs:
      previousHost?.outcome === "took-over"
        ? BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS
        : 0,
    previousHostPid: previousHost?.previousPid ?? null,
  };
}

export const BOX_EXEC_DAEMON_ORPHAN_STOP_TIMEOUT_MS = 5_000;
export const BOX_EXEC_DAEMON_ORPHAN_STOP_POLL_MS = 50;

export interface BoxExecDaemonProcessProbe {
  readonly pid: number;
  readonly command: string | null;
  readonly parentPid: number | null;
}

export interface BoxExecDaemonPortAvailability {
  readonly available: boolean;
  readonly waitedMs: number;
  readonly holderPid: number | null;
  readonly previousHostPid: number | null;
  /** True only when THIS start killed a live host and is waiting out its socket. */
  readonly evicted: boolean;
  readonly reclaimedPids: readonly number[];
}

export interface EnsureBoxExecDaemonPortAvailableOptions {
  readonly host?: string;
  readonly port?: number;
  readonly entryPath: string;
  readonly previousHost?: { readonly outcome?: string; readonly previousPid?: number } | undefined;
  /** Overrides the pid named in the refusal, for callers that know better. */
  readonly previousHostPid?: number | null;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly portReleaseTimeoutMs?: number;
  readonly isPortBound?: (host: string, port: number) => Promise<boolean>;
  readonly holderPidsFor?: (host: string, port: number) => number[];
  readonly readCommand?: (pid: number) => string | null;
  readonly readParentPid?: (pid: number) => number | null;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly terminate?: (pid: number) => void;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: Pick<Console, "log" | "error">;
}

/**
 * Splits a command line into arguments, honouring double quotes.
 *
 * `spawn` quotes an argument that contains a space, and this install path does
 * contain spaces on every packaged build, so a plain `split(/\s+/)` would cut
 * `C:\Program Files\...\main.cjs` in half and never recognise its own daemon.
 */
export function splitCommandArguments(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const character of command) {
    if (character === "\"") { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(character)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

function comparablePath(value: string): string {
  const withoutNamespace = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  return withoutNamespace.replace(/\//g, "\\").toLowerCase();
}

/**
 * Whether this process was started FROM this host's own exec-daemon entry.
 *
 * Both halves must be provable, because the reclaim that uses this stops a
 * process: the argument has to be the exact entry this start resolved, not a
 * substring of it. A path merely contained in some other command line is not
 * evidence of anything.
 */
export function commandCarriesBoxExecDaemonEntry(command: string | null, entryPath: string): boolean {
  if (command == null || entryPath == null || entryPath.length === 0) return false;
  const wanted = comparablePath(entryPath);
  return splitCommandArguments(command).some(argument => comparablePath(argument) === wanted);
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function defaultTerminate(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch {}
}

/**
 * The command line and the parent pid of one pid, in one query.
 *
 * Best effort, exactly like `readPortHolderPids`: a CIM provider that is wedged,
 * missing or too slow answers "unknown", and unknown is never proof. A throw
 * becomes a null, so a platform that cannot answer produces a refusal to
 * reclaim rather than a reclaim on a guess.
 */
export function readProcessCommandAndParent(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): { readonly command: string | null; readonly parentPid: number | null } {
  if (!Number.isInteger(pid) || pid <= 0) return { command: null, parentPid: null };
  try {
    if (platform === "win32") {
      const output = queryPowerShellUtf8(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { @{CommandLine=$p.CommandLine;ParentProcessId=$p.ParentProcessId}|ConvertTo-Json -Compress }`, { timeoutMs: 5_000 });
      if (output.trim().length === 0) return { command: null, parentPid: null };
      const parsed = JSON.parse(output) as { CommandLine?: unknown; ParentProcessId?: unknown };
      const parentPid = Number(parsed.ParentProcessId);
      return {
        command: typeof parsed.CommandLine === "string" ? parsed.CommandLine : null,
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
      };
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "command="], { encoding: "utf8", timeout: 2_000, windowsHide: true });
    const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    const first = lines[0];
    if (first == null || first.length === 0) return { command: null, parentPid: null };
    const [ppid, ...rest] = first.split(/\s+/);
    const parentPid = Number.parseInt(ppid ?? "", 10);
    return {
      command: rest.join(" "),
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
    };
  } catch {
    return { command: null, parentPid: null };
  }
}

/**
 * Decides whether one port holder may be stopped.
 *
 * Both halves are required, and neither alone is enough:
 *
 *  - the command line carries the exact entry this host starts, so the holder is
 *    this app's own daemon and not a stranger that happens to hold 1337;
 *  - the parent is gone, so nobody is left who can still stop it properly. A
 *    daemon whose host is alive - a second box, or the host this start just
 *    evicted and is waiting for - belongs to a running app and is left alone.
 *
 * "Cannot tell" answers no on both counts, so a missing CIM provider degrades to
 * today's refusal instead of to a signal sent on a guess.
 */
export function isReclaimableBoxExecDaemonOrphan(
  probe: BoxExecDaemonProcessProbe,
  entryPath: string,
  isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
): boolean {
  if (!commandCarriesBoxExecDaemonEntry(probe.command, entryPath)) return false;
  if (probe.parentPid === null) return false;
  return !isProcessAlive(probe.parentPid);
}

/**
 * Everything between "the lock is mine" and "the port is bound", in one place.
 *
 * The refusal that used to live inline in `startBoxExecDaemonProcess` is
 * preserved exactly: a port that is still held after the wait, and that this
 * host cannot prove it owns, is refused and named. What is new is that a holder
 * this host CAN prove is its own orphaned daemon is stopped and waited for
 * again, which is the difference between a host that comes back after an abrupt
 * kill and a host that refuses the same message forever.
 */
export async function ensureBoxExecDaemonPortAvailable(
  options: EnsureBoxExecDaemonPortAvailableOptions,
): Promise<BoxExecDaemonPortAvailability> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? EXEC_DAEMON_PORT;
  const budget = resolveBoxExecDaemonPortReleaseBudget(options.previousHost);
  const timeoutMs = Math.max(0, options.timeoutMs ?? options.portReleaseTimeoutMs ?? budget.timeoutMs);
  const pollMs = Math.max(1, options.pollMs ?? BOX_EXEC_DAEMON_PORT_RELEASE_POLL_MS);
  const previousHostPid = options.previousHostPid ?? budget.previousHostPid;
  const evicted = options.previousHost?.outcome === "took-over";
  const isPortBound = options.isPortBound ?? isPortAcceptingConnections;
  const holderPidsFor = options.holderPidsFor ?? ((target, targetPort) => readPortHolderPids(targetPort));
  const sleep = options.delay ?? delay;
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const terminate = options.terminate ?? defaultTerminate;
  const readProcess = (pid: number): BoxExecDaemonProcessProbe => {
    if (options.readCommand !== undefined && options.readParentPid !== undefined) {
      return { pid, command: options.readCommand(pid), parentPid: options.readParentPid(pid) };
    }
    const observed = readProcessCommandAndParent(pid);
    return { pid, command: observed.command, parentPid: observed.parentPid };
  };

  const release = await waitForBoxExecDaemonPortRelease({
    host,
    port,
    timeoutMs,
    pollMs,
    previousHostPid,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.isPortBound === undefined ? {} : { isPortBound: options.isPortBound }),
    ...(options.holderPidsFor === undefined
      ? {}
      : { holderPidFor: () => holderPidsFor(host, port)[0] ?? null }),
  });
  if (release.released) {
    return { available: true, waitedMs: release.waitedMs, holderPid: null, previousHostPid, evicted, reclaimedPids: [] };
  }

  const reclaimedPids: number[] = [];
  for (const pid of holderPidsFor(host, port)) {
    if (!isReclaimableBoxExecDaemonOrphan(readProcess(pid), options.entryPath, isAlive)) continue;
    options.log?.log(`[box-exec-daemon] reclaiming orphaned exec-daemon pid ${pid} on ${host}:${port}: its host is gone and it is running this host's own entry`);
    terminate(pid);
    const deadline = now() + BOX_EXEC_DAEMON_ORPHAN_STOP_TIMEOUT_MS;
    while (isAlive(pid) && now() < deadline) await sleep(BOX_EXEC_DAEMON_ORPHAN_STOP_POLL_MS);
    if (isAlive(pid)) { options.log?.log(`[box-exec-daemon] orphaned exec-daemon pid ${pid} did not exit within ${BOX_EXEC_DAEMON_ORPHAN_STOP_TIMEOUT_MS}ms`); continue; }
    reclaimedPids.push(pid);
  }

  if (reclaimedPids.length > 0) {
    const after = await waitForBoxExecDaemonPortRelease({
      host,
      port,
      timeoutMs: timeoutMs === 0 ? BOX_EXEC_DAEMON_ORPHAN_STOP_TIMEOUT_MS : timeoutMs,
      pollMs,
      previousHostPid,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.isPortBound === undefined ? {} : { isPortBound: options.isPortBound }),
      ...(options.holderPidsFor === undefined
        ? {}
        : { holderPidFor: () => holderPidsFor(host, port)[0] ?? null }),
    });
    if (after.released) {
      return { available: true, waitedMs: release.waitedMs + after.waitedMs, holderPid: null, previousHostPid, evicted, reclaimedPids };
    }
    return { available: false, waitedMs: release.waitedMs + after.waitedMs, holderPid: after.holderPid, previousHostPid, evicted, reclaimedPids };
  }

  return { available: false, waitedMs: release.waitedMs, holderPid: release.holderPid, previousHostPid, evicted, reclaimedPids };
}

export function resolveBoxExecDaemonEntry(hostEntry = process.argv[1]): string {
  if (hostEntry == null || hostEntry.length === 0) {
    throw new Error("cannot resolve box exec-daemon entry without a host process entry");
  }
  return path.resolve(path.dirname(hostEntry), BOX_EXEC_DAEMON_ENTRY_RELATIVE);
}

export async function isPortAcceptingConnections(host: string, port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host, port });
    const settle = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(300, () => settle(false));
  });
}

/**
 * The pids listening on a TCP port, or `[]` when the platform cannot answer.
 *
 * Best effort by design: a refusal that names a pid is worth far more than one
 * that names nothing, but a refusal must not turn into a second failure because
 * the lookup tool was missing. Every failure here yields "unknown holder", and
 * the message says so rather than inventing a cause.
 */
export function readPortHolderPids(
  port: number,
  platform: NodeJS.Platform = process.platform,
): number[] {
  try {
    if (platform === "win32") {
      // `netstat -ano` is a core Windows binary and costs far less than
      // starting PowerShell, which `readProcessCommand` in host-lock.ts has to
      // do precisely because wmic is gone from current builds.
      const output = execFileSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      const pids = new Set<number>();
      for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        // `TCP <local> <remote> LISTENING <pid>`; the remote column is a
        // dash-padded placeholder on some builds, so the state is matched by
        // position and the pid by last, not by a fixed column count.
        if (fields.length < 5 || fields[0] !== "TCP") continue;
        if (fields[3] !== "LISTENING") continue;
        const local = fields[1] ?? "";
        const separator = local.lastIndexOf(":");
        if (separator < 0 || Number.parseInt(local.slice(separator + 1), 10) !== port) continue;
        const pid = Number.parseInt(fields[fields.length - 1] ?? "", 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const lsof = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const pids = lsof
      .split(/\r?\n/)
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
    if (pids.length > 0) return [...new Set(pids)];
  } catch {}
  try {
    const ss = execFileSync("ss", ["-Hltnp", "sport", "=", `:${port}`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const pids = [...ss.matchAll(/pid=(\d+)/g)]
      .map(match => Number.parseInt(match[1] ?? "", 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
    return [...new Set(pids)];
  } catch {}
  return [];
}

export function readPortHolderPid(
  host: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  const pids = readPortHolderPids(port, platform);
  // A single listener is the normal case. Several means the port is bound twice,
  // which is legal on Windows and impossible on POSIX, so naming all of them is
  // the only honest answer.
  return pids.length === 0 ? null : pids[0] ?? null;
}

/**
 * Waits a bounded time for a port to go quiet.
 *
 * The first probe happens before any sleeping, so a host that found the port
 * free pays one refused connection and no poll interval at all. The loop is
 * capped by both the deadline and the iteration count: an uncapped wait turns
 * a foreign listener into a startup that never finishes.
 */
export async function waitForBoxExecDaemonPortRelease(
  options: BoxExecDaemonPortReleaseOptions = {},
): Promise<BoxExecDaemonPortRelease> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? EXEC_DAEMON_PORT;
  const isPortBound = options.isPortBound ?? isPortAcceptingConnections;
  const holderPidFor = options.holderPidFor ?? ((target, targetPort) => readPortHolderPid(target, targetPort));
  const sleep = options.delay ?? delay;
  const now = options.now ?? (() => Date.now());
  const pollMs = Math.max(1, options.pollMs ?? BOX_EXEC_DAEMON_PORT_RELEASE_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? BOX_EXEC_DAEMON_PORT_RELEASE_TIMEOUT_MS);
  const previousHostPid = options.previousHostPid ?? null;
  const startedAt = now();

  if (!(await isPortBound(host, port))) {
    return { released: true, waitedMs: 0, holderPid: null, previousHostPid };
  }

  const deadline = startedAt + timeoutMs;
  const attempts = Math.ceil(timeoutMs / pollMs);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
    if (!(await isPortBound(host, port))) {
      const waitedMs = now() - startedAt;
      options.log?.log(
        `[box-exec-daemon] ${host}:${port} was still bound after this start released its predecessor` +
          `${previousHostPid == null ? "" : ` pid ${previousHostPid}`}; it came free after ${waitedMs}ms`,
      );
      return { released: true, waitedMs, holderPid: null, previousHostPid };
    }
  }
  return {
    released: false,
    waitedMs: now() - startedAt,
    holderPid: holderPidFor(host, port),
    previousHostPid,
  };
}

function childExit(child: ChildProcess): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function startBoxExecDaemonProcess(options: BoxExecDaemonProcessOptions): Promise<OwnedBoxExecDaemon> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? EXEC_DAEMON_PORT;
  const authToken = options.authToken ?? DEFAULT_AUTH_TOKEN;
  const log = options.log ?? console;
  const availability = await ensureBoxExecDaemonPortAvailable({
    host,
    port,
    entryPath: options.entryPath,
    previousHost: options.previousHost,
    ...(options.portReleaseTimeoutMs === undefined ? {} : { portReleaseTimeoutMs: options.portReleaseTimeoutMs }),
    ...(options.previousHostPid === undefined ? {} : { previousHostPid: options.previousHostPid }),
    log,
  });
  if (!availability.available) {
    throw new BoxExecDaemonPortHeldError(
      `${host}:${port}`,
      availability.holderPid,
      availability.previousHostPid,
      availability.evicted,
    );
  }
  await access(options.entryPath);
  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.terminalsDirectory, { recursive: true });
  const child = spawn(options.execPath ?? process.execPath, [options.entryPath], {
    cwd: path.dirname(options.entryPath),
    env: {
      ...(options.env ?? process.env),
      SAND_BOX_EXEC_DAEMON_PORT: String(port),
      SAND_BOX_EXEC_DAEMON_AUTH_TOKEN: authToken,
      SAND_BOX_WORKSPACE_ROOT: options.workspaceRoot,
      SAND_BOX_TERMINALS_DIRECTORY: options.terminalsDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("box exec-daemon child did not receive a pid");
  const exited = childExit(child);
  child.stdout?.on("data", chunk => log.log(`[box-exec-daemon] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", chunk => log.error(`[box-exec-daemon] ${String(chunk).trimEnd()}`));

  const ready = (async () => {
    const deadline = Date.now() + (options.startTimeoutMs ?? BOX_EXEC_DAEMON_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const result = await Promise.race([
        pingBoxClassified(createContext(), { host, port, authToken }, options.generated, 500),
        exited.then(status => { throw new Error(`box exec-daemon exited before readiness: ${JSON.stringify(status)}`); }),
      ]);
      if (result.outcome === "ok") return;
      await delay(100);
    }
    throw new Error(`box exec-daemon did not answer authenticated generated Ping at ${host}:${port}`);
  })();

  try {
    await ready;
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  }

  let closed = false;
  return {
    pid: child.pid,
    entryPath: options.entryPath,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(options.stopTimeoutMs ?? BOX_EXEC_DAEMON_STOP_TIMEOUT_MS).then(() => false),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        await exited;
        throw new Error(`box exec-daemon pid ${child.pid} required forced shutdown`);
      }
      if (await isPortAcceptingConnections(host, port)) {
        throw new Error(`box exec-daemon shutdown left ${host}:${port} bound`);
      }
    },
  };
}
