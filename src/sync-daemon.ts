#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { normalizeError, ToolError, type NormalizedError } from "./errors.js";
import { stringify } from "./json.js";
import { MessageStore } from "./store.js";
import { TelegramService } from "./telegram-client.js";
import { HistorySyncer, type SyncOnceResult } from "./sync-engine.js";
import { VectorRag } from "./vector-rag.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOnce(): Promise<void> {
  const config = loadConfig();
  const store = new MessageStore(config.storage.dbPath);
  const telegram = new TelegramService(config);
  const syncer = new HistorySyncer(config, telegram, store);
  try {
    const result = await syncer.syncOnce();
    console.log(stringify({ ok: true, result }));
  } finally {
    await telegram.disconnect();
  }
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const store = new MessageStore(config.storage.dbPath);
  const telegram = new TelegramService(config);
  const syncer = new HistorySyncer(config, telegram, store);
  const vectorRag = new VectorRag(config, store);
  const intervalMs = Math.max(5_000, config.sync.intervalMs);
  let backoffMs = 0;

  console.error(`telegram-parilka-mcp sync daemon running every ${intervalMs}ms`);
  while (true) {
    const started = Date.now();
    let errors: NormalizedError[] = [];
    recordDaemonStarted(store);
    try {
      const result = await syncer.syncOnce();
      errors = syncErrors(result);
      if (errors.length > 0) {
        recordDaemonFailure(store, errors);
      } else {
        recordDaemonSuccess(store);
      }
      const embeddings = await indexEmbeddings(vectorRag, result.chat);
      console.error(
        `sync tick ${stringify({
          recent: summarize(result.recent),
          backfill: summarize(result.backfill),
          embeddings,
          daemonStatus: store.getDaemonStatus(),
        })}`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      errors = [normalized];
      recordDaemonFailure(store, errors);
      console.error(`sync tick error ${stringify({ error: normalized, daemonStatus: store.getDaemonStatus() })}`);
    } finally {
      await telegram.disconnect();
    }
    stopOnPermanentDaemonErrors(errors);
    const elapsed = Date.now() - started;
    const delay = computeDaemonDelayMs({
      intervalMs,
      elapsedMs: elapsed,
      errors,
      previousBackoffMs: backoffMs,
      backoffInitialMs: config.sync.transientBackoffInitialMs,
      backoffMaxMs: config.sync.transientBackoffMaxMs,
    });
    backoffMs = delay.nextBackoffMs;
    if (delay.reason !== "interval") {
      console.error(`sync delayed ${stringify(delay)}`);
    }
    await sleep(delay.delayMs);
  }
}

export function syncErrors(result: SyncOnceResult): NormalizedError[] {
  return [result.recent?.error, result.backfill?.error].filter((error): error is NormalizedError => error != null);
}

export function shouldStopDaemonForErrors(errors: NormalizedError[]): boolean {
  return errors.some((error) => error.category === "auth" && !error.retryable);
}

export function computeDaemonDelayMs(params: {
  intervalMs: number;
  elapsedMs: number;
  errors: NormalizedError[];
  previousBackoffMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  minDelayMs?: number;
}): { delayMs: number; nextBackoffMs: number; reason: "interval" | "retry_after" | "backoff" } {
  const minDelayMs = params.minDelayMs ?? 1_000;
  const intervalDelayMs = Math.max(minDelayMs, params.intervalMs - params.elapsedMs);
  const retryAfterMs = Math.max(0, ...params.errors.map((error) => (error.retryAfterSec ?? 0) * 1000));
  if (retryAfterMs > 0) {
    return {
      delayMs: Math.max(intervalDelayMs, retryAfterMs),
      nextBackoffMs: 0,
      reason: "retry_after",
    };
  }

  if (params.errors.some((error) => error.retryable)) {
    const nextBackoffMs =
      params.previousBackoffMs > 0
        ? Math.min(params.previousBackoffMs * 2, params.backoffMaxMs)
        : params.backoffInitialMs;
    return {
      delayMs: Math.max(intervalDelayMs, nextBackoffMs),
      nextBackoffMs,
      reason: "backoff",
    };
  }

  return {
    delayMs: intervalDelayMs,
    nextBackoffMs: 0,
    reason: "interval",
  };
}

function stopOnPermanentDaemonErrors(errors: NormalizedError[]): void {
  const permanent = errors.find((error) => error.category === "auth" && !error.retryable);
  if (!permanent) {
    return;
  }
  throw new ToolError(permanent);
}

function recordDaemonStarted(store: MessageStore): void {
  try {
    store.recordDaemonTickStarted();
  } catch (error) {
    console.error(`daemon status start write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordDaemonSuccess(store: MessageStore): void {
  try {
    store.recordDaemonTickSuccess();
  } catch (error) {
    console.error(`daemon status success write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordDaemonFailure(store: MessageStore, errors: NormalizedError[]): void {
  try {
    store.recordDaemonTickFailure(daemonErrorSummary(errors));
  } catch (error) {
    console.error(`daemon status failure write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function daemonErrorSummary(errors: NormalizedError[]): string {
  return errors.map((error) => `${error.category}: ${error.message}`).join(" | ");
}

export async function indexEmbeddings(
  vectorRag: VectorRag,
  chatId: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!chatId || !vectorRag.isConfigured) {
    return null;
  }
  try {
    const estimate = vectorRag.estimateIndexCachedMessages({ chatId });
    if (estimate.requiresConfirmation) {
      return {
        skipped: "first_embedding_index_requires_manual_confirmation",
        estimate,
      };
    }
    const result = await vectorRag.indexCachedMessages({ chatId, confirmFirstRun: true });
    return {
      chunksCreated: result.chunksCreated,
      messagesCovered: result.messagesCovered,
      nextAfterMessageId: result.nextAfterMessageId,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarize(result: Awaited<ReturnType<HistorySyncer["syncDirection"]>> | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  return {
    mode: result.mode,
    status: result.status,
    skipped: result.skipped,
    fetched: result.fetched,
    saved: result.saved,
    nextOffsetId: result.nextOffsetId,
    error: result.error?.message,
  };
}

const once = process.argv.includes("--once");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (once ? runOnce() : runDaemon()).catch((error) => {
    console.error("sync-daemon fatal:", error);
    process.exit(1);
  });
}
