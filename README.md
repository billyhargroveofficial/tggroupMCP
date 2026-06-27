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

MCP config example:

```toml
[mcp_servers.telegram-parilka]
command = "/root/telegram-parilka-mcp/bin/telegram-parilka-mcp"
```

Sending is dry-run/disabled until `TELEGRAM_SEND_ENABLED=true`.
