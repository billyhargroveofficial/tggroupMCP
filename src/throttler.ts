import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { MessageStore } from "./store.js";
import type { ChatInfo } from "./telegram-client.js";

export type SentTelegramMessage = {
  id?: number;
  chat: ChatInfo;
};

type QueueJob = {
  outboxId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  run: () => Promise<SentTelegramMessage>;
  resolve: (value: SentTelegramMessage) => void;
  reject: (error: unknown) => void;
};

export class SendThrottler {
  private readonly chatQueues = new Map<string, QueueJob[]>();
  private readonly runningPerChat = new Map<string, number>();
  private runningGlobal = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly store: MessageStore,
  ) {}

  run(params: {
    chatId: string;
    dedupeKey?: string;
    payloadHash: string;
    replyToMessageId?: number;
    userKey: string;
    action: () => Promise<SentTelegramMessage>;
  }): Promise<SentTelegramMessage> {
    const now = Date.now();
    const reservation = this.store.reserveSend({
      outboxId: `send_${randomUUID()}`,
      dedupeKey: params.dedupeKey,
      payloadHash: params.payloadHash,
      chatId: params.chatId,
      replyToMessageId: params.replyToMessageId,
      userKey: params.userKey,
      nowMs: now,
      maxAgeMs: this.config.throttle.maxAgeMs,
      userCooldownMs: this.config.throttle.userCooldownMs,
      maxPendingPerUserPerChat: this.config.throttle.maxPendingPerUserPerChat,
      maxQueuePerChat: this.config.throttle.maxQueuePerChat,
    });

    if (reservation.kind === "duplicate_sent") {
      return Promise.resolve({
        id: reservation.telegramMessageId,
        chat: this.store.getCachedChat(reservation.chatId) ?? {
          chatId: reservation.chatId,
          requested: reservation.chatId,
          kind: "Cached",
        },
      });
    }

    const queue = this.chatQueues.get(params.chatId) ?? [];
    this.chatQueues.set(params.chatId, queue);

    return new Promise<SentTelegramMessage>((resolve, reject) => {
      queue.push({
        outboxId: reservation.outboxId,
        chatId: params.chatId,
        createdAt: now,
        expiresAt: reservation.expiresAtMs,
        run: params.action,
        resolve,
        reject,
      });
      this.schedule();
    });
  }

  private schedule(): void {
    while (this.runningGlobal < this.config.throttle.globalConcurrency) {
      const job = this.pickNextRunnableJob();
      if (!job) {
        return;
      }
      this.runningGlobal += 1;
      this.runningPerChat.set(job.chatId, (this.runningPerChat.get(job.chatId) ?? 0) + 1);

      if (Date.now() >= job.expiresAt) {
        this.expireRunningJob(job);
        continue;
      }

      try {
        this.store.markSendSending(job.outboxId);
      } catch (error) {
        job.reject(error);
        this.releaseRunningJob(job);
        continue;
      }
      void job
        .run()
        .then(
          (sent) => {
            try {
              this.store.markSendSent(job.outboxId, sent.id);
              job.resolve(sent);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              job.reject(new Error(`Send completed but audit update failed: ${message}`));
            }
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            try {
              this.store.markSendFailed(job.outboxId, message);
              job.reject(error);
            } catch (auditError) {
              const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
              job.reject(new Error(`Send failed and audit update failed: ${auditMessage}; original error: ${message}`));
            }
          },
        )
        .finally(() => {
          this.releaseRunningJob(job);
          this.schedule();
        });
    }
  }

  private pickNextRunnableJob(): QueueJob | undefined {
    const now = Date.now();
    for (const [chatId, queue] of this.chatQueues) {
      while (queue.length > 0) {
        const job = queue[0]!;
        if (now - job.createdAt > this.config.throttle.maxAgeMs || now >= job.expiresAt) {
          queue.shift();
          this.expireQueuedJob(job);
          continue;
        }
        if ((this.runningPerChat.get(chatId) ?? 0) >= this.config.throttle.maxRunningPerChat) {
          break;
        }
        return queue.shift();
      }
    }
    return undefined;
  }

  private expireQueuedJob(job: QueueJob): void {
    this.store.markSendExpired(job.outboxId);
    job.reject(
      new ToolError({
        category: "rate_limit",
        retryable: false,
        message: "Queued send expired before execution.",
      }),
    );
  }

  private expireRunningJob(job: QueueJob): void {
    this.expireQueuedJob(job);
    this.releaseRunningJob(job);
  }

  private releaseRunningJob(job: QueueJob): void {
    this.runningGlobal = Math.max(0, this.runningGlobal - 1);
    this.runningPerChat.set(job.chatId, Math.max(0, (this.runningPerChat.get(job.chatId) ?? 1) - 1));
  }
}
