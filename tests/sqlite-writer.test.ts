import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { MessageStore } from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

test("message writes wait and retry while another SQLite writer holds the lock", async (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);

  await withWriteLock(dbPath, 350, () => {
    const saved = store.upsertMessages(CHAT, [
      {
        chatId: CHAT.chatId,
        messageId: 1,
        text: "held lock message",
      },
    ]);
    assert.equal(saved, 1);
  });

  assert.equal(store.countMessages(CHAT.chatId), 1);
});

test("history job writes wait and retry while another SQLite writer holds the lock", async (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);

  let jobId = "";
  await withWriteLock(dbPath, 350, () => {
    jobId = store.startHistoryJob(CHAT.chatId, "recent", 10);
  });
  store.finishHistoryJob(jobId, {
    status: "done",
    batches: 1,
    messagesSeen: 10,
    messagesUpserted: 10,
  });

  assert.match(jobId, /^hist_/);
});

test("embedding chunk writes wait and retry while another SQLite writer holds the lock", async (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);

  await withWriteLock(dbPath, 350, () => {
    const saved = store.upsertEmbeddingChunks([
      {
        chatId: CHAT.chatId,
        startMessageId: 1,
        endMessageId: 2,
        messageCount: 2,
        text: "embedding text",
        model: "test-model",
        dimensions: 3,
        embedding: new Uint8Array([1, 2, 3]),
        contentHash: "hash",
      },
    ]);
    assert.equal(saved, 1);
  });

  assert.equal(store.getEmbeddingStats(CHAT.chatId)[0]?.chunks, 1);
});

async function withWriteLock(dbPath: string, holdMs: number, fn: () => void): Promise<void> {
  const worker = new Worker(
    `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const db = new DatabaseSync(workerData.dbPath);
      db.exec("PRAGMA busy_timeout = 1000;");
      db.exec("BEGIN IMMEDIATE;");
      parentPort.postMessage("locked");
      setTimeout(() => {
        try {
          db.exec("COMMIT;");
          db.close();
          parentPort.postMessage("released");
        } catch (error) {
          parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
          process.exit(1);
        }
      }, workerData.holdMs);
    `,
    { eval: true, workerData: { dbPath, holdMs } },
  );

  try {
    const [message] = (await once(worker, "message")) as [unknown];
    assert.equal(message, "locked");
    fn();
    const [exitCode] = (await once(worker, "exit")) as [number];
    assert.equal(exitCode, 0);
  } finally {
    await worker.terminate();
  }
}

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-sqlite-writer-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}
