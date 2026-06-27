import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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
    return messages.length;
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
        `SELECT m.*
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.message_id DESC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
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

  updateSyncState(chat: ChatInfo, state: { oldestMessageId?: number; newestMessageId?: number; syncedCount: number }): void {
    this.upsertChat(chat);
    this.db
      .prepare(
        `INSERT INTO sync_state (chat_id, oldest_message_id, newest_message_id, synced_count, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           oldest_message_id = COALESCE(excluded.oldest_message_id, sync_state.oldest_message_id),
           newest_message_id = COALESCE(excluded.newest_message_id, sync_state.newest_message_id),
           synced_count = sync_state.synced_count + excluded.synced_count,
           updated_at = excluded.updated_at`,
      )
      .run(chat.chatId, state.oldestMessageId ?? null, state.newestMessageId ?? null, state.syncedCount);
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
    return { ...messageStats, syncState };
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
        synced_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
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
    `);
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
