import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { EmbeddingChunkVector } from "./embeddings.js";
import { ToolError } from "./errors.js";
import type { ChatInfo } from "./telegram-client.js";

const SQLITE_BUSY_TIMEOUT_MS = 250;
const SQLITE_BUSY_RETRY_ATTEMPTS = 6;
const SQLITE_BUSY_RETRY_INITIAL_MS = 25;
const SCHEMA_VERSION = 8;

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
  deletedAt?: string;
};

export type SyncState = {
  chatId: string;
  oldestMessageId?: number;
  newestMessageId?: number;
  nextBackfillOffsetId?: number;
  recentCatchupMinId?: number;
  recentCatchupNextOffsetId?: number;
  recentCatchupNewestId?: number;
  syncedCount: number;
  lastRecentSyncAt?: string;
  lastBackfillAt?: string;
  backfillExhaustedAt?: string;
  lastError?: string;
  updatedAt?: string;
};

export type DaemonStatus = {
  service: string;
  lastStartedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  updatedAt?: string;
};

export type ChatCacheStatus = {
  chatId: string;
  messages: {
    count: number;
    oldestMessageId?: number;
    newestMessageId?: number;
  };
  syncState: SyncState | null;
  daemonStatus: DaemonStatus | null;
  embeddings: Array<Record<string, unknown>>;
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
  messageIds: number[];
  messageCount: number;
  text: string;
  model: string;
  dimensions: number;
  embedding: Uint8Array;
  contentHash: string;
  dirtyAt?: string;
  updatedAt: string;
};

export type SendOutboxStatus = "queued" | "sending" | "sent" | "failed" | "expired";
export type SendStartupReconciliation = {
  expiredQueued: number;
  markedUnknownDelivery: number;
};

const RESTART_EXPIRED_SEND_ERROR = "Queued send abandoned by process restart before execution.";
const UNKNOWN_DELIVERY_AFTER_RESTART_ERROR =
  "Send was in-flight during process restart; Telegram delivery state is unknown and automatic retry is refused.";

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
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  getSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    return Number(row?.user_version ?? 0);
  }

  upsertChat(chat: ChatInfo): void {
    this.writeWithRetry("upsertChat", () => this.upsertChatLocked(chat));
  }

  private upsertChatLocked(chat: ChatInfo): void {
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
    for (const alias of chatAliases(chat)) {
      this.db
        .prepare(
          `INSERT INTO chat_aliases (alias, chat_id, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(alias) DO UPDATE SET
             chat_id = excluded.chat_id,
             updated_at = excluded.updated_at`,
        )
        .run(alias, chat.chatId);
    }
  }

  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number {
    return this.immediateTransaction("upsertMessages", () => {
      this.upsertChatLocked(chat);
      const stmt = this.db.prepare(
        `INSERT INTO messages (
           chat_id, message_id, date, sender_id, sender_name, text,
           reply_to_message_id, topic_id, raw_json, deleted_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           date = excluded.date,
           sender_id = excluded.sender_id,
           sender_name = excluded.sender_name,
           text = excluded.text,
           reply_to_message_id = excluded.reply_to_message_id,
           topic_id = excluded.topic_id,
           raw_json = excluded.raw_json,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`,
      );
      for (const row of messages) {
        const previous = this.getMessageForDirtyCheck(row.chatId, row.messageId);
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
          row.deletedAt ?? null,
        );
        if (previous && (previous.text !== row.text || previous.deletedAt !== (row.deletedAt ?? null))) {
          this.markEmbeddingChunksDirtyForMessagesLocked(row.chatId, [row.messageId]);
        }
      }
      return new Set(messages.map((message) => `${message.chatId}:${message.messageId}`)).size;
    });
  }

  getCachedChat(chatId: string): ChatInfo | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return rowToChatInfo(row);
  }

  resolveCachedChat(chat: string): ChatInfo | undefined {
    const direct = this.getCachedChat(chat);
    if (direct) {
      return direct;
    }
    const alias = normalizeChatAlias(chat);
    const row = this.db
      .prepare(
        `SELECT c.*
         FROM chat_aliases a
         JOIN chats c ON c.chat_id = a.chat_id
         WHERE a.alias = ?`,
      )
      .get(alias) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return { ...rowToChatInfo(row), requested: chat };
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

  getRecentMessageIds(chatId: string, limit: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT message_id
         FROM messages
         WHERE chat_id = ? AND deleted_at IS NULL
         ORDER BY message_id DESC
         LIMIT ?`,
      )
      .all(chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => Number(row.message_id));
  }

  markMessagesDeleted(chatId: string, messageIds: number[]): number {
    if (messageIds.length === 0) {
      return 0;
    }
    return this.immediateTransaction("markMessagesDeleted", () => {
      let changed = 0;
      const stmt = this.db.prepare(
        `UPDATE messages
         SET text = '', deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE chat_id = ? AND message_id = ? AND deleted_at IS NULL`,
      );
      for (const messageId of messageIds) {
        const result = stmt.run(chatId, messageId);
        if (Number(result.changes ?? 0) > 0) {
          changed += Number(result.changes ?? 0);
          this.markEmbeddingChunksDirtyForMessagesLocked(chatId, [messageId]);
        }
      }
      return changed;
    });
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

  getMessagesNeedingEmbedding(params: {
    chatId: string;
    model: string;
    dimensions?: number;
    afterId?: number;
    limit: number;
  }): StoredMessage[] {
    const clauses = [
      "m.chat_id = ?",
      "length(trim(m.text)) > 0",
      "m.deleted_at IS NULL",
      `NOT EXISTS (
        SELECT 1
        FROM message_embedding_chunk_messages cm
        JOIN message_embedding_chunks c ON c.id = cm.chunk_id
        WHERE cm.chat_id = m.chat_id
          AND cm.message_id = m.message_id
          AND c.embedding_model = ?
          AND (? IS NULL OR c.embedding_dimensions = ?)
          AND c.dirty_at IS NULL
      )`,
    ];
    const values: unknown[] = [params.chatId, params.model, params.dimensions ?? null, params.dimensions ?? null];
    if (params.afterId != null) {
      clauses.push("m.message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.*
         FROM messages m
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.message_id ASC
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

  getMessagesByIds(params: { chatId: string; messageIds: number[] }): StoredMessage[] {
    if (params.messageIds.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(params.messageIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE chat_id = ? AND message_id IN (${placeholders})`)
      .all(params.chatId, ...uniqueIds) as Record<string, unknown>[];
    const byId = new Map(rows.map((row) => [Number(row.message_id), rowToStoredMessage(row)]));
    return params.messageIds.map((id) => byId.get(id)).filter((message): message is StoredMessage => message != null);
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
      recentCatchup?: { minMessageId?: number; nextOffsetId: number; newestMessageId?: number } | null;
    },
  ): void {
    this.immediateTransaction("updateSyncState", () => {
      this.upsertChatLocked(chat);
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
      if (Object.prototype.hasOwnProperty.call(state, "recentCatchup")) {
        if (state.recentCatchup == null) {
          this.db
            .prepare(
              `UPDATE sync_state
               SET recent_catchup_min_id = NULL,
                   recent_catchup_next_offset_id = NULL,
                   recent_catchup_newest_id = NULL,
                   updated_at = datetime('now')
               WHERE chat_id = ?`,
            )
            .run(chat.chatId);
        } else {
          this.db
            .prepare(
              `UPDATE sync_state
               SET recent_catchup_min_id = ?,
                   recent_catchup_next_offset_id = ?,
                   recent_catchup_newest_id = ?,
                   updated_at = datetime('now')
               WHERE chat_id = ?`,
            )
            .run(
              state.recentCatchup.minMessageId ?? null,
              state.recentCatchup.nextOffsetId,
              state.recentCatchup.newestMessageId ?? null,
              chat.chatId,
            );
        }
      }
    });
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

  setBackfillExhausted(chat: ChatInfo, exhausted: boolean): void {
    this.immediateTransaction("setBackfillExhausted", () => {
      this.upsertChatLocked(chat);
      this.db
        .prepare(
          `INSERT INTO sync_state (
             chat_id, synced_count, backfill_exhausted_at, updated_at
           )
           VALUES (?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
           ON CONFLICT(chat_id) DO UPDATE SET
             backfill_exhausted_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
             updated_at = datetime('now')`,
        )
        .run(chat.chatId, this.countMessages(chat.chatId), exhausted ? 1 : 0, exhausted ? 1 : 0);
    });
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
    return this.immediateTransaction("upsertEmbeddingChunks", () => {
      const stmt = this.db.prepare(
        `INSERT INTO message_embedding_chunks (
           chat_id, start_message_id, end_message_id, message_count, text,
           embedding_model, embedding_dimensions, embedding, content_hash, dirty_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
         ON CONFLICT(chat_id, start_message_id, end_message_id, embedding_model, embedding_dimensions)
         DO UPDATE SET
           message_count = excluded.message_count,
           text = excluded.text,
           embedding = excluded.embedding,
           content_hash = excluded.content_hash,
           dirty_at = NULL,
           updated_at = excluded.updated_at`,
      );
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
        const row = this.db
          .prepare(
            `SELECT id
             FROM message_embedding_chunks
             WHERE chat_id = ?
               AND start_message_id = ?
               AND end_message_id = ?
               AND embedding_model = ?
               AND embedding_dimensions = ?`,
          )
          .get(chunk.chatId, chunk.startMessageId, chunk.endMessageId, chunk.model, chunk.dimensions) as
          | Record<string, unknown>
          | undefined;
        if (!row) {
          throw new Error("Failed to read embedding chunk id after upsert.");
        }
        this.replaceEmbeddingChunkMessagesLocked(
          Number(row.id),
          chunk.chatId,
          normalizeChunkMessageIds(chunk.messageIds, chunk.startMessageId, chunk.endMessageId),
        );
      }
      return chunks.length;
    });
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
    return this.writeWithRetry("deleteEmbeddingChunks", () => {
      const result = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`).run(...toSqlValues(values));
      return Number(result.changes ?? 0);
    });
  }

  deleteDirtyEmbeddingChunks(params: { chatId: string; model: string; dimensions?: number }): number {
    const clauses = ["chat_id = ?", "embedding_model = ?", "dirty_at IS NOT NULL"];
    const values: unknown[] = [params.chatId, params.model];
    if (params.dimensions != null) {
      clauses.push("embedding_dimensions = ?");
      values.push(params.dimensions);
    }
    return this.writeWithRetry("deleteDirtyEmbeddingChunks", () => {
      const result = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`).run(...toSqlValues(values));
      return Number(result.changes ?? 0);
    });
  }

  deleteDirtyEmbeddingChunksForRanges(params: {
    chatId: string;
    model: string;
    dimensions?: number;
    ranges: Array<{ startMessageId: number; endMessageId: number }>;
  }): number {
    if (params.ranges.length === 0) {
      return 0;
    }
    return this.immediateTransaction("deleteDirtyEmbeddingChunksForRanges", () => {
      let deleted = 0;
      const clauses = [
        "chat_id = ?",
        "embedding_model = ?",
        "dirty_at IS NOT NULL",
        "start_message_id <= ?",
        "end_message_id >= ?",
      ];
      if (params.dimensions != null) {
        clauses.push("embedding_dimensions = ?");
      }
      const stmt = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`);
      for (const range of params.ranges) {
        const values: unknown[] = [params.chatId, params.model, range.endMessageId, range.startMessageId];
        if (params.dimensions != null) {
          values.push(params.dimensions);
        }
        const result = stmt.run(...toSqlValues(values));
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    });
  }

  deleteDirtyEmbeddingChunksForMessages(params: {
    chatId: string;
    model: string;
    dimensions?: number;
    messageIds: number[];
  }): number {
    const messageIds = [...new Set(params.messageIds)];
    if (messageIds.length === 0) {
      return 0;
    }
    return this.immediateTransaction("deleteDirtyEmbeddingChunksForMessages", () => {
      let deleted = 0;
      const clauses = [
        "chat_id = ?",
        "embedding_model = ?",
        "dirty_at IS NOT NULL",
        `id IN (
          SELECT chunk_id
          FROM message_embedding_chunk_messages
          WHERE chat_id = ? AND message_id = ?
        )`,
      ];
      if (params.dimensions != null) {
        clauses.push("embedding_dimensions = ?");
      }
      const stmt = this.db.prepare(`DELETE FROM message_embedding_chunks WHERE ${clauses.join(" AND ")}`);
      for (const messageId of messageIds) {
        const values: unknown[] = [params.chatId, params.model, params.chatId, messageId];
        if (params.dimensions != null) {
          values.push(params.dimensions);
        }
        const result = stmt.run(...toSqlValues(values));
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    });
  }

  getEmbeddingChunks(params: {
    chatId: string;
    model: string;
    dimensions?: number;
    beforeId?: number;
    afterId?: number;
    includeDirty?: boolean;
    limit?: number;
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
    if (!params.includeDirty) {
      clauses.push("dirty_at IS NULL");
    }
    const limitClause = params.limit == null ? "" : "LIMIT ?";
    if (params.limit != null) {
      values.push(params.limit);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM message_embedding_chunks
         WHERE ${clauses.join(" AND ")}
         ORDER BY start_message_id ASC
         ${limitClause}`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map((row) => {
      const chunk = rowToEmbeddingChunk(row);
      return { ...chunk, messageIds: this.getEmbeddingChunkMessageIdsLocked(chunk.id) };
    });
  }

  getEmbeddingStats(chatId: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT
           embedding_model AS model,
           embedding_dimensions AS dimensions,
           COUNT(*) AS chunks,
           MIN(start_message_id) AS oldest_message_id,
           MAX(end_message_id) AS newest_message_id,
           SUM(message_count) AS indexed_messages,
           SUM(CASE WHEN dirty_at IS NOT NULL THEN 1 ELSE 0 END) AS dirty_chunks,
           MAX(updated_at) AS updated_at
         FROM message_embedding_chunks
         WHERE chat_id = ?
         GROUP BY embedding_model, embedding_dimensions
         ORDER BY updated_at DESC`,
      )
      .all(chatId) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...row,
      ...this.getEmbeddingCoverageStats({
        chatId,
        model: String(row.model),
        dimensions: Number(row.dimensions),
      }),
    }));
  }

  getEmbeddingCoverageStats(params: { chatId: string; model: string; dimensions?: number }): Record<string, number> {
    const values = [params.chatId, params.model, params.dimensions ?? null, params.dimensions ?? null] as const;
    const cache = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE chat_id = ? AND length(trim(text)) > 0 AND deleted_at IS NULL`,
      )
      .get(params.chatId) as Record<string, unknown> | undefined;
    const indexed = this.db
      .prepare(
        `SELECT COUNT(DISTINCT m.id) AS count
         FROM messages m
         WHERE m.chat_id = ?
           AND length(trim(m.text)) > 0
           AND m.deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM message_embedding_chunk_messages cm
             JOIN message_embedding_chunks c ON c.id = cm.chunk_id
             WHERE cm.chat_id = m.chat_id
               AND cm.message_id = m.message_id
               AND c.embedding_model = ?
               AND (? IS NULL OR c.embedding_dimensions = ?)
               AND c.dirty_at IS NULL
           )`,
      )
      .get(...values) as Record<string, unknown> | undefined;
    const uncoveredRows = this.db
      .prepare(
        `SELECT m.message_id
         FROM messages m
         WHERE m.chat_id = ?
           AND length(trim(m.text)) > 0
           AND m.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM message_embedding_chunk_messages cm
             JOIN message_embedding_chunks c ON c.id = cm.chunk_id
             WHERE cm.chat_id = m.chat_id
               AND cm.message_id = m.message_id
               AND c.embedding_model = ?
               AND (? IS NULL OR c.embedding_dimensions = ?)
               AND c.dirty_at IS NULL
           )
         ORDER BY m.message_id ASC`,
      )
      .all(...values) as Record<string, unknown>[];
    const dirty = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM message_embedding_chunks
         WHERE chat_id = ? AND embedding_model = ? AND (? IS NULL OR embedding_dimensions = ?) AND dirty_at IS NOT NULL`,
      )
      .get(...values) as Record<string, unknown> | undefined;

    return {
      cache_messages: Number(cache?.count ?? 0),
      indexed_messages: Number(indexed?.count ?? 0),
      uncovered_messages: uncoveredRows.length,
      uncovered_ranges: countMessageIdRanges(uncoveredRows.map((row) => Number(row.message_id))),
      dirty_chunks: Number(dirty?.count ?? 0),
    };
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
    return this.immediateTransaction("reserveSend", () => {
      this.expireStaleSendsLocked(params.nowMs);
      const existing = params.dedupeKey == null ? undefined : this.getSendByDedupeKeyLocked(params.dedupeKey);
      if (existing) {
        if (isUnknownDeliveryAfterRestart(existing)) {
          throw new ToolError({
            category: "internal",
            retryable: false,
            message: "Previous send with this dedupe_key has unknown Telegram delivery state after process restart; refusing automatic retry.",
          });
        }
        if (existing.payloadHash !== params.payloadHash) {
          throw new ToolError({
            category: "rate_limit",
            retryable: false,
            message: "dedupe_key has already been used for a different send payload.",
          });
        }
        if (existing.status === "sent") {
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
      return { kind: "queued", outboxId: params.outboxId, expiresAtMs };
    });
  }

  markSendSending(outboxId: string, nowMs = Date.now()): void {
    this.writeWithRetry("markSendSending", () => {
      this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'sending', sending_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(nowMs, nowMs, outboxId);
    });
  }

  markSendSent(outboxId: string, telegramMessageId: number | undefined, nowMs = Date.now()): void {
    this.writeWithRetry("markSendSent", () => {
      this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'sent', telegram_message_id = ?, sent_at_ms = ?, updated_at_ms = ?, error = NULL
           WHERE id = ?`,
        )
        .run(telegramMessageId ?? null, nowMs, nowMs, outboxId);
    });
  }

  markSendFailed(outboxId: string, error: string, nowMs = Date.now()): void {
    this.writeWithRetry("markSendFailed", () => {
      this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'failed', error = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(error, nowMs, outboxId);
    });
  }

  markSendExpired(outboxId: string, error = "Queued send expired before execution.", nowMs = Date.now()): void {
    this.writeWithRetry("markSendExpired", () => {
      this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'expired', error = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(error, nowMs, outboxId);
    });
  }

  getSendOutboxByDedupeKey(dedupeKey: string): StoredSendOutboxItem | undefined {
    return this.getSendByDedupeKeyLocked(dedupeKey);
  }

  reconcileActiveSendsOnStartup(nowMs = Date.now()): SendStartupReconciliation {
    return this.immediateTransaction("reconcileActiveSendsOnStartup", () => {
      const queued = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'expired',
               error = COALESCE(error, ?),
               updated_at_ms = ?
           WHERE status = 'queued'`,
        )
        .run(RESTART_EXPIRED_SEND_ERROR, nowMs);
      const sending = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'failed',
               error = ?,
               updated_at_ms = ?
           WHERE status = 'sending'`,
        )
        .run(UNKNOWN_DELIVERY_AFTER_RESTART_ERROR, nowMs);
      return {
        expiredQueued: Number(queued.changes ?? 0),
        markedUnknownDelivery: Number(sending.changes ?? 0),
      };
    });
  }

  startHistoryJob(chatId: string, direction: "recent" | "backfill" | "manual", targetCount: number): string {
    const jobId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.writeWithRetry("startHistoryJob", () => {
      this.db
        .prepare(
          `INSERT INTO history_jobs (job_id, chat_id, direction, status, target_count, started_at)
           VALUES (?, ?, ?, 'running', ?, datetime('now'))`,
        )
        .run(jobId, chatId, direction, targetCount);
    });
    return jobId;
  }

  finishHistoryJob(
    jobId: string,
    result: {
      status: "done" | "failed" | "skipped" | "catching_up";
      batches: number;
      messagesSeen: number;
      messagesUpserted: number;
      error?: string;
    },
  ): void {
    this.writeWithRetry("finishHistoryJob", () => {
      this.db
        .prepare(
          `UPDATE history_jobs
           SET status = ?, finished_at = datetime('now'), batches = ?, messages_seen = ?,
               messages_upserted = ?, error = ?
           WHERE job_id = ?`,
        )
        .run(result.status, result.batches, result.messagesSeen, result.messagesUpserted, result.error ?? null, jobId);
    });
  }

  recordDaemonTickStarted(service = "sync-daemon"): void {
    this.writeWithRetry("recordDaemonTickStarted", () => {
      this.db
        .prepare(
          `INSERT INTO daemon_status (service, last_started_at, consecutive_failures, updated_at)
           VALUES (?, datetime('now'), 0, datetime('now'))
           ON CONFLICT(service) DO UPDATE SET
             last_started_at = excluded.last_started_at,
             updated_at = excluded.updated_at`,
        )
        .run(service);
    });
  }

  recordDaemonTickSuccess(service = "sync-daemon"): void {
    this.writeWithRetry("recordDaemonTickSuccess", () => {
      this.db
        .prepare(
          `INSERT INTO daemon_status (service, last_success_at, last_error, consecutive_failures, updated_at)
           VALUES (?, datetime('now'), NULL, 0, datetime('now'))
           ON CONFLICT(service) DO UPDATE SET
             last_success_at = excluded.last_success_at,
             last_error = NULL,
             consecutive_failures = 0,
             updated_at = excluded.updated_at`,
        )
        .run(service);
    });
  }

  recordDaemonTickFailure(error: string, service = "sync-daemon"): void {
    this.writeWithRetry("recordDaemonTickFailure", () => {
      this.db
        .prepare(
          `INSERT INTO daemon_status (service, last_failure_at, last_error, consecutive_failures, updated_at)
           VALUES (?, datetime('now'), ?, 1, datetime('now'))
           ON CONFLICT(service) DO UPDATE SET
             last_failure_at = excluded.last_failure_at,
             last_error = excluded.last_error,
             consecutive_failures = daemon_status.consecutive_failures + 1,
             updated_at = excluded.updated_at`,
        )
        .run(service, error);
    });
  }

  getDaemonStatus(service = "sync-daemon"): DaemonStatus | undefined {
    const row = this.db.prepare("SELECT * FROM daemon_status WHERE service = ?").get(service) as
      | Record<string, unknown>
      | undefined;
    return row == null ? undefined : rowToDaemonStatus(row);
  }

  getChatStatus(chatId: string): ChatCacheStatus {
    const messageStats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(message_id) AS oldest_message_id, MAX(message_id) AS newest_message_id
         FROM messages WHERE chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown>;
    return {
      chatId,
      messages: {
        count: Number(messageStats.count ?? 0),
        oldestMessageId: optionalNumber(messageStats.oldest_message_id),
        newestMessageId: optionalNumber(messageStats.newest_message_id),
      },
      syncState: this.getSyncState(chatId) ?? null,
      daemonStatus: this.getDaemonStatus() ?? null,
      embeddings: this.getEmbeddingStats(chatId),
    };
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
    return { ...messageStats, syncState, daemonStatus: this.getDaemonStatus(), embeddings: this.getEmbeddingStats(chatId) };
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

  private immediateTransaction<T>(operation: string, fn: () => T): T {
    return this.writeWithRetry(operation, () => {
      let started = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        started = true;
        const result = fn();
        this.db.exec("COMMIT");
        started = false;
        return result;
      } catch (error) {
        if (started) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            console.error(
              `sqlite rollback failed after ${operation}: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`,
            );
          }
        }
        throw error;
      }
    });
  }

  private writeWithRetry<T>(operation: string, fn: () => T): T {
    let delayMs = SQLITE_BUSY_RETRY_INITIAL_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        if (!isSqliteBusy(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS) {
          throw error;
        }
        const nextAttempt = attempt + 1;
        console.error(
          `sqlite busy during ${operation}; retry ${nextAttempt}/${SQLITE_BUSY_RETRY_ATTEMPTS} in ${delayMs}ms`,
        );
        sleepSync(delayMs);
        delayMs *= 2;
      }
    }
  }

  private migrate(): void {
    this.immediateTransaction("migrate", () => {
      const currentVersion = this.getSchemaVersion();
      if (currentVersion > SCHEMA_VERSION) {
        throw new Error(`Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`);
      }
      if (currentVersion < 1) {
        this.applyBaseSchema();
        this.rebuildMessagesFts();
        this.db.exec("PRAGMA user_version = 1");
      }
      if (currentVersion < 2) {
        this.applyBackfillExhaustedMigration();
        this.db.exec("PRAGMA user_version = 2");
      }
      if (currentVersion < 3) {
        this.applyChatAliasMigration();
        this.db.exec("PRAGMA user_version = 3");
      }
      if (currentVersion < 4) {
        this.applyMessageReconciliationMigration();
        this.db.exec("PRAGMA user_version = 4");
      }
      if (currentVersion < 5) {
        this.applyDaemonStatusMigration();
        this.db.exec("PRAGMA user_version = 5");
      }
      if (currentVersion < 6) {
        this.applyEmbeddingChunkMembershipMigration();
        this.db.exec("PRAGMA user_version = 6");
      }
      if (currentVersion < 7) {
        this.applySendOutboxMigration();
        this.db.exec("PRAGMA user_version = 7");
      }
      if (currentVersion < 8) {
        this.applyRecentCatchupMigration();
        this.db.exec("PRAGMA user_version = 8");
      }
      this.validateSchema();
    });
  }

  private applyBaseSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT,
        username TEXT,
        kind TEXT,
        is_forum INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_aliases (
        alias TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
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
        deleted_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        chat_id TEXT PRIMARY KEY,
        oldest_message_id INTEGER,
        newest_message_id INTEGER,
        next_backfill_offset_id INTEGER,
        recent_catchup_min_id INTEGER,
        recent_catchup_next_offset_id INTEGER,
        recent_catchup_newest_id INTEGER,
        synced_count INTEGER NOT NULL DEFAULT 0,
        last_recent_sync_at TEXT,
        last_backfill_at TEXT,
        backfill_exhausted_at TEXT,
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

      CREATE TABLE IF NOT EXISTS daemon_status (
        service TEXT PRIMARY KEY,
        last_started_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
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
        dirty_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(chat_id, start_message_id, end_message_id, embedding_model, embedding_dimensions)
      );

      CREATE TABLE IF NOT EXISTS message_embedding_chunk_messages (
        chunk_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(chunk_id, message_id)
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

      CREATE TRIGGER IF NOT EXISTS embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
        DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      END;

      CREATE INDEX IF NOT EXISTS idx_messages_chat_message_id ON messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(chat_id, sender_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_lookup
        ON message_embedding_chunks(chat_id, embedding_model, embedding_dimensions);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunks_range
        ON message_embedding_chunks(chat_id, start_message_id, end_message_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_lookup
        ON message_embedding_chunk_messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_chunk_position
        ON message_embedding_chunk_messages(chunk_id, position);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_chat_status
        ON send_outbox(chat_id, status, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_user_status
        ON send_outbox(chat_id, user_key, status, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_chat_aliases_chat_id
        ON chat_aliases(chat_id);
    `);
    this.ensureColumn("sync_state", "next_backfill_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_min_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_next_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_newest_id", "INTEGER");
    this.ensureColumn("sync_state", "last_recent_sync_at", "TEXT");
    this.ensureColumn("sync_state", "last_backfill_at", "TEXT");
    this.ensureColumn("sync_state", "backfill_exhausted_at", "TEXT");
    this.ensureColumn("sync_state", "last_error", "TEXT");
    this.ensureColumn("messages", "date", "TEXT");
    this.ensureColumn("messages", "sender_id", "TEXT");
    this.ensureColumn("messages", "sender_name", "TEXT");
    this.ensureColumn("messages", "reply_to_message_id", "INTEGER");
    this.ensureColumn("messages", "topic_id", "INTEGER");
    this.ensureColumn("messages", "raw_json", "TEXT");
    this.ensureColumn("messages", "deleted_at", "TEXT");
    this.ensureColumn("messages", "updated_at", "TEXT");
    this.ensureColumn("message_embedding_chunks", "dirty_at", "TEXT");
  }

  private applyBackfillExhaustedMigration(): void {
    this.ensureColumn("sync_state", "backfill_exhausted_at", "TEXT");
  }

  private applyChatAliasMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_aliases (
        alias TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_aliases_chat_id
        ON chat_aliases(chat_id);
    `);
    const chats = this.db.prepare("SELECT * FROM chats").all() as Record<string, unknown>[];
    for (const row of chats) {
      this.upsertChatLocked(rowToChatInfo(row));
    }
  }

  private applyMessageReconciliationMigration(): void {
    this.ensureColumn("messages", "deleted_at", "TEXT");
    this.ensureColumn("message_embedding_chunks", "dirty_at", "TEXT");
  }

  private applyDaemonStatusMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_status (
        service TEXT PRIMARY KEY,
        last_started_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private applyEmbeddingChunkMembershipMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_embedding_chunk_messages (
        chunk_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(chunk_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_lookup
        ON message_embedding_chunk_messages(chat_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_chunk_messages_chunk_position
        ON message_embedding_chunk_messages(chunk_id, position);
      CREATE TRIGGER IF NOT EXISTS embedding_chunks_ad AFTER DELETE ON message_embedding_chunks BEGIN
        DELETE FROM message_embedding_chunk_messages WHERE chunk_id = old.id;
      END;
    `);
    const chunks = this.db
      .prepare(
        `SELECT id, chat_id, start_message_id, end_message_id, message_count
         FROM message_embedding_chunks
         ORDER BY id ASC`,
      )
      .all() as Record<string, unknown>[];
    const selectMessages = this.db.prepare(
      `SELECT message_id
       FROM messages
       WHERE chat_id = ?
         AND message_id BETWEEN ? AND ?
         AND length(trim(text)) > 0
         AND deleted_at IS NULL
       ORDER BY message_id ASC
       LIMIT ?`,
    );
    for (const chunk of chunks) {
      const rows = selectMessages.all(
        String(chunk.chat_id),
        Number(chunk.start_message_id),
        Number(chunk.end_message_id),
        Math.max(1, Number(chunk.message_count ?? 1)),
      ) as Record<string, unknown>[];
      this.replaceEmbeddingChunkMessagesLocked(
        Number(chunk.id),
        String(chunk.chat_id),
        rows.map((row) => Number(row.message_id)),
      );
    }
  }

  private applySendOutboxMigration(): void {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_send_outbox_chat_status
        ON send_outbox(chat_id, status, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_send_outbox_user_status
        ON send_outbox(chat_id, user_key, status, expires_at_ms);
    `);
  }

  private applyRecentCatchupMigration(): void {
    this.ensureColumn("sync_state", "recent_catchup_min_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_next_offset_id", "INTEGER");
    this.ensureColumn("sync_state", "recent_catchup_newest_id", "INTEGER");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private rebuildMessagesFts(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }

  private validateSchema(): void {
    for (const table of [
      "chats",
      "chat_aliases",
      "messages",
      "sync_state",
      "history_jobs",
      "daemon_status",
      "send_outbox",
      "send_throttle_state",
      "message_embedding_chunks",
      "message_embedding_chunk_messages",
      "messages_fts",
    ]) {
      this.assertSqliteObject("table", table);
    }
    for (const index of [
      "idx_messages_chat_message_id",
      "idx_messages_sender",
      "idx_chat_aliases_chat_id",
      "idx_embedding_chunks_lookup",
      "idx_embedding_chunks_range",
      "idx_embedding_chunk_messages_lookup",
      "idx_embedding_chunk_messages_chunk_position",
      "idx_send_outbox_chat_status",
      "idx_send_outbox_user_status",
    ]) {
      this.assertSqliteObject("index", index);
    }
    for (const trigger of ["messages_ai", "messages_ad", "messages_au", "embedding_chunks_ad"]) {
      this.assertSqliteObject("trigger", trigger);
    }
    this.assertColumns("messages", ["id", "chat_id", "message_id", "text", "deleted_at", "updated_at"]);
    this.assertColumns("message_embedding_chunks", ["id", "chat_id", "dirty_at", "updated_at"]);
    this.assertColumns("message_embedding_chunk_messages", ["chunk_id", "chat_id", "message_id", "position"]);
    this.assertColumns("send_outbox", [
      "id",
      "dedupe_key",
      "payload_hash",
      "chat_id",
      "reply_to_message_id",
      "user_key",
      "status",
      "telegram_message_id",
      "error",
      "created_at_ms",
      "updated_at_ms",
      "queued_at_ms",
      "sending_at_ms",
      "sent_at_ms",
      "expires_at_ms",
    ]);
    this.assertColumns("send_throttle_state", ["chat_id", "user_key", "next_allowed_at_ms", "updated_at_ms"]);
    this.assertColumns("daemon_status", [
      "service",
      "last_started_at",
      "last_success_at",
      "last_failure_at",
      "last_error",
      "consecutive_failures",
      "updated_at",
    ]);
    this.assertColumns("sync_state", [
      "chat_id",
      "oldest_message_id",
      "newest_message_id",
      "next_backfill_offset_id",
      "recent_catchup_min_id",
      "recent_catchup_next_offset_id",
      "recent_catchup_newest_id",
      "synced_count",
      "last_recent_sync_at",
      "last_backfill_at",
      "backfill_exhausted_at",
      "last_error",
      "updated_at",
    ]);
    this.db.prepare("SELECT rowid FROM messages_fts LIMIT 1").all();
  }

  private assertSqliteObject(type: "table" | "index" | "trigger", name: string): void {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(`Database schema validation failed: missing ${type} ${name}.`);
    }
  }

  private assertColumns(table: string, columns: string[]): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    const present = new Set(rows.map((row) => String(row.name)));
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`Database schema validation failed: ${table} missing required column ${column}.`);
      }
    }
  }

  private getMessageForDirtyCheck(chatId: string, messageId: number): { text: string; deletedAt: string | null } | undefined {
    const row = this.db
      .prepare("SELECT text, deleted_at FROM messages WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      text: String(row.text ?? ""),
      deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
    };
  }

  private markEmbeddingChunksDirtyForMessagesLocked(chatId: string, messageIds: number[]): void {
    const stmt = this.db.prepare(
      `UPDATE message_embedding_chunks
       SET dirty_at = COALESCE(dirty_at, datetime('now')), updated_at = datetime('now')
       WHERE id IN (
         SELECT chunk_id
         FROM message_embedding_chunk_messages
         WHERE chat_id = ? AND message_id = ?
       )`,
    );
    for (const messageId of messageIds) {
      stmt.run(chatId, messageId);
    }
  }

  private replaceEmbeddingChunkMessagesLocked(chunkId: number, chatId: string, messageIds: number[]): void {
    this.db.prepare("DELETE FROM message_embedding_chunk_messages WHERE chunk_id = ?").run(chunkId);
    const stmt = this.db.prepare(
      `INSERT INTO message_embedding_chunk_messages (chunk_id, chat_id, message_id, position)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [position, messageId] of messageIds.entries()) {
      stmt.run(chunkId, chatId, messageId, position);
    }
  }

  private getEmbeddingChunkMessageIdsLocked(chunkId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT message_id
         FROM message_embedding_chunk_messages
         WHERE chunk_id = ?
         ORDER BY position ASC`,
      )
      .all(chunkId) as Record<string, unknown>[];
    return rows.map((row) => Number(row.message_id));
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
    deletedAt: row.deleted_at == null ? undefined : String(row.deleted_at),
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

function chatAliases(chat: ChatInfo): string[] {
  const aliases = new Set<string>([normalizeChatAlias(chat.chatId), normalizeChatAlias(chat.requested)]);
  if (chat.username) {
    aliases.add(normalizeChatAlias(chat.username));
    aliases.add(normalizeChatAlias(`@${chat.username}`));
  }
  return [...aliases].filter(Boolean);
}

function normalizeChatAlias(chat: string): string {
  const trimmed = chat.trim();
  if (trimmed.startsWith("@")) {
    return trimmed.toLowerCase();
  }
  if (/^[a-zA-Z0-9_]{5,}$/.test(trimmed)) {
    return `@${trimmed.toLowerCase()}`;
  }
  return trimmed;
}

function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

function rowToSyncState(row: Record<string, unknown>): SyncState {
  return {
    chatId: String(row.chat_id),
    oldestMessageId: row.oldest_message_id == null ? undefined : Number(row.oldest_message_id),
    newestMessageId: row.newest_message_id == null ? undefined : Number(row.newest_message_id),
    nextBackfillOffsetId: row.next_backfill_offset_id == null ? undefined : Number(row.next_backfill_offset_id),
    recentCatchupMinId: row.recent_catchup_min_id == null ? undefined : Number(row.recent_catchup_min_id),
    recentCatchupNextOffsetId:
      row.recent_catchup_next_offset_id == null ? undefined : Number(row.recent_catchup_next_offset_id),
    recentCatchupNewestId: row.recent_catchup_newest_id == null ? undefined : Number(row.recent_catchup_newest_id),
    syncedCount: Number(row.synced_count ?? 0),
    lastRecentSyncAt: row.last_recent_sync_at == null ? undefined : String(row.last_recent_sync_at),
    lastBackfillAt: row.last_backfill_at == null ? undefined : String(row.last_backfill_at),
    backfillExhaustedAt: row.backfill_exhausted_at == null ? undefined : String(row.backfill_exhausted_at),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
  };
}

function rowToDaemonStatus(row: Record<string, unknown>): DaemonStatus {
  return {
    service: String(row.service),
    lastStartedAt: row.last_started_at == null ? undefined : String(row.last_started_at),
    lastSuccessAt: row.last_success_at == null ? undefined : String(row.last_success_at),
    lastFailureAt: row.last_failure_at == null ? undefined : String(row.last_failure_at),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    updatedAt: row.updated_at == null ? undefined : String(row.updated_at),
  };
}

function rowToEmbeddingChunk(row: Record<string, unknown>): StoredEmbeddingChunk {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    startMessageId: Number(row.start_message_id),
    endMessageId: Number(row.end_message_id),
    messageIds: [],
    messageCount: Number(row.message_count),
    text: String(row.text ?? ""),
    model: String(row.embedding_model),
    dimensions: Number(row.embedding_dimensions),
    embedding: row.embedding as Uint8Array,
    contentHash: String(row.content_hash),
    dirtyAt: row.dirty_at == null ? undefined : String(row.dirty_at),
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

function isUnknownDeliveryAfterRestart(item: StoredSendOutboxItem): boolean {
  return item.error === UNKNOWN_DELIVERY_AFTER_RESTART_ERROR;
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

function countMessageIdRanges(ids: number[]): number {
  let ranges = 0;
  let previous: number | undefined;
  for (const id of ids) {
    if (previous == null || id !== previous + 1) {
      ranges += 1;
    }
    previous = id;
  }
  return ranges;
}

function normalizeChunkMessageIds(messageIds: number[] | undefined, startMessageId: number, endMessageId: number): number[] {
  const ids = messageIds?.length
    ? messageIds
    : Array.from({ length: Math.max(0, endMessageId - startMessageId + 1) }, (_, index) => startMessageId + index);
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id)))];
}

function isSqliteBusy(error: unknown): boolean {
  const anyError = error as { code?: string; message?: string };
  const message = String(anyError?.message ?? error ?? "").toUpperCase();
  return anyError?.code === "SQLITE_BUSY" || message.includes("SQLITE_BUSY") || message.includes("DATABASE IS LOCKED");
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}
