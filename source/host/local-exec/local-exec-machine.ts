import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getSandRootDir, SAND_DATA_ROOT_ENV } from "../host-paths.js";
import { realpathNearestExisting } from "../../shared/node/paths.js";

export class SandLocalExecPathError extends Error {}

/**
 * Directory the local-exec root falls back to when the operator configured none.
 *
 * It is the box's own workspace, spelled the same way `host/main.ts` spells it
 * when it starts the box exec daemon. The two have to name one directory: the
 * agent works here and the daemon runs here, so a script the agent writes is a
 * script the daemon is allowed to run.
 */
export const LOCAL_EXEC_DEFAULT_ROOT_DIRNAME = "box-workspace";

async function statOrUndefined(path: string) {
  try { return await stat(path); } catch { return undefined; }
}

export async function regularFileSizeBytes(path: string): Promise<number | undefined> {
  const stats = await statOrUndefined(path);
  return stats?.isFile() === true ? stats.size : undefined;
}

/**
 * The data root the box and the host share, read from an explicit `env`.
 *
 * `getSandRootDir()` already starts from the same `SAND_DATA_ROOT` override and
 * applies the same `isAbsolute` test, so in production this returns exactly what
 * `host/main.ts` gets. Spelling the override out here is what lets a caller pass
 * an environment other than `process.env` and still get a root inside it, instead
 * of the live machine's home directory leaking into a test or a child process.
 */
function sandRootDirFor(env: NodeJS.ProcessEnv): string {
  const override = env[SAND_DATA_ROOT_ENV]?.trim();
  if (override != null && override.length > 0 && isAbsolute(override)) return override;
  return getSandRootDir();
}

/**
 * Where the agent's hands may reach when nobody configured a root.
 *
 * WHAT CHANGED. The fallback was `homedir()`, so the default root was
 * `%USERPROFILE%` itself. Escaping the root was already refused — `containPath`
 * below has done that honestly since the containment existed — but the root
 * itself was the user's whole account, so the containment closed nothing: inside
 * the root the agent could read `AppData\Local\GrokBotLocalBox\gateway.json`,
 * which carries the loopback gateway bearer token, `launcher-secrets.txt`,
 * `launcher-gateway-token.txt`, `.ssh`, and every other file the account owns.
 * A file the agent can read is a file it can put in a transcript.
 *
 * The fallback is now the box workspace, which is the directory the agent is
 * actually meant to work in and the directory the box exec daemon is given as
 * its workspace root. Everything outside it is refused by the same check that
 * already existed; only the default moved.
 *
 * An explicit `SAND_LOCAL_EXEC_ROOT` or `SAND_AGENT_PROJECT_DIR` still wins, so
 * an operator who wants a different root is not overruled by this.
 */
export function resolveLocalExecRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_LOCAL_EXEC_ROOT?.trim() || env.SAND_AGENT_PROJECT_DIR?.trim();
  return configured != null && configured.length > 0
    ? configured
    : join(sandRootDirFor(env), LOCAL_EXEC_DEFAULT_ROOT_DIRNAME);
}

async function isDirectory(path: string): Promise<boolean> {
  return (await statOrUndefined(path))?.isDirectory() ?? false;
}

function resolvePath(path: string, root: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

export async function resolveShellWorkingDirectory(args: { readonly root: string; readonly requested: string }): Promise<{ workingDirectory: string; fellBackToRoot: boolean }> {
  const requested = args.requested.trim();
  // WHAT CHANGED. An empty request answered with the empty string and claimed
  // `fellBackToRoot: false`. `shell-core.ts` consumes this value as
  // `args.workingDirectory || await this.executor.getCwd()`, and `""` is falsy,
  // so the command silently inherited the PERSISTED shell session directory
  // instead. `powershell.ts` rewrites that directory after every command from
  // the snapshot its wrapper writes, so a single `cd` outside the root made
  // every later call that named no directory run — and be refused by
  // `createLocalExecPermissionsService.escapes` — somewhere the model never
  // asked for. That is the "access to my computer drops" the user reported, and
  // it arrived as a permissions refusal on a command that named no path at all.
  //
  // A request that names no directory means the root. That is what the root is
  // for, and it is not a widening: `containPath` still refuses everything
  // outside it, `gateway.json` included. `fellBackToRoot` stays `false` because
  // nothing fell back — reporting `true` would print a "does not exist on this
  // machine" notice that is not true.
  if (requested.length === 0) return { workingDirectory: args.root, fellBackToRoot: false };
  const resolved = resolvePath(requested, args.root);
  if (await isDirectory(resolved)) return { workingDirectory: resolved, fellBackToRoot: false };
  return { workingDirectory: args.root, fellBackToRoot: true };
}

export function missingWorkingDirectoryNotice(args: { readonly requested: string; readonly root: string }): string {
  return `working directory ${args.requested} does not exist on this machine; running in ${args.root} instead\n`;
}

export function escapesRoot(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
}

export async function containPath(args: { readonly root: string; readonly path: string }): Promise<string> {
  const resolved = isAbsolute(args.path) ? resolve(args.path) : resolve(args.root, args.path);
  if (escapesRoot(args.root, resolved)) {
    throw new SandLocalExecPathError(`Path is outside the allowed local-exec root and was refused: ${args.path}`);
  }
  let realRoot: string;
  try { realRoot = await realpathNearestExisting(args.root); }
  catch { return resolved; }
  const realResolved = await realpathNearestExisting(resolved);
  if (escapesRoot(realRoot, realResolved)) {
    throw new SandLocalExecPathError(`Path resolves through a symlink to outside the allowed local-exec root and was refused: ${args.path}`);
  }
  return resolved;
}

/**
 * The original manager wiring depends on the recovered workspace local-exec
 * package. Keeping that dependency explicit prevents a reduced substitute from
 * being mistaken for the shipped executor while the package runtime is rebuilt.
 */
export interface LocalExecManagerRuntime<Manager> {
  build(root: string, maxFileBytes: number, guards: {
    readonly containPath: typeof containPath;
    readonly regularFileSizeBytes: typeof regularFileSizeBytes;
    readonly resolveShellWorkingDirectory: typeof resolveShellWorkingDirectory;
    readonly missingWorkingDirectoryNotice: typeof missingWorkingDirectoryNotice;
  }): Manager;
}

export function buildLocalExecManager<Manager>(root: string, maxFileBytes: number, runtime: LocalExecManagerRuntime<Manager>): Manager {
  return runtime.build(root, maxFileBytes, { containPath, regularFileSizeBytes, resolveShellWorkingDirectory, missingWorkingDirectoryNotice });
}

