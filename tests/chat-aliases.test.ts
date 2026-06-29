import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { MessageStore } from "../src/store.js";
import { TelegramTools } from "../src/tools.js";
import type { ChatInfo, TelegramService } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "@name",
  username: "name",
  kind: "Fake",
};

class FakeTelegram {
  get isConfigured(): boolean {
    return true;
  }

  assertChatAllowed(): void {
    return;
  }

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }
}

test("cache-only tools resolve known username aliases", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      text: "cached alias message",
    },
  ]);
  const tools = new TelegramTools(config(), new FakeTelegram() as unknown as TelegramService, store);

  const resolved = await callTool(tools, "resolve_chat", {
    chat: "@name",
  });
  const history = await callTool(tools, "read_history", {
    chat: "@name",
    limit: 10,
  });

  assert.equal(resolved.ok, true);
  assert.equal(history.ok, true);
  assert.equal((history.chat as { chatId: string }).chatId, CHAT.chatId);
  assert.equal(((history.messages as Array<{ messageId: number }>)[0] ?? {}).messageId, 1);
});

test("unknown username aliases return remediation text", async () => {
  const tools = new TelegramTools(config(), new FakeTelegram() as unknown as TelegramService, new MessageStore(":memory:"));

  const result = await callTool(tools, "read_history", {
    chat: "@unknown",
    limit: 10,
  });

  assert.equal(result.ok, false);
  assert.equal((result.error as { category: string }).category, "peer");
  assert.match((result.error as { message: string }).message, /Call resolve_chat or sync_history/);
});

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
      historyWaitTimeSec: 1,
      historyOperationTimeoutMs: 120_000,
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
      requestTimeoutMs: 60_000,
      maxRetries: 2,
      retryInitialMs: 0,
      chunkMessages: 12,
      chunkMaxChars: 1600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1000,
      maxCharsPerRun: 500_000,
      vectorCandidateLimit: 20_000,
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

async function callTool(tools: TelegramTools, name: string, args: unknown): Promise<Record<string, unknown> & { ok: boolean }> {
  const result = await tools.callTool(name, args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown> & { ok: boolean };
}
