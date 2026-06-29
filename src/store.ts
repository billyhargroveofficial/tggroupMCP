import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { EmbeddingChunkVector } from "./embeddings.js";
import { ToolError } from "./errors.js";
import type { ChatInfo } from "./telegram-client.js";

export type StoredMessage = {
  id?: number;
  chatId: string;
  messageId: number;
  date?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  replyToMessageId?: number;
  topicId?: number;
  rawJson?: string;
};

export type SyncState = {
  chatId: string;
  oldestMessageId?: number;
  newestMessageId?: number;
  nextBackfillOffsetId?: number;
  syncedCount: number;
  lastRecentSyncAt?: string;
  lastBackfillAt?: string;
  lastError?: string;
  updatedAt?: string;
};

export type KeywordSearchHit = {
  message: StoredMessage;
  rank: number;
};

export type StoredEmbeddingChunk = {
  id: number;
  chatId: string;
  startMessageId: number;
  endMessageId: number;
  messageCount: number;
  text: string;
  model: string;
  dimensions: number;
  embedding: Uint8Array;
  contentHash: string;
  updatedAt: string;
};

export type SendOutboxStatus = "queued" | "sending" | "sent" | "failed" | "expired";

export type StoredSendOutboxItem = {
  id: string;
  dedupeKey?: string;
  payloadHash: string;
  chatId: string;
  replyToMessageId?: number;
  userKey: string;
  status: SendOutboxStatus;
  telegramMessageId?: number;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  queuedAtMs?: number;
  sendingAtMs?: number;
  sentAtMs?: number;
  expiresAtMs: number;
};

export type SendReservation =
  | {
      kind: "queued";
      outboxId: string;
      expiresAtMs: number;
    }
  | {
      kind: "duplicate_sent";
      outboxId: string;
      chatId: string;
      telegramMessageId?: number;
    };

export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  upsertChat(chat: ChatInfo): void {
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, title, username, kind, is_forum, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           title = excluded.title,
           username = excluded.username,
           kind = excluded.kind,
           is_forum = excluded.is_forum,
           updated_at = excluded.updated_at`,
      )
      .run(chat.chatId, chat.title ?? null, chat.username ?? null, chat.kind, chat.isForum ? 1 : 0);
  }

  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number {
    this.upsertChat(chat);
    const stmt = this.db.prepare(
      `INSERT INTO messages (
         chat_id, message_id, date, sender_id, sender_name, text,
         reply_to_message_id, topic_id, raw_json, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id, message_id) DO UPDATE SET
         date = excluded.date,
         sender_id = excluded.sender_id,
         sender_name = excluded.sender_name,
         text = excluded.text,
         reply_to_message_id = excluded.reply_to_message_id,
         topic_id = excluded.topic_id,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
    );
    this.db.exec("BEGIN");
    try {
      for (const row of messages) {
        stmt.run(
          row.chatId,
          row.messageId,
          row.date ?? null,
          row.senderId ?? null,
          row.senderName ?? null,
          row.text,
          row.replyToMessageId ?? null,
          row.topicId ?? null,
          row.rawJson ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return new Set(messages.map((message) => `${message.chatId}:${message.messageId}`)).size;
  }

  getCachedChat(chatId: string): ChatInfo | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return rowToChatInfo(row);
  }

  getHistory(params: {
    chatId: string;
    limit: number;
    beforeId?: number;
    afterId?: number;
    order?: "asc" | "desc";
  }): StoredMessage[] {
    const order = params.order === "asc" ? "ASC" : "DESC";
    const clauses = ["chat_id = ?"];
    const values: unknown[] = [params.chatId];
    if (params.beforeId != null) {
      clauses.push("message_id < ?");
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      clauses.push("message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY message_id ${order}
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  search(params: { chatId: string; query: string; limit: number; beforeId?: number; afterId?: number }): StoredMessage[] {
    return this.searchWithRank(params).map((hit) => hit.message);
  }

  searchWithRank(params: { chatId: string; query: string; limit: number; beforeId?: number; afterId?: number }): KeywordSearchHit[] {
    const clauses = ["m.chat_id = ?", "messages_fts MATCH ?"];
    const values: unknown[] = [params.chatId, escapeFtsQuery(params.query)];
    if (params.beforeId != null) {
      clauses.push("m.message_id < ?");
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      clauses.push("m.message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(messages_fts) AS fts_rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY fts_rank ASC, m.message_id DESC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map((row) => ({
      message: rowToStoredMessage(row),
      rank: Number(row.fts_rank ?? 0),
    }));
  }

  getThreadContext(params: { chatId: string; messageId: number; before: number; after: number }): StoredMessage[] {
    const min = params.messageId - params.before;
    const max = params.messageId + params.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND message_id BETWEEN ? AND ?
         ORDER BY message_id ASC`,
      )
      .all(params.chatId, min, max) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getMessagesForEmbedding(params: { chatId: string; afterId?: number; limit: number }): StoredMessage[] {
    const clauses = ["chat_id = ?", "length(trim(text)) > 0"];
    const values: unknown[] = [params.chatId];
    if (params.afterId != null) {
      clauses.push("message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY message_id ASC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getMessagesInRange(params: { chatId: string; startMessageId: number; endMessageId: number; limit?: number }): StoredMessage[] {
    const limit = params.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND message_id BETWEEN ? AND ?
         ORDER BY message_id ASC
         LIMIT ?`,
      )
      .all(params.chatId, params.startMessageId, params.endMessageId, limit) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  updateSyncState(
    chat: ChatInfo,
    state: {
      oldestMessageId?: number;
      newestMessageId?: number;
      nextBackfillOffsetId?: number;
      syncedCount: number;
      mode?: "recent" | "backfill" | "manual";
      error?: string | null;
    },
  ): void {
    this.upsertChat(chat);
    this.db
      .prepare(
        `INSERT INTO sync_state (
           chat_id, oldest_message_id, newest_message_id, next_backfill_offset_id,
           synced_count, last_recent_sync_at, last_backfill_at, last_error, updated_at
         )
         VALUES (
           ?, ?, ?, ?, ?,
           CASE WHEN ? = 'recent' THEN datetime('now') ELSE NULL END,
           CASE WHEN ? = 'backfill' THEN datetime('now') ELSE NULL END,
           ?, datetime('now')
         )
         ON CONFLICT(chat_id) DO UPDATE SET
           oldest_message_id = CASE
             WHEN excluded.oldest_message_id IS NULL THEN sync_state.oldest_message_id
             WHEN sync_state.oldest_message_id IS NULL THEN excluded.oldest_message_id
             WHEN excluded.oldest_message_id < sync_state.oldest_message_id THEN excluded.oldest_message_id
             ELSE sync_state.oldest_message_id
           END,
           newest_message_id = CASE
             WHEN excluded.newest_message_id IS NULL THEN sync_state.newest_message_id
             WHEN sync_state.newest_message_id IS NULL THEN excluded.newest_message_id
             WHEN excluded.newest_message_id > sync_state.newest_message_id THEN excluded.newest_message_id
             ELSE sync_state.newest_message_id
           END,
           next_backfill_offset_id = COALESCE(excluded.next_backfill_offset_id, sync_state.next_backfill_offset_id),
           synced_count = excluded.synced_count,
           last_recent_sync_at = COALESCE(excluded.last_recent_sync_at, sync_state.last_recent_sync_at),
           last_backfill_at = COALESCE(excluded.last_backfill_at, sync_state.last_backfill_at),
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        chat.chatId,
        state.oldestMessageId ?? null,
        state.newestMessageId ?? null,
        state.nextBackfillOffsetId ?? null,
        state.syncedCount,
        state.mode ?? "manual",
        state.mode ?? "manual",
        state.error ?? null,
      );
  }

  getSyncState(chatId: string): SyncState | undefined {
    const row = this.db.prepare("SELECT * FROM sync_state WHERE chat_id = ?").get(chatId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return undefined;
    }
    return rowToSyncState(row);
  }

  countMessages(chatId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get(chatId) as
      | Record<string, unknown>
      | undefined;
    return Number(row?.count ?? 0);
  }

  getEmbeddingCursor(params: { chatId: string; model: string; dimensions?: number }): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(end_message_id) AS cursor
         FROM message_embedding_chunks
         WHERE chat_id = ? AND embedding_model = ? AND (? IS NULL OR embedding_dimensions = ?)`,
      )
      .get(params.chatId, params.model, params.dimensions ?? null, params.dimensions ?? null) as
      | Record<string, unknown>
      | undefined;
    return row?.cursor == null ? undefined : Number(row.cursor);
  }

  upsertEmbeddingChunks(chunks: EmbeddingChunkVector[]): number {
    if (chunks.length === 0) {
      return 0;
    }
    const stmt = this.db.prepare(
      `INSERT INTO message_embedding_chunks (
         chat_id, start_message_id, end_message_id, message_count, text,
         embedding_model, embedding_dimensions, embedding, content_hash, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id, start_message_id, end_message_id, embedding_model, embedding_dimensions)
       DO UPDATE SET
         message_count = excluded.message_count,
         text = excluded.text,
         embedding = excluded.embedding,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
    );
    this.db.exec("BEGIN");
    try {
      for (const chunk of chunks) {
        stmt.run(
          chunk.chatId,
          chunk.startMessageId,
          chunk.endMessageId,
          chunk.messageCount,
          chunk.text,
          chunk.model,
          chunk.dimensions,
          chunk.embedding,
          chunk.contentHash,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return chunks.length;
  }

  deleteEmbeddingChunks(params: { chatId: string; model?: string; dimensions?: number }): number {
    const clauses = ["chat_id = ?"];
    const values: unknown[] = [params.chatId];
    if (params.model != null) {
      clauses.push("embedding_model = ?");
      values.push(params.model);
    }
    if (params.dimensions != null) {
      clauses.push("embedding_dimensions = ?");
      values.push(params.dimensions);
    }
    const result = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`).run(...toSqlValues(values));
    return Number(result.changes ?? 0);
  }

  getEmbeddingChunks(params: {
    chatId: string;
    model: string;
    dimensions?: number;
    beforeId?: number;
    afterId?: number;
  }): StoredEmbeddingChunk[] {
    const clauses = ["chat_id = ?", "embedding_model = ?"];
    const values: unknown[] = [params.chatId, params.model];
    if (params.dimensions != null) {
      clauses.push("embedding_dimensions = ?");
      values.push(params.dimensions);
    }
    if (params.beforeId != null) {
      clauses.push("start_message_id < ?");
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      clauses.push("end_message_id > ?");
      values.push(params.afterId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM message_embedding_chunks
         WHERE ${clauses.join(" AND ")}
         ORDER BY start_message_id ASC`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToEmbeddingChunk);
  }

  getEmbeddingStats(chatId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT
           embedding_model AS model,
           embedding_dimensions AS dimensions,
           COUNT(*) AS chunks,
           MIN(start_message_id) AS oldest_message_id,
           MAX(end_message_id) AS newest_message_id,
           SUM(message_count) AS indexed_messages,
           MAX(updated_at) AS updated_at
         FROM message_embedding_chunks
         WHERE chat_id = ?
         GROUP BY embedding_model, embedding_dimensions
         ORDER BY updated_at DESC`,
      )
      .all(chatId) as Record<string, unknown>[];
  }

  reserveSend(params: {
    outboxId: string;
    dedupeKey?: string;
    payloadHash: string;
    chatId: string;
    replyToMessageId?: number;
    userKey: string;
    nowMs: number;
    maxAgeMs: number;
    userCooldownMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
  }): SendReservation {
    const expiresAtMs = params.nowMs + params.maxAgeMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.expireStaleSendsLocked(params.nowMs);
      const existing = params.dedupeKey == null ? undefined : this.getSendByDedupeKeyLocked(params.dedupeKey);
      if (existing) {
        if (existing.payloadHash !== params.payloadHash) {
          throw new ToolError({
            category: "rate_limit",
            retryable: false,
            message: "dedupe_key has already been used for a different send payload.",
          });
        }
        if (existing.status === "sent") {
          this.db.exec("COMMIT");
          return {
            kind: "duplicate_sent",
            outboxId: existing.id,
            chatId: existing.chatId,
            telegramMessageId: existing.telegramMessageId,
          };
        }
        if ((existing.status === "queued" || existing.status === "sending") && existing.expiresAtMs > params.nowMs) {
          throw new ToolError({
            category: "rate_limit",
            retryable: true,
            message: "Send with this dedupe_key is already queued or sending.",
          });
        }
      }

      this.assertSendThrottleAvailable(params);

      if (existing) {
        this.db
          .prepare(
            `UPDATE send_outbox
             SET chat_id = ?, reply_to_message_id = ?, user_key = ?, status = 'queued',
                 telegram_message_id = NULL, error = NULL, updated_at_ms = ?,
                 queued_at_ms = ?, sending_at_ms = NULL, sent_at_ms = NULL, expires_at_ms = ?
             WHERE id = ?`,
          )
          .run(
            params.chatId,
            params.replyToMessageId ?? null,
            params.userKey,
            params.nowMs,
            params.nowMs,
            expiresAtMs,
            existing.id,
          );
        this.updateSendCooldownLocked(params.chatId, params.userKey, params.nowMs + params.userCooldownMs, params.nowMs);
        this.db.exec("COMMIT");
        return { kind: "queued", outboxId: existing.id, expiresAtMs };
      }

      this.db
        .prepare(
          `INSERT INTO send_outbox (
             id, dedupe_key, payload_hash, chat_id, reply_to_message_id, user_key,
             status, created_at_ms, updated_at_ms, queued_at_ms, expires_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(
          params.outboxId,
          params.dedupeKey ?? null,
          params.payloadHash,
          params.chatId,
          params.replyToMessageId ?? null,
          params.userKey,
          params.nowMs,
          params.nowMs,
          params.nowMs,
          expiresAtMs,
        );
      this.updateSendCooldownLocked(params.chatId, params.userKey, params.nowMs + params.userCooldownMs, params.nowMs);
      this.db.exec("COMMIT");
      return { kind: "queued", outboxId: params.outboxId, expiresAtMs };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markSendSending(outboxId: string, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE send_outbox
         SET status = 'sending', sending_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(nowMs, nowMs, outboxId);
  }

  markSendSent(outboxId: string, telegramMessageId: number | undefined, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE send_outbox
         SET status = 'sent', telegram_message_id = ?, sent_at_ms = ?, updated_at_ms = ?, error = NULL
         WHERE id = ?`,
      )
      .run(telegramMessageId ?? null, nowMs, nowMs, outboxId);
  }

  markSendFailed(outboxId: string, error: string, nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE send_outbox
         SET status = 'failed', error = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(error, nowMs, outboxId);
  }

  markSendExpired(outboxId: string, error = "Queued send expired before execution.", nowMs = Date.now()): void {
    this.db
      .prepare(
        `UPDATE send_outbox
         SET status = 'expired', error = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(error, nowMs, outboxId);
  }

  getSendOutboxByDedupeKey(dedupeKey: string): StoredSendOutboxItem | undefined {
    return this.getSendByDedupeKeyLocked(dedupeKey);
  }

  startHistoryJob(chatId: string, direction: "recent" | "backfill" | "manual", targetCount: number): string {
    const jobId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .prepare(
        `INSERT INTO history_jobs (job_id, chat_id, direction, status, target_count, started_at)
         VALUES (?, ?, ?, 'running', ?, datetime('now'))`,
      )
      .run(jobId, chatId, direction, targetCount);
    return jobId;
  }

  finishHistoryJob(
    jobId: string,
    result: { status: "done" | "failed"; batches: number; messagesSeen: number; messagesUpserted: number; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE history_jobs
         SET status = ?, finished_at = datetime('now'), batches = ?, messages_seen = ?,
             messages_upserted = ?, error = ?
         WHERE job_id = ?`,
      )
      .run(result.status, result.batches, result.messagesSeen, result.messagesUpserted, result.error ?? null, jobId);
  }

  getStats(chatId: string): Record<string, unknown> {
    const messageStats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(message_id) AS oldest_message_id, MAX(message_id) AS newest_message_id
         FROM messages WHERE chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown>;
    const syncState =
      (this.db.prepare("SELECT * FROM sync_state WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined) ??
      {};
    return { ...messageStats, syncState, embeddings: this.getEmbeddingStats(chatId) };
  }

  private assertSendThrottleAvailable(params: {
    chatId: string;
    userKey: string;
    nowMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
  }): void {
    const cooldown = this.db
      .prepare(
        `SELECT next_allowed_at_ms
         FROM send_throttle_state
         WHERE chat_id = ? AND user_key = ?`,
      )
      .get(params.chatId, params.userKey) as Record<string, unknown> | undefined;
    const nextAllowedAtMs = Number(cooldown?.next_allowed_at_ms ?? 0);
    if (nextAllowedAtMs > params.nowMs) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        retryAfterSec: Math.ceil((nextAllowedAtMs - params.nowMs) / 1000),
        message: "Per-user cooldown is active.",
      });
    }

    const pendingUser = this.countActiveSendsLocked({
      chatId: params.chatId,
      userKey: params.userKey,
      nowMs: params.nowMs,
    });
    if (pendingUser >= params.maxPendingPerUserPerChat) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        message: "Per-user pending limit reached.",
      });
    }

    const pendingChat = this.countActiveSendsLocked({
      chatId: params.chatId,
      nowMs: params.nowMs,
    });
    if (pendingChat >= params.maxQueuePerChat) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        message: "Per-chat queue is full.",
      });
    }
  }

  private countActiveSendsLocked(params: { chatId: string; userKey?: string; nowMs: number }): number {
    const clauses = ["chat_id = ?", "status IN ('queued', 'sending')", "expires_at_ms > ?"];
    const values: unknown[] = [params.chatId, params.nowMs];
    if (params.userKey != null) {
      clauses.push("user_key = ?");
      values.push(params.userKey);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM send_outbox WHERE ${clauses.join(" AND ")}`)
      .get(...toSqlValues(values)) as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  }

  private updateSendCooldownLocked(chatId: string, userKey: string, nextAllowedAtMs: number, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO send_throttle_state (chat_id, user_key, next_allowed_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, user_key) DO UPDATE SET
           next_allowed_at_ms = excluded.next_allowed_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(chatId, userKey, nextAllowedAtMs, nowMs);
  }

  private expireStaleSendsLocked(nowMs: number): void {
    this.db
      .prepare(
        `UPDATE send_outbox
         SET status = 'expired', error = COALESCE(error, 'Queued send expired before execution.'), updated_at_ms = ?
         WHERE status IN ('queued', 'sending') AND expires_at_ms <= ?`,
      )
      .run(nowMs, nowMs);
  }

  private getSendByDedupeKeyLocked(dedupeKey: string): StoredSendOutboxItem | undefined {
    const row = this.db.prepare("SELECT * FROM send_outbox WHERE dedupe_key = ?").get(dedupeKey) as
      | Record<string, unknown>
      | undefined;
    return row == null ? undefined : rowToSendOutboxItem(row);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT,
        username TEXT,
        kind TEXT,
        is_forum INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        date TEXT,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        reply_to_message_id INTEGER,
        topic_id INTEGER,
        raw_json TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        chat_id TEXT PRIMARY KEY,
        oldest_message_id INTEGER,
        newest_message_id INTEGER,
        next_backfill_offset_id INTEGER,
        synced_count INTEGER NOT NULL DEFAULT 0,
        last_recent_sync_at TEXT,
        last_backfill_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history_jobs (
        job_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        target_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        batches INTEGER NOT NULL DEFAULT 0,
        messages_seen INTEGER NOT NULL DEFAULT 0,
        messages_upserted INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS send_outbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT UNIQUE,
        payload_hash TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        reply_to_message_id INTEGER,
        user_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'sent', 'failed', 'expired')),
        telegram_message_id INTEGER,
        error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        queued_at_ms INTEGER,
        sending_at_ms INTEGER,
        sent_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS send_throttle_state (
        chat_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        next_allowed_at_ms INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(chat_id, user_key)
      );

      CREATE TABLE IF NOT EXISTS message_embedding_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, start_message_id, end_message_id, embedding_model, embedding_dimensions)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        sender_name,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, sender_name)
        VALUES (new.id, new.text, new.sender_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
        VALUES ('delete', old.id, old.text, old.sender_name);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
        VALUES ('delete', old.id, old.text, old.sender_name);
        INSERT INTO messages_fts(rowid, text, sender_name)
        VALUES (new.id, new.text, new.sender_name);
      END;

      CREATE INDEX IF NOT EXISTS idx_messages_chat_message_id ON messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(chat_id, sender_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_lookup
        ON message_embedding_chunks(chat_id, embedding_model, embedding_dimensions);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_range
        ON message_embedding_chunks(chat_id, start_message_id, end_message_id);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_chat_status
        ON send_outbox(chat_id, status, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_user_status
        ON send_outbox(chat_id, user_key, status, expires_at_ms);
    `);
    this.ensureColumn("sync_state", "next_backfill_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "last_recent_sync_at", "TEXT");
    this.ensureColumn("sync_state", "last_backfill_at", "TEXT");
    this.ensureColumn("sync_state", "last_error", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function gramMessageToStored(chat: ChatInfo, message: any): StoredMessage | undefined {
  const messageId = Number(message?.id);
  if (!Number.isFinite(messageId)) {
    return undefined;
  }
  const text = String(message?.message ?? message?.text ?? "");
  const replyHeader = message?.replyTo;
  const date = message?.date ? new Date(Number(message.date) * 1000).toISOString() : undefined;

  return {
    chatId: chat.chatId,
    messageId,
    date,
    senderId: message?.senderId?.toString?.(),
    senderName: message?.sender?.username || message?.sender?.firstName || message?.sender?.title,
    text,
    replyToMessageId: numberOrUndefined(replyHeader?.replyToMsgId),
    topicId: numberOrUndefined(replyHeader?.topMsgId),
    rawJson: JSON.stringify({
      groupedId: message?.groupedId?.toString?.(),
      views: message?.views,
      forwards: message?.forwards,
      post: message?.post,
    }),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowToStoredMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    messageId: Number(row.message_id),
    date: row.date == null ? undefined : String(row.date),
    senderId: row.sender_id == null ? undefined : String(row.sender_id),
    senderName: row.sender_name == null ? undefined : String(row.sender_name),
    text: String(row.text ?? ""),
    replyToMessageId: row.reply_to_message_id == null ? undefined : Number(row.reply_to_message_id),
    topicId: row.topic_id == null ? undefined : Number(row.topic_id),
    rawJson: row.raw_json == null ? undefined : String(row.raw_json),
  };
}

function rowToChatInfo(row: Record<string, unknown>): ChatInfo {
  return {
    chatId: String(row.chat_id),
    requested: String(row.chat_id),
    title: row.title == null ? undefined : String(row.title),
    username: row.username == null ? undefined : String(row.username),
    kind: row.kind == null ? "Cached" : String(row.kind),
    isForum: row.is_forum === 1,
  };
}

function rowToSyncState(row: Record<string, unknown>): SyncState {
  return {
    chatId: String(row.chat_id),
    oldestMessageId: row.oldest_message_id == null ? undefined : Number(row.oldest_message_id),
    newestMessageId: row.newest_message_id == null ? undefined : Number(row.newest_message_id),
    nextBackfillOffsetId: row.next_backfill_offset_id == null ? undefined : Number(row.next_backfill_offset_id),
    syncedCount: Number(row.synced_count ?? 0),
    lastRecentSyncAt: row.last_recent_sync_at == null ? undefined : String(row.last_recent_sync_at),
    lastBackfillAt: row.last_backfill_at == null ? undefined : String(row.last_backfill_at),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
  };
}

function rowToEmbeddingChunk(row: Record<string, unknown>): StoredEmbeddingChunk {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    startMessageId: Number(row.start_message_id),
    endMessageId: Number(row.end_message_id),
    messageCount: Number(row.message_count),
    text: String(row.text ?? ""),
    model: String(row.embedding_model),
    dimensions: Number(row.embedding_dimensions),
    embedding: row.embedding as Uint8Array,
    contentHash: String(row.content_hash),
    updatedAt: String(row.updated_at),
  };
}

function rowToSendOutboxItem(row: Record<string, unknown>): StoredSendOutboxItem {
  return {
    id: String(row.id),
    dedupeKey: row.dedupe_key == null ? undefined : String(row.dedupe_key),
    payloadHash: String(row.payload_hash),
    chatId: String(row.chat_id),
    replyToMessageId: row.reply_to_message_id == null ? undefined : Number(row.reply_to_message_id),
    userKey: String(row.user_key),
    status: String(row.status) as SendOutboxStatus,
    telegramMessageId: row.telegram_message_id == null ? undefined : Number(row.telegram_message_id),
    error: row.error == null ? undefined : String(row.error),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    queuedAtMs: row.queued_at_ms == null ? undefined : Number(row.queued_at_ms),
    sendingAtMs: row.sending_at_ms == null ? undefined : Number(row.sending_at_ms),
    sentAtMs: row.sent_at_ms == null ? undefined : Number(row.sent_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function escapeFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "\"\""))
    .filter(Boolean);
  if (terms.length === 0) {
    return "\"\"";
  }
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function toSqlValues(values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}
