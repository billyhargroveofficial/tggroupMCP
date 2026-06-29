import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { errors as telegramErrors } from "telegram";
import type { AppConfig } from "../src/config.js";
import { normalizeError } from "../src/errors.js";
import { MessageStore } from "../src/store.js";
import { computeDaemonDelayMs, shouldStopDaemonForErrors } from "../src/sync-daemon.js";
import { SendThrottler } from "../src/throttler.js";
import { telegramClientOptions } from "../src/telegram-client.js";

test("telegram client options include configured flood sleep threshold", () => {
  const options = telegramClientOptions(config({ floodWaitMaxSleepSec: 42 }));

  assert.equal(options.connectionRetries, 3);
  assert.equal(options.floodSleepThreshold, 42);
});

test("flood wait retry-after delays the next daemon tick", () => {
  const error = normalizeError(new Error("FLOOD_WAIT_30"));
  const delay = computeDaemonDelayMs({
    intervalMs: 5_000,
    elapsedMs: 0,
    errors: [error],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryAfterSec, 30);
  assert.equal(delay.reason, "retry_after");
  assert.equal(delay.delayMs, 30_000);
  assert.equal(delay.nextBackoffMs, 0);
});

test("slow mode retry-after is normalized like flood wait", () => {
  const error = normalizeError(new Error("SLOWMODE_WAIT_12"));

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSec, 12);
});

test("real GramJS flood wait errors expose retry-after seconds", () => {
  const error = normalizeError(new telegramErrors.FloodWaitError({ capture: "42" }));

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSec, 42);
});

test("real GramJS slow mode errors expose retry-after seconds", () => {
  const error = normalizeError(new telegramErrors.SlowModeWaitError({ capture: "42" }));

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSec, 42);
});

test("send queue waits for chat flood not-before before dispatching the next job", async () => {
  const store = new MessageStore(":memory:");
  const throttler = new SendThrottler(config(), store);
  const chat = { chatId: "-1001", requested: "-1001", kind: "Fake" as const };
  let calls = 0;

  const first = throttler.run({
    chatId: chat.chatId,
    payloadHash: "first/hash",
    userKey: "mcp-server",
    action: async () => {
      calls += 1;
      throw new telegramErrors.SlowModeWaitError({ capture: "0.15" });
    },
  });

  await assert.rejects(first, /wait of 0.15 seconds/i);
  assert.equal(calls, 1);

  const started = Date.now();
  const second = throttler.run({
    chatId: chat.chatId,
    payloadHash: "second/hash",
    userKey: "mcp-server",
    action: async () => {
      calls += 1;
      return { id: 2, chat };
    },
  });

  await sleep(50);
  assert.equal(calls, 1);

  const sent = await second;
  assert.equal(sent.id, 2);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 120);
});

test("transient network errors use exponential daemon backoff", () => {
  const error = normalizeError(new Error("ECONNRESET socket hang up"));
  const first = computeDaemonDelayMs({
    intervalMs: 1_000,
    elapsedMs: 0,
    errors: [error],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });
  const second = computeDaemonDelayMs({
    intervalMs: 1_000,
    elapsedMs: 0,
    errors: [error],
    previousBackoffMs: first.nextBackoffMs,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });

  assert.equal(error.retryable, true);
  assert.equal(first.reason, "backoff");
  assert.equal(first.delayMs, 5_000);
  assert.equal(first.nextBackoffMs, 5_000);
  assert.equal(second.delayMs, 10_000);
  assert.equal(second.nextBackoffMs, 10_000);
});

test("permanent auth errors stop the daemon", () => {
  const error = normalizeError(new Error("AUTH_KEY_UNREGISTERED"));

  assert.equal(error.category, "auth");
  assert.equal(error.retryable, false);
  assert.equal(shouldStopDaemonForErrors([error]), true);
});

function config(sync?: Partial<AppConfig["sync"]>): AppConfig {
  return {
    telegram: {
      apiId: 1,
      apiHash: "hash",
      session: "session",
      phone: "",
      defaultChatId: "-1001",
      allowedChatIds: ["-1001"],
      requireAllowlistedChat: true,
      connectionRetries: 3,
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
      ...sync,
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
