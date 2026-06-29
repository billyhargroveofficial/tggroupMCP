import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { vectorToBlob } from "../src/embeddings.js";
import { MessageStore } from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";
import { VectorRag } from "../src/vector-rag.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

test("coverage indexing picks up older backfill after recent messages were indexed", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config(), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 100, senderName: "alice", text: "recent alpha" },
    { chatId: CHAT.chatId, messageId: 101, senderName: "bob", text: "recent beta" },
  ]);

  const first = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  assert.equal(first.messagesCovered, 2);

  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 90, senderName: "carol", text: "older needle one" },
    { chatId: CHAT.chatId, messageId: 91, senderName: "dave", text: "older needle two" },
  ]);
  const estimate = vectorRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(estimate.estimatedMessages, 2);
  assert.equal(estimate.coverage.cache_messages, 4);
  assert.equal(estimate.coverage.indexed_messages, 2);
  assert.equal(estimate.coverage.uncovered_messages, 2);
  assert.equal(estimate.coverage.uncovered_ranges, 1);

  const second = await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(second.messagesCovered, 2);
  assert.equal(second.coverage.cache_messages, 4);
  assert.equal(second.coverage.indexed_messages, 4);
  assert.equal(second.coverage.uncovered_messages, 0);

  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 102, senderName: "erin", text: "newer gamma" },
    { chatId: CHAT.chatId, messageId: 103, senderName: "frank", text: "newer delta" },
  ]);
  const thirdEstimate = vectorRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(thirdEstimate.estimatedMessages, 2);
  assert.equal(thirdEstimate.coverage.uncovered_messages, 2);
  const third = await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(third.messagesCovered, 2);
  assert.equal(third.coverage.cache_messages, 6);
  assert.equal(third.coverage.indexed_messages, 6);
  assert.equal(third.coverage.uncovered_messages, 0);

  const chunks = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });
  assert.deepEqual(
    chunks.map((chunk) => [chunk.startMessageId, chunk.endMessageId]),
    [
      [90, 91],
      [100, 101],
      [102, 103],
    ],
  );
  const search = await vectorRag.search({ chatId: CHAT.chatId, query: "older", limit: 1, includeMessages: true });
  assert.equal(search.hits[0]?.chunk.startMessageId, 90);
  assert.deepEqual(
    search.hits[0]?.messages.map((message) => message.messageId),
    [90, 91],
  );
});

test("dirty chunks are excluded from search and reindexed after message edits", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config(), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "plain beta" },
  ]);

  await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "edited needle" }]);

  const dirtyStats = store.getEmbeddingStats(CHAT.chatId)[0]!;
  assert.equal(dirtyStats.dirty_chunks, 1);
  assert.equal(dirtyStats.indexed_messages, 0);
  assert.equal(dirtyStats.uncovered_messages, 2);
  assert.equal(
    store.getEmbeddingChunks({
      chatId: CHAT.chatId,
      model: config().embeddings.model,
      dimensions: config().embeddings.dimensions,
    }).length,
    0,
  );

  const result = await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(result.messagesCovered, 2);
  assert.equal(result.coverage.dirty_chunks, 0);
  assert.equal(result.coverage.indexed_messages, 2);
  assert.equal(result.coverage.uncovered_messages, 0);

  const search = await vectorRag.search({ chatId: CHAT.chatId, query: "needle", limit: 1, includeMessages: true });
  assert.equal(search.hits[0]?.chunk.startMessageId, 1);
  assert.match(search.hits[0]?.chunk.text ?? "", /edited needle/);
});

test("vector hits hydrate exact chunk message ids across empty messages", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config(), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "media", text: "" },
    { chatId: CHAT.chatId, messageId: 3, senderName: "bob", text: "needle beta" },
  ]);

  await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  const [chunk] = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });
  assert.deepEqual(chunk?.messageIds, [1, 3]);
  assert.equal(chunk?.startMessageId, 1);
  assert.equal(chunk?.endMessageId, 3);

  const search = await vectorRag.search({ chatId: CHAT.chatId, query: "needle", limit: 1, includeMessages: true });
  assert.deepEqual(
    search.hits[0]?.messages.map((message) => message.messageId),
    [1, 3],
  );
});

test("embedding API requests time out with AbortController", async (t) => {
  mockFetch(t, async (_url, init) => {
    const signal = (init as RequestInit).signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ requestTimeoutMs: 10, maxRetries: 0 }), store);
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" }]);

  await assert.rejects(
    () =>
      vectorRag.indexCachedMessages({
        chatId: CHAT.chatId,
        limitChunks: 1,
        confirmFirstRun: true,
      }),
    /Embedding API request timed out after 10ms/,
  );
});

test("embedding API retry honors retry-after for 429 responses", async (t) => {
  let calls = 0;
  mockFetch(t, async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      });
    }
    return embeddingResponse(init as RequestInit);
  });
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ maxRetries: 1, retryInitialMs: 0 }), store);
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" }]);

  const result = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });

  assert.equal(calls, 2);
  assert.equal(result.chunksCreated, 1);
});

test("embedding indexing respects chunk and character budgets", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(
    config({ chunkMessages: 1, maxChunksPerRun: 2, maxCharsPerRun: 500_000 }),
    store,
  );
  store.upsertMessages(
    CHAT,
    [1, 2, 3, 4, 5].map((messageId) => ({
      chatId: CHAT.chatId,
      messageId,
      senderName: "alice",
      text: `budget message ${messageId}`,
    })),
  );

  const estimate = vectorRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 10 });
  assert.equal(estimate.requestedLimitChunks, 10);
  assert.equal(estimate.limitChunks, 2);
  assert.equal(estimate.budget.truncatedByChunkBudget, true);
  assert.equal(estimate.estimatedChunks, 2);

  const result = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 10,
    confirmFirstRun: true,
  });
  assert.equal(result.chunksCreated, 2);
  assert.equal(result.messagesCovered, 2);
  assert.equal(result.coverage.uncovered_messages, 3);

  const charBudgetStore = new MessageStore(":memory:");
  const charBudgetRag = new VectorRag(config({ maxCharsPerRun: 1 }), charBudgetStore);
  charBudgetStore.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "too large" }]);
  const charEstimate = charBudgetRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 10 });
  assert.equal(charEstimate.estimatedChunks, 0);
  assert.equal(charEstimate.budget.truncatedByCharBudget, true);
});

test("embedding dimension mismatch fails indexing clearly", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ dimensions: 2 }), store);
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" }]);

  await assert.rejects(
    () =>
      vectorRag.indexCachedMessages({
        chatId: CHAT.chatId,
        limitChunks: 1,
        confirmFirstRun: true,
      }),
    /Embedding API returned 3 dimensions for input 0; expected TELEGRAM_EMBEDDINGS_DIMENSIONS=2/,
  );
  assert.equal(
    store.getEmbeddingChunks({
      chatId: CHAT.chatId,
      model: config().embeddings.model,
      dimensions: 2,
    }).length,
    0,
  );
});

test("vector search uses actual query dimensions for mixed indexes", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ dimensions: undefined }), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "two dimensional needle" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "three dimensional distractor" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "two dimensional needle",
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "two",
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "three dimensional distractor",
      model: config().embeddings.model,
      dimensions: 3,
      embedding: vectorToBlob([1, 0, 0]),
      contentHash: "three",
    },
  ]);

  const result = await vectorRag.search({ chatId: CHAT.chatId, query: "needle", limit: 10, includeMessages: true });

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.chunk.dimensions, 2);
  assert.equal(result.hits[0]?.messages[0]?.messageId, 1);
  assert.deepEqual(
    result.stats.map((row) => row.dimensions).sort(),
    [2, 3],
  );
});

function mockEmbeddingFetch(t: { after(fn: () => void): void }): void {
  mockFetch(t, async (_url, init) => embeddingResponse(init as RequestInit));
}

function mockFetch(t: { after(fn: () => void): void }, handler: typeof globalThis.fetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function embeddingResponse(init: RequestInit): Response {
  const body = JSON.parse(String(init.body ?? "{}")) as { input?: string | string[] };
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  return new Response(
    JSON.stringify({
      data: inputs.map((input, index) => ({
        index,
        embedding: embeddingForText(String(input)),
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function embeddingForText(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("older") || normalized.includes("needle")) {
    return [1, 0];
  }
  return [0, 1];
}

function config(embeddings: Partial<AppConfig["embeddings"]> = {}): AppConfig {
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
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: 2,
      apiBatchSize: 64,
      requestTimeoutMs: 60_000,
      maxRetries: 2,
      retryInitialMs: 0,
      chunkMessages: 2,
      chunkMaxChars: 1600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1000,
      maxCharsPerRun: 500_000,
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
