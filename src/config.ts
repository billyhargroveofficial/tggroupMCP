import { parse as parseDotenv } from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const DEFAULT_PARILKA_CHAT_ID = "-1003179772905";
const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));

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

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
};

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
    chunkMessages: number;
    chunkMaxChars: number;
    tickChunkLimit: number;
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
  const embeddingDimensions = intFromEnv("TELEGRAM_EMBEDDINGS_DIMENSIONS", 256);

  const config: AppConfig = {
    telegram: {
      apiId: intFromEnv("TELEGRAM_API_ID", 0),
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
      connectionRetries: intFromEnv("TELEGRAM_CONNECTION_RETRIES", 5),
    },
    storage: {
      dbPath,
    },
    safety: {
      sendEnabled: boolFromEnv("TELEGRAM_SEND_ENABLED", true),
      dryRunDefault: boolFromEnv("TELEGRAM_DRY_RUN_DEFAULT", false),
      maxSendChars: intFromEnv("TELEGRAM_MAX_SEND_CHARS", 4096),
      liveSendApprovalTtlMs: intFromEnv("TELEGRAM_LIVE_SEND_APPROVAL_TTL_MS", 5 * 60_000),
      liveSendApprovalBypass: boolFromEnv("TELEGRAM_LIVE_SEND_APPROVAL_BYPASS", false),
    },
    sync: {
      batchSize: intFromEnv("TELEGRAM_HISTORY_BATCH_SIZE", 100),
      maxSyncLimit: intFromEnv("TELEGRAM_MAX_SYNC_LIMIT", 500_000),
      floodWaitMaxSleepSec: intFromEnv("TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC", 10),
      historyWaitTimeSec: intFromEnv("TELEGRAM_HISTORY_WAIT_TIME_SEC", 1),
      intervalMs: intFromEnv("TELEGRAM_SYNC_INTERVAL_MS", 60_000),
      recentLimit: intFromEnv("TELEGRAM_SYNC_RECENT_LIMIT", 300),
      backfillLimit: intFromEnv("TELEGRAM_SYNC_BACKFILL_LIMIT", 1_000),
      transientBackoffInitialMs: intFromEnv("TELEGRAM_SYNC_BACKOFF_INITIAL_MS", 5_000),
      transientBackoffMaxMs: intFromEnv("TELEGRAM_SYNC_BACKOFF_MAX_MS", 5 * 60_000),
    },
    embeddings: {
      enabled: boolFromEnv("TELEGRAM_EMBEDDINGS_ENABLED", false),
      apiKey: embeddingApiKey,
      baseUrl: process.env.TELEGRAM_EMBEDDINGS_BASE_URL?.trim() || "https://api.openai.com/v1",
      model: process.env.TELEGRAM_EMBEDDINGS_MODEL?.trim() || "text-embedding-3-small",
      dimensions: embeddingDimensions > 0 ? embeddingDimensions : undefined,
      apiBatchSize: intFromEnv("TELEGRAM_EMBEDDINGS_API_BATCH_SIZE", 64),
      chunkMessages: intFromEnv("TELEGRAM_EMBEDDINGS_CHUNK_MESSAGES", 12),
      chunkMaxChars: intFromEnv("TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS", 1600),
      tickChunkLimit: intFromEnv("TELEGRAM_EMBEDDINGS_TICK_CHUNK_LIMIT", 100),
      searchLimit: intFromEnv("TELEGRAM_EMBEDDINGS_SEARCH_LIMIT", 12),
    },
    throttle: {
      dedupeTtlMs: intFromEnv("TELEGRAM_DEDUPE_TTL_MS", 10 * 60_000),
      userCooldownMs: intFromEnv("TELEGRAM_USER_COOLDOWN_MS", 20_000),
      maxPendingPerUserPerChat: intFromEnv("TELEGRAM_MAX_PENDING_PER_USER_PER_CHAT", 1),
      maxQueuePerChat: intFromEnv("TELEGRAM_MAX_QUEUE_PER_CHAT", 25),
      maxAgeMs: intFromEnv("TELEGRAM_QUEUE_MAX_AGE_MS", 2 * 60_000),
      globalConcurrency: intFromEnv("TELEGRAM_GLOBAL_CONCURRENCY", 2),
      maxRunningPerChat: intFromEnv("TELEGRAM_MAX_RUNNING_PER_CHAT", 1),
    },
  };

  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  return config;
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
      chunkMessages: config.embeddings.chunkMessages,
      chunkMaxChars: config.embeddings.chunkMaxChars,
      tickChunkLimit: config.embeddings.tickChunkLimit,
      searchLimit: config.embeddings.searchLimit,
    },
    throttle: config.throttle,
  };
}
