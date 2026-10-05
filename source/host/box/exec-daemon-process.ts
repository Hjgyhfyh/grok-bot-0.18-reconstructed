import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

import { createContext } from "../../packages/context/core.js";
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
  ) {
    super(
      `refusing contaminated box exec-daemon startup: ${target} is already bound` +
        (holderPid == null
          ? " by a process this host cannot name"
          : ` by pid ${holderPid}`) +
        (previousHostPid == null
          ? ""
          : `, after this host evicted its predecessor pid ${previousHostPid}`) +
        (holderPid != null && previousHostPid != null && holderPid !== previousHostPid
          ? "; the holder is NOT the host this start evicted, so it is a foreign listener and this host will not stop it"
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
        `[box-exec-daemon] ${host}:${port} was still bound after this host evicted its predecessor` +
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
  const budget = resolveBoxExecDaemonPortReleaseBudget(options.previousHost);
  const release = await waitForBoxExecDaemonPortRelease({
    host,
    port,
    timeoutMs: options.portReleaseTimeoutMs ?? budget.timeoutMs,
    previousHostPid: options.previousHostPid ?? budget.previousHostPid,
    log,
  });
  if (!release.released) {
    throw new BoxExecDaemonPortHeldError(
      `${host}:${port}`,
      release.holderPid,
      release.previousHostPid,
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
