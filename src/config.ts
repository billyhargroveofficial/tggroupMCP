import { parse as parseDotenv } from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const DEFAULT_PARILKA_CHAT_ID = "-1003179772905";
const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));
const INT32_MAX = 2_147_483_647;

loadEnvFile("/root/.config/telegram-mcp/.env", false);
loadEnvFile(resolve(process.cwd(), ".env"), true);

function loadEnvFile(path: string, preferOverLoadedFile: boolean): void {
  if (!existsSync(path)) {
    return;
  }
  const parsed = parseDotenv(readFileSync(path));
  for (const [key, value] of Object.entries(parsed)) {
    if (INITIAL_ENV_KEYS.has(key)) {
      continue;
    }
    if (process.env[key] == null || preferOverLoadedFile) {
      process.env[key] = value;
    }
  }
}

export type NumericEnvRule = {
  fallback: number;
  min: number;
  max: number;
};

export const NUMERIC_ENV_RULES = {
  TELEGRAM_API_ID: { fallback: 0, min: 0, max: INT32_MAX },
  TELEGRAM_CONNECTION_RETRIES: { fallback: 5, min: 0, max: 100 },
  TELEGRAM_MAX_SEND_CHARS: { fallback: 4096, min: 1, max: 35_000 },
  TELEGRAM_LIVE_SEND_APPROVAL_TTL_MS: { fallback: 5 * 60_000, min: 1_000, max: 24 * 60 * 60_000 },
  TELEGRAM_HISTORY_BATCH_SIZE: { fallback: 100, min: 1, max: 1_000 },
  TELEGRAM_MAX_SYNC_LIMIT: { fallback: 500_000, min: 1, max: 1_000_000 },
  TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC: { fallback: 10, min: 0, max: 24 * 60 * 60 },
  TELEGRAM_HISTORY_WAIT_TIME_SEC: { fallback: 1, min: 0, max: 60 },
  TELEGRAM_HISTORY_OPERATION_TIMEOUT_MS: { fallback: 120_000, min: 100, max: 24 * 60 * 60_000 },
  TELEGRAM_SYNC_INTERVAL_MS: { fallback: 60_000, min: 1_000, max: 24 * 60 * 60_000 },
  TELEGRAM_SYNC_RECENT_LIMIT: { fallback: 300, min: 0, max: 1_000_000 },
  TELEGRAM_SYNC_BACKFILL_LIMIT: { fallback: 1_000, min: 0, max: 1_000_000 },
  TELEGRAM_SYNC_BACKOFF_INITIAL_MS: { fallback: 5_000, min: 1_000, max: 60 * 60_000 },
  TELEGRAM_SYNC_BACKOFF_MAX_MS: { fallback: 5 * 60_000, min: 1_000, max: 24 * 60 * 60_000 },
  TELEGRAM_EMBEDDINGS_DIMENSIONS: { fallback: 256, min: 1, max: 16_384 },
  TELEGRAM_EMBEDDINGS_API_BATCH_SIZE: { fallback: 64, min: 1, max: 2_048 },
  TELEGRAM_EMBEDDINGS_REQUEST_TIMEOUT_MS: { fallback: 60_000, min: 100, max: 60 * 60_000 },
  TELEGRAM_EMBEDDINGS_MAX_RETRIES: { fallback: 2, min: 0, max: 10 },
  TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS: { fallback: 1_000, min: 0, max: 60 * 60_000 },
  TELEGRAM_EMBEDDINGS_CHUNK_MESSAGES: { fallback: 12, min: 1, max: 1_000 },
  TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS: { fallback: 1600, min: 1, max: 200_000 },
  TELEGRAM_EMBEDDINGS_TICK_CHUNK_LIMIT: { fallback: 100, min: 1, max: 100_000 },
  TELEGRAM_EMBEDDINGS_MAX_CHUNKS_PER_RUN: { fallback: 1_000, min: 1, max: 100_000 },
  TELEGRAM_EMBEDDINGS_MAX_CHARS_PER_RUN: { fallback: 500_000, min: 1, max: 50_000_000 },
  TELEGRAM_EMBEDDINGS_SEARCH_LIMIT: { fallback: 12, min: 1, max: 1_000 },
  TELEGRAM_DEDUPE_TTL_MS: { fallback: 10 * 60_000, min: 1_000, max: 30 * 24 * 60 * 60_000 },
  TELEGRAM_USER_COOLDOWN_MS: { fallback: 20_000, min: 0, max: 24 * 60 * 60_000 },
  TELEGRAM_MAX_PENDING_PER_USER_PER_CHAT: { fallback: 1, min: 1, max: 1_000 },
  TELEGRAM_MAX_QUEUE_PER_CHAT: { fallback: 25, min: 1, max: 100_000 },
  TELEGRAM_QUEUE_MAX_AGE_MS: { fallback: 2 * 60_000, min: 1_000, max: 24 * 60 * 60_000 },
  TELEGRAM_GLOBAL_CONCURRENCY: { fallback: 2, min: 1, max: 1_000 },
  TELEGRAM_MAX_RUNNING_PER_CHAT: { fallback: 1, min: 1, max: 1_000 },
} as const satisfies Record<string, NumericEnvRule>;

type NumericEnvName = keyof typeof NUMERIC_ENV_RULES;

const intFromEnv = (name: NumericEnvName): number => {
  const rule = NUMERIC_ENV_RULES[name];
  validateInteger(name, rule.fallback, rule);
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return rule.fallback;
  }
  const parsed = parseInteger(name, raw.trim(), rule);
  return parsed;
};

function parseInteger(name: string, raw: string, rule: NumericEnvRule): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${rule.min} and ${rule.max}; got ${JSON.stringify(raw)}.`);
  }
  const parsed = Number(raw);
  validateInteger(name, parsed, rule);
  return parsed;
}

function validateInteger(name: string, value: number, rule: NumericEnvRule): void {
  if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) {
    throw new Error(`${name} must be an integer between ${rule.min} and ${rule.max}; got ${value}.`);
  }
}

const boolFromEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const ToolSchemas = {
  chatRef: z.string().min(1).optional(),
};

export type AppConfig = {
  telegram: {
    apiId: number;
    apiHash: string;
    session: string;
    phone: string;
    defaultChatId: string;
    allowedChatIds: string[];
    requireAllowlistedChat: boolean;
    connectionRetries: number;
  };
  storage: {
    dbPath: string;
  };
  safety: {
    sendEnabled: boolean;
    dryRunDefault: boolean;
    maxSendChars: number;
    liveSendApprovalTtlMs: number;
    liveSendApprovalBypass: boolean;
  };
  sync: {
    batchSize: number;
    maxSyncLimit: number;
    floodWaitMaxSleepSec: number;
    historyWaitTimeSec: number;
    historyOperationTimeoutMs: number;
    intervalMs: number;
    recentLimit: number;
    backfillLimit: number;
    transientBackoffInitialMs: number;
    transientBackoffMaxMs: number;
  };
  embeddings: {
    enabled: boolean;
    apiKey: string;
    baseUrl: string;
    model: string;
    dimensions?: number;
    apiBatchSize: number;
    requestTimeoutMs: number;
    maxRetries: number;
    retryInitialMs: number;
    chunkMessages: number;
    chunkMaxChars: number;
    tickChunkLimit: number;
    maxChunksPerRun: number;
    maxCharsPerRun: number;
    searchLimit: number;
  };
  throttle: {
    dedupeTtlMs: number;
    userCooldownMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
    maxAgeMs: number;
    globalConcurrency: number;
    maxRunningPerChat: number;
  };
};

export function expandPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

export function loadConfig(): AppConfig {
  const defaultChatId = process.env.TELEGRAM_DEFAULT_CHAT_ID?.trim() || DEFAULT_PARILKA_CHAT_ID;
  const allowed = csv(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const dbPath = expandPath(process.env.TELEGRAM_DB_PATH || "~/.telegram-parilka-mcp/messages.sqlite");
  const embeddingApiKey =
    process.env.TELEGRAM_EMBEDDINGS_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  const embeddingDimensions = intFromEnv("TELEGRAM_EMBEDDINGS_DIMENSIONS");

  const config: AppConfig = {
    telegram: {
      apiId: intFromEnv("TELEGRAM_API_ID"),
      apiHash: process.env.TELEGRAM_API_HASH?.trim() || "",
      session:
        process.env.TELEGRAM_SESSION?.trim() ||
        process.env.TELEGRAM_SESSION_STRING_PERSONAL?.trim() ||
        process.env.TELEGRAM_SESSION_STRING_WIFE?.trim() ||
        process.env.SESSION?.trim() ||
        "",
      phone: process.env.TELEGRAM_PHONE?.trim() || "",
      defaultChatId,
      allowedChatIds: allowed.length > 0 ? allowed : [defaultChatId],
      requireAllowlistedChat: boolFromEnv("TELEGRAM_REQUIRE_ALLOWLIST", true),
      connectionRetries: intFromEnv("TELEGRAM_CONNECTION_RETRIES"),
    },
    storage: {
      dbPath,
    },
    safety: {
      sendEnabled: boolFromEnv("TELEGRAM_SEND_ENABLED", true),
      dryRunDefault: boolFromEnv("TELEGRAM_DRY_RUN_DEFAULT", false),
      maxSendChars: intFromEnv("TELEGRAM_MAX_SEND_CHARS"),
      liveSendApprovalTtlMs: intFromEnv("TELEGRAM_LIVE_SEND_APPROVAL_TTL_MS"),
      liveSendApprovalBypass: boolFromEnv("TELEGRAM_LIVE_SEND_APPROVAL_BYPASS", false),
    },
    sync: {
      batchSize: intFromEnv("TELEGRAM_HISTORY_BATCH_SIZE"),
      maxSyncLimit: intFromEnv("TELEGRAM_MAX_SYNC_LIMIT"),
      floodWaitMaxSleepSec: intFromEnv("TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC"),
      historyWaitTimeSec: intFromEnv("TELEGRAM_HISTORY_WAIT_TIME_SEC"),
      historyOperationTimeoutMs: intFromEnv("TELEGRAM_HISTORY_OPERATION_TIMEOUT_MS"),
      intervalMs: intFromEnv("TELEGRAM_SYNC_INTERVAL_MS"),
      recentLimit: intFromEnv("TELEGRAM_SYNC_RECENT_LIMIT"),
      backfillLimit: intFromEnv("TELEGRAM_SYNC_BACKFILL_LIMIT"),
      transientBackoffInitialMs: intFromEnv("TELEGRAM_SYNC_BACKOFF_INITIAL_MS"),
      transientBackoffMaxMs: intFromEnv("TELEGRAM_SYNC_BACKOFF_MAX_MS"),
    },
    embeddings: {
      enabled: boolFromEnv("TELEGRAM_EMBEDDINGS_ENABLED", false),
      apiKey: embeddingApiKey,
      baseUrl: process.env.TELEGRAM_EMBEDDINGS_BASE_URL?.trim() || "https://api.openai.com/v1",
      model: process.env.TELEGRAM_EMBEDDINGS_MODEL?.trim() || "text-embedding-3-small",
      dimensions: embeddingDimensions,
      apiBatchSize: intFromEnv("TELEGRAM_EMBEDDINGS_API_BATCH_SIZE"),
      requestTimeoutMs: intFromEnv("TELEGRAM_EMBEDDINGS_REQUEST_TIMEOUT_MS"),
      maxRetries: intFromEnv("TELEGRAM_EMBEDDINGS_MAX_RETRIES"),
      retryInitialMs: intFromEnv("TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS"),
      chunkMessages: intFromEnv("TELEGRAM_EMBEDDINGS_CHUNK_MESSAGES"),
      chunkMaxChars: intFromEnv("TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS"),
      tickChunkLimit: intFromEnv("TELEGRAM_EMBEDDINGS_TICK_CHUNK_LIMIT"),
      maxChunksPerRun: intFromEnv("TELEGRAM_EMBEDDINGS_MAX_CHUNKS_PER_RUN"),
      maxCharsPerRun: intFromEnv("TELEGRAM_EMBEDDINGS_MAX_CHARS_PER_RUN"),
      searchLimit: intFromEnv("TELEGRAM_EMBEDDINGS_SEARCH_LIMIT"),
    },
    throttle: {
      dedupeTtlMs: intFromEnv("TELEGRAM_DEDUPE_TTL_MS"),
      userCooldownMs: intFromEnv("TELEGRAM_USER_COOLDOWN_MS"),
      maxPendingPerUserPerChat: intFromEnv("TELEGRAM_MAX_PENDING_PER_USER_PER_CHAT"),
      maxQueuePerChat: intFromEnv("TELEGRAM_MAX_QUEUE_PER_CHAT"),
      maxAgeMs: intFromEnv("TELEGRAM_QUEUE_MAX_AGE_MS"),
      globalConcurrency: intFromEnv("TELEGRAM_GLOBAL_CONCURRENCY"),
      maxRunningPerChat: intFromEnv("TELEGRAM_MAX_RUNNING_PER_CHAT"),
    },
  };

  validateConfig(config);
  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  return config;
}

function validateConfig(config: AppConfig): void {
  if (config.sync.transientBackoffMaxMs < config.sync.transientBackoffInitialMs) {
    throw new Error(
      "TELEGRAM_SYNC_BACKOFF_MAX_MS must be greater than or equal to TELEGRAM_SYNC_BACKOFF_INITIAL_MS.",
    );
  }
}

export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    telegram: {
      apiId: config.telegram.apiId ? "<set>" : "<missing>",
      apiHash: config.telegram.apiHash ? "<set>" : "<missing>",
      session: config.telegram.session ? "<set>" : "<missing>",
      phone: config.telegram.phone ? "<set>" : "<missing>",
      defaultChatId: config.telegram.defaultChatId,
      allowedChatIds: config.telegram.allowedChatIds,
      requireAllowlistedChat: config.telegram.requireAllowlistedChat,
      connectionRetries: config.telegram.connectionRetries,
    },
    storage: config.storage,
    safety: config.safety,
    sync: config.sync,
    embeddings: {
      enabled: config.embeddings.enabled,
      configured: Boolean(config.embeddings.apiKey),
      baseUrl: config.embeddings.baseUrl,
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
      apiBatchSize: config.embeddings.apiBatchSize,
      requestTimeoutMs: config.embeddings.requestTimeoutMs,
      maxRetries: config.embeddings.maxRetries,
      retryInitialMs: config.embeddings.retryInitialMs,
      chunkMessages: config.embeddings.chunkMessages,
      chunkMaxChars: config.embeddings.chunkMaxChars,
      tickChunkLimit: config.embeddings.tickChunkLimit,
      maxChunksPerRun: config.embeddings.maxChunksPerRun,
      maxCharsPerRun: config.embeddings.maxCharsPerRun,
      searchLimit: config.embeddings.searchLimit,
    },
    throttle: config.throttle,
  };
}
