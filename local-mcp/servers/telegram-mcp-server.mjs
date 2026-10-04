/**
 * Telegram MCP server.
 *
 * Lets an agent send messages through a Telegram bot — the transport a periodic
 * news-digest agent needs. It covers the Bot API directly rather than a user
 * account: a bot needs no phone number, no session login and no risk of an
 * account being banned for automation, which is why this is the right shape for
 * a scheduled digest job.
 *
 * Credentials: `TELEGRAM_BOT_TOKEN` from the environment only. There is no token
 * in this file and none should ever be committed. If the variable is missing the
 * server exits immediately rather than starting with a broken tool.
 *
 * Configuration:
 *   { "command": "node", "args": ["...\\telegram-mcp-server.mjs"],
 *     "env": { "TELEGRAM_BOT_TOKEN": "<token from @BotFather>" } }
 *
 * `TELEGRAM_API_BASE` overrides the API host. It exists so the tool can be tested
 * against a local stub without touching the real Telegram. Point it at anything
 * other than the default only in a test.
 *
 * Sending a digest is a side effect on the user's account. This server is built
 * and proved; nothing here was sent to Telegram while testing it.
 */

import { serveStdio, textResult } from "../mcp-stdio-core.mjs";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (token === undefined || token.length === 0) {
  process.stderr.write("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and set the token.\n");
  process.exit(1);
}
const apiBase = (process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org").replace(/\/+$/, "");
const requestTimeoutMs = Number(process.env.TELEGRAM_TIMEOUT_MS ?? 30_000);

/** Calls one Bot API method. Telegram answers 200 even for logical errors, so both are checked. */
async function callApi(method, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (response.status !== 200) {
      throw new Error(`${method} failed with HTTP ${response.status}: ${parsed?.description ?? text.slice(0, 200)}`);
    }
    if (parsed?.ok !== true) {
      throw new Error(`${method} was rejected by Telegram: ${parsed?.description ?? "unknown error"}`);
    }
    return parsed.result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${method} timed out after ${requestTimeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireString(args, key, toolName) {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${toolName}: "${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

serveStdio({
  name: "telegram",
  version: "1.0.0",
  instructions: `Send and read Telegram messages as the bot configured by TELEGRAM_BOT_TOKEN. Use chat_id from get_chats, not a phone number.`,
  tools: [
    {
      name: "get_me",
      description: "Verify the bot token works. Returns the bot username. Call this first when configuration is in doubt.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "send_message",
      description: "Send a text message to a chat. This delivers a real message to the user's Telegram.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Target chat id, e.g. \"123456789\". Obtain it from get_chats." },
          text: { type: "string", description: "Message text. Telegram caps it near 4096 characters." },
          parse_mode: { type: "string", description: "Optional Markdown or HTML." },
          disable_notification: { type: "boolean", description: "Deliver silently." },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "get_chats",
      description: "List the chats the bot has seen, with their ids. Use this to discover chat_id.",
      inputSchema: { type: "object", properties: { limit: { type: "number", description: "Maximum chats to return." } } },
    },
    {
      name: "get_updates",
      description: "Read incoming messages for the bot. Long-polling aware: pass offset from the previous call to acknowledge.",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "number", description: "Update id to start from, from a previous call." },
          limit: { type: "number", description: "Maximum updates to return." },
          timeout: { type: "number", description: "Long-poll seconds, 0-50." },
        },
      },
    },
    {
      name: "edit_message",
      description: "Replace the text of a message the bot already sent.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Chat holding the message." },
          message_id: { type: "number", description: "Id of the message to edit." },
          text: { type: "string", description: "Replacement text." },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
  ],
  async onCall(toolName, args) {
    switch (toolName) {
      case "get_me": {
        const me = await callApi("getMe", {});
        return textResult(`Bot @${me.username} (${me.first_name ?? ""}) is connected.`);
      }
      case "send_message": {
        const chatId = requireString(args, "chat_id", "send_message");
        const text = requireString(args, "text", "send_message");
        const payload = { chat_id: chatId, text };
        if (typeof args.parse_mode === "string" && args.parse_mode.length > 0) payload.parse_mode = args.parse_mode;
        if (args.disable_notification === true) payload.disable_notification = true;
        const sent = await callApi("sendMessage", payload);
        return textResult(`Sent message ${sent.message_id} to chat ${chatId} at ${new Date(sent.date * 1000).toISOString()}.`);
      }
      case "get_chats": {
        const updates = await callApi("getUpdates", { limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 100 });
        const seen = new Map();
        for (const update of updates) {
          const chat = update?.message?.chat ?? update?.edited_message?.chat ?? update?.channel_post?.chat;
          if (chat?.id != null && !seen.has(chat.id)) {
            seen.set(chat.id, `${chat.id}\ttype=${chat.type}\ttitle=${chat.title ?? chat.username ?? chat.first_name ?? "(no name)"}`);
          }
        }
        if (seen.size === 0) {
          return "No chats yet. Send the bot a message in Telegram once, then call get_chats again.";
        }
        return [...seen.values()].join("\n");
      }
      case "get_updates": {
        const payload = {};
        if (Number.isFinite(Number(args.offset))) payload.offset = Number(args.offset);
        if (Number.isFinite(Number(args.limit))) payload.limit = Number(args.limit);
        if (Number.isFinite(Number(args.timeout))) payload.timeout = Math.min(50, Math.max(0, Number(args.timeout)));
        const updates = await callApi("getUpdates", payload);
        if (updates.length === 0) return "No updates.";
        return updates.map((update) => {
          const message = update?.message ?? update?.edited_message ?? update?.channel_post;
          if (message == null) return `update ${update.update_id}: (unsupported kind)`;
          const from = message.from?.username ?? message.from?.first_name ?? "unknown";
          return `update ${update.update_id} chat=${message.chat?.id} from=${from}\n${message.text ?? "(no text)"}`;
        }).join("\n\n");
      }
      case "edit_message": {
        const result = await callApi("editMessageText", {
          chat_id: requireString(args, "chat_id", "edit_message"),
          message_id: Number(args.message_id),
          text: requireString(args, "text", "edit_message"),
        });
        return textResult(result === true ? "Message edited." : `Message ${result?.message_id ?? "?"} edited.`);
      }
      default:
        throw new Error(`unhandled tool: ${toolName}`);
    }
  },
});