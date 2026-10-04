import { spawn } from "node:child_process";

export const NONINTERACTIVE_RUN_STDIO = Object.freeze([
  "ignore",
  "inherit",
  "inherit",
]);

export function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? NONINTERACTIVE_RUN_STDIO,
    detached: options.detached ?? false,
    shell: false,
  });
}

// Both helpers settle on `close`, not `exit`. `close` fires after the process
// has exited AND every stdio stream has ended, so a pipe with data still in the
// kernel buffer is drained before the promise settles. Resolving on `exit` let a
// large capture — `scripts/verify.mjs` reads a whole `Info.plist` through a pipe
// that holds far less — return a truncated string and compare a prefix of the
// real answer. `close` reports the same `(code, signal)` pair, so the exit-code
// semantics are unchanged.

export async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`));
    });
  });
}

export async function capture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}: ${stderr.trim()}`));
    });
  });
}
