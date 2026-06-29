import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";

test("old fixture DB migrates once and rebuilds FTS for historical rows", (t) => {
  const dbPath = tempDbPath(t);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (
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
    INSERT INTO messages (chat_id, message_id, sender_name, text, updated_at)
    VALUES ('-1001', 1, 'alice', 'historical searchable text', datetime('now'));
  `);
  db.close();

  const store = new MessageStore(dbPath);

  assert.equal(store.getSchemaVersion(), 8);
  assert.equal(store.search({ chatId: "-1001", query: "historical", limit: 10 }).length, 1);

  const reopened = new MessageStore(dbPath);
  assert.equal(reopened.getSchemaVersion(), 8);
  assert.equal(reopened.search({ chatId: "-1001", query: "searchable", limit: 10 })[0]?.messageId, 1);
});

test("version 5 fixture without send tables migrates send audit schema", (t) => {
  const dbPath = tempDbPath(t);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chats (
      chat_id TEXT PRIMARY KEY,
      title TEXT,
      username TEXT,
      kind TEXT,
      is_forum INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_aliases (
      alias TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
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
    CREATE TABLE sync_state (
      chat_id TEXT PRIMARY KEY,
      oldest_message_id INTEGER,
      newest_message_id INTEGER,
      next_backfill_offset_id INTEGER,
      synced_count INTEGER NOT NULL DEFAULT 0,
      last_recent_sync_at TEXT,
      last_backfill_at TEXT,
      backfill_exhausted_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE history_jobs (
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
    CREATE TABLE daemon_status (
      service TEXT PRIMARY KEY,
      last_started_at TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE message_embedding_chunks (
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
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text,
      sender_name,
      content='messages',
      content_rowid='id'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, sender_name)
      VALUES (new.id, new.text, new.sender_name);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
      VALUES ('delete', old.id, old.text, old.sender_name);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, sender_name)
      VALUES ('delete', old.id, old.text, old.sender_name);
      INSERT INTO messages_fts(rowid, text, sender_name)
      VALUES (new.id, new.text, new.sender_name);
    END;
    CREATE INDEX idx_messages_chat_message_id ON messages(chat_id, message_id);
    CREATE INDEX idx_messages_sender ON messages(chat_id, sender_id);
    CREATE INDEX idx_chat_aliases_chat_id ON chat_aliases(chat_id);
    CREATE INDEX idx_embedding_chunks_lookup
      ON message_embedding_chunks(chat_id, embedding_model, embedding_dimensions);
    CREATE INDEX idx_embedding_chunks_range
      ON message_embedding_chunks(chat_id, start_message_id, end_message_id);
    INSERT INTO chats (chat_id, title, kind, updated_at)
    VALUES ('-1001', 'fixture chat', 'Fake', datetime('now'));
    INSERT INTO messages (chat_id, message_id, sender_name, text, updated_at)
    VALUES ('-1001', 1, 'alice', 'preexisting fixture text', datetime('now'));
    PRAGMA user_version = 5;
  `);
  db.close();

  const store = new MessageStore(dbPath);

  assert.equal(store.getSchemaVersion(), 8);
  assert.equal(store.search({ chatId: "-1001", query: "preexisting", limit: 10 })[0]?.messageId, 1);
  assert.equal(store.countMessages("-1001"), 1);
  store.updateSyncState(
    { chatId: "-1001", requested: "-1001", kind: "Fake" },
    {
      syncedCount: store.countMessages("-1001"),
      mode: "recent",
      error: null,
      recentCatchup: {
        minMessageId: 1,
        nextOffsetId: 10,
        newestMessageId: 20,
      },
    },
  );
  assert.equal(store.getSyncState("-1001")?.recentCatchupNextOffsetId, 10);
  const reservation = store.reserveSend({
    outboxId: "send_fixture",
    dedupeKey: "dedupe/fixture",
    payloadHash: "hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1000,
    maxAgeMs: 60_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 1,
    maxQueuePerChat: 5,
  });
  assert.equal(reservation.kind, "queued");

  const inspect = new DatabaseSync(dbPath);
  try {
    assertSqliteObject(inspect, "table", "send_outbox");
    assertSqliteObject(inspect, "table", "send_throttle_state");
    assertSqliteObject(inspect, "index", "idx_send_outbox_chat_status");
    assertSqliteObject(inspect, "index", "idx_send_outbox_user_status");
    assertSqliteObject(inspect, "table", "message_embedding_chunk_messages");
  } finally {
    inspect.close();
  }
});

test("daemon status records last success and failure", () => {
  const store = new MessageStore(":memory:");

  assert.equal(store.getDaemonStatus(), undefined);
  store.recordDaemonTickStarted();
  store.recordDaemonTickFailure("internal: first failure");

  const failed = store.getDaemonStatus();
  assert.equal(failed?.service, "sync-daemon");
  assert.equal(typeof failed?.lastStartedAt, "string");
  assert.equal(typeof failed?.lastFailureAt, "string");
  assert.equal(failed?.lastError, "internal: first failure");
  assert.equal(failed?.consecutiveFailures, 1);

  store.recordDaemonTickFailure("internal: second failure");
  assert.equal(store.getDaemonStatus()?.consecutiveFailures, 2);

  store.recordDaemonTickSuccess();
  const recovered = store.getDaemonStatus();
  assert.equal(typeof recovered?.lastSuccessAt, "string");
  assert.equal(typeof recovered?.lastFailureAt, "string");
  assert.equal(recovered?.lastError, undefined);
  assert.equal(recovered?.consecutiveFailures, 0);
});

test("failed migration rolls back user_version", (t) => {
  const dbPath = tempDbPath(t);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY)");
  db.close();

  assert.throws(() => new MessageStore(dbPath));

  const inspect = new DatabaseSync(dbPath);
  const version = inspect.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  const fts = inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'").get() as
    | Record<string, unknown>
    | undefined;
  inspect.close();

  assert.equal(Number(version.user_version ?? 0), 0);
  assert.equal(fts, undefined);
});

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-store-migration-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}

function assertSqliteObject(db: DatabaseSync, type: "table" | "index" | "trigger", name: string): void {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
    | Record<string, unknown>
    | undefined;
  assert.notEqual(row, undefined, `missing ${type} ${name}`);
}
