# Architecture TODO

Generated from six read-only sub-agent reviews on 2026-06-29.

Current posture:

- Telegram SQLite cache is operational.
- Embeddings are intentionally not required for the core system; keep vector indexing disabled until the opt-in and coverage items below are done.
- No P0 issues were reported by the reviewers.

## P1 - Fix Before More Autonomy

### 1. Add server-side live-send approval

Status 2026-06-29: Completed in code and no-network tests. `TELEGRAM_DRY_RUN_DEFAULT=true` is now a hard server-side dry-run gate, `preview_message` returns a short-lived `approval_id`, and live `send_message` / `reply_to_message` require a matching unexpired approval unless the explicit admin break-glass flag `TELEGRAM_LIVE_SEND_APPROVAL_BYPASS=true` is set. Approval matching is bound to chat id, text hash, reply id, parse mode, link preview, and silent flag, and approved live sends consume the token before reaching the send path.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`
- `npm run print-config`

Problem:
`send_message` can post live when `TELEGRAM_SEND_ENABLED=true` and `dryRunDefault=false`. Safety is mostly in skill instructions, not enforced by the MCP server. `TELEGRAM_DRY_RUN_DEFAULT=true` is also only a default, because a caller can pass `dry_run:false`.

Relevant files:

- `src/config.ts`
- `src/tools.ts`
- `src/throttler.ts`
- `src/telegram-client.ts`

TODO:

- Make dry-run mode hard-safe: when `TELEGRAM_DRY_RUN_DEFAULT=true`, a tool caller must not be able to override it with `dry_run:false`.
- Add approval-token flow:
  - `preview_message` returns an approval id.
  - Approval id is bound to chat id, text hash, reply id, parse mode, link preview, silent flag, and expiry.
  - Live `send_message` rejects without a matching unexpired approval.
- Keep a bypass only for an explicit admin env flag if really needed.

Acceptance criteria:

- Unit tests prove `dry_run:false` cannot bypass hard dry-run mode.
- Live send without approval returns `ok:false`.
- Live send with mismatched text/chat/reply id returns `ok:false`.
- Approved send returns the Telegram message id and marks the approval consumed.

### 2. Persist send idempotency, audit, and throttling state

Status 2026-06-29: Completed for the MCP send path. `send_outbox` now persists dedupe keys, payload hashes, chat/reply metadata, server-owned caller identity, queued/sending/sent/failed/expired status, Telegram message id, errors, and timestamps. `send_throttle_state` persists cooldown state. Send reservations run in SQLite `BEGIN IMMEDIATE` transactions, duplicate sent dedupe keys return the recorded message id without calling Telegram again, failed/expired rows can be retried with the same payload, and queue/cooldown checks use persisted active rows. Caller-supplied `user_key` is no longer exposed or parsed; the send path uses a server-owned throttle identity.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
Send dedupe, cooldown, queue, and pending counts are in memory. Restarts forget them. `dedupe_key` is optional and recorded before enqueue/send succeeds.

Relevant files:

- `src/throttler.ts`
- `src/tools.ts`
- `src/store.ts`

TODO:

- Add SQLite tables for send outbox/audit:
  - dedupe key
  - payload hash
  - chat id
  - reply id
  - status: queued, sending, sent, failed, expired
  - Telegram sent message id
  - error
  - timestamps
- Make duplicate sent keys return the original result.
- Move cooldown and queue checks into SQLite transactions or a single durable queue manager.
- Make caller identity server-owned; remove or constrain caller-supplied `user_key`.

Acceptance criteria:

- Restart does not permit duplicate sends with the same dedupe key.
- Failed enqueue does not burn a dedupe key forever.
- Queue/cooldown behavior survives process restart.
- Tests cover duplicate sends, retry after failure, queue expiry, and cooldown bypass attempts.

### 3. Make recent sync contiguous and self-healing

Status 2026-06-29: Completed for recent sync catch-up. Recent sync now treats `newestMessageId` as the contiguous high-water mark, pages above the previous value until Telegram returns a short/empty page, and refuses to advance state if an iterator failure or `TELEGRAM_MAX_SYNC_LIMIT` interruption prevents confirming the contiguous range. Partial rows already flushed to SQLite are harmless: the next recent tick starts from the unchanged high-water mark and upserts the full range again to repair the suspected gap.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
Recent sync uses cached `newestMessageId` as `minId`, but still fetches only `recentLimit`. If more messages arrive than the limit during downtime or a burst, the newest page can advance `newestMessageId` and leave an unfilled middle gap.

Relevant files:

- `src/sync-engine.ts`
- `src/store.ts`
- `src/config.ts`

TODO:

- Add recent catch-up pagination until all messages above the previous newest id are stored.
- Track gaps or contiguous high-water marks explicitly.
- Do not advance `newestMessageId` past a gap.
- Add a repair path that can scan and fill suspected gaps.

Acceptance criteria:

- With cached newest `1000`, mocked Telegram messages `1001..1500`, and recent limit `300`, sync stores all 500 messages before reporting newest `1500`.
- A failed mid-page sync does not permanently skip unseen messages.
- Tests cover downtime burst, partial failure after flushed rows, and normal no-new-message tick.

### 4. Wire Telegram flood/rate controls end to end

Status 2026-06-29: Completed. GramJS client options now include `floodSleepThreshold` from `TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC`, history iteration receives configurable `TELEGRAM_HISTORY_WAIT_TIME_SEC`, and the daemon computes its next sleep from normalized sync errors. `FLOOD_WAIT_*` / `SLOWMODE_WAIT_*` retry-after values delay the next tick for at least the requested duration, transient network/socket/timeouts use exponential backoff, and permanent auth errors stop the daemon instead of restart-looping inside the process. Redacted config includes the flood, wait-time, and backoff settings.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`
- `npm run print-config`

Problem:
`TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC` is loaded but not wired into GramJS client options or daemon sleep policy. `FLOOD_WAIT` can be normalized but the daemon continues on the ordinary interval.

Relevant files:

- `src/config.ts`
- `src/telegram-client.ts`
- `src/sync-engine.ts`
- `src/sync-daemon.ts`
- `src/errors.ts`

TODO:

- Pass `floodSleepThreshold` into `TelegramClient`.
- Add configurable `waitTime` for history requests.
- Teach daemon to honor `retryAfterSec` from sync failures.
- Add exponential backoff for transient connection/flood failures.

Acceptance criteria:

- Mocked `FLOOD_WAIT_30` prevents new Telegram requests for at least 30 seconds or fails fast according to configured policy.
- Flood settings appear in redacted config.
- Tests cover flood wait, slow mode, transient network error, and permanent auth error.

### 5. Add central config validation

Status 2026-06-29: Completed. Numeric env parsing now uses a central `NUMERIC_ENV_RULES` table with explicit integer min/max bounds for Telegram, send safety, sync, throttling, and embeddings settings. Floats, NaN, negatives, disallowed zero values, and too-large values fail during `loadConfig()` before daemon/server startup, with errors naming the env var and allowed range. Cross-field validation rejects `TELEGRAM_SYNC_BACKOFF_MAX_MS` below `TELEGRAM_SYNC_BACKOFF_INITIAL_MS`, and `npm run validate-config` exercises the same load path as startup.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`
- `npm run print-config`
- `npm run validate-config`

Problem:
Numeric env parsing only checks finite numbers. Bad values can wedge the process, for example `TELEGRAM_EMBEDDINGS_API_BATCH_SIZE=0` creates an infinite loop and `TELEGRAM_GLOBAL_CONCURRENCY=0` leaves sends queued forever.

Relevant files:

- `src/config.ts`
- `src/vector-rag.ts`
- `src/throttler.ts`

TODO:

- Replace raw `intFromEnv` usage with typed validators:
  - positive integer
  - non-negative integer
  - bounded integer
  - duration ms/sec
- Validate all concurrency, batch, queue, limit, cooldown, and dimension values.
- Add `npm run validate-config` or make `print-config` fail early with actionable messages.

Acceptance criteria:

- Invalid zero, negative, float, NaN, and too-large values fail before daemon starts.
- Validation errors name the env var and allowed range.
- Tests cover every numeric env field used by sync, throttling, and embeddings.

### 6. Add SQLite writer coordination

Status 2026-06-29: Completed for current write paths. Each `MessageStore` connection sets `PRAGMA busy_timeout`, multi-row message and embedding writes use `BEGIN IMMEDIATE`, and store writes for chats, sync state, history jobs, send outbox transitions, and embedding deletion run through bounded `SQLITE_BUSY` retry with logged backoff. Concurrent writer tests hold a real SQLite write lock from a worker thread while another store writes messages, history jobs, and embedding chunks.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
The expected deployment can run MCP server, sync daemon, and embed indexer against the same SQLite DB. WAL is enabled, but there is no busy timeout, retry policy, or writer coordination. Batch writes use bare `BEGIN`.

Relevant files:

- `src/store.ts`
- `src/sync-daemon.ts`
- `README.md`

TODO:

- Set `PRAGMA busy_timeout`.
- Use `BEGIN IMMEDIATE` for write batches.
- Retry transient `SQLITE_BUSY` with bounded backoff.
- Add tests with concurrent store instances writing messages/jobs/embedding chunks.

Acceptance criteria:

- Concurrent MCP + sync-daemon writes do not throw uncaught `SQLITE_BUSY`.
- Busy retries are logged with bounded attempts.
- Long write transactions remain small enough not to block reads for too long.

### 7. Harden embeddings opt-in

Status 2026-06-29: Completed. Embeddings remain disabled unless `TELEGRAM_EMBEDDINGS_ENABLED=true`; an `OPENAI_API_KEY` alone does not make `VectorRag` configured and the daemon returns `embeddings:null`. `index_embeddings` returns a clear disabled/configuration error when disabled. First-run indexing now produces a structured estimate with provider, base URL, model, dimensions, chat, limit, estimated chunks/messages/chars, existing chunks, and privacy text; non-empty first runs require `confirm_estimate:true` / `--confirm-estimate` before any external embedding API call. The sync daemon logs the first-run estimate and skips API calls until a manual confirmed index creates initial chunks.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`
- `npm run print-config`

Problem:
The reviewers found that `OPENAI_API_KEY` implied embeddings were configured/enabled by default. The default has been changed so `TELEGRAM_EMBEDDINGS_ENABLED=true` is required, but the first indexing run still needs stronger privacy and cost visibility.

Relevant files:

- `src/config.ts`
- `src/sync-daemon.ts`
- `src/embeddings.ts`
- `.env.example`

TODO:

- Keep `TELEGRAM_EMBEDDINGS_ENABLED=true` as an explicit opt-in requirement.
- Do not auto-enable embeddings merely because `OPENAI_API_KEY` exists.
- Before first indexing run, report provider, model, dimensions, chat, estimated chunks, and estimated chars.
- Keep embeddings disabled in production until this is done.

Acceptance criteria:

- With `OPENAI_API_KEY` set but `TELEGRAM_EMBEDDINGS_ENABLED` unset, daemon logs `embeddings:null` and does not call the embeddings API.
- `index_embeddings` returns a clear disabled/configuration error.
- Docs state the privacy implication of external embeddings.

## P2 - Correctness And Durability

### 8. Version database migrations

Status 2026-06-29: Completed. `MessageStore` now runs schema setup inside a `BEGIN IMMEDIATE` migration transaction, records `PRAGMA user_version = 1`, validates required tables, indexes, triggers, columns, and FTS access, and explicitly rebuilds `messages_fts` during migration so historical rows become searchable. Migration version is inspectable via `getSchemaVersion()` / `PRAGMA user_version`, and failed migration leaves `user_version` unchanged.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
Migrations are `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE ADD COLUMN`. Existing DBs will not receive changed triggers/tokenizers/constraints. FTS may not rebuild historical rows if created after messages already exist.

Relevant files:

- `src/store.ts`

TODO:

- Add `PRAGMA user_version` or `schema_migrations`.
- Wrap migrations in `BEGIN IMMEDIATE`.
- Validate required tables, indexes, triggers, and FTS state.
- Add explicit FTS rebuild migration.

Acceptance criteria:

- Fixture DBs from older schemas migrate once.
- FTS searches historical rows after migration.
- Failed migration rolls back cleanly.
- Migration history is inspectable.

### 9. Add backfill exhausted state

Status 2026-06-29: Completed. `sync_state.backfill_exhausted_at` was added in schema version 2. A zero-row backfill marks the chat exhausted; later backfill ticks return `status:"skipped"` with `skipped:"backfill_exhausted"` without making Telegram history requests, while recent sync still runs. Manual `sync_history` can pass `reset_backfill_exhausted:true` to clear the marker and resume backfill.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
When backfill reaches the beginning and returns zero rows, the cursor stays preserved. The daemon can retry the same exhausted request every tick.

Relevant files:

- `src/sync-engine.ts`
- `src/store.ts`

TODO:

- Add `backfill_exhausted_at` or equivalent sync state.
- Skip backfill ticks when exhausted unless reset.
- Add a reset option for manual recheck.

Acceptance criteria:

- Zero-row backfill records exhausted state.
- Next daemon tick skips backfill and still runs recent sync.
- Manual reset resumes backfill.

### 10. Make manual offset sync non-mutating by default

Status 2026-06-29: Completed. `sync_history` now accepts `commit_cursor`; when `offset_id` is provided, cursor commits default to false and the sync state is updated as `mode:"manual"` without advancing daemon oldest/newest/backfill cursor fields. Normal daemon backfill without `offset_id` still advances the cursor. Explicit `commit_cursor:true` is validated against the current daemon backfill cursor before any history job is created.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
Manual `sync_history({ mode:"backfill", offset_id })` uses the same cursor mutation path as daemon backfill. A manual jump can skip an unfilled range.

Relevant files:

- `src/tools.ts`
- `src/sync-engine.ts`
- `src/store.ts`

TODO:

- Add `commit_cursor` flag, default false when `offset_id` is provided.
- Separate manual jobs from daemon cursor advancement.
- Validate explicit cursor commits against current state.

Acceptance criteria:

- Manual offset sync does not alter daemon cursor unless `commit_cursor:true`.
- Tests cover manual older jump, manual newer overlap, and normal daemon backfill.

### 11. Normalize MCP error and status semantics

Status 2026-06-29: Completed. Zod argument failures now return `ok:false` with `category:"validation"` and field paths. Numeric tool input schemas now use JSON Schema `integer`. `sync_history` returns explicit top-level `status`, `chat`, and `stats` for single and `both` modes; sync failures/skips are represented as `status:"failed"`, `status:"partial"`, or `status:"skipped"` instead of requiring callers to infer from nested errors. Tool map docs include validation category plus success/partial/failure examples.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
Some sync failures become `{ ok:true, result.error }`, while docs imply normalized errors. Tool response shapes differ across modes.

Relevant files:

- `src/tools.ts`
- `src/sync-engine.ts`
- `src/errors.ts`
- `codex-skill/telegram-parilka-mcp/references/tool-map.md`

TODO:

- Define stable tool response contracts.
- Make total failures return `ok:false`, or add documented `status:"failed"` / `status:"partial"`.
- Add field-addressed validation errors instead of generic internal errors for Zod failures.
- Use JSON Schema `integer` for integer fields.

Acceptance criteria:

- Invalid arguments return non-internal `ok:false` with field paths.
- `sync_history` returns consistent `chat`, `stats`, and `status` for both single and both modes.
- Tool map contains examples for success, partial, and failure.

### 12. Add cache alias resolution for usernames

Status 2026-06-29: Completed. Schema version 3 adds `chat_aliases`, populated from canonical numeric chat id, requested ref, and username on chat upsert. Cache-only tools now resolve known aliases such as `@name` to the canonical numeric chat id without network calls, while unknown aliases return a peer error with remediation to call `resolve_chat` or `sync_history` once.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
Cache-only tools reject `@username`, even after a prior resolve/sync. The docs imply all tools accept optional chat refs.

Relevant files:

- `src/tools.ts`
- `src/store.ts`
- `src/telegram-client.ts`

TODO:

- Store chat aliases: requested ref, username, numeric id, canonical id.
- Let cache-only tools resolve known aliases without network.
- Return a clear error if alias is unknown or stale.

Acceptance criteria:

- After `resolve_chat({ chat:"@name" })`, `read_history({ chat:"@name" })` works from cache.
- Responses include canonical numeric `chatId`.
- Unknown alias gives remediation text.

### 13. Add message reconciliation for edits/deletes

Status 2026-06-29: Completed for the recent sliding window. Schema version 4 adds `messages.deleted_at` tombstones and `message_embedding_chunks.dirty_at`. Recent sync reconciles a cached recent ID window via `getMessages({ ids })`, upserts returned messages to pick up edits, and tombstones missing IDs by clearing text so FTS no longer returns deleted content. Message text/deletion changes mark overlapping embedding chunks dirty, and embedding stats expose `dirty_chunks`.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec`
- `npm run check`

Problem:
The cache is append/upsert oriented. Recent sync only fetches messages above newest id; deleted or edited older messages may remain stale.

Relevant files:

- `src/sync-engine.ts`
- `src/store.ts`
- `src/telegram-client.ts`

TODO:

- Periodically refresh a recent sliding window by ids/date.
- Represent tombstones or deletion status.
- Mark affected FTS/vector chunks dirty on text changes/deletes.

Acceptance criteria:

- Edited message fixture updates messages, FTS, and embedding dirty state.
- Deleted message fixture becomes a tombstone or is removed consistently.
- Search does not return deleted content unless explicitly requested.

### 14. Harden daemon failure behavior

Status 2026-06-29: Completed. The daemon records each tick start plus last success/failure in a schema v5 `daemon_status` table, exposes that status through existing store stats, and logs the current daemon status with every tick. Sync history requests, iterator `next()` calls, chat resolution, and recent reconciliation lookups are bounded by `TELEGRAM_HISTORY_OPERATION_TIMEOUT_MS`; a stuck iterator fails the sync result with a retryable normalized timeout and invokes iterator cleanup without advancing cursors. Permanent auth errors are still classified as non-retryable and now record the failure before the daemon exits. The systemd sync unit uses `Restart=on-failure`, `RestartSec=30`, `StartLimitIntervalSec=10min`, and `StartLimitBurst=3` to avoid an infinite 10-second restart loop.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (46 passed)
- `npm run check`
- `npm run print-config`
- `npm run validate-config`

Problem:
Permanent startup/auth/peer failures can restart-loop under systemd. A stuck GramJS iterator has no watchdog timeout.

Relevant files:

- `src/sync-daemon.ts`
- `src/sync-engine.ts`
- `systemd/telegram-parilka-mcp-sync.service`

TODO:

- Catch per-tick failures at daemon loop boundary.
- Add operation timeout/watchdog around Telegram calls.
- Use exponential backoff for transient failures.
- Stop or fail clearly on permanent auth/config failures.
- Add systemd `StartLimitIntervalSec` / `StartLimitBurst` and consider `Restart=on-failure`.

Acceptance criteria:

- Auth failure does not restart forever every 10 seconds.
- Stuck iterator is aborted and logged.
- Health/status reports last successful tick and last failure.

## P2 - Vector RAG Track

Embeddings may remain disabled until this section is done.

### 15. Replace high-water vector cursor with coverage tracking

Status 2026-06-29: Completed while keeping embeddings opt-in disabled by default. Vector indexing no longer uses only `MAX(end_message_id)` as a forward cursor. `MessageStore` now scans cached messages that are not covered by a clean chunk for the configured model/dimension, treats dirty chunks as uncovered, excludes dirty chunks from vector search, and reports coverage counters (`cache_messages`, `indexed_messages`, `uncovered_messages`, `uncovered_ranges`, `dirty_chunks`) in embedding stats and index estimates/results. `VectorRag` builds chunks from uncovered/dirty cached messages, so recent-index-then-backfill-index covers older messages without rebuild, and edited messages marked dirty are reindexed before search uses them again.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (48 passed)
- `npm run check`

Problem:
Vector indexing uses a single forward cursor. If recent messages are indexed before older backfill arrives, older backfilled messages are skipped forever without rebuild.

Relevant files:

- `src/vector-rag.ts`
- `src/store.ts`

TODO:

- Track per-message or per-range embedding coverage.
- Add anti-join scanner for cached messages not covered by chunks.
- Track dirty chunks using content hashes.
- Reindex edited messages.

Acceptance criteria:

- Recent-index-then-backfill-index makes older messages searchable without rebuild.
- Stats expose cache messages, indexed messages, uncovered ranges, and dirty chunks.
- Tests cover backfill, new messages, and message edits.

### 16. Store exact chunk membership

Status 2026-06-29: Completed. Schema version 6 adds `message_embedding_chunk_messages` with ordered chunk membership rows, indexes for chunk/message lookups, and a delete trigger so memberships are removed when chunks are deleted. New vector chunks store the exact `messageIds` used to create the embedding; migrated historical chunks are backfilled best-effort from non-empty cached messages inside the old range. Coverage scans and dirty marking now use exact membership rows instead of broad chunk ranges, dirty cleanup only removes chunks whose member messages were actually reindexed, and vector hit hydration uses `getMessagesByIds()` in membership order instead of `getMessagesInRange(... LIMIT messageCount)`.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (49 passed)
- `npm run check`

Problem:
Chunk input skips empty text rows, but vector hit hydration fetches all messages in the start/end range with `LIMIT messageCount`. This can return the wrong source messages.

Relevant files:

- `src/vector-rag.ts`
- `src/store.ts`

TODO:

- Store message ids used in each chunk, either as JSON or a join table.
- Hydrate vector hits by exact message ids.

Acceptance criteria:

- Vector hit `messages` exactly match chunk input.
- Tests include empty/media messages inside chunk ranges.

### 17. Add embedding API timeout, retry, and budget controls

Status 2026-06-29: Completed while preserving explicit embedding opt-in. Embedding API calls now use `AbortController` with `TELEGRAM_EMBEDDINGS_REQUEST_TIMEOUT_MS`, retry retryable network/timeout/429/5xx failures up to `TELEGRAM_EMBEDDINGS_MAX_RETRIES`, and honor HTTP `Retry-After` before falling back to exponential `TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS` backoff. Indexing caps each run with `TELEGRAM_EMBEDDINGS_MAX_CHUNKS_PER_RUN` and `TELEGRAM_EMBEDDINGS_MAX_CHARS_PER_RUN`; estimates/results include requested/effective chunk limits, char/chunk truncation flags, and coverage. The `index_embeddings` MCP tool returns the estimate without calling the embedding API when a manual request is budget-truncated unless `confirm_estimate:true` is provided.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (53 passed)
- `npm run check`
- `npm run print-config`
- `npm run validate-config`

Problem:
Embedding calls have no timeout/retry/backoff/cost budget. Large manual jobs can send many chunks and hang or spend unexpectedly.

Relevant files:

- `src/embeddings.ts`
- `src/vector-rag.ts`
- `src/tools.ts`
- `src/sync-daemon.ts`

TODO:

- Add timeout with `AbortController`.
- Honor `Retry-After`.
- Add retry policy for 429/5xx.
- Add max chars/chunks per run.
- Report estimated chars before large manual runs.

Acceptance criteria:

- Hung embedding endpoint times out.
- 429 with retry-after delays or fails according to policy.
- Manual large run respects configured budget.

### 18. Enforce embedding dimensions and model consistency

Status 2026-06-29: Completed. The embedding client now rejects provider responses whose vector length does not match configured `TELEGRAM_EMBEDDINGS_DIMENSIONS`, with a clear non-retryable error before chunks are written. Vector search uses the actual query vector dimension when selecting chunks, filters by model plus dimension, and fails closed if a mixed-dimension chunk ever reaches comparison. Embedding stats already group by model and dimension, and coverage remains model/dimension-scoped.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (55 passed)
- `npm run check`

Problem:
Providers may ignore requested dimensions. Ingest stores actual length, while search filters by configured dimensions. Mixed dimensions can lead to zero hits or partial comparisons.

Relevant files:

- `src/embeddings.ts`
- `src/vector-rag.ts`
- `src/store.ts`

TODO:

- Reject returned vectors whose length differs from configured dimensions.
- Search by actual indexed model/dimension pair.
- Reject mixed-dimension comparisons.

Acceptance criteria:

- Dimension mismatch fails indexing with clear error.
- Search never compares different dimensions.
- Stats show model and dimensions clearly.

### 19. Replace vector full scan before scale-up

Status 2026-06-29: Completed as a bounded exact-candidate strategy, with future ANN/vector-extension work split behind measured need. Vector search now reads at most `TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT + 1` clean chunks for the selected model/dimension and fails closed with remediation instead of loading an unbounded full index. Successful vector results report candidate count/limit. `npm run benchmark:vector` provides a no-network synthetic cosine-loop benchmark before raising the candidate limit; README documents the current target (p95 <= 250ms at the configured limit), bounded memory posture, and fallback path to sqlite-vec/sqlite-vss/pgvector/FAISS if the expected full index cannot meet the target.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (56 passed)
- `npm run check`
- `npm run print-config`
- `npm run validate-config`
- `npm run benchmark:vector -- --candidates 20000 --dimensions 256 --runs 5 --target-p95-ms 250` (`p95Ms: 29.21`, `rssMb: 121.6`)

Problem:
Vector search loads all chunks and sorts in JS. This is acceptable for small indexes, but not for large history.

Relevant files:

- `src/vector-rag.ts`
- `src/store.ts`

TODO:

- Benchmark current full scan.
- Decide on sqlite-vec/sqlite-vss/pgvector/FAISS or a bounded candidate strategy.
- Add p95 latency and memory targets.

Acceptance criteria:

- Search over expected full chat index meets agreed p95 target.
- Memory usage remains bounded.
- Fallback path is documented.

### 20. Improve hybrid ranking and chunking

Status 2026-06-29: Completed. Hybrid results now use reciprocal-rank fusion only, merge duplicate keyword/vector evidence when a keyword hit is inside a vector chunk, expose `source:"hybrid"` plus contributing `sources`, and rank overlapping evidence above single-source hits predictably. Chunking now supports configurable `TELEGRAM_EMBEDDINGS_CHUNK_OVERLAP_MESSAGES`, stores overlapping exact memberships, and truncates formatted single-message chunk text to `TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS` with a marker so long messages cannot silently exceed the configured chunk size. Exact `messageIds`, start/end ids, and source fields explain chunk and hybrid boundaries; topic/reply-aware chunking remains an optional future enhancement rather than required for correctness.

Verification 2026-06-29:

- `npm test -- --test-reporter=spec` (59 passed)
- `npm run check`
- `npm run print-config`
- `npm run validate-config`

Problem:
Hybrid ranking simply mixes reciprocal rank with raw cosine. Chunking ignores topic/reply boundaries, has no overlap, and long messages can exceed `chunkMaxChars`.

Relevant files:

- `src/vector-rag.ts`
- `src/store.ts`

TODO:

- Use true reciprocal rank fusion or normalized rank fusion.
- Merge duplicate keyword/vector evidence.
- Add configurable overlap.
- Split/truncate long messages.
- Optionally chunk by topic/reply thread.

Acceptance criteria:

- Tests prove lexical-only, vector-only, and overlapping hits rank predictably.
- Long messages cannot exceed configured chunk max by surprise.
- Chunk metadata explains boundaries.

## P3 - Testing, Observability, And Hygiene

### 21. Add automated tests and CI

Status 2026-06-29: Completed. The repo now has `npm test` with no-network coverage for config validation, store migrations and FTS rebuilds, durable send throttling/outbox behavior, tool validation/response contracts, sync cursor/failure logic, SQLite writer retry, and vector helper behavior. `npm run check` type-checks both `src/**/*.ts` and repository scripts. `npm run smoke:mcp` starts the MCP server over stdio with sanitized env, a temp SQLite DB, live sends disabled, dry-run enabled, Telegram/OpenAI credentials blanked, then verifies initialize, `tools/list`, and `get_config`. GitHub Actions CI runs `npm ci`, `npm run check`, `npm test`, and `npm run smoke:mcp` on pushes to `main` and pull requests.

Verification 2026-06-29:

- `npm run check`
- `npm test -- --test-reporter=spec` (59 passed)
- `npm run smoke:mcp`

Problem:
There is no `npm test`, no CI workflow, no lint, and no automated smoke script.

TODO:

- Add no-network unit tests for config, store migrations, FTS, throttler, tool validation, sync cursor logic, and vector helpers.
- Add MCP smoke script that runs initialize, tools/list, and get_config without Telegram/OpenAI secrets.
- Add GitHub Actions for `npm ci`, `npm run check`, `npm test`, and smoke.

Acceptance criteria:

- `npm test` runs locally.
- CI passes on clean checkout.
- Tests do not require real Telegram or OpenAI credentials.

### 22. Add health/status observability

Status 2026-06-29: Completed. Added cache-only `get_status` MCP tool and `npm run status` CLI path. The status payload includes redacted service/config summary, chat cache message count plus oldest/newest IDs, sync timestamps, last sync error, backfill exhausted state, daemon last-start/success/failure row from the existing `daemon_status` table, and embedding coverage for indexed models. Health is classified as `ok`, `degraded`, `critical`, or `unknown` with explicit recent-sync, daemon-success, and consecutive-failure thresholds. README, runbook, and tool map now document the status command and alertable lag thresholds.

Verification 2026-06-29:

- `node --test --import tsx tests/tools-response.test.ts --test-reporter=spec` (4 passed)
- `npm run check`
- `npm run status`
- `npm test -- --test-reporter=spec` (60 passed)
- `npm run smoke:mcp`

Problem:
Observability is mostly journal logs and DB inspection.

TODO:

- Add `status` CLI or MCP tool returning:
  - service config summary
  - message count
  - newest/oldest ids
  - last recent/backfill time
  - last error
  - backfill exhausted state
  - embedding coverage
- Add structured daemon last-run status file or DB table.
- Document alertable lag thresholds.

Acceptance criteria:

- One command shows whether the service is healthy.
- Status is readable without scraping journal logs.
- Runbook includes health check commands.

### 23. Replace shell-sourced env wrappers

Problem:
Wrappers source env files as shell. TypeScript config uses dotenv parsing, but wrappers execute `.env` content and hard-code `/root`.

Relevant files:

- `bin/telegram-parilka-mcp`
- `bin/telegram-parilka-mcp-sync-daemon`
- `bin/telegram-parilka-mcp-embed-index`
- `src/config.ts`

TODO:

- Stop shell-sourcing `.env` files.
- Let Node config load env files consistently.
- Make install/project path configurable or derived from wrapper location.
- Run shellcheck if wrappers remain.

Acceptance criteria:

- `.env` content is parsed, not executed.
- Project can move away from `/root/telegram-parilka-mcp` with minimal config.
- Env precedence is documented once.

### 24. Expand secret/log ignore and scan hygiene

Problem:
`.gitignore` covers `.env` and SQLite, but not common variants like `.env.local`, `.env.production`, session dumps, or logs.

TODO:

- Extend `.gitignore` for env variants, logs, session files, and dumps.
- Add lightweight secret scan script or CI step.
- Keep `.env.example` tracked.

Acceptance criteria:

- Common local secret/log files are ignored.
- Secret scan runs in CI or documented release checklist.

### 25. Add cache completeness metadata to read tools

Problem:
`read_history` and `get_thread_context` can return empty or partial windows without telling the caller whether data is absent or merely not cached.

TODO:

- Include applied filters, returned count, cache range, and sync state in read outputs.
- `get_thread_context` should include `center_found`.

Acceptance criteria:

- Empty result says whether requested range is outside cached range.
- Context result says whether center message exists.

## What Is Already Solid

- Clear separation between `TelegramService`, `HistorySyncer`, `MessageStore`, and MCP tools.
- Cache-first read/search/context tools avoid unnecessary Telegram calls.
- SQLite has stable `(chat_id, message_id)` uniqueness and useful indexes.
- FTS triggers maintain local insert/update/delete changes for fresh DBs.
- Batch upserts are transactional.
- `sync_state` tracks oldest/newest/backfill cursor and last error.
- `history_jobs` gives a base for health and audits.
- Allowlist is enabled by default.
- `TELEGRAM_SEND_ENABLED=false` is a hard stop when configured.
- `preview_message` exists and validates size/formatting.
- Embeddings degrade cleanly when disabled or unconfigured.
- `npm run check` passes under strict TypeScript.

## Suggested Implementation Order

1. Config validation and hard-safe send approval.
2. Durable send queue/idempotency/audit.
3. Recent sync gap repair and flood handling.
4. SQLite concurrency and versioned migrations.
5. Backfill exhausted state and manual offset safety.
6. Tests/CI/smoke harness.
7. Only then re-enable and harden embeddings/vector RAG.
