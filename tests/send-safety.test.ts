import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { TelegramTools } from "../src/tools.js";
import type { ChatInfo, TelegramService } from "../src/telegram-client.js";
import type { MessageStore } from "../src/store.js";

type ToolPayload = Record<string, unknown> & { ok: boolean };

class FakeTelegram {
  sends: Array<Record<string, unknown>> = [];

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
    const chatId = String(params.chat ?? "-1001");
    return {
      id: 9000 + this.sends.length,
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
  const tools = makeTools(telegram, { dryRunDefault: true });

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
  const tools = makeTools(telegram);

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
  const tools = makeTools(telegram);
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
  const tools = makeTools(telegram);
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

function makeTools(telegram: FakeTelegram, safety?: Partial<AppConfig["safety"]>): TelegramTools {
  return new TelegramTools(
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
        ...safety,
      },
      sync: {
        batchSize: 100,
        maxSyncLimit: 500_000,
        floodWaitMaxSleepSec: 10,
        intervalMs: 60_000,
        recentLimit: 300,
        backfillLimit: 1000,
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
      },
    },
    telegram as unknown as TelegramService,
    {} as MessageStore,
  );
}

async function callTool(tools: TelegramTools, name: string, args: unknown): Promise<ToolPayload> {
  const result = await tools.callTool(name, args);
  return JSON.parse(result.content[0]!.text) as ToolPayload;
}
