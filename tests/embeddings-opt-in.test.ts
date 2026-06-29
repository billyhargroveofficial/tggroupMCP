import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { indexEmbeddings } from "../src/sync-daemon.js";
import { MessageStore } from "../src/store.js";
import { TelegramTools } from "../src/tools.js";
import type { ChatInfo, TelegramService } from "../src/telegram-client.js";
import { VectorRag } from "../src/vector-rag.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

class FakeTelegram {
  get isConfigured(): boolean {
    return false;
  }

  assertChatAllowed(): void {
    return;
  }
}

test("OPENAI_API_KEY alone does not enable daemon embeddings", async () => {
  await withEnv({ OPENAI_API_KEY: "test-key", TELEGRAM_EMBEDDINGS_ENABLED: "" }, async (dbPath) => {
    const config = loadConfig();
    const store = new MessageStore(dbPath);
    const vectorRag = new VectorRag(config, store);

    assert.equal(config.embeddings.enabled, false);
    assert.equal(Boolean(config.embeddings.apiKey), true);
    assert.equal(vectorRag.isConfigured, false);
    assert.equal(await indexEmbeddings(vectorRag, CHAT.chatId), null);
  });
});

test("index_embeddings returns a clear disabled error", async () => {
  const store = new MessageStore(":memory:");
  const tools = new TelegramTools(
    config({ enabled: false, apiKey: "test-key" }),
    new FakeTelegram() as unknown as TelegramService,
    store,
  );

  const result = await callTool(tools, "index_embeddings", {
    chat: CHAT.chatId,
  });

  assert.equal(result.ok, false);
  assert.match((result.error as { message: string }).message, /Embeddings are disabled/);
});

test("first index run returns an estimate and does not call embeddings API without confirmation", async () => {
  const store = seededStore();
  const tools = new TelegramTools(
    config({ enabled: true, apiKey: "test-key" }),
    new FakeTelegram() as unknown as TelegramService,
    store,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called for an unconfirmed estimate");
  };
  try {
    const result = await callTool(tools, "index_embeddings", {
      chat: CHAT.chatId,
      limit_chunks: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.requires_confirmation, true);
    assert.equal(result.result, null);
    const estimate = result.estimate as Record<string, unknown>;
    assert.equal(estimate.provider, "OpenAI");
    assert.equal(estimate.model, "text-embedding-3-small");
    assert.equal(estimate.dimensions, 256);
    assert.equal(estimate.chatId, CHAT.chatId);
    assert.equal(estimate.firstRun, true);
    assert.equal(estimate.requiresConfirmation, true);
    assert.equal(estimate.estimatedChunks, 1);
    assert.equal(estimate.estimatedMessages, 2);
    assert.equal(Number(estimate.estimatedChars) > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daemon skips first embedding run and reports the estimate", async () => {
  const store = seededStore();
  const vectorRag = new VectorRag(config({ enabled: true, apiKey: "test-key" }), store);
  const result = await indexEmbeddings(vectorRag, CHAT.chatId);

  assert.equal(result?.skipped, "first_embedding_index_requires_manual_confirmation");
  assert.equal((result?.estimate as { chatId?: string }).chatId, CHAT.chatId);
});

function seededStore(): MessageStore {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "first cached message",
    },
    {
      chatId: CHAT.chatId,
      messageId: 2,
      senderName: "bob",
      text: "second cached message",
    },
  ]);
  return store;
}

function config(embeddings?: Partial<AppConfig["embeddings"]>): AppConfig {
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
      historyWaitTimeSec: 1,
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
      ...embeddings,
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

async function callTool(tools: TelegramTools, name: string, args: unknown): Promise<Record<string, unknown> & { ok: boolean }> {
  const result = await tools.callTool(name, args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown> & { ok: boolean };
}

async function withEnv(vars: Record<string, string>, fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "telegram-embeddings-opt-in-test-"));
  const dbPath = join(dir, "messages.sqlite");
  const applied = {
    ...vars,
    TELEGRAM_DB_PATH: dbPath,
  };
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(applied)) {
    previous.set(key, process.env[key]);
    process.env[key] = applied[key];
  }
  try {
    await fn(dbPath);
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
