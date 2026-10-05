import { spawn } from "node:child_process";

import { WINDOWS_COMMAND_INTERPRETER_FALLBACK, readEnvName } from "../packages/shell-exec/shell-env.js";

/**
 * Turns one child process's bytes into text the model and the user can read.
 *
 * WHAT THIS IS FOR. `cmd.exe` writes its output in the console's OEM code page —
 * CP866 on a Russian Windows — and the daemon used to read those bytes with
 * `String(chunk)`, which is `Buffer.toString("utf8")`. Every byte of a Russian
 * system message is a byte UTF-8 does not define, so each one arrived as U+FFFD.
 * Measured on the transcript journal of one user session: 35 of 154 shell results
 * carried replacement characters, 195 168 of them in total, including every
 * `dir` listing, every "не является внутренней или внешней командой" and every
 * "Не удается найти указанный файл". The agent reads that as the machine
 * refusing it, and says so to the user.
 *
 * WHY NOT SIMPLY `chcp 65001` FIRST. Measured: it changes nothing here. The
 * child's stdout is a pipe, not a console, so `chcp` retargets a console that does
 * not exist and cmd keeps writing CP866. A second reason is that it would not
 * help anyway: a child program such as Python writes its own ANSI code page
 * (CP1251 on the same machine, measured), so one command can produce two
 * different legacy encodings at once.
 *
 * SO THE BYTES DECIDE, PER STREAM. A stream is decoded as strict UTF-8 while the
 * bytes say UTF-8, which leaves PowerShell, git and anything already set to UTF-8
 * byte-for-byte unchanged. The first chunk that is not valid UTF-8 decides that
 * the stream is legacy, and from then on it is decoded with the box's own code
 * page — never with a replacement character.
 */
export interface ShellOutputDecoder {
  /** Decodes one chunk and returns the text that is complete; holds back a split character. */
  push(chunk: Buffer | Uint8Array | string): string;
  /** Decodes whatever `push` held back, at end of stream. */
  flush(): string;
}

const EMPTY = Buffer.alloc(0);

/** A code page number as a `TextDecoder` label, or `undefined` when Node cannot decode it. */
export function codePageLabel(codePage: number): string | undefined {
  const label = codePage === 65001 ? "utf-8" : `cp${codePage}`;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return undefined;
  }
}

/**
 * How many bytes at the end of `bytes` are the start of a UTF-8 character the
 * next chunk will finish, or 0.
 *
 * Only meaningful for a stream already known to be UTF-8: in a legacy code page
 * every byte above 0x7F is a whole character, and holding one back would move a
 * letter to the end of the output. `push` therefore never asks this question
 * about a legacy stream.
 */
function truncatedUtf8TailLength(bytes: Buffer): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const lead = bytes[bytes.length - back]!;
    const total = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 0;
    if (total === 0) return 0;
    if (total < back) return 0;
    for (let index = bytes.length - back + 1; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      if (byte < 0x80 || byte > 0xbf) return 0;
    }
    return back;
  }
  return 0;
}

/**
 * A decoder for one stream. One instance per channel per command: the UTF-8
 * decision is remembered, because it is a property of the stream and not of a
 * chunk.
 *
 * `consoleCodePageLabel` is the box's own code page. When it is missing the
 * decoder falls back to the old behaviour, so a box where the probe failed is no
 * worse off than it was.
 */
export function createShellOutputDecoder(consoleCodePageLabel: string | undefined): ShellOutputDecoder {
  const strict = new TextDecoder("utf-8", { fatal: true });
  let legacy: TextDecoder | undefined;
  if (consoleCodePageLabel !== undefined) {
    try {
      legacy = new TextDecoder(consoleCodePageLabel);
    } catch {
      legacy = undefined;
    }
  }
  let carry = EMPTY;
  /**
   * How this stream's bytes are to be read. It starts undecided and is settled by
   * the bytes, never by the platform.
   */
  let mode: "undecided" | "utf8" | "legacy" = "undecided";
  /**
   * Consecutive chunks held back for want of a decision. Two is enough: a UTF-8
   * stream that is still undecided after two chunks is not one that is merely
   * split, and holding longer would stall output from a legacy stream forever.
   */
  let holds = 0;
  const decodeLegacy = (bytes: Buffer): string => legacy?.decode(bytes) ?? bytes.toString("utf8");

  return {
    push(chunk) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (bytes.length === 0) return "";
      const joined = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
      carry = EMPTY;
      if (!joined.some(byte => byte >= 0x80)) return joined.toString("latin1");
      try {
        const text = strict.decode(joined);
        // Only a decode that actually succeeded may settle the stream. Setting the
        // mode before the call made every legacy stream look like a UTF-8 stream
        // that ended mid-character, which held a CP866 letter's bytes back and lost
        // them.
        mode = "utf8";
        holds = 0;
        return text;
      } catch {
        // A character the operating system split is not a broken stream, so the
        // trailing bytes are held for one more chunk before any verdict is reached
        // about the encoding. Two chunks of holding is the ceiling, and it is what
        // keeps this from stalling a legacy stream that happens to end its chunks
        // on a byte that looks like the start of a UTF-8 character.
        const tail = mode === "legacy" ? 0 : truncatedUtf8TailLength(joined);
        if (tail === 0) {
          mode = "legacy";
          holds = 0;
          return decodeLegacy(joined);
        }
        holds += 1;
        if (holds >= 2) {
          mode = "legacy";
          holds = 0;
          return decodeLegacy(joined);
        }
        carry = Buffer.from(joined.subarray(joined.length - tail));
        return decodeLegacy(joined.subarray(0, joined.length - tail));
      }
    },
    flush() {
      const rest = carry;
      carry = EMPTY;
      if (rest.length === 0) return "";
      // A held tail is by definition a character with no second half. UTF-8 spells
      // that U+FFFD; a code page has no half character to spell.
      return mode === "utf8" ? new TextDecoder("utf-8").decode(rest) : decodeLegacy(rest);
    },
  };
}

/**
 * Asks this box which code page its command interpreter writes in.
 *
 * `chcp` is a command interpreter built-in, so it exists wherever the interpreter
 * the daemon is about to spawn exists, and it prints the number in ASCII, which
 * survives whatever code page it is printed in. The probe is bounded and its
 * failure is not an error: a box that cannot answer keeps the previous
 * behaviour.
 */
export async function resolveConsoleCodePageLabel(environment: NodeJS.ProcessEnv = process.env, deadlineMs = 5_000): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const interpreter = readEnvName(environment, "ComSpec")?.trim() || WINDOWS_COMMAND_INTERPRETER_FALLBACK;
  const text = await new Promise<string>((resolve) => {
    let collected = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(collected);
    };
    let child;
    try {
      child = spawn(interpreter, ["/c", "chcp"], {
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish();
    }, deadlineMs);
    child.stdout?.on("data", data => { collected += String(data); });
    child.once("error", finish);
    child.once("close", finish);
  });
  const match = /:\s*(\d{3,5})/.exec(text);
  if (match == null) return undefined;
  return codePageLabel(Number(match[1]));
}