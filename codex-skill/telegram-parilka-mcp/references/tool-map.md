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

Cache-only tools: `get_config`, `get_status`, `read_history`, `search_messages`, `semantic_search_messages`, and
`get_thread_context`. Live-resolving tools may connect to Telegram: `resolve_chat`, `get_chat_info`, `sync_history`,
`preview_message`, `send_message`, and `reply_to_message`.

Cache metadata uses these `relation.completeness` values:

- `empty_cache`: no cached rows exist for the chat.
- `outside_cached_range`: the requested window is wholly before or after the local cache.
- `partial_cached_range`: the request overlaps the local cache but may omit older or newer uncached rows.
- `within_cached_range`: the requested window is inside the local cache range.
- `no_matching_message_ids`: ID filters are impossible, such as `after_id >= before_id`.

When a read/context result returns zero rows, `empty_reason` is one of `cache_empty`,
`requested_before_cached_range`, `requested_after_cached_range`, `filters_exclude_all_message_ids`,
`no_cached_rows_in_requested_range`, or `no_cached_rows_in_partial_cached_range`.

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

Failed tool results also set MCP `isError:true` while preserving the JSON payload above. Clients should treat either
MCP `isError:true` or JSON `ok:false` as failure.

Runtime argument validation is strict. Unknown input keys are not ignored; they return `ok:false` with
`error.category:"validation"` and a `fields[].path` entry naming the unknown key.

For `semantic_search_messages` and vector/hybrid portions of `search_messages`, `before_id` and `after_id` are strict
message windows. Candidate chunks may overlap the window for scoring, but returned chunk `messageIds`, hydrated
`messages`, `startMessageId`/`endMessageId`, and text are trimmed to in-window messages only.

For `search_messages`, prefer top-level `results` / `result_count` as the canonical flattened ranked output. The older
top-level `messages` field is keyword-only compatibility data. `hybrid.count` is the final `hybrid.hits.length`, while
`hybrid.raw_candidate_count` reports keyword plus vector candidates before merge/dedupe. When vector search is disabled,
unindexed, provider-failed, or candidate-limited, the tool returns `status:"partial"` with `degraded_channels` and
`partial_failure` metadata while preserving keyword results.

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
