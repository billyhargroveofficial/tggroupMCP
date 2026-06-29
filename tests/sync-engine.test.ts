import assert from "node:assert/strict";
import { test } from "node:test";
import { HistorySyncer } from "../src/sync-engine.js";
import { MessageStore } from "../src/store.js";
import type { AppConfig } from "../src/config.js";
import type { ChatInfo, TelegramService } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

class FakeTelegram {
  readonly requests: Array<{ limit: number; offsetId?: number; minId?: number; waitTime?: number }> = [];
  throwAfterTotal: number | undefined;
  private yieldedTotal = 0;

  constructor(private readonly ids: number[]) {}

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }

  async iterateMessages(params: {
    limit: number;
    offsetId?: number;
    minId?: number;
    waitTime?: number;
  }): Promise<{ chat: ChatInfo; messages: AsyncIterable<Record<string, unknown>> }> {
    this.requests.push(params);
    const minId = params.minId ?? 0;
    const offsetId = params.offsetId ?? 0;
    const page = this.ids
      .filter((id) => id > minId)
      .filter((id) => offsetId <= 0 || id < offsetId)
      .sort((left, right) => right - left)
      .slice(0, params.limit);
    const self = this;

    return {
      chat: CHAT,
      messages: (async function* () {
        for (const id of page) {
          if (self.throwAfterTotal != null && self.yieldedTotal >= self.throwAfterTotal) {
            throw new Error("simulated iterator failure");
          }
          self.yieldedTotal += 1;
          yield {
            id,
            message: `message ${id}`,
            date: 1_800_000_000 + id,
          };
        }
      })(),
    };
  }

  async getMessages(params: {
    ids?: number | number[];
  }): Promise<{ chat: ChatInfo; messages: Array<Record<string, unknown>> }> {
    const ids = Array.isArray(params.ids) ? params.ids : params.ids == null ? [] : [params.ids];
    return {
      chat: CHAT,
      messages: ids
        .filter((id) => this.ids.includes(id))
        .map((id) => ({
          id,
          message: `message ${id}`,
          date: 1_800_000_000 + id,
        })),
    };
  }
}

class HangingTelegram {
  readonly requests: Array<{ limit: number; offsetId?: number; minId?: number; waitTime?: number }> = [];
  closed = false;

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }

  async iterateMessages(params: {
    limit: number;
    offsetId?: number;
    minId?: number;
    waitTime?: number;
  }): Promise<{ chat: ChatInfo; messages: AsyncIterable<Record<string, unknown>> }> {
    this.requests.push(params);
    const self = this;
    return {
      chat: CHAT,
      messages: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => new Promise<IteratorResult<Record<string, unknown>>>(() => undefined),
            return: async () => {
              self.closed = true;
              return { done: true, value: undefined as unknown as Record<string, unknown> };
            },
          };
        },
      },
    };
  }
}

test("recent sync catches up all pages above the previous newest id", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram(range(1001, 1500));
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.fetched, 500);
  assert.equal(result.saved, 500);
  assert.equal(result.newestMessageId, 1500);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1500);
  assert.equal(store.countMessages(CHAT.chatId), 501);
  assert.deepEqual(
    store.getHistory({ chatId: CHAT.chatId, afterId: 1000, limit: 600, order: "asc" }).map((message) => message.messageId),
    range(1001, 1500),
  );
  assert.deepEqual(
    telegram.requests.map((request) => request.offsetId ?? 0),
    [0, 1201],
  );
  assert.deepEqual(
    telegram.requests.map((request) => request.waitTime),
    [2, 2],
  );
});

test("history operation watchdog fails a stuck iterator and closes it", async () => {
  const store = seededStore(1000);
  const telegram = new HangingTelegram();
  const syncer = new HistorySyncer(config({ historyOperationTimeoutMs: 15 }), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error?.message ?? "", /Telegram recent history iterator timed out after 15ms/);
  assert.equal(result.error?.retryable, true);
  assert.equal(telegram.closed, true);
  assert.match(store.getSyncState(CHAT.chatId)?.lastError ?? "", /timed out/);
});

test("partial recent failure leaves high-water mark behind for repair", async () => {
  const store = seededStore(1000);
  const failingTelegram = new FakeTelegram(range(1001, 1500));
  failingTelegram.throwAfterTotal = 120;
  const failingSyncer = new HistorySyncer(config(), failingTelegram as unknown as TelegramService, store);

  const failed = await failingSyncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(failed.error?.message, "simulated iterator failure");
  assert.equal(failed.saved, 100);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1000);
  assert.equal(store.countMessages(CHAT.chatId), 101);

  const repairingTelegram = new FakeTelegram(range(1001, 1500));
  const repairingSyncer = new HistorySyncer(config(), repairingTelegram as unknown as TelegramService, store);
  const repaired = await repairingSyncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(repaired.error, undefined);
  assert.equal(repaired.fetched, 500);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1500);
  assert.deepEqual(
    store.getHistory({ chatId: CHAT.chatId, afterId: 1000, limit: 600, order: "asc" }).map((message) => message.messageId),
    range(1001, 1500),
  );
});

test("recent sync with no new messages preserves the newest id", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram(range(1, 1000));
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.fetched, 0);
  assert.equal(result.saved, 0);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1000);
  assert.equal(telegram.requests.length, 1);
});

test("zero-row backfill records exhausted state", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 100,
    batchSize: 50,
  });

  assert.equal(result.status, "done");
  assert.equal(result.fetched, 0);
  assert.equal(typeof store.getSyncState(CHAT.chatId)?.backfillExhaustedAt, "string");
});

test("exhausted backfill is skipped while recent sync still runs", async () => {
  const store = seededStore(1000);
  store.setBackfillExhausted(CHAT, true);
  const telegram = new FakeTelegram([1001]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncOnce({
    recentLimit: 10,
    backfillLimit: 10,
    batchSize: 5,
  });

  assert.equal(result.recent?.status, "done");
  assert.equal(result.recent?.fetched, 1);
  assert.equal(result.backfill?.status, "skipped");
  assert.equal(result.backfill?.skipped, "backfill_exhausted");
  assert.equal(telegram.requests.length, 1);
});

test("resetting backfill exhausted state resumes backfill", async () => {
  const store = seededStore(1000);
  store.setBackfillExhausted(CHAT, true);
  const telegram = new FakeTelegram([998, 999]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
    resetBackfillExhausted: true,
  });

  assert.equal(result.status, "done");
  assert.equal(result.fetched, 2);
  assert.equal(store.getSyncState(CHAT.chatId)?.backfillExhaustedAt, undefined);
  assert.equal(telegram.requests.length, 1);
});

test("manual older offset backfill does not mutate daemon cursor by default", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([398, 399]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
    offsetId: 400,
  });

  const state = store.getSyncState(CHAT.chatId);
  assert.equal(result.status, "done");
  assert.equal(result.fetched, 2);
  assert.equal(state?.oldestMessageId, 1000);
  assert.equal(state?.nextBackfillOffsetId, undefined);
});

test("manual newer overlap backfill does not mutate daemon cursor by default", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([999]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
    offsetId: 1001,
  });

  const state = store.getSyncState(CHAT.chatId);
  assert.equal(result.status, "done");
  assert.equal(result.fetched, 1);
  assert.equal(state?.oldestMessageId, 1000);
  assert.equal(state?.nextBackfillOffsetId, undefined);
});

test("normal daemon backfill advances cursor", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([998, 999]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
  });

  const state = store.getSyncState(CHAT.chatId);
  assert.equal(result.status, "done");
  assert.equal(result.fetched, 2);
  assert.equal(state?.oldestMessageId, 998);
  assert.equal(state?.nextBackfillOffsetId, 998);
});

test("explicit cursor commits must match the current daemon cursor", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([899]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  await assert.rejects(
    () =>
      syncer.syncDirection({
        mode: "backfill",
        limit: 10,
        batchSize: 5,
        offsetId: 900,
        commitCursor: true,
      }),
    /commit_cursor:true requires offset_id to match current backfill cursor 1000/,
  );
  assert.equal(telegram.requests.length, 0);
});

test("recent reconciliation updates edited messages and marks embedding chunks dirty", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1000,
      text: "old searchable text",
    },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 1000,
    newestMessageId: 1000,
    syncedCount: store.countMessages(CHAT.chatId),
    mode: "recent",
    error: null,
  });
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1000,
      endMessageId: 1000,
      messageCount: 1,
      text: "old searchable text",
      model: "test",
      dimensions: 3,
      embedding: new Uint8Array([1, 2, 3]),
      contentHash: "old",
    },
  ]);
  const telegram = new FakeTelegram([1000]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });

  assert.equal(result.reconciliation?.refreshed, 1);
  assert.equal(store.search({ chatId: CHAT.chatId, query: "old", limit: 10 }).length, 0);
  assert.equal(store.search({ chatId: CHAT.chatId, query: "message", limit: 10 })[0]?.messageId, 1000);
  assert.equal(store.getEmbeddingStats(CHAT.chatId)[0]?.dirty_chunks, 1);
});

test("recent reconciliation tombstones deleted messages and removes searchable content", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });

  const [message] = store.getHistory({ chatId: CHAT.chatId, limit: 1, order: "asc" });
  assert.equal(result.reconciliation?.deleted, 1);
  assert.equal(typeof message?.deletedAt, "string");
  assert.equal(store.search({ chatId: CHAT.chatId, query: "message", limit: 10 }).length, 0);
});

function seededStore(newestMessageId: number): MessageStore {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: newestMessageId,
      text: `message ${newestMessageId}`,
    },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: newestMessageId,
    newestMessageId,
    syncedCount: store.countMessages(CHAT.chatId),
    mode: "recent",
    error: null,
  });
  return store;
}

function config(sync: Partial<AppConfig["sync"]> = {}): AppConfig {
  return {
    telegram: {
      apiId: 1,
      apiHash: "hash",
      session: "session",
      phone: "",
      defaultChatId: CHAT.chatId,
      allowedChatIds: [CHAT.chatId],
      requireAllowlistedChat: true,
      connectionRetries: 1,
    },
    storage: {
      dbPath: ":memory:",
    },
    safety: {
      sendEnabled: true,
      dryRunDefault: false,
      maxSendChars: 4096,
      liveSendApprovalTtlMs: 60_000,
      liveSendApprovalBypass: false,
    },
    sync: {
      batchSize: 100,
      maxSyncLimit: 500_000,
      floodWaitMaxSleepSec: 10,
      historyWaitTimeSec: 2,
      historyOperationTimeoutMs: 120_000,
      intervalMs: 60_000,
      recentLimit: 300,
      backfillLimit: 1000,
      transientBackoffInitialMs: 5_000,
      transientBackoffMaxMs: 300_000,
      ...sync,
    },
    embeddings: {
      enabled: false,
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: 256,
      apiBatchSize: 64,
      chunkMessages: 12,
      chunkMaxChars: 1600,
      tickChunkLimit: 100,
      searchLimit: 12,
    },
    throttle: {
      dedupeTtlMs: 600_000,
      userCooldownMs: 0,
      maxPendingPerUserPerChat: 10,
      maxQueuePerChat: 25,
      maxAgeMs: 120_000,
      globalConcurrency: 2,
      maxRunningPerChat: 1,
    },
  };
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
