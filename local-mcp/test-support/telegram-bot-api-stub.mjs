/**
 * Local stub of the Telegram Bot API, used only to test
 * `servers/telegram-mcp-server.mjs` without contacting Telegram.
 *
 * It implements just the four methods the server calls and answers with the
 * `{ ok: true, result }` envelope, or `{ ok: false, description }` for the
 * deliberately invalid token, so both the success and the error branch of
 * `callApi` are exercised.
 *
 * Run standalone:  node local-mcp/test-support/telegram-bot-api-stub.mjs <port>
 */

import { createServer } from "node:http";

const VALID_TOKEN = "000000000:TESTTOKEN-not-a-real-credential";

export function createTelegramStub(port) {
  const sent = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").split("/").pop();
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const token = (request.url ?? "").split("/")[1] ?? "";
      const reply = (payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      };
      if (token !== `bot${VALID_TOKEN}`) {
        reply({ ok: false, error_code: 401, description: "Unauthorized" });
        return;
      }
      switch (method) {
        case "getMe":
          reply({ ok: true, result: { id: 1, username: "stub_bot", first_name: "Stub" } });
          return;
        case "sendMessage":
          sent.push({ ...body, message_id: sent.length + 1 });
          reply({ ok: true, result: { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id }, text: body.text } });
          return;
        case "getUpdates":
          reply({
            ok: true,
            result: [
              { update_id: 100, message: { chat: { id: 42, type: "private", username: "user" }, from: { username: "user" }, text: "hello" } },
            ],
          });
          return;
        case "editMessageText":
          reply({ ok: true, result: { message_id: body.message_id } });
          return;
        default:
          reply({ ok: false, error_code: 404, description: `Not Found: method not found` });
      }
    });
  });
  const ready = new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, ready, sent, validToken: VALID_TOKEN };
}

if (process.argv[1] != null && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const port = Number(process.argv[2] ?? 8931);
  const stub = createTelegramStub(port);
  await stub.ready;
  process.stdout.write(`stub listening on http://127.0.0.1:${port} with token ${stub.validToken}\n`);
}