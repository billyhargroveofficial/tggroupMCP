import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppConfig } from "../src/config.js";
import { MessageStore } from "../src/store.js";
import { TelegramTools } from "../src/tools.js";
import type { ChatInfo, TelegramService } from "../src/telegram-client.js";

type ToolPayload = Record<string, unknown> & { ok: boolean };

class FakeTelegram {
  sends: Array<Record<string, unknown>> = [];
  failNextSend: Error | undefined;
  onSend: ((callNumber: number, params: Record<string, unknown>) => Promise<void> | void) | undefined;

  get isConfigured(): boolean {
    return true;
  }

  async resolveChat(chat?: string): Promise<{ info: ChatInfo }> {
    const chatId = chat?.trim() || "-1001";
    return {
      info: {
        chatId,
        requested: chatId,
        kind: "Fake",
      },
    };
  }

  async sendMessage(params: Record<string, unknown>): Promise<{ id: number; chat: ChatInfo }> {
    this.sends.push(params);
    const callNumber = this.sends.length;
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    await this.onSend?.(callNumber, params);
    const chatId = String(params.chat ?? "-1001");
    return {
      id: 9000 + callNumber,
      chat: {
        chatId,
        requested: chatId,
        kind: "Fake",
      },
    };
  }
}

test("hard dry-run mode cannot be bypassed with dry_run:false", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, { safety: { dryRunDefault: true } });

  const result = await callTool(tools, "send_message", {
    text: "safe preview only",
    dry_run: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.hard_dry_run, true);
  assert.equal(telegram.sends.length, 0);
});

test("live send rejects without an approval id", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);

  const result = await callTool(tools, "send_message", {
    text: "needs approval",
    dry_run: false,
  });

  assert.equal(result.ok, false);
  assert.equal((result.error as { category: string }).category, "permission");
  assert.match((result.error as { message: string }).message, /approval_id/);
  assert.equal(telegram.sends.length, 0);
});

test("live send rejects when approval metadata does not match", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);
  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "approved text",
    reply_to_message_id: 10,
  });

  assert.equal(preview.ok, true);
  assert.equal(typeof preview.approval_id, "string");

  const mismatchedText = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "changed text",
    reply_to_message_id: 10,
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedText.ok, false);

  const mismatchedChat = await callTool(tools, "send_message", {
    chat: "-1002",
    text: "approved text",
    reply_to_message_id: 10,
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedChat.ok, false);

  const mismatchedReply = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "approved text",
    reply_to_message_id: 11,
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedReply.ok, false);
  assert.equal(telegram.sends.length, 0);
});

test("approved live send posts once and consumes the approval", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);
  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "ship it",
    parse_mode: "html",
    link_preview: false,
    silent: true,
  });

  const sent = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "ship it",
    parse_mode: "html",
    link_preview: false,
    silent: true,
    dry_run: false,
    approval_id: preview.approval_id,
  });

  assert.equal(sent.ok, true);
  assert.equal(sent.dry_run, false);
  assert.deepEqual(sent.sent, {
    id: 9001,
    chat: {
      chatId: "-1001",
      requested: "-1001",
      kind: "Fake",
    },
  });

  const replay = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "ship it",
    parse_mode: "html",
    link_preview: false,
    silent: true,
    dry_run: false,
    approval_id: preview.approval_id,
  });

  assert.equal(replay.ok, false);
  assert.equal(telegram.sends.length, 1);
});

test("sent dedupe keys survive a fresh tools instance", async (t) => {
  const dbPath = tempDbPath(t);
  const firstTelegram = new FakeTelegram();
  const { tools: firstTools } = makeTools(firstTelegram, {
    dbPath,
    throttle: { userCooldownMs: 0 },
  });
  const firstPreview = await callTool(firstTools, "preview_message", {
    chat: "-1001",
    text: "dedupe me",
  });
  const firstSend = await callTool(firstTools, "send_message", {
    chat: "-1001",
    text: "dedupe me",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    dedupe_key: "dedupe/restart",
  });

  assert.equal(firstSend.ok, true);
  assert.equal(firstTelegram.sends.length, 1);

  const secondTelegram = new FakeTelegram();
  const { tools: secondTools } = makeTools(secondTelegram, {
    dbPath,
    throttle: { userCooldownMs: 0 },
  });
  const secondPreview = await callTool(secondTools, "preview_message", {
    chat: "-1001",
    text: "dedupe me",
  });
  const duplicate = await callTool(secondTools, "send_message", {
    chat: "-1001",
    text: "dedupe me",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/restart",
  });

  assert.equal(duplicate.ok, true);
  assert.equal((duplicate.sent as { id?: number }).id, (firstSend.sent as { id?: number }).id);
  assert.equal(
    ((duplicate.sent as { chat: { chatId: string } }).chat).chatId,
    ((firstSend.sent as { chat: { chatId: string } }).chat).chatId,
  );
  assert.equal(secondTelegram.sends.length, 0);
});

test("failed sends can retry with the same dedupe key", async () => {
  const telegram = new FakeTelegram();
  telegram.failNextSend = new Error("temporary send failure");
  const { tools, store } = makeTools(telegram, {
    throttle: { userCooldownMs: 0 },
  });
  const preview = await callTool(tools, "preview_message", {
    text: "retry me",
  });
  const failed = await callTool(tools, "send_message", {
    text: "retry me",
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "dedupe/retry",
  });

  assert.equal(failed.ok, false);
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/retry")?.status, "failed");

  const retryPreview = await callTool(tools, "preview_message", {
    text: "retry me",
  });
  const retried = await callTool(tools, "send_message", {
    text: "retry me",
    dry_run: false,
    approval_id: retryPreview.approval_id,
    dedupe_key: "dedupe/retry",
  });

  assert.equal(retried.ok, true);
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/retry")?.status, "sent");
  assert.equal(telegram.sends.length, 2);
});

test("queued sends expire before execution", async () => {
  const telegram = new FakeTelegram();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  telegram.onSend = async (callNumber) => {
    if (callNumber === 1) {
      await firstGate;
    }
  };
  const { tools, store } = makeTools(telegram, {
    throttle: {
      userCooldownMs: 0,
      maxAgeMs: 5,
      globalConcurrency: 1,
      maxRunningPerChat: 1,
    },
  });

  const firstPreview = await callTool(tools, "preview_message", {
    text: "first",
  });
  const secondPreview = await callTool(tools, "preview_message", {
    text: "second",
  });
  const firstSend = callTool(tools, "send_message", {
    text: "first",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    dedupe_key: "dedupe/first",
  });
  const secondSend = callTool(tools, "send_message", {
    text: "second",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/second",
  });

  await sleep(20);
  releaseFirst();

  assert.equal((await firstSend).ok, true);
  const expired = await secondSend;
  assert.equal(expired.ok, false);
  assert.equal((expired.error as { category: string }).category, "rate_limit");
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/second")?.status, "expired");
  assert.equal(telegram.sends.length, 1);
});

test("caller-supplied user_key cannot bypass persisted cooldown", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, {
    throttle: { userCooldownMs: 60_000 },
  });
  const firstPreview = await callTool(tools, "preview_message", {
    text: "cooldown one",
  });
  const firstSend = await callTool(tools, "send_message", {
    text: "cooldown one",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    user_key: "caller-a",
  });

  assert.equal(firstSend.ok, true);

  const secondPreview = await callTool(tools, "preview_message", {
    text: "cooldown two",
  });
  const secondSend = await callTool(tools, "send_message", {
    text: "cooldown two",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    user_key: "caller-b",
  });

  assert.equal(secondSend.ok, false);
  assert.equal((secondSend.error as { category: string }).category, "rate_limit");
  assert.equal(telegram.sends.length, 1);
});

function makeTools(
  telegram: FakeTelegram,
  options: {
    dbPath?: string;
    safety?: Partial<AppConfig["safety"]>;
    throttle?: Partial<AppConfig["throttle"]>;
  } = {},
): { tools: TelegramTools; store: MessageStore } {
  const store = new MessageStore(options.dbPath ?? ":memory:");
  const tools = new TelegramTools(
    {
      telegram: {
        apiId: 1,
        apiHash: "hash",
        session: "session",
        phone: "",
        defaultChatId: "-1001",
        allowedChatIds: ["-1001", "-1002"],
        requireAllowlistedChat: true,
        connectionRetries: 1,
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
        ...options.safety,
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
      },
      embeddings: {
        enabled: false,
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        dimensions: 256,
        apiBatchSize: 64,
        chunkMessages: 12,
        chunkMaxChars: 1600,
        tickChunkLimit: 100,
        searchLimit: 12,
      },
      throttle: {
        dedupeTtlMs: 600_000,
        userCooldownMs: 0,
        maxPendingPerUserPerChat: 10,
        maxQueuePerChat: 25,
        maxAgeMs: 120_000,
        globalConcurrency: 2,
        maxRunningPerChat: 1,
        ...options.throttle,
      },
    },
    telegram as unknown as TelegramService,
    store,
  );
  return { tools, store };
}

async function callTool(tools: TelegramTools, name: string, args: unknown): Promise<ToolPayload> {
  const result = await tools.callTool(name, args);
  return JSON.parse(result.content[0]!.text) as ToolPayload;
}

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-parilka-mcp-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}
