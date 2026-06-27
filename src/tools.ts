import { z } from "zod";
import type { AppConfig } from "./config.js";
import { fail, ok, ToolError } from "./errors.js";
import { stringify } from "./json.js";
import { gramMessageToStored, MessageStore } from "./store.js";
import { TelegramService } from "./telegram-client.js";
import { SendThrottler } from "./throttler.js";

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const chatSchema = z.object({ chat: z.string().optional() });
const limitSchema = z.number().int().positive();

type ToolContent = { content: Array<{ type: "text"; text: string }> };

const jsonTool = (payload: unknown): ToolContent => ({
  content: [{ type: "text" as const, text: stringify(payload) }],
});

export class TelegramTools {
  private readonly throttler: SendThrottler;

  constructor(
    private readonly config: AppConfig,
    private readonly telegram: TelegramService,
    private readonly store: MessageStore,
  ) {
    this.throttler = new SendThrottler(config);
  }

  listTools(): ToolDef[] {
    return [
      {
        name: "get_config",
        description: "Return redacted Telegram Parilka MCP configuration and safety state.",
        inputSchema: objectSchema({}),
      },
      {
        name: "resolve_chat",
        description: "Resolve the configured or provided Telegram chat and cache its input peer.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          refresh: boolProp("Force GramJS entity refresh."),
        }),
      },
      {
        name: "get_chat_info",
        description: "Resolve chat info plus local cache statistics.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
        }),
      },
      {
        name: "sync_history",
        description:
          "Backfill Telegram history into local SQLite cache. Supports large limits, but returns only sync metadata.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          limit: numberProp("Messages to fetch. Max TELEGRAM_MAX_SYNC_LIMIT.", 1, 500000),
          batch_size: numberProp("Telegram page size.", 1, 1000),
          offset_id: numberProp("Start older-than this message ID. 0 means latest.", 0),
        }),
      },
      {
        name: "read_history",
        description: "Read messages from the local SQLite cache.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          limit: numberProp("Messages to return.", 1, 500),
          before_id: numberProp("Only messages older than this message ID.", 1),
          after_id: numberProp("Only messages newer than this message ID.", 1),
          order: enumProp(["asc", "desc"], "Message order."),
        }),
      },
      {
        name: "search_messages",
        description: "Search cached Telegram messages with SQLite FTS.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          query: stringProp("Search query."),
          limit: numberProp("Messages to return.", 1, 200),
          before_id: numberProp("Only messages older than this message ID.", 1),
          after_id: numberProp("Only messages newer than this message ID.", 1),
        }, ["query"]),
      },
      {
        name: "get_thread_context",
        description: "Return cached messages around a message ID.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          message_id: numberProp("Center message ID.", 1),
          before: numberProp("Approximate number of message IDs before center.", 0, 500),
          after: numberProp("Approximate number of message IDs after center.", 0, 500),
        }, ["message_id"]),
      },
      {
        name: "preview_message",
        description: "Validate a Telegram send without sending anything.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          text: stringProp("Message text."),
          parse_mode: enumProp(["none", "html", "markdown"], "Client-side parse mode."),
          reply_to_message_id: numberProp("Message ID to reply to.", 1),
        }, ["text"]),
      },
      {
        name: "send_message",
        description: "Send or dry-run a Telegram message with allowlist, dedupe, and throttling.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          text: stringProp("Message text."),
          parse_mode: enumProp(["none", "html", "markdown"], "Client-side parse mode. Default none."),
          reply_to_message_id: numberProp("Message ID to reply to.", 1),
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
          dry_run: boolProp("Force dry run."),
          dedupe_key: stringProp("Optional caller-provided idempotency key."),
          user_key: stringProp("Logical user key for cooldown. Default mcp-agent."),
        }, ["text"]),
      },
      {
        name: "reply_to_message",
        description: "Convenience wrapper around send_message with required reply_to_message_id.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          message_id: numberProp("Message ID to reply to.", 1),
          text: stringProp("Reply text."),
          parse_mode: enumProp(["none", "html", "markdown"], "Client-side parse mode. Default none."),
          dry_run: boolProp("Force dry run."),
          dedupe_key: stringProp("Optional caller-provided idempotency key."),
          user_key: stringProp("Logical user key for cooldown. Default mcp-agent."),
        }, ["message_id", "text"]),
      },
    ];
  }

  async callTool(name: string, rawArgs: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      switch (name) {
        case "get_config":
          return jsonTool(ok({ config: this.safeConfig() }));
        case "resolve_chat":
          return jsonTool(await this.resolveChat(rawArgs));
        case "get_chat_info":
          return jsonTool(await this.getChatInfo(rawArgs));
        case "sync_history":
          return jsonTool(await this.syncHistory(rawArgs));
        case "read_history":
          return jsonTool(await this.readHistory(rawArgs));
        case "search_messages":
          return jsonTool(await this.searchMessages(rawArgs));
        case "get_thread_context":
          return jsonTool(await this.getThreadContext(rawArgs));
        case "preview_message":
          return jsonTool(await this.previewMessage(rawArgs));
        case "send_message":
          return jsonTool(await this.sendMessage(rawArgs));
        case "reply_to_message":
          return jsonTool(await this.replyToMessage(rawArgs));
        default:
          throw new ToolError({ category: "internal", retryable: false, message: `Unknown tool: ${name}` });
      }
    } catch (error) {
      return jsonTool(fail(error));
    }
  }

  private safeConfig(): Record<string, unknown> {
    return {
      defaultChatId: this.config.telegram.defaultChatId,
      allowedChatIds: this.config.telegram.allowedChatIds,
      sendEnabled: this.config.safety.sendEnabled,
      dryRunDefault: this.config.safety.dryRunDefault,
      dbPath: this.config.storage.dbPath,
      isTelegramConfigured: this.telegram.isConfigured,
      throttle: this.config.throttle,
    };
  }

  private async resolveChat(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema.extend({ refresh: z.boolean().optional() }).parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat, args.refresh);
    this.store.upsertChat(resolved.info);
    return ok({ chat: resolved.info });
  }

  private async getChatInfo(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema.parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat);
    this.store.upsertChat(resolved.info);
    return ok({ chat: resolved.info, stats: this.store.getStats(resolved.info.chatId) });
  }

  private async syncHistory(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        limit: limitSchema.max(this.config.sync.maxSyncLimit).default(1000),
        batch_size: limitSchema.max(1000).default(this.config.sync.batchSize),
        offset_id: z.number().int().nonnegative().default(0),
      })
      .parse(rawArgs ?? {});

    const resolved = await this.telegram.resolveChat(args.chat);
    let fetched = 0;
    let saved = 0;
    let offsetId = args.offset_id;
    let newestMessageId: number | undefined;
    let oldestMessageId: number | undefined;

    while (fetched < args.limit) {
      const pageLimit = Math.min(args.batch_size, args.limit - fetched);
      const page = await this.telegram.getMessages({ chat: resolved.info.chatId, limit: pageLimit, offsetId });
      const rows = page.messages.map((message) => gramMessageToStored(page.chat, message)).filter((row) => row != null);
      if (rows.length === 0) {
        break;
      }
      saved += this.store.upsertMessages(page.chat, rows);
      fetched += page.messages.length;
      const ids = rows.map((row) => row.messageId);
      const minId = Math.min(...ids);
      const maxId = Math.max(...ids);
      oldestMessageId = oldestMessageId == null ? minId : Math.min(oldestMessageId, minId);
      newestMessageId = newestMessageId == null ? maxId : Math.max(newestMessageId, maxId);
      offsetId = minId;
      if (page.messages.length < pageLimit) {
        break;
      }
    }

    this.store.updateSyncState(resolved.info, { oldestMessageId, newestMessageId, syncedCount: saved });
    return ok({
      chat: resolved.info,
      requested: args.limit,
      fetched,
      saved,
      next_offset_id: offsetId,
      oldest_message_id: oldestMessageId,
      newest_message_id: newestMessageId,
      stats: this.store.getStats(resolved.info.chatId),
    });
  }

  private async readHistory(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        limit: limitSchema.max(500).default(50),
        before_id: z.number().int().positive().optional(),
        after_id: z.number().int().positive().optional(),
        order: z.enum(["asc", "desc"]).default("desc"),
      })
      .parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat);
    return ok({
      chat: resolved.info,
      messages: this.store.getHistory({
        chatId: resolved.info.chatId,
        limit: args.limit,
        beforeId: args.before_id,
        afterId: args.after_id,
        order: args.order,
      }),
    });
  }

  private async searchMessages(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        query: z.string().min(1),
        limit: limitSchema.max(200).default(30),
        before_id: z.number().int().positive().optional(),
        after_id: z.number().int().positive().optional(),
      })
      .parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat);
    return ok({
      chat: resolved.info,
      messages: this.store.search({
        chatId: resolved.info.chatId,
        query: args.query,
        limit: args.limit,
        beforeId: args.before_id,
        afterId: args.after_id,
      }),
    });
  }

  private async getThreadContext(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        message_id: z.number().int().positive(),
        before: z.number().int().nonnegative().max(500).default(25),
        after: z.number().int().nonnegative().max(500).default(25),
      })
      .parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat);
    return ok({
      chat: resolved.info,
      center_message_id: args.message_id,
      messages: this.store.getThreadContext({
        chatId: resolved.info.chatId,
        messageId: args.message_id,
        before: args.before,
        after: args.after,
      }),
    });
  }

  private async previewMessage(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        text: z.string().min(1),
        parse_mode: z.enum(["none", "html", "markdown"]).default("none"),
        reply_to_message_id: z.number().int().positive().optional(),
      })
      .parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat);
    const warnings = validateSendText(args.text, this.config.safety.maxSendChars);
    return ok({
      dry_run: true,
      chat: resolved.info,
      text_chars: args.text.length,
      utf8_bytes: Buffer.byteLength(args.text, "utf8"),
      parse_mode: args.parse_mode,
      reply_to_message_id: args.reply_to_message_id,
      warnings,
    });
  }

  private async sendMessage(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        text: z.string().min(1),
        parse_mode: z.enum(["none", "html", "markdown"]).default("none"),
        reply_to_message_id: z.number().int().positive().optional(),
        link_preview: z.boolean().optional(),
        silent: z.boolean().optional(),
        dry_run: z.boolean().optional(),
        dedupe_key: z.string().optional(),
        user_key: z.string().default("mcp-agent"),
      })
      .parse(rawArgs ?? {});

    const resolved = await this.telegram.resolveChat(args.chat);
    const warnings = validateSendText(args.text, this.config.safety.maxSendChars);
    if (warnings.some((warning) => warning.severity === "error")) {
      throw new ToolError({ category: "formatting", retryable: false, message: warnings.map((w) => w.message).join("; ") });
    }

    const dryRun = args.dry_run ?? this.config.safety.dryRunDefault ?? !this.config.safety.sendEnabled;
    if (dryRun || !this.config.safety.sendEnabled) {
      return ok({
        dry_run: true,
        send_enabled: this.config.safety.sendEnabled,
        chat: resolved.info,
        reply_to_message_id: args.reply_to_message_id,
        text_chars: args.text.length,
        utf8_bytes: Buffer.byteLength(args.text, "utf8"),
        warnings,
      });
    }

    this.throttler.dedupe(args.dedupe_key);
    const sent = await this.throttler.run({
      chatId: resolved.info.chatId,
      userId: args.user_key,
      action: () =>
        this.telegram.sendMessage({
          chat: resolved.info.chatId,
          text: args.text,
          replyToMessageId: args.reply_to_message_id,
          parseMode: args.parse_mode,
          linkPreview: args.link_preview,
          silent: args.silent,
        }),
    });
    return ok({ dry_run: false, sent, warnings });
  }

  private async replyToMessage(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        message_id: z.number().int().positive(),
        text: z.string().min(1),
        parse_mode: z.enum(["none", "html", "markdown"]).default("none"),
        dry_run: z.boolean().optional(),
        dedupe_key: z.string().optional(),
        user_key: z.string().default("mcp-agent"),
      })
      .parse(rawArgs ?? {});
    return this.sendMessage({
      chat: args.chat,
      text: args.text,
      parse_mode: args.parse_mode,
      reply_to_message_id: args.message_id,
      dry_run: args.dry_run,
      dedupe_key: args.dedupe_key,
      user_key: args.user_key,
    });
  }
}

function validateSendText(text: string, maxChars: number): Array<{ severity: "warning" | "error"; message: string }> {
  const warnings: Array<{ severity: "warning" | "error"; message: string }> = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length > maxChars) {
    warnings.push({ severity: "error", message: `Message has ${text.length} chars; max is ${maxChars}.` });
  }
  if (bytes > 35_000) {
    warnings.push({ severity: "error", message: `Message has ${bytes} UTF-8 bytes; keep below 35000.` });
  }
  if (text.includes("**")) {
    warnings.push({ severity: "warning", message: "Telegram Markdown can render ** literally; prefer parse_mode html." });
  }
  return warnings;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProp(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function boolProp(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function numberProp(description: string, minimum?: number, maximum?: number): Record<string, unknown> {
  return { type: "number", description, minimum, maximum };
}

function enumProp(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}
