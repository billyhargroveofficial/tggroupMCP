import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { embeddingNamespace, vectorToBlob } from "../src/embeddings.js";
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
    namespace: namespace(),
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
      namespace: namespace(),
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
    namespace: namespace(),
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

test("vector range filters trim semantic and hybrid hits to the requested window", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ chunkMessages: 3 }), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "outside alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "needle beta" },
    { chatId: CHAT.chatId, messageId: 3, senderName: "carol", text: "needle gamma" },
  ]);

  await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });

  const after = await vectorRag.search({
    chatId: CHAT.chatId,
    query: "needle",
    afterId: 1,
    limit: 5,
    includeMessages: true,
  });
  assert.deepEqual(after.hits[0]?.chunk.messageIds, [2, 3]);
  assert.deepEqual(
    after.hits[0]?.messages.map((message) => message.messageId),
    [2, 3],
  );
  assert.equal(after.hits[0]?.chunk.startMessageId, 2);
  assert.doesNotMatch(after.hits[0]?.chunk.text ?? "", /outside alpha/);

  const before = await vectorRag.search({
    chatId: CHAT.chatId,
    query: "needle",
    beforeId: 2,
    limit: 5,
    includeMessages: true,
  });
  assert.deepEqual(before.hits[0]?.chunk.messageIds, [1]);
  assert.deepEqual(
    before.hits[0]?.messages.map((message) => message.messageId),
    [1],
  );
  assert.equal(before.hits[0]?.chunk.endMessageId, 1);

  const keywordHits = store.searchWithRank({
    chatId: CHAT.chatId,
    query: "needle",
    afterId: 1,
    limit: 10,
  });
  const hybrid = vectorRag.hybrid(keywordHits, after.hits, 10);

  assert.equal(hybrid.some((hit) => hit.messageId === 1 || hit.startMessageId === 1), false);
  assert.equal(hybrid.some((hit) => hit.source === "hybrid" && hit.messageId === 2), true);
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
      namespace: namespace({ dimensions: 2 }),
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
      namespace: namespace({ dimensions: undefined }),
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
      namespace: namespace({ dimensions: undefined }),
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

test("changing provider or model starts a separate confirmed namespace", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const firstConfig = config();
  const firstRag = new VectorRag(firstConfig, store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "namespace alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "namespace beta" },
  ]);

  const first = await firstRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  assert.equal(first.namespace, embeddingNamespace(firstConfig));
  assert.equal(first.normalizationVersion, "l2-v1");

  const providerConfig = config({ baseUrl: "https://embeddings.example.test/v1" });
  const providerEstimate = new VectorRag(providerConfig, store).estimateIndexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
  });
  assert.notEqual(providerEstimate.namespace, first.namespace);
  assert.equal(providerEstimate.firstRun, true);
  assert.equal(providerEstimate.requiresConfirmation, true);
  assert.equal(providerEstimate.existingChunks, 0);
  assert.equal(providerEstimate.coverage.indexed_messages, 0);
  assert.equal(providerEstimate.coverage.uncovered_messages, 2);

  const modelConfig = config({ model: "other-embedding-model" });
  const modelEstimate = new VectorRag(modelConfig, store).estimateIndexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
  });
  assert.notEqual(modelEstimate.namespace, first.namespace);
  assert.equal(modelEstimate.firstRun, true);
  assert.equal(modelEstimate.requiresConfirmation, true);
  assert.equal(modelEstimate.coverage.uncovered_messages, 2);

  const stats = store.getEmbeddingStats(CHAT.chatId);
  assert.equal(stats.some((row) => row.namespace === first.namespace), true);
});

test("vector search only compares chunks from the current namespace", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const currentConfig = config({ baseUrl: "https://current-provider.example.test/v1" });
  const currentNamespace = embeddingNamespace(currentConfig);
  const otherNamespace = embeddingNamespace(config({ baseUrl: "https://other-provider.example.test/v1" }));
  const vectorRag = new VectorRag(currentConfig, store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "other namespace perfect match" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "current namespace weak match" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "other namespace perfect match",
      namespace: otherNamespace,
      model: currentConfig.embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "other",
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "current namespace weak match",
      namespace: currentNamespace,
      model: currentConfig.embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([0, 1]),
      contentHash: "current",
    },
  ]);

  const result = await vectorRag.search({ chatId: CHAT.chatId, query: "perfect", limit: 5, includeMessages: true });

  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.chunk.namespace, currentNamespace);
  assert.equal(result.hits[0]?.messages[0]?.messageId, 2);
  assert.deepEqual(result.stats.map((row) => row.namespace), [currentNamespace]);
});

test("vector search refuses candidate sets above the configured bound", async (t) => {
  mockFetch(t, async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ dimensions: 2, vectorCandidateLimit: 1 }), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "first" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "second" },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "first",
      namespace: namespace({ dimensions: 2, vectorCandidateLimit: 1 }),
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "first",
    },
    {
      chatId: CHAT.chatId,
      startMessageId: 2,
      endMessageId: 2,
      messageIds: [2],
      messageCount: 1,
      text: "second",
      namespace: namespace({ dimensions: 2, vectorCandidateLimit: 1 }),
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([0, 1]),
      contentHash: "second",
    },
  ]);

  await assert.rejects(
    () => vectorRag.search({ chatId: CHAT.chatId, query: "first", limit: 1 }),
    /Vector search candidate limit 1 exceeded/,
  );
});

test("hybrid ranking merges overlapping keyword and vector evidence", () => {
  const vectorRag = new VectorRag(config(), new MessageStore(":memory:"));
  const lexicalOnly = { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "lexical only" };
  const overlap = { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "shared evidence" };
  const vectorOnly = { chatId: CHAT.chatId, messageId: 3, senderName: "carol", text: "vector only" };

  const results = vectorRag.hybrid(
    [
      { message: lexicalOnly, rank: 0 },
      { message: overlap, rank: 0 },
    ],
    [
      {
        rank: 1,
        score: 0.99,
        chunk: {
          id: 20,
          startMessageId: 2,
          endMessageId: 2,
          messageCount: 1,
          messageIds: [2],
          text: "shared evidence chunk",
          namespace: namespace(),
          model: config().embeddings.model,
          dimensions: 2,
        },
        messages: [overlap],
      },
      {
        rank: 2,
        score: 0.98,
        chunk: {
          id: 30,
          startMessageId: 3,
          endMessageId: 3,
          messageCount: 1,
          messageIds: [3],
          text: "vector only chunk",
          namespace: namespace(),
          model: config().embeddings.model,
          dimensions: 2,
        },
        messages: [vectorOnly],
      },
    ],
    10,
  );

  assert.equal(results[0]?.source, "hybrid");
  assert.deepEqual(results[0]?.sources.sort(), ["keyword", "vector"]);
  assert.equal(results[0]?.messageId, 2);
  assert.equal(results.some((hit) => hit.source === "keyword" && hit.messageId === 1), true);
  assert.equal(results.some((hit) => hit.source === "vector" && hit.startMessageId === 3), true);
  assert.equal((results[0]?.score ?? 0) > (results[1]?.score ?? 0), true);
});

test("chunk overlap repeats trailing message membership", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ chunkMessages: 2, chunkOverlapMessages: 1 }), store);
  store.upsertMessages(
    CHAT,
    [1, 2, 3].map((messageId) => ({
      chatId: CHAT.chatId,
      messageId,
      senderName: "alice",
      text: `overlap message ${messageId}`,
    })),
  );

  await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 3, confirmFirstRun: true });

  const chunks = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: namespace({ chunkMessages: 2, chunkOverlapMessages: 1 }),
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });
  assert.deepEqual(
    chunks.map((chunk) => chunk.messageIds),
    [
      [1, 2],
      [2, 3],
    ],
  );
});

test("long messages are truncated to the configured chunk max", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ chunkMessages: 1, chunkMaxChars: 80 }), store);
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "x".repeat(500),
    },
  ]);

  await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1, confirmFirstRun: true });
  const [chunk] = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: namespace({ chunkMessages: 1, chunkMaxChars: 80 }),
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });

  assert.equal((chunk?.text.length ?? 0) <= 80, true);
  assert.match(chunk?.text ?? "", /truncated/);
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
      chunkOverlapMessages: 0,
      chunkMaxChars: 1600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1000,
      maxCharsPerRun: 500_000,
      vectorCandidateLimit: 20_000,
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

function namespace(embeddings: Partial<AppConfig["embeddings"]> = {}): string {
  return embeddingNamespace(config(embeddings));
}
