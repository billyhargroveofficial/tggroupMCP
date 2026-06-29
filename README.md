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
npm run smoke:mcp:wrapper
```

Put the generated `TELEGRAM_SESSION` into `.env`.

## Run

```bash
npm run print-config
npm run start
```

MCP clients and systemd should use the `./bin/*` wrappers. They execute the built `dist/*.js` files and fail with a
clear `npm run build` remediation when the build is missing or stale. Run `npm run build` and
`npm run smoke:mcp:wrapper` before restarting deployed clients or services.

## Cache warmer

Run this as a long-lived process to keep SQLite warm. It fetches recent messages first, then an older backfill chunk, using cursors stored in SQLite:

```bash
npm run sync-daemon
```

One-shot mode, useful for cron/systemd timers:

```bash
npm run sync-once
```

Check cache, daemon, sync, and embedding coverage health without touching Telegram:

```bash
npm run status
```

Status is `ok`, `degraded`, `critical`, or `unknown`. Alert on `critical` immediately, and investigate `degraded`
when recent sync or daemon success lag is above the warning threshold shown in the JSON.

SQLite uses WAL plus a busy timeout and bounded retry for write coordination, so the MCP server, sync daemon, and
embedding indexer can share the same DB. Keep any custom/manual write transactions small so reads and other writers do
not sit behind long locks.

## Vector RAG

Embeddings are disabled unless explicitly opted in. Set `TELEGRAM_EMBEDDINGS_ENABLED=true` plus `OPENAI_API_KEY` or
`TELEGRAM_EMBEDDINGS_API_KEY`, then review the first-run estimate before indexing cached messages into local SQLite
vector chunks. Indexing sends cached Telegram message text to the configured external embeddings provider.

```bash
npm run embed-once -- --limit-chunks 1000 --estimate-only
npm run embed-once -- --limit-chunks 1000 --confirm-estimate
```

The regular sync daemon indexes new chunks only when embeddings are explicitly enabled and configured. On the first
indexing run it logs the estimate and skips API calls until you run a confirmed manual index. `search_messages` returns
keyword, vector, and hybrid candidates; `semantic_search_messages` returns only cosine-ranked chunks.

Vector search uses an exact in-process cosine scan capped by `TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT` (default
20,000 chunks). If a query would exceed the cap, narrow it with `before_id`/`after_id` or raise the cap only after a
local benchmark. Current target: p95 <= 250ms and bounded RSS at the configured candidate limit.

```bash
npm run benchmark:vector -- --candidates 20000 --dimensions 256 --target-p95-ms 250
```

If the expected full index cannot meet that target, keep the cap in place and switch the vector store to sqlite-vec,
sqlite-vss, pgvector, or FAISS before increasing the scanned candidate set.

MCP config example:

```toml
[mcp_servers.telegram-parilka]
command = "/root/telegram-parilka-mcp/bin/telegram-parilka-mcp"
```

Sending is preview-only by default. Live posts require explicit operator opt-in with `TELEGRAM_SEND_ENABLED=true` and
`TELEGRAM_DRY_RUN_DEFAULT=false`, plus a server-issued approval for each message. Call `preview_message` first, then
pass the returned `approval_id` to `send_message` or `reply_to_message` with the exact same chat, text, reply id, parse
mode, link preview, and silent options. `TELEGRAM_DRY_RUN_DEFAULT=true` or `TELEGRAM_SEND_ENABLED=false` forces every
send tool call into hard dry-run mode; callers cannot override that with `dry_run:false`, even when the approval bypass
flag is set. Reply targets are validated before approvals are consumed or send outbox rows are reserved; previews and
dry-runs include a short reply target excerpt when the target is available.
