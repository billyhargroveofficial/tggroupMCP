# Runbook

## Project

```bash
cd /root/telegram-parilka-mcp
npm install
npm run build
npm run smoke:mcp:wrapper
./bin/telegram-parilka-mcp --print-config
```

Wrappers derive the project directory from their own location, or from `TELEGRAM_PROJECT_DIR` when set, then exec the
built Node entrypoint. They fail with a clear `npm run build` remediation when `dist/*.js` is missing or older than
the TypeScript source/config used to build it. They do not source `.env` as shell.

Environment precedence is handled by TypeScript config with dotenv parsing:

1. Real process environment wins and is never overridden by dotenv files.
2. `TELEGRAM_SHARED_ENV_PATH` is parsed first; default is `~/.config/telegram-mcp/.env`.
3. `TELEGRAM_ENV_PATH` is parsed second; default is `<project>/.env` from the current working directory. It can override
   values from the shared dotenv file, but not real process environment variables.

Common local env variants, logs, SQLite files, session dumps, and backup/dump files are ignored by git. Keep
`.env.example` tracked. Before pushing release or ops changes, run:

```bash
npm run secret-scan
```

## Session Generation

```bash
cd /root/telegram-parilka-mcp
cp .env.example .env
npm run generate-session
```

Put the generated StringSession into `.env` as `TELEGRAM_SESSION`.

## MCP Smoke Test

Source entrypoint smoke, useful while developing:

```bash
npm run smoke:mcp
```

Built wrapper smoke, required after `npm run build` and before deploying/restarting clients:

```bash
npm run smoke:mcp:wrapper
```

Manual JSON-RPC smoke through the wrapper:

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
cd /root/telegram-parilka-mcp
npm run build
npm run smoke:mcp:wrapper
mkdir -p /root/.config/systemd/user
cp /root/telegram-parilka-mcp/systemd/telegram-parilka-mcp-sync.service /root/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now telegram-parilka-mcp-sync.service
```

Before restarting the service after code changes, run `npm run build`. The unit also runs a build freshness preflight
and fails clearly if `dist/sync-daemon.js` is missing or stale.

Check it:

```bash
systemctl --user status telegram-parilka-mcp-sync.service
journalctl --user -u telegram-parilka-mcp-sync.service -n 100 --no-pager
```

## Health Status

Use the cache-only status command for a quick operational read:

```bash
cd /root/telegram-parilka-mcp
npm run status
```

The JSON includes service config summary, cache message count and oldest/newest IDs, sync timestamps and last error,
backfill exhaustion, daemon last started/success/failure status, and embedding coverage. It does not connect to
Telegram or call an embeddings provider.

Alert thresholds are included in the `health.thresholds` field. With the default 60s daemon interval, warning lag is
5 minutes and critical lag is 30 minutes for both recent sync and daemon success. Treat
`daemonCriticalFailures` (3 consecutive failures by default) as critical immediately. `unknown` usually means a fresh DB
or a daemon that has not written status yet; run one sync pass and recheck.

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
npm run embed-once -- --limit-chunks 1000 --estimate-only
npm run embed-once -- --limit-chunks 1000 --confirm-estimate
```

The estimate prints provider, model, dimensions, namespace, chat, estimated chunks/messages/chars, and budget flags
without calling the embeddings API. CLI output includes `status:"estimate_only"`, `status:"requires_confirmation"`,
or `status:"indexed"`. Run the confirmed command only after reviewing that privacy/cost surface; confirmation is
required for first runs and when chunk/character budgets truncate the requested work. On the first daemon indexing run,
the daemon logs the estimate and skips API calls until a confirmed manual index exists.

Search with `search_messages` for keyword/vector/hybrid results, or `semantic_search_messages` for vector-only chunks.

## Cache-Only Vs Live-Resolving Tools

Use cache-only tools first when inspecting state or answering from already synced data: `get_config`, `get_status`,
`read_history`, `search_messages`, `semantic_search_messages`, and `get_thread_context`.

These tools may connect to Telegram and should be used deliberately: `resolve_chat`, `get_chat_info`, `sync_history`,
`preview_message`, `send_message`, and `reply_to_message`. Sending tools remain dry-run or approval-gated according to
the safety config.

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
