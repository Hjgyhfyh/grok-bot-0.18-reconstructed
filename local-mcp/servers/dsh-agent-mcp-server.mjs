/**
 * DeepSeek Harness (DSH) MCP server.
 *
 * Lets a Grok Bot agent orchestrate coding agents running on the local DSH
 * install at `C:\Users\user\OneDrive\Рабочий стол\Tests-Ai\Space_Bunny-dsh`.
 *
 * DSH has no MCP server of its own — its checkout ships `@deepseek-ai/dsh-mcp-client`
 * and `packages/mcp/mcp-resources`, which is the other direction: DSH as an MCP
 * *client*. This file closes the missing direction by driving the `dsh` CLI.
 *
 * The primitive is `dsh headless "<task>"`, which answers one task, prints the
 * result and exits. That is the shape an orchestrator needs: it maps one MCP
 * tool call onto one bounded coding-agent run.
 *
 * Configuration — the DSH root comes from the environment:
 *   { "command": "node", "args": ["...\\dsh-agent-mcp-server.mjs"],
 *     "env": { "DSH_ROOT": "C:\\...\\Space_Bunny-dsh" } }
 * Optional: DSH_CLI (default "dsh"), DSH_DEFAULT_PROFILE, DSH_TASK_TIMEOUT_MS.
 *
 * Deliberately not exposed: `--from-default-profile`, `dsh plugin`, and any
 * profile mutation. This server runs tasks and reads state; it does not
 * reconfigure the user's harness.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { serveStdio, textResult } from "../mcp-stdio-core.mjs";

const dshRoot = process.env.DSH_ROOT?.trim();
const dshCli = process.env.DSH_CLI?.trim() || "dsh";
const defaultProfile = process.env.DSH_DEFAULT_PROFILE?.trim() || "";
const defaultTimeoutMs = Number(process.env.DSH_TASK_TIMEOUT_MS ?? 900_000);

/** Caps echoed output so one runaway task cannot flood the agent's context. */
const MAX_OUTPUT_CHARS = 40_000;

/** Runs a command, capturing output. Never rejects on a non-zero exit. */
function runCommand(command, args, { cwd, timeoutMs, onChild }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    if (onChild != null) onChild(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false, spawnFailed: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, timedOut, spawnFailed: false });
    });
  });
}

function clip(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n... [output clipped at ${MAX_OUTPUT_CHARS} of ${trimmed.length} chars]`;
}

/** Builds `dsh` arguments, putting launcher flags before the task text. */
function buildHeadlessArgs(args) {
  const commandArgs = [];
  const profile = typeof args.profile === "string" && args.profile.length > 0 ? args.profile : defaultProfile;
  if (profile.length > 0) commandArgs.push("--profile", profile);
  commandArgs.push("headless", String(args.task));
  return commandArgs;
}

serveStdio({
  name: "dsh-agent",
  version: "1.0.0",
  instructions: `Orchestrate coding agents on the local DeepSeek Harness install${dshRoot == null ? "" : ` at ${dshRoot}`}. run_task executes one bounded headless task and returns its result.`,
  tools: [
    {
      name: "dsh_version",
      description: "Report the installed DSH version. Use this first to confirm the harness is reachable.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "dsh_dump_config",
      description: "Print the composed profile tree for a profile, without booting it.",
      inputSchema: {
        type: "object",
        properties: { profile: { type: "string", description: "Profile name. Omit for the default profile." } },
      },
    },
    {
      name: "dsh_run_task",
      description: "Run one task on a headless DeepSeek Harness coding agent and return its output. Equivalent to `dsh headless \"<task>\"`. This can take minutes.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task for the coding agent, in natural language." },
          profile: { type: "string", description: "Profile to boot, e.g. web or tui. Defaults to DSH_DEFAULT_PROFILE." },
          cwd: { type: "string", description: "Working directory for the agent, normally a repository path." },
          timeout_ms: { type: "number", description: `Kill the run after this long (default ${defaultTimeoutMs}).` },
        },
        required: ["task"],
      },
    },
  ],
  async onCall(toolName, args) {
    switch (toolName) {
      case "dsh_version": {
        const result = await runCommand(dshCli, ["--version"], { cwd: dshRoot ?? undefined, timeoutMs: 60_000 });
        if (result.spawnFailed) {
          throw new Error(`could not start "${dshCli}". Install DSH or set DSH_CLI to its absolute path. Detail: ${result.stderr.trim()}`);
        }
        return textResult(`DSH ${clip(result.stdout || result.stderr)}`);
      }
      case "dsh_dump_config": {
        if (dshRoot != null && !existsSync(dshRoot)) {
          throw new Error(`DSH_ROOT does not exist: ${dshRoot}`);
        }
        const commandArgs = [];
        const profile = typeof args.profile === "string" && args.profile.length > 0 ? args.profile : defaultProfile;
        if (profile.length > 0) commandArgs.push("--profile", profile);
        commandArgs.push("--dump-config");
        const result = await runCommand(dshCli, commandArgs, { cwd: dshRoot ?? undefined, timeoutMs: 120_000 });
        if (result.spawnFailed) throw new Error(`could not start "${dshCli}": ${result.stderr.trim()}`);
        if (!result.ok) return textResult(`dsh --dump-config exited ${result.code}.\n${clip(result.stderr)}`, true);
        return clip(result.stdout);
      }
      case "dsh_run_task": {
        if (typeof args.task !== "string" || args.task.trim().length === 0) {
          throw new Error("run_task: \"task\" is required and must be a non-empty string");
        }
        if (dshRoot != null && !existsSync(dshRoot)) {
          throw new Error(`DSH_ROOT does not exist: ${dshRoot}`);
        }
        const cwd = typeof args.cwd === "string" && args.cwd.length > 0
          ? args.cwd
          : dshRoot ?? homedir();
        if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`);
        const timeoutMs = Number.isFinite(Number(args.timeout_ms)) ? Number(args.timeout_ms) : defaultTimeoutMs;
        const started = Date.now();
        const result = await runCommand(dshCli, buildHeadlessArgs(args), { cwd, timeoutMs });
        if (result.spawnFailed) throw new Error(`could not start "${dshCli}": ${result.stderr.trim()}`);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (result.timedOut) {
          return textResult(`dsh headless was killed after ${timeoutMs}ms (${seconds}s). Partial output:\n${clip(result.stdout)}\n${clip(result.stderr)}`, true);
        }
        const body = `${clip(result.stdout)}${result.stderr.trim().length === 0 ? "" : `\n[stderr]\n${clip(result.stderr)}`}`;
        if (!result.ok) return textResult(`dsh headless exited ${result.code} after ${seconds}s.\n${body}`, true);
        return textResult(`dsh headless finished in ${seconds}s (exit 0).\n${body}`);
      }
      default:
        throw new Error(`unhandled tool: ${toolName}`);
    }
  },
});