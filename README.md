# tggroupMCP

TypeScript MCP stdio server for a Telegram group through MTProto/GramJS.

The default chat is `Парилка228` (`-1003179772905`), but all chat IDs live in env config so the server can be reused for other groups.

## Setup

```bash
cd /root/telegram-parilka-mcp
npm install
cp .env.example .env
npm run generate-session
npm run build
```

Put the generated `TELEGRAM_SESSION` into `.env`.

## Run

```bash
npm run print-config
npm run start
```

## Cache warmer

Run this as a long-lived process to keep SQLite warm. It fetches recent messages first, then an older backfill chunk, using cursors stored in SQLite:

```bash
npm run sync-daemon
```

One-shot mode, useful for cron/systemd timers:

```bash
npm run sync-once
```

## Vector RAG

Embeddings are disabled unless explicitly opted in. Set `TELEGRAM_EMBEDDINGS_ENABLED=true` plus `OPENAI_API_KEY` or `TELEGRAM_EMBEDDINGS_API_KEY`, then index cached messages into local SQLite vector chunks:

```bash
npm run embed-once -- --limit-chunks 1000
```

The regular sync daemon also indexes new chunks only when embeddings are explicitly enabled and configured. `search_messages` returns keyword, vector, and hybrid candidates; `semantic_search_messages` returns only cosine-ranked chunks.

MCP config example:

```toml
[mcp_servers.telegram-parilka]
command = "/root/telegram-parilka-mcp/bin/telegram-parilka-mcp"
```

Sending requires a server-issued approval for live posts. Call `preview_message` first, then pass the returned
`approval_id` to `send_message` or `reply_to_message` with the exact same chat, text, reply id, parse mode, link
preview, and silent options. Set `TELEGRAM_DRY_RUN_DEFAULT=true` or `TELEGRAM_SEND_ENABLED=false` to force every send
tool call into hard dry-run mode; callers cannot override that with `dry_run:false`.
