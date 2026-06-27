import type { AppConfig } from "./config.js";
import { ToolError } from "./errors.js";

type QueueJob<T> = {
  chatId: string;
  userId: string;
  createdAt: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class SendThrottler {
  private readonly seen = new Map<string, number>();
  private readonly userState = new Map<string, { nextAllowedAt: number; pending: number }>();
  private readonly chatQueues = new Map<string, QueueJob<unknown>[]>();
  private readonly runningPerChat = new Map<string, number>();
  private runningGlobal = 0;

  constructor(private readonly config: AppConfig) {}

  dedupe(key?: string): void {
    if (!key) {
      return;
    }
    const now = Date.now();
    this.gcSeen(now);
    if (this.seen.has(key)) {
      throw new ToolError({
        category: "rate_limit",
        retryable: false,
        message: `Duplicate dedupe_key rejected: ${key}`,
      });
    }
    this.seen.set(key, now + this.config.throttle.dedupeTtlMs);
  }

  run<T>(params: { chatId: string; userId: string; action: () => Promise<T> }): Promise<T> {
    const now = Date.now();
    const userKey = `${params.chatId}:${params.userId}`;
    const state = this.userState.get(userKey) ?? { nextAllowedAt: 0, pending: 0 };
    this.userState.set(userKey, state);

    if (state.pending >= this.config.throttle.maxPendingPerUserPerChat) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        retryAfterSec: Math.ceil(Math.max(0, state.nextAllowedAt - now) / 1000),
        message: "Per-user pending limit reached.",
      });
    }
    if (now < state.nextAllowedAt) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        retryAfterSec: Math.ceil((state.nextAllowedAt - now) / 1000),
        message: "Per-user cooldown is active.",
      });
    }

    const queue = this.chatQueues.get(params.chatId) ?? [];
    this.chatQueues.set(params.chatId, queue);
    if (queue.length >= this.config.throttle.maxQueuePerChat) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        message: "Per-chat queue is full.",
      });
    }

    state.pending += 1;
    state.nextAllowedAt = now + this.config.throttle.userCooldownMs;

    return new Promise<T>((resolve, reject) => {
      queue.push({
        chatId: params.chatId,
        userId: params.userId,
        createdAt: now,
        run: params.action,
        resolve: resolve as (value: unknown) => void,
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

      void job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.runningGlobal -= 1;
          this.runningPerChat.set(job.chatId, Math.max(0, (this.runningPerChat.get(job.chatId) ?? 1) - 1));
          const userKey = `${job.chatId}:${job.userId}`;
          const state = this.userState.get(userKey);
          if (state) {
            state.pending = Math.max(0, state.pending - 1);
          }
          this.schedule();
        });
    }
  }

  private pickNextRunnableJob(): QueueJob<unknown> | undefined {
    const now = Date.now();
    for (const [chatId, queue] of this.chatQueues) {
      while (queue.length > 0) {
        const job = queue[0]!;
        if (now - job.createdAt > this.config.throttle.maxAgeMs) {
          queue.shift();
          const state = this.userState.get(`${job.chatId}:${job.userId}`);
          if (state) {
            state.pending = Math.max(0, state.pending - 1);
          }
          job.reject(
            new ToolError({
              category: "rate_limit",
              retryable: false,
              message: "Queued send expired before execution.",
            }),
          );
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

  private gcSeen(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
  }
}
