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
  getMessageCalls: Array<Record<string, unknown>> = [];
  missingMessageIds = new Set<number>();
  deletedMessageIds = new Set<number>();
  replyTexts = new Map<number, string>();
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

  async getMessages(params: { chat?: string; ids?: number | number[]; limit: number }): Promise<{ chat: ChatInfo; messages: any[] }> {
    this.getMessageCalls.push(params as Record<string, unknown>);
    const chatId = String(params.chat ?? "-1001");
    const ids = Array.isArray(params.ids) ? params.ids : params.ids == null ? [] : [params.ids];
    return {
      chat: {
        chatId,
        requested: chatId,
        kind: "Fake",
      },
      messages: ids.flatMap((id) => {
        if (this.missingMessageIds.has(id)) {
          return [];
        }
        if (this.deletedMessageIds.has(id)) {
          return [{ id, className: "MessageEmpty" }];
        }
        return [
          {
            id,
            className: "Message",
            message: this.replyTexts.get(id) ?? `reply target ${id}`,
            date: 1_700_000_000,
            senderId: "42",
            sender: { username: "reply_author" },
          },
        ];
      }),
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

test("hard dry-run wins over approval bypass", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, {
    safety: {
      sendEnabled: true,
      dryRunDefault: true,
      liveSendApprovalBypass: true,
    },
  });

  const result = await callTool(tools, "send_message", {
    text: "bypass still previews",
    dry_run: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.hard_dry_run, true);
  assert.equal(result.send_enabled, true);
  assert.equal(telegram.sends.length, 0);
});

test("send disabled wins over approval bypass", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, {
    safety: {
      sendEnabled: false,
      dryRunDefault: false,
      liveSendApprovalBypass: true,
    },
  });

  const result = await callTool(tools, "send_message", {
    text: "disabled send stays dry",
    dry_run: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.hard_dry_run, true);
  assert.equal(result.send_enabled, false);
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

test("preview and dry-run include validated reply target metadata", async () => {
  const telegram = new FakeTelegram();
  telegram.replyTexts.set(44, "reply target excerpt");
  const { tools } = makeTools(telegram);

  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "reply with context",
    reply_to_message_id: 44,
  });

  assert.equal(preview.ok, true);
  assert.deepEqual(preview.reply_target, {
    message_id: 44,
    source: "live",
    date: "2023-11-14T22:13:20.000Z",
    sender_id: "42",
    sender_name: "reply_author",
    text_excerpt: "reply target excerpt",
  });
  assert.equal(telegram.getMessageCalls.length, 1);

  const dryRun = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "reply with context",
    reply_to_message_id: 44,
    dry_run: true,
  });

  assert.equal(dryRun.ok, true);
  assert.deepEqual(dryRun.reply_target, {
    message_id: 44,
    source: "cache",
    date: "2023-11-14T22:13:20.000Z",
    sender_id: "42",
    sender_name: "reply_author",
    text_excerpt: "reply target excerpt",
  });
  assert.equal(telegram.getMessageCalls.length, 1);
  assert.equal(telegram.sends.length, 0);
});

test("preview rejects missing reply targets before issuing approval", async () => {
  const telegram = new FakeTelegram();
  telegram.missingMessageIds.add(404);
  const { tools } = makeTools(telegram);

  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "cannot approve missing reply",
    reply_to_message_id: 404,
  });

  assert.equal(preview.ok, false);
  assert.equal((preview.error as { category: string }).category, "reply");
  assert.equal(preview.approval_id, undefined);
  assert.equal(telegram.sends.length, 0);
});

test("invalid reply target fails before approval consumption and outbox reservation", async () => {
  const telegram = new FakeTelegram();
  const { tools, store } = makeTools(telegram, {
    throttle: { userCooldownMs: 60_000 },
  });
  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "reply after validation",
    reply_to_message_id: 77,
  });

  assert.equal(preview.ok, true);
  assert.equal(store.markMessagesDeleted("-1001", [77]), 1);

  const failed = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "reply after validation",
    reply_to_message_id: 77,
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "reply/deleted-target",
  });

  assert.equal(failed.ok, false);
  assert.equal((failed.error as { category: string }).category, "reply");
  assert.equal(store.getSendOutboxByDedupeKey("reply/deleted-target"), undefined);
  assert.equal(telegram.sends.length, 0);

  store.upsertMessages(
    { chatId: "-1001", requested: "-1001", kind: "Fake" },
    [{ chatId: "-1001", messageId: 77, senderName: "restored", text: "restored target" }],
  );
  const sent = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "reply after validation",
    reply_to_message_id: 77,
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "reply/deleted-target",
  });

  assert.equal(sent.ok, true);
  assert.equal(telegram.sends.length, 1);
  assert.equal(telegram.sends[0]?.replyToMessageId, 77);
});

test("reply_to_message enforces approval lifecycle and admin bypass", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);

  const noApproval = await callTool(tools, "reply_to_message", {
    message_id: 10,
    text: "reply lifecycle",
    dry_run: false,
  });
  assert.equal(noApproval.ok, false);
  assert.equal((noApproval.error as { category: string }).category, "permission");

  const preview = await callTool(tools, "preview_message", {
    text: "reply lifecycle",
    reply_to_message_id: 10,
  });
  const mismatchedReply = await callTool(tools, "reply_to_message", {
    message_id: 11,
    text: "reply lifecycle",
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedReply.ok, false);
  assert.equal((mismatchedReply.error as { category: string }).category, "permission");

  const sent = await callTool(tools, "reply_to_message", {
    message_id: 10,
    text: "reply lifecycle",
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(sent.ok, true);

  const replay = await callTool(tools, "reply_to_message", {
    message_id: 10,
    text: "reply lifecycle",
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(replay.ok, false);
  assert.equal((replay.error as { category: string }).category, "permission");
  assert.equal(telegram.sends.length, 1);

  const expiredTelegram = new FakeTelegram();
  const { tools: expiredTools } = makeTools(expiredTelegram, {
    safety: { liveSendApprovalTtlMs: 1 },
  });
  const expiredPreview = await callTool(expiredTools, "preview_message", {
    text: "expired reply",
    reply_to_message_id: 12,
  });
  await sleep(5);
  const expired = await callTool(expiredTools, "reply_to_message", {
    message_id: 12,
    text: "expired reply",
    dry_run: false,
    approval_id: expiredPreview.approval_id,
  });
  assert.equal(expired.ok, false);
  assert.equal((expired.error as { category: string }).category, "permission");
  assert.equal(expiredTelegram.sends.length, 0);

  const bypassTelegram = new FakeTelegram();
  const { tools: bypassTools } = makeTools(bypassTelegram, {
    safety: { liveSendApprovalBypass: true },
  });
  const bypass = await callTool(bypassTools, "reply_to_message", {
    message_id: 13,
    text: "bypassed reply approval",
    dry_run: false,
  });
  assert.equal(bypass.ok, true);
  assert.equal(bypassTelegram.sends.length, 1);
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

test("sent dedupe keys are permanent audit ids before and after the old ttl window", () => {
  const store = new MessageStore(":memory:");
  const original = store.reserveSend({
    outboxId: "send/permanent-dedupe",
    dedupeKey: "dedupe/permanent",
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1_000,
    maxAgeMs: 120_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 10,
    maxQueuePerChat: 10,
  });

  assert.equal(original.kind, "queued");
  assert.equal(store.markSendSending(original.outboxId, 1_001), true);
  assert.equal(store.markSendSent(original.outboxId, 9001, 1_002), true);

  for (const nowMs of [5 * 60_000, 31 * 24 * 60 * 60_000]) {
    const duplicate = store.reserveSend({
      outboxId: `send/duplicate-${nowMs}`,
      dedupeKey: "dedupe/permanent",
      payloadHash: "payload/hash",
      chatId: "-1001",
      userKey: "mcp-server",
      nowMs,
      maxAgeMs: 120_000,
      userCooldownMs: 0,
      maxPendingPerUserPerChat: 10,
      maxQueuePerChat: 10,
    });
    assert.equal(duplicate.kind, "duplicate_sent");
    assert.equal(duplicate.telegramMessageId, 9001);
  }

  assert.throws(
    () =>
      store.reserveSend({
        outboxId: "send/permanent-dedupe-conflict",
        dedupeKey: "dedupe/permanent",
        payloadHash: "payload/other",
        chatId: "-1001",
        userKey: "mcp-server",
        nowMs: 31 * 24 * 60 * 60_000,
        maxAgeMs: 120_000,
        userCooldownMs: 0,
        maxPendingPerUserPerChat: 10,
        maxQueuePerChat: 10,
      }),
    /dedupe_key has already been used/,
  );
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
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  telegram.onSend = async (callNumber) => {
    if (callNumber === 1) {
      markFirstStarted();
      await firstGate;
    }
  };
  const { tools, store } = makeTools(telegram, {
    throttle: {
      userCooldownMs: 0,
      maxAgeMs: 50,
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
  await firstStarted;
  const secondSend = callTool(tools, "send_message", {
    text: "second",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/second",
  });

  await sleep(80);
  releaseFirst();

  assert.equal((await firstSend).ok, true);
  const expired = await secondSend;
  assert.equal(expired.ok, false);
  assert.equal((expired.error as { category: string }).category, "rate_limit");
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/second")?.status, "expired");
  assert.equal(telegram.sends.length, 1);
});

test("stale queued transition aborts before Telegram dispatch", async () => {
  const telegram = new FakeTelegram();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  telegram.onSend = async (callNumber) => {
    if (callNumber === 1) {
      markFirstStarted();
      await firstGate;
    }
  };
  const { tools, store } = makeTools(telegram, {
    throttle: {
      userCooldownMs: 0,
      maxAgeMs: 60_000,
      globalConcurrency: 1,
      maxRunningPerChat: 1,
    },
  });

  const firstPreview = await callTool(tools, "preview_message", {
    text: "first stale guard",
  });
  const secondPreview = await callTool(tools, "preview_message", {
    text: "second stale guard",
  });
  const firstSend = callTool(tools, "send_message", {
    text: "first stale guard",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    dedupe_key: "dedupe/stale-first",
  });
  await firstStarted;

  const secondSend = callTool(tools, "send_message", {
    text: "second stale guard",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/stale-second",
  });
  const queued = await waitForSendOutbox(store, "dedupe/stale-second");
  assert.equal(store.markSendExpired(queued.id, "manually expired before dispatch"), true);

  releaseFirst();

  assert.equal((await firstSend).ok, true);
  const stale = await secondSend;
  assert.equal(stale.ok, false);
  assert.equal((stale.error as { category: string }).category, "rate_limit");
  assert.match((stale.error as { message: string }).message, /no longer queued/);
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/stale-second")?.status, "expired");
  assert.equal(telegram.sends.length, 1);
});

test("persisted cooldown uses server-owned caller identity", async () => {
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
  });

  assert.equal(firstSend.ok, true);

  const secondPreview = await callTool(tools, "preview_message", {
    text: "cooldown two",
  });
  const secondSend = await callTool(tools, "send_message", {
    text: "cooldown two",
    dry_run: false,
    approval_id: secondPreview.approval_id,
  });

  assert.equal(secondSend.ok, false);
  assert.equal((secondSend.error as { category: string }).category, "rate_limit");
  assert.equal(telegram.sends.length, 1);
});

test("fresh tools reconcile active outbox rows without changing terminal rows", (t) => {
  const dbPath = tempDbPath(t);
  const seedStore = new MessageStore(dbPath);
  seedSend(seedStore, "queued", "queued/restart");
  seedSend(seedStore, "sending", "sending/restart");
  seedSend(seedStore, "failed", "failed/restart", "original failure");
  seedSend(seedStore, "expired", "expired/restart", "already expired");
  seedSend(seedStore, "sent", "sent/restart");

  const { store } = makeTools(new FakeTelegram(), { dbPath });

  const queued = store.getSendOutboxByDedupeKey("queued/restart");
  assert.equal(queued?.status, "expired");
  assert.match(queued?.error ?? "", /abandoned by process restart/);

  const sending = store.getSendOutboxByDedupeKey("sending/restart");
  assert.equal(sending?.status, "failed");
  assert.match(sending?.error ?? "", /delivery state is unknown/);

  assert.equal(store.getSendOutboxByDedupeKey("failed/restart")?.status, "failed");
  assert.equal(store.getSendOutboxByDedupeKey("failed/restart")?.error, "original failure");
  assert.equal(store.getSendOutboxByDedupeKey("expired/restart")?.status, "expired");
  assert.equal(store.getSendOutboxByDedupeKey("expired/restart")?.error, "already expired");
  assert.equal(store.getSendOutboxByDedupeKey("sent/restart")?.status, "sent");
});

test("ambiguous in-flight send is not retried after restart", async (t) => {
  const dbPath = tempDbPath(t);
  const seedStore = new MessageStore(dbPath);
  seedSend(seedStore, "sending", "ambiguous/restart");
  const telegram = new FakeTelegram();
  const { tools, store } = makeTools(telegram, {
    dbPath,
    throttle: { userCooldownMs: 0 },
  });

  const reconciled = store.getSendOutboxByDedupeKey("ambiguous/restart");
  assert.equal(reconciled?.status, "failed");
  assert.match(reconciled?.error ?? "", /delivery state is unknown/);

  const preview = await callTool(tools, "preview_message", {
    text: "ambiguous send",
  });
  const retried = await callTool(tools, "send_message", {
    text: "ambiguous send",
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "ambiguous/restart",
  });

  assert.equal(retried.ok, false);
  assert.equal((retried.error as { category: string }).category, "internal");
  assert.match((retried.error as { message: string }).message, /unknown Telegram delivery state/);
  assert.equal(telegram.sends.length, 0);
});

test("terminal send outbox states are not overwritten by later transitions", () => {
  const store = new MessageStore(":memory:");
  const sentId = seedSend(store, "sent", "terminal/sent");
  const failedId = seedSend(store, "failed", "terminal/failed", "original failure");
  const expiredId = seedSend(store, "expired", "terminal/expired", "original expiry");

  assert.equal(store.markSendFailed(sentId, "late failure", 2000), false);
  assert.equal(store.markSendExpired(sentId, "late expiry", 2001), false);
  assert.equal(store.getSendOutboxByDedupeKey("terminal/sent")?.status, "sent");
  assert.equal(store.getSendOutboxByDedupeKey("terminal/sent")?.error, undefined);

  assert.equal(store.markSendSent(failedId, 9002, 2002), false);
  assert.equal(store.markSendExpired(failedId, "late expiry", 2003), false);
  assert.equal(store.markSendFailed(failedId, "late failure", 2004), false);
  const failed = store.getSendOutboxByDedupeKey("terminal/failed");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "original failure");

  assert.equal(store.markSendSending(expiredId, 2005), false);
  assert.equal(store.markSendSent(expiredId, 9003, 2006), false);
  assert.equal(store.markSendFailed(expiredId, "late failure", 2007), false);
  assert.equal(store.markSendExpired(expiredId, "late expiry", 2008), false);
  const expired = store.getSendOutboxByDedupeKey("terminal/expired");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.error, "original expiry");
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
        requestTimeoutMs: 60_000,
        maxRetries: 2,
        retryInitialMs: 0,
        chunkMessages: 12,
        chunkOverlapMessages: 0,
        chunkMaxChars: 1600,
        tickChunkLimit: 100,
        maxChunksPerRun: 1000,
        maxCharsPerRun: 500_000,
        vectorCandidateLimit: 20_000,
        searchLimit: 12,
      },
      throttle: {
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

async function waitForSendOutbox(store: MessageStore, dedupeKey: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const item = store.getSendOutboxByDedupeKey(dedupeKey);
    if (item) {
      return item;
    }
    await sleep(5);
  }
  throw new Error(`Timed out waiting for send outbox row ${dedupeKey}`);
}

function seedSend(
  store: MessageStore,
  status: "queued" | "sending" | "sent" | "failed" | "expired",
  dedupeKey: string,
  error?: string,
): string {
  const reservation = store.reserveSend({
    outboxId: `seed/${dedupeKey}`,
    dedupeKey,
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1000,
    maxAgeMs: 60_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 100,
    maxQueuePerChat: 100,
  });
  assert.equal(reservation.kind, "queued");
  if (status === "sending" || status === "sent") {
    assert.equal(store.markSendSending(reservation.outboxId, 1001), true);
  }
  if (status === "sent") {
    assert.equal(store.markSendSent(reservation.outboxId, 9001, 1002), true);
  } else if (status === "failed") {
    assert.equal(store.markSendFailed(reservation.outboxId, error ?? "failed", 1002), true);
  } else if (status === "expired") {
    assert.equal(store.markSendExpired(reservation.outboxId, error ?? "expired", 1002), true);
  }
  return reservation.outboxId;
}
