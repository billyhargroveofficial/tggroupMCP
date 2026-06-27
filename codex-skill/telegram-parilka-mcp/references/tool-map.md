# Telegram Parilka MCP Tool Map

Default chat: `-1003179772905` (`Парилка228`). All tools accept optional `chat`; omitted means `TELEGRAM_DEFAULT_CHAT_ID`.

## Read Tools

- `get_config`: return redacted config, default chat, allowlist, dry-run state, and throttle settings.
- `resolve_chat`: resolve and cache a Telegram peer. Use before important actions.
- `get_chat_info`: resolve chat and return local SQLite cache stats.
- `sync_history`: backfill history into SQLite. Use bounded pages; the server returns metadata, not a huge message dump.
- `read_history`: read cached messages by `limit`, `before_id`, `after_id`, and order.
- `search_messages`: SQLite FTS search over cached text.
- `get_thread_context`: cached messages around a message ID.

## Write Tools

- `preview_message`: validate text length, bytes, formatting warnings, and target chat without sending.
- `send_message`: send or dry-run a message. Respects allowlist, `TELEGRAM_SEND_ENABLED`, `dry_run`, dedupe, per-user cooldown, per-chat queue, and global concurrency.
- `reply_to_message`: convenience wrapper for `send_message` with required `message_id`.

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
    "category": "rate_limit | permission | formatting | reply | peer | auth | internal",
    "retryable": false,
    "message": "..."
  }
}
```
