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

  assert.equal(store.getSchemaVersion(), 3);
  assert.equal(store.search({ chatId: "-1001", query: "historical", limit: 10 }).length, 1);

  const reopened = new MessageStore(dbPath);
  assert.equal(reopened.getSchemaVersion(), 3);
  assert.equal(reopened.search({ chatId: "-1001", query: "searchable", limit: 10 })[0]?.messageId, 1);
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
