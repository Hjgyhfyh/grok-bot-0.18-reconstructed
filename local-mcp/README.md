# Local MCP servers

Working Model Context Protocol servers for the three external systems the
agents need: Graphite notes, Telegram, and DeepSeek Harness.

## Why this directory exists

Grok Bot 0.18 reconstructed can describe an MCP server but cannot run one. The
configuration type accepts a stdio process:

```ts
// source/shared/node/mcp/mcp-display-runtime.ts:2
export type McpServerConfig =
  | { url: string; type?: "sse" | "http"; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };
```

and `source/shared/node/mcp/mcp-validation.ts:3` classifies a config as `stdio`
whenever `command` is present. But nothing in this repository starts such a
process:

| Fact | Where |
|---|---|
| No MCP client exists | `source/packages/agent-exec/mcp.ts` has no `spawn`, no `child_process`, no `command` |
| No MCP SDK is installed | `@modelcontextprotocol/sdk` is absent from `package.json` and from `node_modules` |
| The box endpoint is a stub | `source/box-exec-daemon/server.ts:472` answers `loadMcpServers` with an empty response and ignores the config |
| The desktop path is a stub too | `source/electron-main/mcp/desktop-mcp-manager.ts:104` stubs `loadServers`; `:109` refuses to execute tools locally |

So the servers here are standalone: plain `.mjs`, no build step, no dependency.
Each one runs under bare `node`, and each can be verified on its own before
anything is wired into the app.

## Layout

```
local-mcp/
  mcp-stdio-core.mjs                        JSON-RPC 2.0 over stdio: server side
  mcp-stdio-client.mjs                      JSON-RPC 2.0 over stdio: client side + CLI
  servers/
    echo-mcp-server.mjs                     no credentials, no network: the transport proof
    graphite-notes-mcp-server.mjs           read and write the Graphite vault
    telegram-mcp-server.mjs                 Telegram Bot API
    dsh-agent-mcp-server.mjs                run coding agents on the local DSH install
  examples/                                 ready-to-paste McpServerConfig entries
  test-support/telegram-bot-api-stub.mjs    local Bot API stand-in, for tests only
```

## The exact configuration shape

An MCP server entry is `McpServerConfig` from
`source/shared/node/mcp/mcp-display-runtime.ts:2`. The envelope the app pushes to
its box is `{ "mcpServers": { <name>: <McpServerConfig> } }`
(`source/shared/node/mcp/tools-discovery.ts:162-163`).

stdio, local file, no secrets:

```json
{
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": ["D:\\path\\to\\grok-bot-0.18-reconstructed\\local-mcp\\servers\\echo-mcp-server.mjs"]
    }
  }
}
```

stdio with environment (this is the only supported way to pass a path or a
secret to a server):

```json
{
  "mcpServers": {
    "graphite": {
      "command": "node",
      "args": ["D:\\path\\to\\local-mcp\\servers\\graphite-notes-mcp-server.mjs"],
      "env": { "GRAPHITE_VAULT": "C:\\Users\\user\\graphite-lite" }
    }
  }
}
```

remote, streamable HTTP (supported by the schema, but see the caveat below):

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://example.com/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

Keep secrets in `env`, never in `args`. Anything in `args` is visible to any
process that can list this machine's command lines.

## Verify a server before wiring it in

The client is a standalone checker. It performs the real `initialize` handshake,
then `tools/list` or `tools/call`.

```powershell
# what tools does this server expose?
node local-mcp/mcp-stdio-client.mjs --config local-mcp/examples/echo.config.json --list

# call one
node local-mcp/mcp-stdio-client.mjs --config local-mcp/examples/echo.config.json --call echo --args-file local-mcp/examples/echo.args.json
```

On PowerShell, prefer `--args-file` over `--args`. PowerShell strips the quotes
from JSON passed to a native command, so `--args '{"message":"hello there"}'`
fails with `Unterminated string in JSON` before MCP is involved at all. That is
a shell quoting problem, not a server problem.

The client exits `1` when the tool returns `isError`, so a scheduled job can
tell a failed digest from a delivered one.

## Server 1 — Graphite notes (`graphite-notes`)

Gives an agent its own personal notes system over the user's own notes project.
No credentials, no network: everything is markdown on disk.

The vault is read from `GRAPHITE_VAULT`. Note format matches Graphite exactly —
YAML frontmatter, then markdown:

```
<vault>/<folder>/<Title>.md
<vault>/.graphite/    application metadata, owned by Graphite
<vault>/.trash/       deleted notes, owned by Graphite
```

Tools: `list_notes`, `read_note`, `search_notes`, `create_note`, `append_note`,
`list_folders`.

`.graphite`, `.trash`, `_assets`, `node_modules` and `.git` are refused, as is
any path that resolves outside the vault. Both guards are covered by the test.

**The user must confirm the vault path.** `C:\Users\user\graphite-lite` is the
repository; `C:\Users\user\graphite-lite-test-vault` is a vault. Nothing here
knows which one holds real notes, so the path is configuration, not a default.

This server writes files. Point `GRAPHITE_VAULT` at a scratch copy while testing.

## Server 2 — Telegram (`telegram`)

Telegram Bot API over plain HTTPS, no SDK. A bot is used rather than a user
account on purpose: no phone number, no session login, no risk of an account
being banned for automation, and `sendMessage` is idempotent enough for a digest.

Requires `TELEGRAM_BOT_TOKEN`. The server exits immediately if it is unset. No
token is committed here and none should be.

Tools: `get_me`, `send_message`, `get_chats`, `get_updates`, `edit_message`.

To get the first `chat_id`: the user sends the bot one message in Telegram, then
the agent calls `get_chats`. Telegram requires this; a bot cannot message a user
who has never started it.

**Nothing was sent to Telegram while building this.** The tool layer was proved
against `test-support/telegram-bot-api-stub.mjs`, a local stub, with
`TELEGRAM_API_BASE` pointed at it. `TELEGRAM_API_BASE` exists for tests only.

## Server 3 — DeepSeek Harness (`dsh-agent`)

Runs coding agents on the local DSH install.

DSH ships no MCP server. Its checkout has `@deepseek-ai/dsh-mcp-client` and
`packages/mcp/mcp-resources`, which is the opposite direction — DSH acting as an
MCP *client*. This server drives the `dsh` CLI instead.

The primitive is `dsh headless "<task>"`, which answers one task, prints the
result and exits. That maps one MCP tool call onto one bounded coding-agent run.

Tools: `dsh_version`, `dsh_dump_config`, `dsh_run_task`.

Requires `DSH_ROOT`. Optional: `DSH_CLI` (default `dsh`), `DSH_DEFAULT_PROFILE`,
`DSH_TASK_TIMEOUT_MS` (default 900000).

Not exposed on purpose: `--from-default-profile`, `dsh plugin`, and any profile
mutation. This server runs tasks and reads state; it does not reconfigure the
user's harness.

Verified: `dsh_version` returns `DSH 0.2.0-rc.2` from the real install. The
`dsh_run_task` execution, timeout and failure paths were proved against a stub
CLI on `PATH`; no real headless task was started, because that would spend a
model request and collide with the live session.

## Cron note for the digest agent

The MCP layer gives an agent the ability to send. It does not give it a
schedule. A digest on a timer needs Windows Task Scheduler to call the client:

```
node local-mcp\mcp-stdio-client.mjs --config <telegram.config.json> ^
  --call send_message --args-file <digest.args.json>
```

The digest has to be assembled first — by a Grok Bot agent, or by any other job
that writes the args file. MCP does not run on a timer by itself.