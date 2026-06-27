import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const DEFAULT_PARILKA_CHAT_ID = "-1003179772905";

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
  };
  sync: {
    batchSize: number;
    maxSyncLimit: number;
    floodWaitMaxSleepSec: number;
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
      sendEnabled: boolFromEnv("TELEGRAM_SEND_ENABLED", false),
      dryRunDefault: boolFromEnv("TELEGRAM_DRY_RUN_DEFAULT", true),
      maxSendChars: intFromEnv("TELEGRAM_MAX_SEND_CHARS", 4096),
    },
    sync: {
      batchSize: intFromEnv("TELEGRAM_HISTORY_BATCH_SIZE", 100),
      maxSyncLimit: intFromEnv("TELEGRAM_MAX_SYNC_LIMIT", 500_000),
      floodWaitMaxSleepSec: intFromEnv("TELEGRAM_FLOOD_WAIT_MAX_SLEEP_SEC", 10),
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
    throttle: config.throttle,
  };
}
