# Next Architecture TODO

Generated from six read-only sub-agent reviews on 2026-06-29 after the current architecture-hardening series.

Baseline at generation time:

- HEAD: `533f861 Report cache completeness in read tools`
- `npm run check`: passed
- `npm test`: passed, 63/63
- `npm run smoke:mcp`: passed
- `npm run secret-scan`: passed
- `npm run status`: passed against the live SQLite DB
- Live cache observed through MCP: about 178k cached messages, embeddings disabled
- No P0 findings were reported

Important operating rule:

- Do not perform live Telegram sends while working this TODO unless the user explicitly approves a concrete outgoing message in the current turn.

## P1 - Fix Before Trusting More Autonomy

- [x] 1. Make boolean env parsing fail closed.

  Status 2026-06-29: Completed. Boolean env parsing now uses a strict `BOOLEAN_ENV_RULES` table and accepts only
  `1,true,yes,on` or `0,false,no,off`. Present-but-empty boolean values are invalid; operators must omit the variable
  to use the built-in default. Malformed values name the offending env var and fail during `loadConfig()` /
  `npm run validate-config`, so typoed allowlist or send-safety booleans cannot silently evaluate false.

  Verification 2026-06-29:

  - `node --test --import tsx tests/config-validation.test.ts --test-reporter=spec`
  - `node --test --import tsx tests/embeddings-opt-in.test.ts --test-reporter=spec`
  - `env TELEGRAM_SEND_ENABLED=maybe npm run validate-config` (expected failure naming `TELEGRAM_SEND_ENABLED`)
  - `npm run validate-config`

  Problem:
  `boolFromEnv` treats any non-empty value outside `1,true,yes,on` as `false`. A typo such as `TELEGRAM_REQUIRE_ALLOWLIST=tru` silently disables the allowlist, and typoed safety flags can silently miss hard dry-run or approval behavior.

  Relevant files:

  - `src/config.ts`
  - `tests/config-validation.test.ts`
  - `.env.example`

  TODO:

  - Replace permissive boolean parsing with a strict parser.
  - Accept only explicit true values (`1`, `true`, `yes`, `on`) and explicit false values (`0`, `false`, `no`, `off`).
  - Decide and document whether an empty env value means unset or invalid; for safety-sensitive flags prefer invalid.
  - Validate all boolean env fields with env-name-specific errors.

  Acceptance criteria:

  - `npm run validate-config` fails for malformed values like `treu`, `maybe`, and unsafe empty boolean env values.
  - Tests cover `TELEGRAM_REQUIRE_ALLOWLIST`, `TELEGRAM_SEND_ENABLED`, `TELEGRAM_DRY_RUN_DEFAULT`, `TELEGRAM_LIVE_SEND_APPROVAL_BYPASS`, and `TELEGRAM_EMBEDDINGS_ENABLED`.
  - The allowlist cannot be disabled by a typo.

- [x] 2. Make live sending safe by default.

  Status 2026-06-29: Completed. Fresh runtime defaults and `.env.example` are now preview-only:
  `TELEGRAM_SEND_ENABLED=false` and `TELEGRAM_DRY_RUN_DEFAULT=true`. Live sending requires an explicit double opt-in
  (`TELEGRAM_SEND_ENABLED=true` plus `TELEGRAM_DRY_RUN_DEFAULT=false`) and still requires a matching `approval_id`
  unless the admin bypass is explicitly enabled. Hard dry-run / disabled sending are evaluated before the approval
  bypass, so `TELEGRAM_LIVE_SEND_APPROVAL_BYPASS=true` cannot override safe defaults.

  Verification 2026-06-29:

  - `node --test --import tsx tests/config-validation.test.ts --test-reporter=spec`
  - `node --test --import tsx tests/send-safety.test.ts --test-reporter=spec`
  - `npm run validate-config`
  - `npm run print-config`

  Problem:
  Runtime defaults still have `TELEGRAM_SEND_ENABLED=true` and `TELEGRAM_DRY_RUN_DEFAULT=false`, and `.env.example` mirrors live-send defaults. Approval gates reduce risk, but a fresh deployment should not be live-post capable until the operator opts in.

  Relevant files:

  - `src/config.ts`
  - `.env.example`
  - `README.md`
  - `codex-skill/telegram-parilka-mcp/references/safety.md`
  - `tests/send-safety.test.ts`

  TODO:

  - Default `sendEnabled` to false, or default `dryRunDefault` to true, or require an explicit live-send env acknowledgement.
  - Keep hard dry-run stronger than approval bypass.
  - Update docs to describe the opt-in path for live sends.

  Acceptance criteria:

  - With unset env or copied `.env.example`, `send_message` cannot post live even with `dry_run:false`.
  - Live send requires explicit live env plus a matching approval.
  - Tests prove hard dry-run and `TELEGRAM_SEND_ENABLED=false` win over `TELEGRAM_LIVE_SEND_APPROVAL_BYPASS=true`.

- [x] 3. Add real migrations for send outbox and throttle tables.

  Status 2026-06-29: Completed. Schema version is now 7 and includes an explicit idempotent migration for
  `send_outbox`, `send_throttle_state`, `idx_send_outbox_chat_status`, and `idx_send_outbox_user_status`. Existing
  DBs at version 5 or 6 now receive the durable send/audit schema during startup validation without losing existing
  chat/message data.

  Verification 2026-06-29:

  - `node --test --import tsx tests/store-migrations.test.ts --test-reporter=spec`
  - `npm run status`
  - live DB schema probe: `PRAGMA user_version` returned `7`; `send_outbox`, `send_throttle_state`, and both send
    indexes were present

  Problem:
  `send_outbox` and `send_throttle_state` are present in the base schema, but existing versioned DBs can skip their creation. A version-5 DB can fail startup validation with missing `send_outbox`.

  Relevant files:

  - `src/store.ts`
  - `tests/store-migrations.test.ts`

  TODO:

  - Add an explicit schema migration version for `send_outbox`, `send_throttle_state`, and their indexes.
  - Include fixture/probe coverage for a DB at the previous schema version without these tables.
  - Preserve existing data while migrating.

  Acceptance criteria:

  - A version-5 fixture DB opens successfully and reaches current schema version.
  - `send_outbox`, `send_throttle_state`, and indexes exist after migration.
  - `npm run status` works on an existing live DB after migration.

- [ ] 4. Reconcile active send outbox rows on startup.

  Problem:
  The executable send queue lives in memory, while SQLite stores only send metadata. After a restart, persisted `queued` or `sending` rows have no worker. A crash after Telegram accepts a send but before `markSendSent()` can also leave ambiguous state that may later be retried and duplicate a live post.

  Relevant files:

  - `src/throttler.ts`
  - `src/store.ts`
  - `src/tools.ts`
  - `tests/send-safety.test.ts`

  TODO:

  - Define startup reconciliation policy for `queued` and `sending` rows.
  - Do not auto-send old in-flight rows unless the full payload and a safe recovery protocol are implemented.
  - Mark abandoned active rows as `failed`, `expired`, or `unknown` so they do not count as active forever.
  - Add explicit handling for crash-after-send-before-audit ambiguity.

  Acceptance criteria:

  - Fresh `TelegramTools` over a DB with active rows does not leave them counted as active without a worker.
  - Ambiguous post-send crashes never auto-send duplicates.
  - Tests simulate queued, sending, expired, failed, and sent rows across a fresh tools/store instance.

- [ ] 5. Normalize real GramJS flood and slowmode errors.

  Problem:
  Error normalization handles string patterns like `FLOOD_WAIT_30`, but real GramJS `FloodWaitError` and `SlowModeWaitError` expose `errorMessage` and `seconds`. These currently normalize as non-retryable internal errors, so daemon backoff and send throttling can ignore Telegram retry-after semantics.

  Relevant files:

  - `src/errors.ts`
  - `src/sync-daemon.ts`
  - `src/throttler.ts`
  - `tests/flood-handling.test.ts`

  TODO:

  - Normalize GramJS flood/slowmode classes and `error.seconds`.
  - Ensure daemon delay honors `retryAfterSec`.
  - Add not-before handling for send queues after chat-level slowmode/flood failures.

  Acceptance criteria:

  - Tests using real GramJS `FloodWaitError({ capture: "42" })` and `SlowModeWaitError` produce `category:"rate_limit"`, `retryable:true`, and `retryAfterSec:42`.
  - Daemon delay is at least the retry-after duration.
  - A send queue does not dispatch the next chat job before a known slowmode/flood not-before timestamp.

- [ ] 6. Make large recent catch-up progress across ticks.

  Problem:
  Recent sync keeps the contiguous high-water mark safe, but if the backlog exceeds `TELEGRAM_MAX_SYNC_LIMIT`, it can flush rows then throw before advancing state. The next tick may refetch the same pages forever.

  Relevant files:

  - `src/sync-engine.ts`
  - `src/store.ts`
  - `src/tools.ts`
  - `tests/sync-engine.test.ts`

  TODO:

  - Add a bounded catch-up cursor or progress marker for recent catch-up.
  - Preserve contiguous-safety guarantees while allowing multi-tick progress.
  - Expose catch-up state in status/health.

  Acceptance criteria:

  - A simulated backlog larger than `TELEGRAM_MAX_SYNC_LIMIT` makes forward progress over multiple daemon ticks.
  - Already stored pages are not refetched forever.
  - Status reports a clear `catching_up` or equivalent state instead of repeated generic failures.

- [ ] 7. Make runtime tool validation match MCP schemas.

  Problem:
  Tool schemas advertise `additionalProperties:false`, but runtime Zod schemas strip unknown keys. Typos such as `befor_id` can be silently ignored while returning `ok:true`.

  Relevant files:

  - `src/tools.ts`
  - `tests/tools-response.test.ts`
  - `codex-skill/telegram-parilka-mcp/references/tool-map.md`

  TODO:

  - Make all runtime tool argument schemas strict.
  - Return normalized validation errors with field paths for unknown keys.
  - Remove stale references to unsupported args such as `user_key`, or intentionally support them with server-owned constraints.

  Acceptance criteria:

  - Unknown args return `ok:false`, `error.category:"validation"`, and a path naming the unknown key.
  - List-tools JSON schema and runtime behavior match.
  - Tests cover unknown keys for representative read, sync, search, index, preview, and send tools.

- [ ] 8. Namespace embeddings by provider configuration.

  Problem:
  Vector chunks are scoped by model and dimensions, but not by embedding provider/base URL or normalization version. Changing provider with the same model/dimensions can reuse old vectors and avoid first-run confirmation.

  Relevant files:

  - `src/store.ts`
  - `src/vector-rag.ts`
  - `src/embeddings.ts`
  - `tests/vector-rag.test.ts`

  TODO:

  - Add an embedding namespace/hash covering provider/base URL, model, dimensions, and vector normalization version.
  - Scope coverage, search, first-run confirmation, rebuild, dirty cleanup, and stats by namespace.
  - Migrate old chunks into a legacy namespace or require explicit rebuild.

  Acceptance criteria:

  - Changing provider or model reports uncovered messages and requires confirmation before external API calls.
  - Search never compares query vectors against chunks from another namespace.
  - Stats expose namespace enough for operators to understand what is indexed.

- [ ] 9. Fix vector search range filters.

  Problem:
  Vector `before_id`/`after_id` filtering selects chunks by overlap, then hydrates every member message. A chunk spanning `[1,2]` can return message `1` for `after_id:1`.

  Relevant files:

  - `src/store.ts`
  - `src/vector-rag.ts`
  - `src/tools.ts`
  - `tests/vector-rag.test.ts`

  TODO:

  - Choose semantics: return only chunks wholly inside the requested window, or trim chunk message IDs/messages/text to the requested window.
  - Apply the same semantics to semantic search and hybrid search.
  - Document the range behavior.

  Acceptance criteria:

  - `after_id:1` never returns message `1`.
  - `before_id:2` never returns message `2`.
  - Tests cover semantic-only and hybrid results with overlapping chunks.

- [ ] 10. Test deployed entrypoints, not only source entrypoints.

  Problem:
  CI smoke starts `tsx src/index.ts`, while MCP clients and systemd wrappers run built `dist/*.js`. `dist/` is ignored, so a fresh deploy or stale build can pass CI but fail in production.

  Relevant files:

  - `.github/workflows/ci.yml`
  - `scripts/smoke-mcp.ts`
  - `bin/telegram-parilka-mcp`
  - `bin/telegram-parilka-mcp-sync-daemon`
  - `systemd/telegram-parilka-mcp-sync.service`
  - `package.json`

  TODO:

  - Add CI `npm run build`.
  - Add post-build smoke using `./bin/telegram-parilka-mcp`, the same entrypoint documented for MCP clients.
  - Add shell syntax checks or shellcheck for wrappers.
  - Make service startup fail clearly if `dist` is missing or stale.

  Acceptance criteria:

  - Clean checkout CI proves the project builds.
  - CI smoke verifies `tools/list` and `get_config` through the wrapper path.
  - Systemd deployment docs include build-before-restart.

## P2 - Correctness, Durability, And Operator Trust

- [ ] 11. Guard send outbox state transitions.

  Problem:
  `markSendSending()` does not verify that a queued row was actually transitioned before Telegram send starts. Sent/failed/expired updates can overwrite terminal states.

  Relevant files:

  - `src/store.ts`
  - `src/throttler.ts`
  - `tests/send-safety.test.ts`

  TODO:

  - Make state transitions conditional and check `changes`.
  - Abort before Telegram when a row is stale, expired, or no longer queued.
  - Prevent non-terminal updates from overwriting terminal states.

  Acceptance criteria:

  - Zero-row transition aborts before Telegram send.
  - `sent` cannot be overwritten by `failed` or `expired`.
  - Tests cover stale queued, expired queued, terminal sent, terminal failed, and terminal expired rows.

- [ ] 12. Preflight reply targets before approval and reservation.

  Problem:
  Preview/dry-run validates only positive reply IDs. Invalid or deleted reply targets are discovered only by Telegram after approval consumption, outbox reservation, and cooldown mutation.

  Relevant files:

  - `src/tools.ts`
  - `src/store.ts`
  - `src/telegram-client.ts`
  - `tests/send-safety.test.ts`

  TODO:

  - Validate reply target exists in the resolved chat via cache or bounded live lookup.
  - Include target excerpt metadata in preview when available.
  - Do not consume approval, reserve outbox, or mutate cooldown when reply target validation fails.

  Acceptance criteria:

  - Invalid replies return `category:"reply"` or another explicit non-retryable category.
  - No outbox or cooldown row is created on invalid reply.
  - `reply_to_message` has tests for no approval, matching approval, mismatched message ID, consumed approval, expired approval, and admin bypass.

- [ ] 13. Define and implement dedupe TTL semantics.

  Problem:
  `TELEGRAM_DEDUPE_TTL_MS` is parsed and exposed, but sent dedupe keys are effectively permanent because `dedupe_key` is unique and duplicate-sent handling ignores TTL.

  Relevant files:

  - `src/config.ts`
  - `src/store.ts`
  - `src/throttler.ts`
  - `tests/send-safety.test.ts`

  TODO:

  - Decide whether dedupe keys are permanent audit IDs or TTL-scoped retry IDs.
  - Either enforce TTL cleanup/reuse safely, or remove/rename the config.
  - Document the chosen semantics.

  Acceptance criteria:

  - Tests prove dedupe behavior before and after TTL expiry.
  - Docs and config names match the behavior.

- [ ] 14. Filter tombstoned messages from FTS search.

  Problem:
  Tombstoning clears text but leaves sender name indexed. `searchWithRank()` does not filter `deleted_at IS NULL`, so deleted messages can still match sender searches.

  Relevant files:

  - `src/store.ts`
  - `tests/sync-engine.test.ts`
  - `tests/tools-response.test.ts`

  TODO:

  - Filter deleted rows in FTS search.
  - Consider indexing empty sender/text for tombstones.
  - Rebuild FTS if trigger definitions change.

  Acceptance criteria:

  - After tombstoning an Alice message, searches for old text and `Alice` return zero results.
  - FTS behavior is covered for insert, update, delete/tombstone, and migration rebuild.

- [ ] 15. Use MCP-level error signaling or document JSON-only errors.

  Problem:
  Tool failures are returned as JSON `{ ok:false }` inside a successful MCP tool result. Clients that rely on MCP `isError` may treat validation/auth/rate-limit failures as successful unless they parse the JSON body.

  Relevant files:

  - `src/tools.ts`
  - `src/index.ts`
  - `tests/tools-response.test.ts`
  - `codex-skill/telegram-parilka-mcp/references/tool-map.md`

  TODO:

  - Decide whether to add `isError:true` for failed tool results while preserving JSON payloads.
  - If not, explicitly document JSON-only error handling and client expectations.

  Acceptance criteria:

  - Tests assert the selected MCP-level failure signal for validation failures.
  - Tool docs match behavior.

- [ ] 16. Normalize `search_messages` result counters and partial-success metadata.

  Problem:
  `hybrid.count` can disagree with `hybrid.hits.length` after dedupe. `search_messages` also returns top-level `messages` as keyword-only while vector failures are downgraded into nested metadata with top-level `ok:true`.

  Relevant files:

  - `src/tools.ts`
  - `src/vector-rag.ts`
  - `tests/tools-response.test.ts`
  - `codex-skill/telegram-parilka-mcp/references/tool-map.md`

  TODO:

  - Compute hybrid hits once and set `count` to `hits.length`.
  - Add `raw_candidate_count` if useful.
  - Add `degraded_channels` or `partial_failure` metadata for vector-disabled/provider-failed/candidate-limit cases.
  - Either deprecate top-level keyword-only `messages` or add canonical flattened `results`.

  Acceptance criteria:

  - `hybrid.count === hybrid.hits.length` in overlap cases.
  - Tests cover embeddings disabled, no index, provider failure, candidate-limit failure, keyword-only, vector-only, and hybrid-overlap cases.
  - Docs clearly tell agents which field to read first.

- [ ] 17. Finish cache completeness semantics and tests.

  Problem:
  The current TODO/docs claim empty windows distinguish every case, but `emptyReason()` does not return a reason for within-range gaps. Test coverage exercises only a subset of branches.

  Relevant files:

  - `src/tools.ts`
  - `tests/tools-response.test.ts`
  - `codex-skill/telegram-parilka-mcp/references/tool-map.md`

  TODO:

  - Define every `completeness` and `empty_reason` value.
  - Add a clear reason for zero rows inside cached range.
  - Test empty cache, before-range miss, after-range miss, impossible `after_id >= before_id`, within-cache gap, context outside-range, and context partial-range cases.

  Acceptance criteria:

  - Every documented cache metadata branch is asserted by tests.
  - Empty results are never ambiguous for agents.

- [ ] 18. Align skill docs and runbook with current tool behavior.

  Problem:
  Skill workflow still starts with live `get_chat_info` instead of cache-only `get_status`. Safety docs mention `user_key`, which is no longer exposed. Vector RAG runbook shows first-run indexing without the required confirmation flow.

  Relevant files:

  - `codex-skill/telegram-parilka-mcp/SKILL.md`
  - `codex-skill/telegram-parilka-mcp/references/safety.md`
  - `codex-skill/telegram-parilka-mcp/references/runbook.md`
  - `codex-skill/telegram-parilka-mcp/references/tool-map.md`
  - `README.md`

  TODO:

  - Make `get_status` the default first read for cache/health tasks.
  - Remove stale `user_key` instructions.
  - Show vector indexing as estimate-first, then `--confirm-estimate`.
  - Document cache-only vs live-resolving tools.

  Acceptance criteria:

  - An agent following the skill can inspect cache freshness without unnecessary Telegram network calls.
  - Operators can tell whether they estimated or actually indexed embeddings.

- [ ] 19. Share env loading for session generation.

  Problem:
  Runtime config uses the new shared/local dotenv precedence, but `generate-session` uses plain `dotenv/config` and its own parsing.

  Relevant files:

  - `src/config.ts`
  - `src/generate-session.ts`
  - `bin/telegram-parilka-mcp-generate-session`
  - `tests/config-validation.test.ts`

  TODO:

  - Share the env loader and validation path where practical.
  - Ensure session generation honors `TELEGRAM_SHARED_ENV_PATH`, `TELEGRAM_ENV_PATH`, and real env precedence consistently.

  Acceptance criteria:

  - Tests prove session generation and runtime config resolve API ID/hash/phone/session env values consistently.
  - Invalid API ID fails clearly.

- [ ] 20. Redact credentials in embedding base URLs.

  Problem:
  Redacted config returns `TELEGRAM_EMBEDDINGS_BASE_URL` as-is. If it contains username/password or token query params, `--print-config` and `get_config` can leak credentials.

  Relevant files:

  - `src/config.ts`
  - `src/tools.ts`
  - `tests/config-validation.test.ts`
  - `tests/tools-response.test.ts`

  TODO:

  - Sanitize URL username/password.
  - Redact known token-like query params such as `api_key`, `key`, `token`, `access_token`, and `authorization`.
  - Reuse the sanitizer in CLI config and MCP `get_config`.

  Acceptance criteria:

  - Tests cover `https://user:pass@example.test?api_key=x&foo=bar`.
  - Redacted output preserves host/path and non-secret params while hiding credentials.

- [ ] 21. Version FTS/trigger definitions and make heavy migrations resumable.

  Problem:
  Startup migrations mostly validate object existence, not exact FTS/trigger definitions. Large FTS rebuilds and embedding membership backfills can run inside startup transactions and block peer processes.

  Relevant files:

  - `src/store.ts`
  - `tests/store-migrations.test.ts`

  TODO:

  - Version FTS and trigger definitions explicitly.
  - Recreate stale definitions when they differ.
  - Move heavy rebuild/backfill work into preflighted or resumable maintenance steps when needed.

  Acceptance criteria:

  - Fixture DBs with stale trigger/FTS definitions are repaired.
  - Large chunk backfills do not make normal startup hold long write locks.
  - Operators get a clear maintenance command or status when heavy migration work is pending.

- [ ] 22. Make embedding coverage stats bounded.

  Problem:
  `getEmbeddingCoverageStats()` materializes every uncovered message ID into JS to compute counts/ranges. On 500k-message caches with no embeddings, status or estimates can become expensive.

  Relevant files:

  - `src/store.ts`
  - `src/vector-rag.ts`
  - `scripts/benchmark-vector-search.ts`

  TODO:

  - Compute uncovered count and range count in SQL, or expose bounded/sample stats.
  - Add a benchmark or test fixture for large uncovered sets.

  Acceptance criteria:

  - A 500k-message zero-embedding DB returns status/estimate within documented latency and memory bounds.
  - Coverage stats remain accurate or clearly labeled as sampled.

- [ ] 23. Apply MCP embedding budget confirmation rules to the CLI.

  Problem:
  The MCP `index_embeddings` tool requires confirmation when budget truncation happens, but `embed-index.ts` only handles first-run confirmation.

  Relevant files:

  - `src/embed-index.ts`
  - `src/vector-rag.ts`
  - `tests/embeddings-opt-in.test.ts`

  TODO:

  - Share the same estimate/confirmation gate between CLI and MCP.
  - Make CLI output explicit when it estimated only versus indexed.

  Acceptance criteria:

  - CLI returns estimate-only when chunk/char budget truncates unless `--confirm-estimate` is passed.
  - Tests cover first-run confirmation and budget-truncation confirmation.

- [ ] 24. Harden systemd deployment persistence.

  Problem:
  The current user unit depends on root user-service behavior and ambient PATH for `/usr/bin/env bash` and `node`. Runbook does not make boot persistence self-contained.

  Relevant files:

  - `systemd/telegram-parilka-mcp-sync.service`
  - `bin/telegram-parilka-mcp-sync-daemon`
  - `codex-skill/telegram-parilka-mcp/references/runbook.md`

  TODO:

  - Either document `loginctl enable-linger root` and PATH expectations, or ship a system unit with explicit `User=` and `WantedBy=multi-user.target`.
  - Pin Node path or set a known PATH in the unit.
  - Add `systemd-analyze verify` guidance.

  Acceptance criteria:

  - Daemon remains active after reboot without interactive root login.
  - Unit verification passes.
  - Docs include exact install, restart, status, and rollback commands.

- [ ] 25. Record or tolerate disconnect failures in the daemon.

  Problem:
  `telegram.disconnect()` runs in `finally`; if it throws after a tick, the daemon can exit through the fatal handler without recording the disconnect failure in daemon status.

  Relevant files:

  - `src/sync-daemon.ts`
  - `tests/flood-handling.test.ts`

  TODO:

  - Make disconnect best-effort, or record disconnect errors before exiting.
  - Decide whether disconnect failure should affect backoff.

  Acceptance criteria:

  - A fake disconnect rejection is covered by tests.
  - The daemon either logs and continues safely or records `daemon_status.lastError`.

## P3 - Test And Hygiene Follow-Ups

- [ ] 26. Add secret-scan regression tests.

  Problem:
  CI runs `npm run secret-scan`, but there are no fixture tests proving detection for supported secret classes.

  Relevant files:

  - `scripts/secret-scan.ts`
  - `tests/`

  TODO:

  - Add tests with synthetic fixture files for OpenAI-compatible keys, Telegram API hashes, Telegram StringSession values, and private keys.
  - Ensure findings are redacted and file/line reporting works.

  Acceptance criteria:

  - Regex changes cannot silently stop detecting supported secret classes.
  - Secret values are never printed in test failures.

- [ ] 27. Restart or redeploy the live daemon after build changes.

  Problem:
  The live systemd process was started before the latest `dist` rebuild, so the new daemon status writer was not active even though source and local `dist` had been updated. Live `get_status` showed fresh sync timestamps but `daemon:null`.

  Relevant files:

  - `systemd/telegram-parilka-mcp-sync.service`
  - `README.md`
  - `codex-skill/telegram-parilka-mcp/references/runbook.md`

  TODO:

  - Add a documented build-and-restart deploy step.
  - After restart, verify `get_status.daemon` is populated after the next tick.
  - Add rollback command guidance.

  Acceptance criteria:

  - `systemctl --user restart telegram-parilka-mcp-sync.service` after build picks up current `dist`.
  - Within one daemon tick, `get_status` includes non-null `daemon.lastStartedAt` and `daemon.lastSuccessAt` or a recorded failure.
  - Runbook tells operators how to confirm the running PID started after the deployed build.
