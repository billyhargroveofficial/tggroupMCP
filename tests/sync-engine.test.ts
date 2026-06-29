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

function config(): AppConfig {
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
      intervalMs: 60_000,
      recentLimit: 300,
      backfillLimit: 1000,
      transientBackoffInitialMs: 5_000,
      transientBackoffMaxMs: 300_000,
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
