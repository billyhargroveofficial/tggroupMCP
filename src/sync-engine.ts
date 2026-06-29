import type { AppConfig } from "./config.js";
import { normalizeError, ToolError } from "./errors.js";
import { gramMessageToStored, MessageStore, type StoredMessage } from "./store.js";
import { type ChatInfo, TelegramService } from "./telegram-client.js";

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
  reconciliation?: {
    checked: number;
    refreshed: number;
    deleted: number;
  };
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
    commitCursor?: boolean;
  }): Promise<SyncResult> {
    const resolved = await withOperationTimeout(
      this.telegram.resolveChat(params.chat),
      this.config.sync.historyOperationTimeoutMs,
      "Telegram chat resolution",
    );
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

    const backfillOffsets = [currentState?.nextBackfillOffsetId, currentState?.oldestMessageId].filter(
      (value): value is number => value != null && value > 0,
    );
    let offsetId =
      params.offsetId ?? (params.mode === "backfill" && backfillOffsets.length > 0 ? Math.min(...backfillOffsets) : 0);
    const minId = params.mode === "recent" ? currentState?.newestMessageId : undefined;
    const hasManualOffset = params.mode === "backfill" && params.offsetId != null;
    const shouldAdvanceBackfillPointer = params.mode === "backfill" && (params.commitCursor ?? !hasManualOffset);
    if (hasManualOffset && params.commitCursor) {
      const currentCursor = backfillOffsets.length > 0 ? Math.min(...backfillOffsets) : undefined;
      if (currentCursor != null && params.offsetId !== currentCursor) {
        throw new ToolError({
          category: "internal",
          retryable: false,
          message: `commit_cursor:true requires offset_id to match current backfill cursor ${currentCursor}.`,
        });
      }
    }
    const jobId = this.store.startHistoryJob(chat.chatId, params.mode, target);
    let fetched = 0;
    let saved = 0;
    let batches = 0;
    let newestMessageId: number | undefined;
    let oldestMessageId: number | undefined;
    let reconciliation: SyncResult["reconciliation"];
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
            const stream = await withOperationTimeout(
              this.telegram.iterateMessages({
                chat: chat.chatId,
                limit: target,
                offsetId: pageOffsetId,
                minId,
                waitTime: this.config.sync.historyWaitTimeSec,
              }),
              this.config.sync.historyOperationTimeoutMs,
              "Telegram recent history request",
            );
            let pageFetched = 0;
            let pageOldestMessageId: number | undefined;

            for await (const message of iterateWithOperationTimeout(
              stream.messages,
              this.config.sync.historyOperationTimeoutMs,
              "Telegram recent history iterator",
            )) {
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
          const stream = await withOperationTimeout(
            this.telegram.iterateMessages({
              chat: chat.chatId,
              limit: target,
              offsetId,
              minId,
              waitTime: this.config.sync.historyWaitTimeSec,
            }),
            this.config.sync.historyOperationTimeoutMs,
            "Telegram backfill history request",
          );

          for await (const message of iterateWithOperationTimeout(
            stream.messages,
            this.config.sync.historyOperationTimeoutMs,
            "Telegram backfill history iterator",
          )) {
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
        oldestMessageId: shouldAdvanceBackfillPointer || params.mode === "recent" ? oldestMessageId : undefined,
        newestMessageId: shouldAdvanceBackfillPointer || params.mode === "recent" ? newestMessageId : undefined,
        nextBackfillOffsetId: shouldAdvanceBackfillPointer && offsetId > 0 ? offsetId : undefined,
        syncedCount: cachedCount,
        mode: shouldAdvanceBackfillPointer || params.mode === "recent" ? params.mode : "manual",
        error: null,
      });
      if (params.mode === "backfill") {
        this.store.setBackfillExhausted(chat, fetched === 0);
      }
      if (params.mode === "recent") {
        reconciliation = await this.reconcileRecentWindow(chat, Math.max(1, Math.min(target, this.config.sync.recentLimit)));
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
        reconciliation,
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

  private async reconcileRecentWindow(chat: ChatInfo, limit: number): Promise<NonNullable<SyncResult["reconciliation"]>> {
    const ids = this.store.getRecentMessageIds(chat.chatId, limit);
    if (ids.length === 0) {
      return { checked: 0, refreshed: 0, deleted: 0 };
    }
    const response = await withOperationTimeout(
      this.telegram.getMessages({
        chat: chat.chatId,
        limit: ids.length,
        ids,
      }),
      this.config.sync.historyOperationTimeoutMs,
      "Telegram recent reconciliation lookup",
    );
    const rows = response.messages
      .map((message) => gramMessageToStored(response.chat, message))
      .filter((row): row is StoredMessage => row != null);
    const returned = new Set(rows.map((row) => row.messageId));
    const missing = ids.filter((id) => !returned.has(id));
    const refreshed = this.store.upsertMessages(chat, rows);
    const deleted = this.store.markMessagesDeleted(chat.chatId, missing);
    return { checked: ids.length, refreshed, deleted };
  }
}

async function* iterateWithOperationTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  operation: string,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    let result: IteratorResult<T>;
    try {
      result = await withOperationTimeout(iterator.next(), timeoutMs, operation);
    } catch (error) {
      closeIteratorQuietly(iterator, operation);
      throw error;
    }
    if (result.done) {
      return;
    }
    yield result.value;
  }
}

async function withOperationTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError({
              category: "internal",
              retryable: true,
              message: `${operation} timed out after ${timeoutMs}ms.`,
            }),
          );
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function closeIteratorQuietly<T>(iterator: AsyncIterator<T>, operation: string): void {
  const close = iterator.return?.bind(iterator);
  if (!close) {
    return;
  }
  void close().catch((error) => {
    console.error(`${operation} cleanup failed after timeout: ${error instanceof Error ? error.message : String(error)}`);
  });
}
