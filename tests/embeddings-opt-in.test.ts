import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { embeddingNamespace, vectorToBlob } from "../src/embeddings.js";
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
  await withEnv({ OPENAI_API_KEY: "test-key", TELEGRAM_EMBEDDINGS_ENABLED: "false" }, async (dbPath) => {
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

test("manual large embedding run reports budget estimate before API calls", async () => {
  const store = seededStore();
  const tools = new TelegramTools(
    config({ enabled: true, apiKey: "test-key", maxChunksPerRun: 1 }),
    new FakeTelegram() as unknown as TelegramService,
    store,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called before confirming a budget-truncated estimate");
  };
  try {
    const result = await callTool(tools, "index_embeddings", {
      chat: CHAT.chatId,
      limit_chunks: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.requires_confirmation, true);
    assert.equal(result.result, null);
    const estimate = result.estimate as Record<string, any>;
    assert.equal(estimate.requestedLimitChunks, 10);
    assert.equal(estimate.limitChunks, 1);
    assert.equal(estimate.budget.truncatedByChunkBudget, true);
    assert.equal(Number(estimate.estimatedChars) > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embed-index CLI returns first-run estimate without calling embeddings API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-embed-cli-first-run-test-"));
  const dbPath = join(dir, "messages.sqlite");
  try {
    const store = seededStoreAt(dbPath);
    store.close();

    const run = await runEmbedIndexCli(dbPath, ["--limit-chunks", "10"], {
      TELEGRAM_EMBEDDINGS_BASE_URL: "http://127.0.0.1:9/v1",
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.payload.ok, true);
    assert.equal(run.payload.status, "requires_confirmation");
    assert.equal(run.payload.requires_confirmation, true);
    assert.equal(run.payload.result, null);
    const estimate = run.payload.estimate as Record<string, any>;
    assert.equal(estimate.firstRun, true);
    assert.equal(estimate.requiresConfirmation, true);
    assert.equal(estimate.estimatedChunks, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embed-index CLI requires budget confirmation and indexes when confirmed", async () => {
  await withEmbeddingServer(2, async (baseUrl, requests) => {
    const dir = mkdtempSync(join(tmpdir(), "telegram-embed-cli-budget-test-"));
    const dbPath = join(dir, "messages.sqlite");
    try {
      const seedConfig = config({
        baseUrl,
        dimensions: 2,
        chunkMessages: 1,
        maxChunksPerRun: 1,
      });
      const store = new MessageStore(dbPath);
      store.upsertMessages(CHAT, [
        { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "already indexed" },
        { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "needs budget confirmation one" },
        { chatId: CHAT.chatId, messageId: 3, senderName: "carol", text: "needs budget confirmation two" },
      ]);
      store.upsertEmbeddingChunks([
        {
          chatId: CHAT.chatId,
          startMessageId: 1,
          endMessageId: 1,
          messageIds: [1],
          messageCount: 1,
          text: "already indexed",
          namespace: embeddingNamespace(seedConfig),
          model: seedConfig.embeddings.model,
          dimensions: 2,
          embedding: vectorToBlob([1, 0]),
          contentHash: "existing",
        },
      ]);
      store.close();

      const env = {
        TELEGRAM_EMBEDDINGS_BASE_URL: baseUrl,
        TELEGRAM_EMBEDDINGS_DIMENSIONS: "2",
        TELEGRAM_EMBEDDINGS_CHUNK_MESSAGES: "1",
        TELEGRAM_EMBEDDINGS_MAX_CHUNKS_PER_RUN: "1",
      };
      const estimateOnly = await runEmbedIndexCli(dbPath, ["--limit-chunks", "10"], env);
      assert.equal(estimateOnly.code, 0, estimateOnly.stderr);
      assert.equal(estimateOnly.payload.status, "requires_confirmation");
      assert.equal(estimateOnly.payload.requires_confirmation, true);
      assert.equal(estimateOnly.payload.result, null);
      const estimate = estimateOnly.payload.estimate as Record<string, any>;
      assert.equal(estimate.firstRun, false);
      assert.equal(estimate.budget.truncatedByChunkBudget, true);
      assert.equal(requests.length, 0);

      const confirmed = await runEmbedIndexCli(dbPath, ["--limit-chunks", "10", "--confirm-estimate"], env);
      assert.equal(confirmed.code, 0, confirmed.stderr);
      assert.equal(confirmed.payload.status, "indexed");
      assert.equal(confirmed.payload.requires_confirmation, false);
      const result = confirmed.payload.result as Record<string, any>;
      assert.equal(result.chunksCreated, 1);
      assert.equal(result.messagesCovered, 1);
      assert.equal(requests.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function seededStore(): MessageStore {
  return seededStoreAt(":memory:");
}

function seededStoreAt(dbPath: string): MessageStore {
  const store = new MessageStore(dbPath);
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

async function runEmbedIndexCli(
  dbPath: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string; payload: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/embed-index.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TELEGRAM_SHARED_ENV_PATH: join(tmpdir(), "telegram-embed-cli-missing-shared.env"),
        TELEGRAM_ENV_PATH: join(tmpdir(), "telegram-embed-cli-missing-local.env"),
        TELEGRAM_DB_PATH: dbPath,
        TELEGRAM_API_ID: "1",
        TELEGRAM_API_HASH: "hash",
        TELEGRAM_SESSION: "session",
        TELEGRAM_DEFAULT_CHAT_ID: CHAT.chatId,
        TELEGRAM_ALLOWED_CHAT_IDS: CHAT.chatId,
        TELEGRAM_EMBEDDINGS_ENABLED: "true",
        TELEGRAM_EMBEDDINGS_API_KEY: "test-key",
        TELEGRAM_EMBEDDINGS_DIMENSIONS: "2",
        TELEGRAM_EMBEDDINGS_MAX_RETRIES: "0",
        TELEGRAM_EMBEDDINGS_REQUEST_TIMEOUT_MS: "1000",
        TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS: "0",
        ...envOverrides,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let payload: Record<string, any> = {};
      const trimmed = stdout.trim();
      if (trimmed) {
        payload = JSON.parse(trimmed) as Record<string, any>;
      }
      resolve({ code: code ?? -1, stdout, stderr, payload });
    });
  });
}

async function withEmbeddingServer<T>(
  dimensions: number,
  fn: (baseUrl: string, requests: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}") as { input?: string | string[] };
      requests.push(payload as Record<string, unknown>);
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ""];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: inputs.map((_, index) => ({
            index,
            embedding: Array.from({ length: dimensions }, (__, dimension) => (dimension === 0 ? 1 : 0)),
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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
      ...embeddings,
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
