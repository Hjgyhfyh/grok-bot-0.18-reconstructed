import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Context } from "../context/core.js";
import { OutputLocation } from "../proto/generated/agent/v1/utils_pb.js";
import { SHELL_OUTPUT_SUPPRESSED_NOTICE } from "../shell-exec/output-suppression.js";
import type { TerminalExecutor } from "../shell-exec/index.js";
import { getSafeConversationId, TRANSCRIPTS_SUBDIR } from "../utils/workspace-paths.js";
import { MAX_BUFFER_SIZE } from "./constants.js";
import { createShellProcessGuard, killProcessTree } from "./process-tree.js";
import type { SandboxRule } from "./sandbox-conversion.js";

const REQUEST_SCOPED_SHELL_ENV_KEYS = ["CURSOR_CONVERSATION_ID", "CURSOR_AGENT_STORE_FILES_DIR", "CURSOR_AGENT_STORE_SHARED_PATHS"] as const;
const MAX_OUTPUT_FILE_SIZE = 50 * 1024 * 1024;
const AGENT_TOOLS_DIR = "agent-tools";
const isWindows = process.platform === "win32";

/**
 * What the model is told when a command wrote bytes that are not text. It names
 * what happened and where the data can still be reached, because a bare "some
 * output was dropped" leaves the model guessing whether it is missing something
 * it needed.
 */
export const SHELL_BINARY_OUTPUT_NOTICE = "[the shell wrote bytes that are not text, so none of them were passed on. Read the file the command wrote if you need that data.]";

/**
 * What the model is told when a channel hit `MAX_BUFFER_SIZE`.
 *
 * The honest report names the limit, the amount kept, and where the rest went:
 * `shell-core` discards the overflow, and no spill file is produced for it, so
 * saying "truncated" without saying that would promise a recovery that does not
 * exist.
 */
export function shellOutputTruncatedNotice(channel: "stdout" | "stderr", keptBytes: number, limitBytes: number): string {
  return `[this host keeps at most ${limitBytes} bytes of ${channel} per command and this command wrote more, so only the first ${keptBytes} bytes are in this result. Everything past that point was discarded and no output file was written, so the rest cannot be recovered from here. Re-run the command with its output redirected to a file if you need all of it.]`;
}

/**
 * The control bytes a chunk of terminal text may carry. TAB, LF and CR are
 * layout. BEL and BS ring and move a cursor, and a progress bar that rings is
 * still text, so they are admitted here and removed by `toModelSafeShellText`
 * instead of costing the whole chunk. ESC introduces a terminal sequence and is
 * removed there too. Every other byte below 0x20, plus DEL, is a byte text
 * output has no use for, and each one is a way to put a character into a tool
 * result that the model cannot see and cannot reason about.
 */
function isForbiddenTextControlByte(byte: number): boolean {
  if (byte === 0x07 || byte === 0x08 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x1b) return false;
  return byte < 0x20 || byte === 0x7f;
}

function hasUtf8Continuation(data: Buffer, start: number, count: number): boolean {
  for (let index = start; index < start + count; index += 1) {
    const byte = data[index];
    if (byte === undefined || byte < 0x80 || byte > 0xbf) return false;
  }
  return true;
}

/**
 * Length of the well-formed UTF-8 sequence at `index`, or 0 when there is none.
 * Overlong encodings, surrogate halves and anything past U+10FFFF are refused:
 * those are exactly the bytes a decoder turns into U+FFFD, and a U+FFFD inside
 * a tool result is a character neither the model nor the human can read.
 */
function wellFormedUtf8SequenceLength(data: Buffer, index: number): number {
  const first = data[index]!;
  if (first >= 0xc2 && first <= 0xdf) return hasUtf8Continuation(data, index + 1, 1) ? 2 : 0;
  if (first >= 0xe0 && first <= 0xef) {
    if (!hasUtf8Continuation(data, index + 1, 2)) return 0;
    const second = data[index + 1]!;
    if (first === 0xe0 && second < 0xa0) return 0;
    if (first === 0xed && second >= 0xa0) return 0;
    return 3;
  }
  if (first >= 0xf0 && first <= 0xf4) {
    if (!hasUtf8Continuation(data, index + 1, 3)) return 0;
    const second = data[index + 1]!;
    if (first === 0xf0 && second < 0x90) return 0;
    if (first === 0xf4 && second >= 0x90) return 0;
    return 4;
  }
  return 0;
}

/**
 * Length of the tail at `index` when the buffer simply stopped in the middle of
 * a UTF-8 sequence, else 0.
 *
 * A terminal hands over whatever bytes arrived, so it splits a three-byte
 * character across two `data` events as a matter of course. Reading that as
 * corruption would throw away half of every non-Latin line the agent runs, and
 * would put a U+FFFD in the model's text for a character that was never broken.
 */
function truncatedUtf8SequenceLength(data: Buffer, index: number): number {
  const first = data[index]!;
  const total = first >= 0xf0 && first <= 0xf4 ? 4 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xc2 && first <= 0xdf ? 2 : 0;
  const available = data.length - index;
  if (total === 0 || available >= total) return 0;
  for (let at = index + 1; at < data.length; at += 1) { const byte = data[at]!; if (byte < 0x80 || byte > 0xbf) return 0; }
  return available;
}

export interface ShellChunkScan {
  /** Bytes `[0, textEnd)` decode to text; everything after them does not. */
  readonly textEnd: number;
  /** True when the chunk is not text at all, as opposed to ending mid-character. */
  readonly binary: boolean;
  /** Trailing bytes of a character the next chunk continues. */
  readonly carry: Buffer | undefined;
}

/**
 * Decides from the raw bytes, before anything is decoded, what part of a chunk
 * is text.
 *
 * The order is the whole point. `Buffer.toString("utf8")` cannot report
 * anything afterwards: by the time it returns, an invalid byte has already
 * become U+FFFD and a NUL has already become a character in the string, and the
 * model reads both as something the command printed. Deciding afterwards means
 * deciding on the wreckage.
 */
export function scanShellChunk(data: Buffer): ShellChunkScan {
  let index = 0;
  while (index < data.length) {
    const byte = data[index]!;
    if (byte < 0x80) {
      if (isForbiddenTextControlByte(byte)) return { textEnd: index, binary: true, carry: undefined };
      index += 1;
      continue;
    }
    const length = wellFormedUtf8SequenceLength(data, index);
    if (length === 0) {
      const truncated = truncatedUtf8SequenceLength(data, index);
      if (truncated > 0) return { textEnd: index, binary: false, carry: data.subarray(index) };
      return { textEnd: index, binary: true, carry: undefined };
    }
    index += length;
  }
  return { textEnd: data.length, binary: false, carry: undefined };
}

/**
 * Terminal sequences, longest introducer first: OSC/DCS/SOS/PM/APC run to a
 * terminator, CSI runs to its final byte, and the two- and three-character forms
 * are the cursor and keypad saves a shell emits around a prompt.
 */
const TERMINAL_CONTROL_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_X][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[()#][0-9A-Za-z]|\x1b[=>NOM78cDEH]/g;

/**
 * Whatever the sequence pattern does not reach: a lone ESC, an ESC that a chunk
 * boundary cut in half, and the control bytes still standing once the sequences
 * are gone. `\x1b` sits inside the first range, so an ESC that survived never
 * leaves this function. TAB, LF and CR are the only survivors, which is the
 * guarantee this file makes about model-facing text.
 */
const LEFTOVER_CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g;

export function toModelSafeShellText(text: string): string {
  return text.replace(TERMINAL_CONTROL_SEQUENCE, "").replace(LEFTOVER_CONTROL_CHARACTERS, "");
}

function countLineBreaks(chunk: Buffer): number {
  let count = 0;
  for (let index = 0; index < chunk.length; index += 1) if (chunk[index] === 0x0a) count += 1;
  return count;
}

const EMPTY_CHUNK = Buffer.alloc(0);

function asBuffer(data: Buffer | string): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export type { SandboxRule } from "./sandbox-conversion.js";
export type SandboxPolicy = { perUser?: SandboxRule; perRepo?: SandboxRule; teamAdmin?: SandboxRule };
function shellSingleQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function effectiveEnv(env: NodeJS.ProcessEnv, key: string): string | undefined { return env[key] ?? process.env[key]; }
function appendRequestScopedEnvRestore(env: NodeJS.ProcessEnv): void {
  const parts = [`builtin unset ${REQUEST_SCOPED_SHELL_ENV_KEYS.join(" ")} 2>/dev/null || true`];
  for (const key of REQUEST_SCOPED_SHELL_ENV_KEYS) { const value = effectiveEnv(env, key); if (value !== undefined) parts.push(`builtin export ${key}=${shellSingleQuote(value)}`); }
  env.__CURSOR_SANDBOX_ENV_RESTORE = [process.env.__CURSOR_SANDBOX_ENV_RESTORE?.trim(), env.__CURSOR_SANDBOX_ENV_RESTORE?.trim(), parts.join("; ")].filter((part) => part !== undefined && part !== "").join("; ");
}
function appendUnique(paths: string[] | undefined, value: string): string[] { const next = paths === undefined ? [] : [...paths]; if (!next.includes(value)) next.push(value); return next; }
function parseSharedPaths(value: string | undefined): Array<{ path: string; readOnly: boolean }> {
  if (value === undefined) return [];
  try { const parsed: unknown = JSON.parse(value); if (typeof parsed !== "object" || parsed === null) return []; const result: Array<{ path: string; readOnly: boolean }> = []; for (const entry of Object.values(parsed)) if (typeof entry === "object" && entry !== null && "path" in entry && "readOnly" in entry && typeof entry.path === "string" && typeof entry.readOnly === "boolean") result.push({ path: entry.path, readOnly: entry.readOnly }); return result; } catch { return []; }
}
function agentStoreSandboxPolicyFromEnv(policy: SandboxPolicy | undefined, env: NodeJS.ProcessEnv): SandboxPolicy | undefined {
  const filesDir = effectiveEnv(env, "CURSOR_AGENT_STORE_FILES_DIR"); const shared = parseSharedPaths(effectiveEnv(env, "CURSOR_AGENT_STORE_SHARED_PATHS"));
  if (filesDir === undefined && shared.length === 0) return policy;
  const reference = policy?.perRepo ?? policy?.perUser ?? policy?.teamAdmin;
  if (reference?.type !== "workspace_readwrite" && reference?.type !== "workspace_readonly") return policy;
  const perUser = { type: reference.type, ...(policy?.perUser?.additionalReadwritePaths === undefined ? {} : { additionalReadwritePaths: [...policy.perUser.additionalReadwritePaths] }), ...(policy?.perUser?.additionalReadonlyPaths === undefined ? {} : { additionalReadonlyPaths: [...policy.perUser.additionalReadonlyPaths] }) };
  const add = (path: string, readOnly: boolean): void => { if (!readOnly && perUser.type === "workspace_readwrite") perUser.additionalReadwritePaths = appendUnique(perUser.additionalReadwritePaths, path); else perUser.additionalReadonlyPaths = appendUnique(perUser.additionalReadonlyPaths, path); };
  if (filesDir !== undefined) add(filesDir, false); for (const entry of shared) add(entry.path, entry.readOnly);
  return { ...policy, perUser };
}

export interface ShellCoreArgs {
  readonly command: string; readonly workingDirectory?: string; readonly signal?: AbortSignal; readonly conversationId?: string;
  readonly sandboxPolicy?: SandboxPolicy; readonly pipeStdin?: boolean; readonly fileOutputThresholdBytes?: number;
  readonly askpassConfig?: { helperPath: string; socketPath: string; secret: string }; readonly toolCallId?: string; readonly showElapsedTime?: boolean;
}
export type ShellCoreEvent =
  | { readonly type: "start"; readonly sandboxed: boolean }
  | { readonly type: "stdout" | "stderr"; readonly data: string }
  | { readonly type: "stdout_trimmed" | "stderr_trimmed"; readonly keptBytes: number; readonly limitBytes: number }
  | { readonly type: "stdin_ready"; readonly stdin: NodeJS.WritableStream | undefined; readonly pid: number | undefined }
  | { readonly type: "sandbox_denies"; readonly events: readonly unknown[] }
  | { readonly type: "exit"; readonly code: number | null; readonly aborted: boolean; readonly outputLocation?: OutputLocation; readonly localExecutionTimeMs: number };

export interface ShellOutputBackpressureOptions { readonly bufferOutputEvents?: boolean; readonly outputLimiterOptions?: unknown }
export class BaseShellCoreExecutor {
  constructor(private readonly executor: TerminalExecutor, private readonly workspacePath?: string, private readonly projectDir?: string, private readonly shellOutputBackpressureOptions?: ShellOutputBackpressureOptions, private readonly extraEnvProvider?: (ctx: Context, args: ShellCoreArgs) => NodeJS.ProcessEnv | undefined) {}
  async *execute(ctx: Context, args: ShellCoreArgs): AsyncIterable<ShellCoreEvent> {
    const started = performance.now(); const requested = args.workingDirectory || await this.executor.getCwd(); const cwd = this.workspacePath === undefined ? resolve(requested) : resolve(this.workspacePath, requested);
    let stdoutSize = 0, stderrSize = 0, suppressionNoticeSent = false, stdoutTrimmed = false, stderrTrimmed = false;
    let binaryNoticeSent = { stdout: false, stderr: false };
    let carry: { stdout: Buffer; stderr: Buffer } = { stdout: EMPTY_CHUNK, stderr: EMPTY_CHUNK };
    let merged: { pending: Buffer[]; lineCount: number; size: number; threshold: number; path?: string; file?: WriteStream } | undefined;
    if (args.fileOutputThresholdBytes && this.projectDir) merged = { pending: [], lineCount: 0, size: 0, threshold: Number(args.fileOutputThresholdBytes) };
    const env: NodeJS.ProcessEnv = { CURSOR_AGENT: "1" };
    if (args.conversationId) env.CURSOR_CONVERSATION_ID = getSafeConversationId(args.conversationId);
    if (this.projectDir) env.AGENT_TRANSCRIPTS = join(this.projectDir, TRANSCRIPTS_SUBDIR);
    Object.assign(env, this.extraEnvProvider?.(ctx, args)); appendRequestScopedEnvRestore(env);
    const sandboxPolicy = agentStoreSandboxPolicyFromEnv(args.sandboxPolicy, env); const policyType = sandboxPolicy?.perRepo?.type ?? sandboxPolicy?.perUser?.type ?? sandboxPolicy?.teamAdmin?.type ?? "insecure_none";
    if (sandboxPolicy !== undefined) yield { type: "start", sandboxed: policyType === "workspace_readonly" || policyType === "workspace_readwrite" };
    if (args.askpassConfig && !isWindows) { env.SUDO_ASKPASS = args.askpassConfig.helperPath; env.CURSOR_ASKPASS_SOCKET = args.askpassConfig.socketPath; env.CURSOR_ASKPASS_SECRET = args.askpassConfig.secret; }
    // The executor is handed its own controller, not `args.signal`. It answers
    // an abort with `child.kill()`, which on Windows is a TerminateProcess on
    // the shell alone: `cmd.exe` dies and the `python` it started keeps running
    // until something walks the tree. The guard walks it first, and only then
    // lets the direct kill happen, because `taskkill /T` needs the shell to
    // still be alive to walk down from.
    const guard = createShellProcessGuard(args.signal, (pid) => { killProcessTree(pid); });
    try {
    for await (const event of this.executor.execute(ctx, args.command, { ...(guard.signal === undefined ? {} : { signal: guard.signal }), workingDirectory: cwd, env, ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }), ...(this.workspacePath === undefined ? {} : { sandboxWorkspaceRoot: this.workspacePath }), pipeStdin: args.pipeStdin ?? false, ...(this.shellOutputBackpressureOptions?.bufferOutputEvents === undefined ? {} : { bufferOutputEvents: this.shellOutputBackpressureOptions.bufferOutputEvents }), ...(this.shellOutputBackpressureOptions?.outputLimiterOptions === undefined ? {} : { outputLimiterOptions: this.shellOutputBackpressureOptions.outputLimiterOptions }) })) {
      let text = "", size = 0;
      if (event.type === "stdout" || event.type === "stderr") {
        const channel = event.type;
        const raw = asBuffer(event.data);
        size = raw.length;
        const chunk = carry[channel].length === 0 ? raw : Buffer.concat([carry[channel], raw]);
        const scan = scanShellChunk(chunk);
        carry[channel] = scan.carry ?? EMPTY_CHUNK;
        // The spill keeps the command's own bytes: `outputLocation` has to keep
        // meaning "the output the command really produced", binary tail
        // included, and sanitising the file too would make a hex dump lie.
        if (merged) { merged.size += size; merged.lineCount += countLineBreaks(chunk); if (merged.size <= MAX_OUTPUT_FILE_SIZE) { if (merged.file) merged.file.write(chunk); else { merged.pending.push(chunk); if (merged.size > merged.threshold && this.projectDir) { const dir = join(this.projectDir, AGENT_TOOLS_DIR); merged.path = join(dir, `${randomUUID()}.txt`); await mkdir(dirname(merged.path), { recursive: true }); merged.file = createWriteStream(merged.path); for (const buffered of merged.pending) merged.file.write(buffered); merged.pending = []; } } } }
        // Text, or nothing at all: not a lossy copy of the bytes. One notice per
        // channel, because a command that writes binary for a minute would
        // otherwise bury the model under notices instead of output.
        if (scan.binary) { if (!binaryNoticeSent[channel]) { binaryNoticeSent[channel] = true; text = SHELL_BINARY_OUTPUT_NOTICE; } else text = ""; }
        else if (scan.textEnd > 0) text = toModelSafeShellText(chunk.toString("utf8", 0, scan.textEnd));
      }
      if (event.type === "stdout" && !stdoutTrimmed) { if (stdoutSize + size > MAX_BUFFER_SIZE) { stdoutTrimmed = true; yield { type: "stdout_trimmed", keptBytes: stdoutSize, limitBytes: MAX_BUFFER_SIZE }; } else { stdoutSize += size; if (text.length > 0) yield { type: "stdout", data: text }; } }
      else if (event.type === "suppressed_output" && !suppressionNoticeSent) { suppressionNoticeSent = true; yield { type: "stdout", data: SHELL_OUTPUT_SUPPRESSED_NOTICE }; }
      else if (event.type === "stderr" && !stderrTrimmed) { if (stderrSize + size > MAX_BUFFER_SIZE) { stderrTrimmed = true; yield { type: "stderr_trimmed", keptBytes: stderrSize, limitBytes: MAX_BUFFER_SIZE }; } else { stderrSize += size; if (text.length > 0) yield { type: "stderr", data: text }; } }
      else if (event.type === "stdin_ready") { guard.observePid(event.pid); yield { type: "stdin_ready", stdin: event.stdin, pid: event.pid }; }
      else if (event.type === "sandbox_denies") yield { type: "sandbox_denies", events: event.events };
      else if (event.type === "exit") { let outputLocation: OutputLocation | undefined; if (merged?.file && merged.path) { await new Promise<void>((done) => merged?.file?.end(done)); outputLocation = new OutputLocation({ filePath: merged.path, sizeBytes: BigInt(merged.size), lineCount: BigInt(merged.lineCount) }); } yield { type: "exit", code: event.code, aborted: event.aborted, ...(outputLocation === undefined ? {} : { outputLocation }), localExecutionTimeMs: Math.max(0, Math.round(performance.now() - started)) }; }
    }
    } finally { guard.release(); }
  }
  getCwd(): Promise<string> { return this.executor.getCwd(); }
  getWorkspacePath(): string { if (!this.workspacePath) throw new Error("Workspace path is not configured"); return this.workspacePath; }
}
