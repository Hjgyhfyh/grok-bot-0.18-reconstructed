#!/usr/bin/env node
/**
 * grok_bot_reply — the one tool a coding agent gets to write back to Grok Bot.
 *
 * Design constraints, each one deliberate:
 *   - stdio only. This process binds no socket, reads no token and exposes no host command.
 *     An agent with a Shell tool could read a shared gateway token from `gateway.json` and
 *     drive ~124 host commands with it; launching this server gives it no such power.
 *   - one tool, one direction. There is nothing to configure and nothing to authenticate.
 *   - durable spool, not a queue. Every accepted message becomes one JSON file under
 *     `<sandRoot>/external-inbox/<chat>/<messageId>.json`. Nothing here deletes spool
 *     entries except its own stale temp files: delivery is somebody else's job, and this
 *     server's whole contract is "accepted" or "rejected, and here is why".
 *   - a receipt, never a bare string. Every call answers with `accepted | duplicate |
 *     conflict | rejected` plus the messageId, because a silent string is how the existing
 *     agent-to-agent path loses messages.
 *
 * CONTAINMENT IS PROVED, NOT ASSERTED. `resolveGrokBotMessagePath` ends in a `startsWith`
 * over a logical path, and a logical path cannot see a junction: `mkdir(recursive)`
 * succeeds silently on an existing junction, so a link planted at `external-inbox` or at
 * `<chat>` sends the write anywhere on the disk while the receipt still names a logical file
 * that is not there. After `mkdir` this server proves containment against the filesystem —
 * one `lstat` per segment below the Sand root, then a `realpath` of the chat directory
 * re-checked against the resolved inbox. For an agent that already has a Shell tool this is
 * not privilege escalation; the point is the NEXT reader. The future drainer runs as the host
 * process with the user's own privileges and must both READ and DELETE these files, so a
 * planted junction turns the deliverer into an arbitrary-path operation on the host.
 *
 * IDEMPOTENCY IS KEYED ON CONTENT. A `message_id` names one message, not one slot: storing
 * `result / needs_reply: false` and then reporting `question / needs_reply: true` under the
 * same id would leave the human asleep while the receipt says they were woken. So the file
 * is created with `O_EXCL` and the stored envelope is read back; the receipt always describes
 * what is ON DISK, and a different body under a taken id is a `conflict`, not a `duplicate`.
 *
 * `open(target, "wx")` is the guard, not `rename`. Node's `fs.rename` on Windows is
 * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, so it replaces an existing file silently; a
 * same-id race between two processes used to produce two `accepted` receipts and one
 * surviving file. `O_EXCL` makes exactly one create win. The body is staged in a temp file
 * in the same directory and hard-linked into place so a reader sees a complete message, and
 * the temp file is removed; on a filesystem without hard links the create falls back to
 * `open(target, "wx")` plus the write, which keeps the exclusivity and gives up only the
 * "never a partial file" property of the link path.
 *
 * JSON-RPC conventions mirror `source/node-agent-coordinator/routed-mcp-bridge.ts:46-79` so the
 * two MCP servers in this repo behave the same way. That file is HTTP, so the mapping is:
 *   - notification (no `id`)  -> 202 Accepted, no body        -> here: no response is written.
 *   - unknown method          -> `result: {}` (line 79)       -> here: `result: {}`.
 *   - bad JSON body           -> 400, no body                  -> here: JSON-RPC -32700.
 *   - body over 1 MiB         -> 413, no body                  -> here: -32700 plus a stderr
 *                                                                    note, then the next line
 *                                                                    is parsed normally.
 *   - unknown tool name       -> isError result (line 75)      -> here: the same shape.
 */

import { link, lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_REQUEST_CANCELLED = -32800;
/** Only a temp file this server writes itself: `<uuid>.json.<pid>.<hex>.tmp`. */
const TEMP_NAME_PATTERN = /\.json\.\d+\.[0-9a-f]+\.tmp$/;
/** Filesystems without hard links: OneDrive placeholders, some removable media, old SMB. */
const LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EXDEV", "EACCES", "EOPNOTSUPP"]);

/**
 * Load the shared wire contract. It is a `.ts` file with no sibling imports, so Node's own
 * type stripping resolves it without a build step. A Node too old for that fails loudly here
 * instead of surfacing as a confusing tool error later in the run.
 */
async function loadEnvelope() {
  try {
    return await import("../../source/shared/grokbot-message-envelope.ts");
  } catch (error) {
    process.stderr.write(
      `grok-bot-reply: cannot load ../../source/shared/grokbot-message-envelope.ts (${error?.message ?? error}). `
      + "This server needs Node 22.6+ (23.6+ recommended) for TypeScript type stripping.\n",
    );
    process.exit(1);
  }
}

const envelope = await loadEnvelope();

/**
 * A stdio child dies with exit 1 on an unhandled `'error'` from `process.stdout` as soon as
 * the parent closes the pipe, which is the normal way an MCP client shuts a server down. A
 * closed parent is not a failure, so it exits 0 and quietly; anything else is still fatal.
 */
function installStreamGuards() {
  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", () => {});
  process.stdin.on("error", () => {});
}

function handleStreamError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END") process.exit(0);
  try {
    process.stderr.write(`grok-bot-reply: ${describeError(error)}\n`);
  } catch {
    // stderr is gone too; there is nowhere left to report to.
  }
  process.exit(1);
}

/** One resolved call: either a receipt or an error result, never a bare string. */
function receiptResult(receipt) {
  const summary = `${receipt.status}: ${receipt.summary}`;
  return {
    isError: envelope.GROKBOT_REPLY_ERROR_STATUSES.has(receipt.status),
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(receipt, null, 2)}` }],
    structuredContent: receipt,
  };
}

function toolNotFoundResult(name) {
  return { isError: true, content: [{ type: "text", text: `Unknown Grok Bot MCP tool: ${String(name)}` }] };
}

function describeTool() {
  return {
    name: envelope.GROKBOT_REPLY_TOOL_NAME,
    description: envelope.GROKBOT_REPLY_TOOL_DESCRIPTION,
    inputSchema: envelope.GROKBOT_REPLY_TOOL_INPUT_SCHEMA,
    annotations: {
      // It writes one file outside the workspace, so it is neither read-only nor idempotent
      // by side effect alone — the id plus the content hash is what makes a retry safe.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

/** Detail text for a segment that is a reparse point, or null when the segment is clean. */
function linkRefusal(sandRootDir, segment) {
  return `${segment} is a symbolic link or a Windows junction. mkdir succeeds silently on one, so a write through it would land outside the Sand root ${sandRootDir} while the receipt still named a file that is not there. Nothing was stored.`;
}

/**
 * Refuse a planted link BEFORE `mkdir`, because `mkdir(…, {recursive:true})` follows one
 * silently and would create the chat directory on the other side of it.
 */
async function refuseLinkBeforeMkdir(sandRootDir, segment) {
  const stat = await lstatOrNull(segment);
  if (stat == null) return null;
  if (stat.isSymbolicLink()) return linkRefusal(sandRootDir, segment);
  return null;
}

/**
 * Prove that `<sandRoot>/external-inbox/<chat>` really is inside the Sand root, after mkdir.
 *
 * Both checks are kept because they fail differently:
 *   - the per-segment `lstat` NAMES the planted link, and refuses a reparse point even when its
 *     target happens to stay inside, which a containment check alone would wave through;
 *   - the `realpath` comparison is the proof, because it resolves EVERY ancestor and so also
 *     catches a link created between the `lstat` and the write.
 *
 * The Sand root itself may legitimately be a link the launcher chose, so it is not inspected:
 * both sides of the comparison are resolved through it and stay consistent.
 */
async function proveSpoolContainment(sandRootDir, inbox, chatDir) {
  for (const segment of [inbox, chatDir]) {
    const stat = await lstatOrNull(segment);
    if (stat == null) return { ok: false, detail: `${segment} is missing right after the spool directory was created` };
    if (stat.isSymbolicLink()) return { ok: false, detail: linkRefusal(sandRootDir, segment) };
    if (!stat.isDirectory()) {
      return { ok: false, detail: `${segment} exists and is not a directory. Nothing was stored.` };
    }
  }
  let realInbox;
  let realChatDir;
  try {
    [realInbox, realChatDir] = await Promise.all([realpath(inbox), realpath(chatDir)]);
  } catch (error) {
    return { ok: false, detail: `the spool directory could not be resolved to a real path (${describeError(error)}). Nothing was stored.` };
  }
  const prefix = realInbox.endsWith(sep) ? realInbox : `${realInbox}${sep}`;
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const actual = caseInsensitive ? realChatDir.slice(0, prefix.length).toLowerCase() : realChatDir.slice(0, prefix.length);
  const expected = caseInsensitive ? prefix.toLowerCase() : prefix;
  if (actual !== expected) {
    return {
      ok: false,
      detail: `${chatDir} resolves to ${realChatDir}, which is outside ${realInbox}. Nothing was stored.`,
    };
  }
  return { ok: true, detail: "" };
}

/**
 * Count everything in one chat directory, after removing temp files this server orphaned.
 *
 * EVERY entry counts. Counting only regular `.json` files let 600 directories named
 * `0000.json` plus 600 symlinks pass as an empty spool, which is not a cap at all: the
 * drainer still has to walk them.
 */
async function inspectChatDir(chatDir) {
  await removeStaleTempFiles(chatDir);
  try {
    const entries = await readdir(chatDir, { withFileTypes: true });
    return entries.length;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return 0;
    throw error;
  }
}

/**
 * Drop temp files left behind by a crash. Only this server's own naming pattern qualifies,
 * only past `GROKBOT_REPLY_TMP_MAX_AGE_MS`, and only that many per call, so a live writer's
 * file is never touched and cleanup can never become the work of a reply.
 */
async function removeStaleTempFiles(chatDir) {
  let entries;
  try {
    entries = await readdir(chatDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (removed >= envelope.GROKBOT_REPLY_TMP_CLEANUP_MAX) break;
    if (!entry.isFile() || !TEMP_NAME_PATTERN.test(entry.name)) continue;
    const full = join(chatDir, entry.name);
    const stat = await lstatOrNull(full);
    if (stat == null || !stat.isFile()) continue;
    if (now - stat.mtimeMs < envelope.GROKBOT_REPLY_TMP_MAX_AGE_MS) continue;
    try {
      await rm(full, { force: true });
      removed += 1;
    } catch {
      // Another process got there first, or the file is locked. Not a reason to fail a call.
    }
  }
  return removed;
}

/** Count chat directories under the inbox. The per-chat cap alone bounds nothing across chats. */
async function countInboxEntries(inbox) {
  try {
    const entries = await readdir(inbox, { withFileTypes: true });
    return entries.length;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return 0;
    throw error;
  }
}

/**
 * Read the stored envelope back. Returns null for anything this module cannot parse, and
 * reports the id as taken by bytes it cannot describe rather than inventing values for them.
 */
async function readStoredEnvelope(path, stat) {
  // A real envelope is at most a few tens of kilobytes. Anything larger is not a message this
  // server wrote, and reading it would turn a receipt into a memory spike.
  if (stat != null && stat.size > envelope.GROKBOT_REPLY_MAX_ENVELOPE_BYTES) return null;
  let raw = await readFile(path, "utf8").catch(() => null);
  let parsed = raw == null ? null : envelope.parseStoredGrokBotEnvelope(raw);
  if (parsed == null && stat?.size === 0) {
    // On the no-hard-link fallback the winner has created the file and may not have written it
    // yet. One short retry turns that race into the real answer instead of a false "corrupt".
    await new Promise(resolve => setTimeout(resolve, 25));
    raw = await readFile(path, "utf8").catch(() => null);
    parsed = raw == null ? null : envelope.parseStoredGrokBotEnvelope(raw);
  }
  return parsed;
}

function rejectedReceipt(input, reason, detail) {
  return {
    status: "rejected",
    messageId: input.messageId,
    chat: input.chat,
    reason,
    detail,
    summary: `nothing was stored — ${reason}: ${detail}`,
  };
}

/**
 * The id is taken by a regular file. Report what is ON DISK, and only call it a `duplicate`
 * when the stored message is the same message.
 */
async function describeStoredMessage(input, target, receivedAt, stat) {
  const stored = await readStoredEnvelope(target, stat);
  if (stored == null) {
    return {
      status: "duplicate",
      messageId: input.messageId,
      chat: input.chat,
      kind: null,
      needsReply: null,
      textBytes: null,
      spoolPath: target,
      receivedAt,
      firstAcceptedAt: null,
      storedReadable: false,
      matchesInput: false,
      summary: `message_id ${input.messageId} is already taken by ${stat?.size ?? 0} bytes at ${target} that are not a readable envelope, so nothing was stored and this receipt cannot describe what is there. Remove that file to reuse the id.`,
    };
  }
  const requestedHash = envelope.replyContentHash(input.kind, input.needsReply, input.text);
  const firstAcceptedAt = stored.receivedAt;
  const sameContent = stored.contentHash === requestedHash;
  if (sameContent) {
    return {
      status: "duplicate",
      messageId: input.messageId,
      chat: input.chat,
      kind: stored.kind,
      needsReply: stored.needsReply,
      textBytes: stored.textBytes,
      spoolPath: target,
      receivedAt,
      firstAcceptedAt,
      storedReadable: true,
      matchesInput: true,
      summary: `message_id ${input.messageId} already holds this exact message${firstAcceptedAt == null ? "" : ` from ${firstAcceptedAt}`}, so it stays stored once and nothing new was written`,
    };
  }
  return {
    status: "conflict",
    messageId: input.messageId,
    chat: input.chat,
    storedKind: stored.kind,
    storedNeedsReply: stored.needsReply,
    storedTextBytes: stored.textBytes,
    requestedKind: input.kind,
    requestedNeedsReply: input.needsReply,
    spoolPath: target,
    firstAcceptedAt,
    summary: `nothing was stored: message_id ${input.messageId} is already held by kind "${stored.kind}" with needs_reply ${stored.needsReply}${firstAcceptedAt == null ? "" : ` (from ${firstAcceptedAt})`}, and this call asked for kind "${input.kind}" with needs_reply ${input.needsReply}. Send the new message without a message_id so it gets a fresh id, or send exactly the stored message again.`,
  };
}

/**
 * Store one validated message. Every failure path returns a `rejected` receipt; nothing throws
 * past the JSON-RPC layer, so a broken spool can never turn into a lost message with no trace.
 */
async function spoolMessage(input, context, isCancelled) {
  const target = envelope.resolveGrokBotMessagePath({
    sandRootDir: context.sandRootDir,
    chat: input.chat,
    messageId: input.messageId,
  });
  const chatDir = dirname(target);
  const inbox = envelope.getGrokBotInboxDir(context.sandRootDir);
  const receivedAt = new Date().toISOString();
  const envelopeBody = envelope.buildGrokBotMessageEnvelope(input, receivedAt);
  const serialized = `${JSON.stringify(envelopeBody, null, 2)}\n`;

  const chatExisted = await lstatOrNull(chatDir);
  // Refuse a planted link before `mkdir`, not after: mkdir would follow it and create the chat
  // directory on the far side, which is a write outside the Sand root even without a message.
  for (const segment of [inbox, chatDir]) {
    const refusal = await refuseLinkBeforeMkdir(context.sandRootDir, segment);
    if (refusal != null) return rejectedReceipt(input, "unsafe_spool_path", refusal);
  }
  try {
    await mkdir(chatDir, { recursive: true });
  } catch (error) {
    return rejectedReceipt(
      input,
      "spool_unavailable",
      `Could not create the spool directory ${chatDir}: ${describeError(error)}. Nothing was stored.`,
    );
  }

  const containment = await proveSpoolContainment(context.sandRootDir, inbox, chatDir);
  if (!containment.ok) {
    return rejectedReceipt(input, "unsafe_spool_path", containment.detail);
  }

  if (chatExisted == null && (await countInboxEntries(inbox)) >= envelope.GROKBOT_REPLY_MAX_CHATS) {
    return rejectedReceipt(
      input,
      "too_many_chats",
      `The inbox ${inbox} already holds ${envelope.GROKBOT_REPLY_MAX_CHATS} chat directories, so a new thread was refused. Send to an existing thread or drain the spool first. Nothing was stored.`,
    );
  }

  if ((await inspectChatDir(chatDir)) >= envelope.GROKBOT_REPLY_MAX_FILES_PER_CHAT) {
    return rejectedReceipt(
      input,
      "spool_full",
      `The spool for chat "${input.chat}" already holds ${envelope.GROKBOT_REPLY_MAX_FILES_PER_CHAT} undelivered messages. Drain it before sending more.`,
    );
  }

  const existing = await lstatOrNull(target);
  if (existing != null) {
    // Only a REGULAR FILE is a delivered message. A directory or a link at the target used to
    // answer `duplicate`, which shadowed the id forever with no message anywhere on disk.
    if (!existing.isFile()) {
      return rejectedReceipt(
        input,
        "target_not_a_file",
        `${target} exists and is not a regular file${existing.isSymbolicLink() ? " (it is a symbolic link or a junction)" : existing.isDirectory() ? " (it is a directory)" : ""}. Nothing was stored, and this id is NOT taken: remove that entry to reuse it.`,
      );
    }
    return describeStoredMessage(input, target, receivedAt, existing);
  }

  if (isCancelled()) {
    // The queue already answered -32800 for a cancellation seen before the call started. This
    // catches one that landed while the spool directory was being prepared.
    return rejectedReceipt(input, "cancelled", "the request was cancelled before the message file was created. Nothing was stored.");
  }

  let created;
  try {
    created = await createMessageFile(target, serialized);
  } catch (error) {
    return rejectedReceipt(input, "write_failed", `Could not write ${target}: ${describeError(error)}. Nothing was stored.`);
  }
  if (!created) {
    // Another process won the exclusive create. Describe the spool as it is now.
    const winner = await lstatOrNull(target);
    if (winner == null) return rejectedReceipt(input, "write_failed", `Could not write ${target}: the file disappeared during the create. Nothing was stored.`);
    if (!winner.isFile()) {
      return rejectedReceipt(input, "target_not_a_file", `${target} exists and is not a regular file. Nothing was stored.`);
    }
    return describeStoredMessage(input, target, receivedAt, winner);
  }

  return {
    status: "accepted",
    messageId: input.messageId,
    chat: input.chat,
    kind: input.kind,
    needsReply: input.needsReply,
    textBytes: envelopeBody.textBytes,
    source: envelopeBody.source,
    authorKind: envelopeBody.authorKind,
    spoolPath: target,
    receivedAt,
    summary: needsReplySummary(input, `stored at ${target}`),
  };
}

/**
 * Create the spool file so that exactly one caller wins.
 *
 * The body is written to a unique temp file in the same directory and then hard-linked into
 * place: `link` fails with EEXIST when the name is taken and, unlike `rename`, it never
 * replaces anything. A reader therefore sees either no file or a complete one, and two
 * processes issuing the same id cannot both report `accepted`. On a filesystem with no hard
 * links the fallback creates the final name with `open(target, "wx")` — still exclusive, so
 * the race stays closed, and only the "never a partial file" property of the link path is lost.
 */
async function createMessageFile(target, serialized) {
  const tempPath = `${target}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, target);
    await rm(tempPath, { force: true });
    return true;
  } catch (error) {
    await rm(tempPath, { force: true });
    if (error?.code === "EEXIST") return false;
    if (!LINK_UNSUPPORTED_CODES.has(error?.code)) throw error;
    process.stderr.write(`grok-bot-reply: hard links unavailable here (${describeError(error)}); falling back to an exclusive create\n`);
  }
  let exclusive;
  try {
    exclusive = await open(target, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    await exclusive.writeFile(serialized, "utf8");
    await exclusive.sync();
  } finally {
    await exclusive.close();
  }
  return true;
}

function needsReplySummary(input, stored) {
  return input.needsReply
    ? `${input.chat} was told: you are blocked and need an answer (${stored})`
    : `${input.chat} was told the outcome, and nobody is expected to answer (${stored})`;
}

function describeError(error) {
  if (error == null) return "unknown error";
  const code = typeof error.code === "string" ? ` ${error.code}` : "";
  return `${error.message ?? String(error)}${code}`.trim();
}

/** Validate, then spool. Validation completes before any filesystem call. */
async function callReplyTool(args, context, isCancelled) {
  const validation = envelope.validateGrokBotReplyInput(
    {
      chat: args?.chat,
      kind: args?.kind,
      text: args?.text,
      needs_reply: args?.needs_reply,
      message_id: args?.message_id,
    },
    { forcedChat: context.forcedChat },
  );
  if (!validation.ok) {
    return receiptResult({
      status: "rejected",
      messageId: validation.messageId,
      chat: validation.chat,
      reason: validation.reason,
      detail: validation.detail,
      summary: `nothing was stored — ${validation.reason}: ${validation.detail}`,
    });
  }
  return receiptResult(await spoolMessage(validation.input, context, isCancelled));
}

function handleMethod(message, context, isCancelled) {
  const params = message.params != null && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {};
  if (message.method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    return {
      protocolVersion: requested != null && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: envelope.GROKBOT_REPLY_SERVER_NAME, version: envelope.GROKBOT_REPLY_SERVER_VERSION },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: [describeTool()] };
  if (message.method === "tools/call") {
    const name = params.name;
    if (name !== envelope.GROKBOT_REPLY_TOOL_NAME) return toolNotFoundResult(name);
    return callReplyTool(params.arguments ?? {}, context, isCancelled);
  }
  // Line 79 of the routed bridge: an unhandled method still answers with an empty result.
  return {};
}

function write(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    handleStreamError(error);
  }
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

async function main() {
  installStreamGuards();
  const argv = process.argv.slice(2);
  const sandRootDir = envelope.resolveSandRootDir({ argv, env: process.env, cwd: process.cwd() });
  let forcedChat = null;
  try {
    forcedChat = envelope.resolveForcedChat({ argv, env: process.env });
  } catch (error) {
    // Fail closed and loudly: a launcher typo must not silently widen the server to every
    // thread, and a dead server is a visible mistake rather than a message in the wrong place.
    process.stderr.write(`grok-bot-reply: ${error?.message ?? error}\n`);
    process.exit(1);
  }
  const context = { sandRootDir, forcedChat };
  process.stderr.write(
    `grok-bot-reply: spool root ${envelope.getGrokBotInboxDir(sandRootDir)}`
    + `${forcedChat == null ? "" : ` pinned to chat "${forcedChat}"`}\n`,
  );

  // `process.stdin` is already a stream here; it is a pipe when a client spawns this server.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Serialize calls: two concurrent writes to one chat directory must not race on the count.
  let queue = Promise.resolve();
  /** Requests the client cancelled. Keyed by id, because `1` and `"1"` are different ids. */
  const cancelled = new Set();

  for await (const rawLine of lines) {
    // A UTF-8 BOM is not valid JSON and PowerShell 5.1 puts one at the head of piped stdin,
    // so a hand-written check from the README would otherwise fail on its first request.
    const line = rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > envelope.GROKBOT_REPLY_MAX_REQUEST_BYTES) {
      process.stderr.write(`grok-bot-reply: dropped an oversized request line over ${envelope.GROKBOT_REPLY_MAX_REQUEST_BYTES} bytes\n`);
      write({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_PARSE_ERROR, message: "Request line is too large" } });
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" } });
      continue;
    }
    if (message == null || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
      write({ jsonrpc: "2.0", id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request" } });
      continue;
    }
    if (message.method === "notifications/cancelled") {
      // Recorded here, before the queued call starts, so a cancel sent immediately after a
      // call is honoured instead of racing the write it was meant to stop. The response is a
      // -32800 error rather than silence, so a client waiting on the id is not left hanging.
      const cancelKey = readCancelledRequestKey(message);
      if (cancelKey != null) cancelled.add(cancelKey);
      continue;
    }
    // A notification carries no id, so it gets no body — the 202 of the routed bridge.
    if (!("id" in message)) continue;
    // `id: null` is a legal JSON-RPC 2.0 request id and the client waits for its answer, so it
    // is answered. Only a line with no `id` at all is a notification.
    const id = message.id;
    const key = requestKey(id);
    const isCancelled = () => cancelled.has(key);
    queue = queue.then(async () => {
      try {
        // Yield one turn first, so a cancellation that arrived in the same read burst as this
        // call is recorded before anything touches the filesystem.
        await new Promise(resolve => setImmediate(resolve));
        if (isCancelled()) {
          write({ jsonrpc: "2.0", id, error: { code: JSON_RPC_REQUEST_CANCELLED, message: "Request cancelled" } });
          return;
        }
        write({ jsonrpc: "2.0", id, result: await handleMethod(message, context, isCancelled) });
      } catch (error) {
        write({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: describeError(error) }] } });
      } finally {
        // The flag lives exactly as long as the request it belongs to, so a long-lived server
        // cannot accumulate one entry per cancelled call.
        cancelled.delete(key);
      }
    });
  }
  await queue;
}

/**
 * Read the `params.requestId` of a cancellation. The value keeps its JSON type so that a
 * request with id `1` is matched by a cancellation of `1` and not by one of `"1"`.
 */
function readCancelledRequestKey(message) {
  const params = message.params;
  if (params == null || typeof params !== "object" || Array.isArray(params)) return null;
  const value = params["requestId"];
  if (typeof value !== "string" && typeof value !== "number") return null;
  return requestKey(value);
}

await main();