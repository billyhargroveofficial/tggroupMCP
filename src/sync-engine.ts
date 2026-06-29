import type { AppConfig } from "./config.js";
import { normalizeError } from "./errors.js";
import { gramMessageToStored, MessageStore, type StoredMessage } from "./store.js";
import { TelegramService } from "./telegram-client.js";

export type SyncDirection = "recent" | "backfill";

export type SyncResult = {
  mode: SyncDirection;
  status: "done" | "failed" | "skipped";
  chat: {
    chatId: string;
    title?: string;
  };
  jobId: string;
  requested: number;
  fetched: number;
  saved: number;
  batches: number;
  nextOffsetId?: number;
  oldestMessageId?: number;
  newestMessageId?: number;
  skipped?: "backfill_exhausted";
  error?: ReturnType<typeof normalizeError>;
};

export type SyncOnceResult = {
  chat?: string;
  recent?: SyncResult;
  backfill?: SyncResult;
};

export class HistorySyncer {
  constructor(
    private readonly config: AppConfig,
    private readonly telegram: TelegramService,
    private readonly store: MessageStore,
  ) {}

  async syncOnce(params: {
    chat?: string;
    recentLimit?: number;
    backfillLimit?: number;
    batchSize?: number;
  } = {}): Promise<SyncOnceResult> {
    const recentLimit = params.recentLimit ?? this.config.sync.recentLimit;
    const backfillLimit = params.backfillLimit ?? this.config.sync.backfillLimit;
    const batchSize = params.batchSize ?? this.config.sync.batchSize;

    const result: SyncOnceResult = {};
    if (recentLimit > 0) {
      result.recent = await this.syncDirection({
        chat: params.chat,
        mode: "recent",
        limit: recentLimit,
        batchSize,
      });
      result.chat = result.recent.chat.chatId;
    }
    if (backfillLimit > 0) {
      result.backfill = await this.syncDirection({
        chat: params.chat,
        mode: "backfill",
        limit: backfillLimit,
        batchSize,
      });
      result.chat = result.backfill.chat.chatId;
    }
    return result;
  }

  async syncDirection(params: {
    chat?: string;
    mode: SyncDirection;
    limit: number;
    batchSize?: number;
    offsetId?: number;
    resetBackfillExhausted?: boolean;
  }): Promise<SyncResult> {
    const resolved = await this.telegram.resolveChat(params.chat);
    const chat = resolved.info;
    const currentState = this.store.getSyncState(chat.chatId);
    const batchSize = Math.max(1, Math.min(params.batchSize ?? this.config.sync.batchSize, 100));
    const target = Math.max(0, Math.min(params.limit, this.config.sync.maxSyncLimit));

    if (params.mode === "backfill" && params.resetBackfillExhausted) {
      this.store.setBackfillExhausted(chat, false);
    } else if (params.mode === "backfill" && currentState?.backfillExhaustedAt) {
      const jobId = this.store.startHistoryJob(chat.chatId, params.mode, 0);
      this.store.finishHistoryJob(jobId, {
        status: "skipped",
        batches: 0,
        messagesSeen: 0,
        messagesUpserted: 0,
      });
      return {
        mode: params.mode,
        status: "skipped",
        chat: { chatId: chat.chatId, title: chat.title },
        jobId,
        requested: 0,
        fetched: 0,
        saved: 0,
        batches: 0,
        nextOffsetId: currentState.nextBackfillOffsetId,
        oldestMessageId: currentState.oldestMessageId,
        newestMessageId: currentState.newestMessageId,
        skipped: "backfill_exhausted",
      };
    }

    const jobId = this.store.startHistoryJob(chat.chatId, params.mode, target);

    const backfillOffsets = [currentState?.nextBackfillOffsetId, currentState?.oldestMessageId].filter(
      (value): value is number => value != null && value > 0,
    );
    let offsetId =
      params.offsetId ?? (params.mode === "backfill" && backfillOffsets.length > 0 ? Math.min(...backfillOffsets) : 0);
    const minId = params.mode === "recent" ? currentState?.newestMessageId : undefined;
    const shouldAdvanceBackfillPointer = params.mode === "backfill" || currentState?.nextBackfillOffsetId == null;
    let fetched = 0;
    let saved = 0;
    let batches = 0;
    let newestMessageId: number | undefined;
    let oldestMessageId: number | undefined;
    let rows: StoredMessage[] = [];
    const seen = new Set<string>();

    const flushRows = (): void => {
      if (rows.length === 0) {
        return;
      }
      saved += this.store.upsertMessages(chat, rows);
      rows = [];
      batches += 1;
    };

    try {
      if (target > 0) {
        if (params.mode === "recent") {
          let pageOffsetId = offsetId;
          while (true) {
            const stream = await this.telegram.iterateMessages({
              chat: chat.chatId,
              limit: target,
              offsetId: pageOffsetId,
              minId,
              waitTime: this.config.sync.historyWaitTimeSec,
            });
            let pageFetched = 0;
            let pageOldestMessageId: number | undefined;

            for await (const message of stream.messages) {
              fetched += 1;
              pageFetched += 1;
              const row = gramMessageToStored(stream.chat, message);
              if (!row) {
                continue;
              }

              const key = `${row.chatId}:${row.messageId}`;
              if (seen.has(key)) {
                continue;
              }
              seen.add(key);
              rows.push(row);

              oldestMessageId = oldestMessageId == null ? row.messageId : Math.min(oldestMessageId, row.messageId);
              newestMessageId = newestMessageId == null ? row.messageId : Math.max(newestMessageId, row.messageId);
              pageOldestMessageId =
                pageOldestMessageId == null ? row.messageId : Math.min(pageOldestMessageId, row.messageId);

              if (rows.length >= batchSize) {
                flushRows();
              }
            }
            flushRows();

            if (pageFetched < target || pageOldestMessageId == null) {
              break;
            }
            if (fetched >= this.config.sync.maxSyncLimit) {
              throw new Error(
                "Recent sync reached TELEGRAM_MAX_SYNC_LIMIT before confirming contiguous catch-up; state was not advanced.",
              );
            }
            pageOffsetId = pageOldestMessageId;
          }
        } else {
          const stream = await this.telegram.iterateMessages({
            chat: chat.chatId,
            limit: target,
            offsetId,
            minId,
            waitTime: this.config.sync.historyWaitTimeSec,
          });

          for await (const message of stream.messages) {
            fetched += 1;
            const row = gramMessageToStored(stream.chat, message);
            if (!row) {
              continue;
            }

            const key = `${row.chatId}:${row.messageId}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            rows.push(row);

            oldestMessageId = oldestMessageId == null ? row.messageId : Math.min(oldestMessageId, row.messageId);
            newestMessageId = newestMessageId == null ? row.messageId : Math.max(newestMessageId, row.messageId);

            if (rows.length >= batchSize) {
              flushRows();
            }
          }
          flushRows();
        }
      }

      if (oldestMessageId != null && shouldAdvanceBackfillPointer) {
        offsetId = oldestMessageId;
      }
      const cachedCount = this.store.countMessages(chat.chatId);

      this.store.updateSyncState(chat, {
        oldestMessageId,
        newestMessageId,
        nextBackfillOffsetId: shouldAdvanceBackfillPointer && offsetId > 0 ? offsetId : undefined,
        syncedCount: cachedCount,
        mode: params.mode,
        error: null,
      });
      if (params.mode === "backfill") {
        this.store.setBackfillExhausted(chat, fetched === 0);
      }
      this.store.finishHistoryJob(jobId, {
        status: "done",
        batches,
        messagesSeen: fetched,
        messagesUpserted: saved,
      });

      return {
        mode: params.mode,
        status: "done",
        chat: { chatId: chat.chatId, title: chat.title },
        jobId,
        requested: target,
        fetched,
        saved,
        batches,
        nextOffsetId: offsetId,
        oldestMessageId,
        newestMessageId,
      };
    } catch (error) {
      const normalized = normalizeError(error);
      this.store.updateSyncState(chat, {
        syncedCount: this.store.countMessages(chat.chatId),
        mode: params.mode,
        error: normalized.message,
      });
      this.store.finishHistoryJob(jobId, {
        status: "failed",
        batches,
        messagesSeen: fetched,
        messagesUpserted: saved,
        error: normalized.message,
      });
      return {
        mode: params.mode,
        status: "failed",
        chat: { chatId: chat.chatId, title: chat.title },
        jobId,
        requested: target,
        fetched,
        saved,
        batches,
        nextOffsetId: offsetId,
        oldestMessageId,
        newestMessageId,
        error: normalized,
      };
    }
  }
}
