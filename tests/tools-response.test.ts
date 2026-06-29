import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { MessageStore } from "../src/store.js";
import { TelegramTools } from "../src/tools.js";
import type { ChatInfo, TelegramService } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
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

  async iterateMessages(): Promise<{ chat: ChatInfo; messages: AsyncIterable<Record<string, unknown>> }> {
    return {
      chat: CHAT,
      messages: (async function* () {
        throw new Error("simulated sync failure");
      })(),
    };
  }
}

test("invalid tool arguments return validation fields", async () => {
  const tools = makeTools();
  const result = await callTool(tools, "read_history", {
    limit: "bad",
  });

  assert.equal(result.ok, false);
  const error = result.error as { category: string; fields?: Array<{ path: string }> };
  assert.equal(error.category, "validation");
  assert.equal(error.fields?.[0]?.path, "limit");
});

test("numeric tool schemas use JSON Schema integer", () => {
  const tools = makeTools();
  const sync = tools.listTools().find((tool) => tool.name === "sync_history");
  const props = sync?.inputSchema.properties as Record<string, Record<string, unknown>>;

  assert.equal(props.limit.type, "integer");
  assert.equal(props.batch_size.type, "integer");
  assert.equal(props.offset_id.type, "integer");
});

test("sync_history exposes failed status, chat, and stats", async () => {
  const tools = makeTools();
  const result = await callTool(tools, "sync_history", {
    mode: "recent",
    limit: 10,
    batch_size: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.chat, { chatId: CHAT.chatId });
  assert.equal((result.result as { status: string }).status, "failed");
  assert.equal(typeof result.stats, "object");
});

function makeTools(): TelegramTools {
  return new TelegramTools(config(), new FakeTelegram() as unknown as TelegramService, new MessageStore(":memory:"));
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
