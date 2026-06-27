# Runbook

## Project

```bash
cd /root/telegram-parilka-mcp
npm install
npm run build
./bin/telegram-parilka-mcp --print-config
```

The wrapper reads `/root/.config/telegram-mcp/.env` first when present, then `/root/telegram-parilka-mcp/.env`. Local `.env` values override the shared env.

## Session Generation

```bash
cd /root/telegram-parilka-mcp
cp .env.example .env
npm run generate-session
```

Put the generated StringSession into `.env` as `TELEGRAM_SESSION`.

## MCP Smoke Test

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| ./bin/telegram-parilka-mcp
```

## Background Cache Warmer

Run one pass:

```bash
cd /root/telegram-parilka-mcp
npm run sync-once
```

Install the user systemd service:

```bash
mkdir -p /root/.config/systemd/user
cp /root/telegram-parilka-mcp/systemd/telegram-parilka-mcp-sync.service /root/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now telegram-parilka-mcp-sync.service
```

Check it:

```bash
systemctl --user status telegram-parilka-mcp-sync.service
journalctl --user -u telegram-parilka-mcp-sync.service -n 100 --no-pager
```

## Vector RAG

Configure an OpenAI-compatible embeddings endpoint:

```bash
OPENAI_API_KEY=...
TELEGRAM_EMBEDDINGS_ENABLED=true
TELEGRAM_EMBEDDINGS_MODEL=text-embedding-3-small
TELEGRAM_EMBEDDINGS_DIMENSIONS=256
```

Index a bounded batch of cached messages:

```bash
cd /root/telegram-parilka-mcp
npm run embed-once -- --limit-chunks 1000
```

Search with `search_messages` for keyword/vector/hybrid results, or `semantic_search_messages` for vector-only chunks.

## Codex Config

```toml
[mcp_servers.telegram-parilka]
command = "/root/telegram-parilka-mcp/bin/telegram-parilka-mcp"
startup_timeout_sec = 30.0
tool_timeout_sec = 600.0
```

## Hermes Config

```yaml
mcp_servers:
  telegram-parilka:
    command: /root/telegram-parilka-mcp/bin/telegram-parilka-mcp
    supports_parallel_tool_calls: false
```

Restart/reload the gateway after changing Hermes config.
