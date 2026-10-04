import { filterElectronEnv } from "../env-filter.js";
import { getSandboxCacheEnv } from "./cache-env.js";
import { SandboxUnsupportedError } from "./errors.js";
import { getLastSandboxFailureReason, isSandboxHelperSupported, spawnWithSandboxHelper, type SandboxHelperPolicy } from "./helper-support.js";
import { spawnUnsafe } from "./unsafe-spawn.js";
import type { SpawnOptions, ChildProcess } from "node:child_process";

export type SandboxExecutionPolicy = SandboxHelperPolicy;

/**
 * Builds the refusal a user sees when a sandbox policy cannot be enforced here.
 * The Windows wording matters: telling a Windows user to "ensure the sandbox
 * helper binary is available" sends them after a binary that cannot sandbox the
 * filesystem on that platform at all. The refusal states that nothing ran, so a
 * blocked command is never mistaken for an executed one.
 */
export function sandboxUnsupportedMessage(
  policyType: SandboxHelperPolicy["type"],
  reason: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const detail = reason ?? "unknown";
  if (platform === "win32") {
    return `Sandbox policy '${policyType}' cannot be enforced on Windows, so the command was not run. `
      + "The Windows sandbox helper provides a network proxy only; it does not isolate the filesystem. "
      + "To run commands here, set the sandbox policy to 'insecure_none' and accept that the command runs "
      + `without filesystem isolation. Reason: ${detail}`;
  }
  return `Sandbox policy '${policyType}' is not supported on this system, so the command was not run. `
    + "Ensure the sandbox helper binary is available, or use 'insecure_none'. "
    + `Reason: ${detail}`;
}

export function spawnInSandbox(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
  sandboxPolicy: SandboxExecutionPolicy,
): ChildProcess {
  options.env = filterElectronEnv(options.env);
  if (sandboxPolicy.enableSharedBuildCache) {
    options = {
      ...options,
      env: {
        ...filterElectronEnv(process.env),
        ...getSandboxCacheEnv(),
        ...options.env,
      },
    };
  }
  if (sandboxPolicy.type !== "insecure_none") {
    if (isSandboxHelperSupported()) {
      return spawnWithSandboxHelper(command, args, options, sandboxPolicy);
    }
    const failureReason = getLastSandboxFailureReason();
    throw new SandboxUnsupportedError(
      sandboxUnsupportedMessage(sandboxPolicy.type, failureReason),
      failureReason ?? undefined,
    );
  }
  return spawnUnsafe(command, args, options);
}
