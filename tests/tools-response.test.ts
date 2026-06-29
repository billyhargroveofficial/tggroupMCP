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

test("failed tool results set MCP isError while preserving JSON payload", async () => {
  const tools = makeTools();
  const failure = await tools.callTool("read_history", {
    limit: "bad",
  });
  const failurePayload = parseToolPayload(failure);

  assert.equal(failure.isError, true);
  assert.equal(failurePayload.ok, false);
  assert.equal((failurePayload.error as { category: string }).category, "validation");

  const success = await tools.callTool("get_config", {});
  const successPayload = parseToolPayload(success);

  assert.equal(success.isError, undefined);
  assert.equal(successPayload.ok, true);
});

test("unknown tool arguments return validation field paths", async () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; path: string }> = [
    { tool: "get_config", args: { extra: true }, path: "extra" },
    { tool: "read_history", args: { befor_id: 10 }, path: "befor_id" },
    { tool: "sync_history", args: { mode: "recent", limt: 10 }, path: "limt" },
    { tool: "search_messages", args: { query: "needle", vector_limt: 5 }, path: "vector_limt" },
    { tool: "index_embeddings", args: { confirm: true }, path: "confirm" },
    { tool: "preview_message", args: { text: "hello", user_key: "caller" }, path: "user_key" },
    { tool: "send_message", args: { text: "hello", user_key: "caller" }, path: "user_key" },
  ];

  for (const item of cases) {
    const result = await callTool(makeTools(), item.tool, item.args);
    assert.equal(result.ok, false, item.tool);
    const error = result.error as { category: string; fields?: Array<{ path: string }> };
    assert.equal(error.category, "validation", item.tool);
    assert.equal(error.fields?.some((field) => field.path === item.path), true, item.tool);
  }
});

test("numeric tool schemas use JSON Schema integer", () => {
  const tools = makeTools();
  const sync = tools.listTools().find((tool) => tool.name === "sync_history");
  const props = sync?.inputSchema.properties as Record<string, Record<string, unknown>>;

  assert.equal(props.limit.type, "integer");
  assert.equal(props.batch_size.type, "integer");
  assert.equal(props.offset_id.type, "integer");
});

test("tool JSON schemas reject additional properties", () => {
  const tools = makeTools();

  for (const tool of tools.listTools()) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
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

test("get_status reports cache health without Telegram network calls", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 42,
      text: "status message",
    },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 42,
    newestMessageId: 42,
    syncedCount: 1,
    mode: "recent",
    error: "transient sync issue",
    recentCatchup: {
      minMessageId: 42,
      nextOffsetId: 100,
      newestMessageId: 150,
    },
  });
  store.setBackfillExhausted(CHAT, true);
  store.recordDaemonTickStarted();
  store.recordDaemonTickFailure("rate_limit: FLOOD_WAIT_30");

  const result = await callTool(makeTools(store), "get_status", {});

  assert.equal(result.ok, true);
  assert.equal((result.health as { status: string }).status, "degraded");
  assert.equal((result.chat as { chatId: string }).chatId, CHAT.chatId);
  assert.equal((result.chat as { kind: string }).kind, "Fake");
  assert.equal((result.cache as { messageCount: number }).messageCount, 1);
  assert.equal((result.cache as { oldestMessageId: number }).oldestMessageId, 42);
  assert.equal((result.sync as { backfillExhausted: boolean }).backfillExhausted, true);
  assert.equal((result.sync as { lastError?: string }).lastError, "transient sync issue");
  const recentCatchup = (result.sync as { recentCatchup?: { status: string; nextOffsetId: number } }).recentCatchup;
  assert.equal(recentCatchup?.status, "catching_up");
  assert.equal(recentCatchup?.nextOffsetId, 100);
  assert.equal((result.daemon as { lastError?: string }).lastError, "rate_limit: FLOOD_WAIT_30");
  assert.equal(Array.isArray((result.embeddings as { coverage?: unknown }).coverage), true);
});

test("read_history reports applied filters and outside cache range", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 10, text: "cached ten" },
    { chatId: CHAT.chatId, messageId: 11, text: "cached eleven" },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 10,
    newestMessageId: 11,
    syncedCount: 2,
    mode: "recent",
    error: null,
  });

  const result = await callTool(makeTools(store), "read_history", {
    after_id: 99,
    limit: 5,
    order: "asc",
  });

  assert.equal(result.ok, true);
  assert.equal(result.returned_count, 0);
  assert.deepEqual(result.applied_filters, { limit: 5, after_id: 99, order: "asc" });
  const cache = result.cache as {
    range: { message_count: number; newest_message_id: number };
    relation: { completeness: string; requested_after_cached_range: boolean };
    empty_reason: string;
    sync_state: { newestMessageId: number };
  };
  assert.equal(cache.range.message_count, 2);
  assert.equal(cache.range.newest_message_id, 11);
  assert.equal(cache.relation.completeness, "outside_cached_range");
  assert.equal(cache.relation.requested_after_cached_range, true);
  assert.equal(cache.empty_reason, "requested_after_cached_range");
  assert.equal(cache.sync_state.newestMessageId, 11);
});

test("get_thread_context reports center_found and partial cache range", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 10, text: "cached ten" },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 10,
    newestMessageId: 10,
    syncedCount: 1,
    mode: "recent",
    error: null,
  });

  const result = await callTool(makeTools(store), "get_thread_context", {
    message_id: 12,
    before: 2,
    after: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.center_found, false);
  assert.equal(result.returned_count, 1);
  assert.deepEqual(result.requested_range, {
    start_message_id: 10,
    end_message_id: 14,
    before: 2,
    after: 2,
  });
  const cache = result.cache as {
    relation: { completeness: string; partial_cached_range: boolean; may_omit_newer_messages: boolean };
    requested_range: { start_message_id: number; end_message_id: number };
  };
  assert.equal(cache.relation.completeness, "partial_cached_range");
  assert.equal(cache.relation.partial_cached_range, true);
  assert.equal(cache.relation.may_omit_newer_messages, true);
  assert.deepEqual(cache.requested_range, { start_message_id: 10, end_message_id: 14 });
});

function makeTools(store = new MessageStore(":memory:")): TelegramTools {
  return new TelegramTools(config(), new FakeTelegram() as unknown as TelegramService, store);
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
      chunkOverlapMessages: 0,
      chunkMaxChars: 1600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1000,
      maxCharsPerRun: 500_000,
      vectorCandidateLimit: 20_000,
      searchLimit: 12,
    },
    throttle: {
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
  return parseToolPayload(result);
}

function parseToolPayload(result: { content: Array<{ type: "text"; text: string }> }): Record<string, unknown> & { ok: boolean } {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown> & { ok: boolean };
}
