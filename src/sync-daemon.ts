#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { stringify } from "./json.js";
import { MessageStore } from "./store.js";
import { TelegramService } from "./telegram-client.js";
import { HistorySyncer } from "./sync-engine.js";

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
  const intervalMs = Math.max(5_000, config.sync.intervalMs);

  console.error(`telegram-parilka-mcp sync daemon running every ${intervalMs}ms`);
  while (true) {
    const started = Date.now();
    try {
      const result = await syncer.syncOnce();
      console.error(
        `sync tick ${stringify({
          recent: summarize(result.recent),
          backfill: summarize(result.backfill),
        })}`,
      );
    } finally {
      await telegram.disconnect();
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(1_000, intervalMs - elapsed));
  }
}

function summarize(result: Awaited<ReturnType<HistorySyncer["syncDirection"]>> | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  return {
    mode: result.mode,
    fetched: result.fetched,
    saved: result.saved,
    nextOffsetId: result.nextOffsetId,
    error: result.error?.message,
  };
}

const once = process.argv.includes("--once");
(once ? runOnce() : runDaemon()).catch((error) => {
  console.error("sync-daemon fatal:", error);
  process.exit(1);
});
