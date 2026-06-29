# Telegram Parilka MCP Tool Map

Default chat: `-1003179772905` (`Парилка228`). All tools accept optional `chat`; omitted means `TELEGRAM_DEFAULT_CHAT_ID`.

## Read Tools

- `get_config`: return redacted config, default chat, allowlist, dry-run state, and throttle settings.
- `get_status`: return cache-only service health, sync state, daemon last-run status, and embedding coverage.
- `resolve_chat`: resolve and cache a Telegram peer. Use before important actions.
- `get_chat_info`: resolve chat and return local SQLite cache stats.
- `sync_history`: backfill history into SQLite. Use bounded pages; the server returns `status`, `chat`, `stats`, and metadata, not a huge message dump.
- `read_history`: read cached messages by `limit`, `before_id`, `after_id`, and order. Includes `applied_filters`, `returned_count`, and `cache` metadata with local range, sync state, and outside/partial-cache relation.
- `search_messages`: multi-channel cached search; returns keyword FTS hits, vector/cosine chunks when indexed, and hybrid candidates.
- `semantic_search_messages`: vector/cosine search over indexed cached message chunks.
- `index_embeddings`: build local SQLite vector chunks from cached messages via the configured embeddings API.
- `get_thread_context`: cached messages around a message ID. Includes `center_found`, requested range, returned count, and cache range/completeness metadata.

## Write Tools

- `preview_message`: validate text length, bytes, formatting warnings, target chat, and optional reply target without sending. Returns a short-lived `approval_id` for the exact previewed payload.
- `send_message`: send or dry-run a message. Respects allowlist, hard dry-run config, live-send approval, reply-target preflight, dedupe, per-user cooldown, per-chat queue, and global concurrency.
- `reply_to_message`: convenience wrapper for `send_message` with required `message_id`; live replies require a matching preview approval too. Reply targets are checked before approval consumption and outbox reservation.

`dedupe_key` is a permanent audit/idempotency key after a successful live send. Reusing the same key and payload returns
the recorded Telegram message id; reusing the key with different payload is rejected. Failed or expired sends may be
retried with the same key and payload.

## Output Shape

Tools return JSON in text content:

```json
{ "ok": true, "...": "..." }
```

or normalized errors:

```json
{
  "ok": false,
    "error": {
    "category": "rate_limit | permission | formatting | reply | peer | auth | validation | internal",
    "retryable": false,
    "fields": [{ "path": "limit", "message": "Expected number" }],
    "message": "..."
  }
}
```

Runtime argument validation is strict. Unknown input keys are not ignored; they return `ok:false` with
`error.category:"validation"` and a `fields[].path` entry naming the unknown key.

For `semantic_search_messages` and vector/hybrid portions of `search_messages`, `before_id` and `after_id` are strict
message windows. Candidate chunks may overlap the window for scoring, but returned chunk `messageIds`, hydrated
`messages`, `startMessageId`/`endMessageId`, and text are trimmed to in-window messages only.

`sync_history` uses explicit status values:

```json
{ "ok": true, "status": "done", "chat": { "chatId": "-1003179772905" }, "stats": {}, "result": {} }
```

```json
{ "ok": true, "status": "catching_up", "chat": { "chatId": "-1003179772905" }, "result": { "status": "catching_up", "catchup": {} } }
```

```json
{ "ok": true, "status": "partial", "chat": { "chatId": "-1003179772905" }, "result": { "recent": {}, "backfill": { "status": "failed" } } }
```

```json
{ "ok": true, "status": "failed", "chat": { "chatId": "-1003179772905" }, "result": { "status": "failed", "error": {} } }
```
