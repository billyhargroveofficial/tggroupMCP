import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { fail, ok, ToolError } from "./errors.js";
import { stringify } from "./json.js";
import { MessageStore, type ChatCacheStatus } from "./store.js";
import { type ChatInfo, TelegramService } from "./telegram-client.js";
import { SendThrottler } from "./throttler.js";
import { HistorySyncer } from "./sync-engine.js";
import { VectorRag } from "./vector-rag.js";
import type { SyncOnceResult, SyncResult } from "./sync-engine.js";

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const chatSchema = z.object({ chat: z.string().optional() });
const limitSchema = z.number().int().positive();
const SERVER_SEND_USER_KEY = "mcp-server";

type ToolContent = { content: Array<{ type: "text"; text: string }> };

const jsonTool = (payload: unknown): ToolContent => ({
  content: [{ type: "text" as const, text: stringify(payload) }],
});

export class TelegramTools {
  private readonly throttler: SendThrottler;
  private readonly syncer: HistorySyncer;
  private readonly vectorRag: VectorRag;
  private readonly approvals: SendApprovalRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly telegram: TelegramService,
    private readonly store: MessageStore,
  ) {
    this.store.reconcileActiveSendsOnStartup();
    this.throttler = new SendThrottler(config, store);
    this.syncer = new HistorySyncer(config, telegram, store);
    this.vectorRag = new VectorRag(config, store);
    this.approvals = new SendApprovalRegistry(config.safety.liveSendApprovalTtlMs);
  }

  listTools(): ToolDef[] {
    return [
      {
        name: "get_config",
        description: "Return redacted Telegram Parilka MCP configuration and safety state.",
        inputSchema: objectSchema({}),
      },
      {
        name: "get_status",
        description: "Return cache-only service health, sync, daemon, and embedding coverage status.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
        }),
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
          "Sync Telegram history into local SQLite cache. Use this manually; normally run sync-daemon in the background.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          mode: enumProp(["both", "recent", "backfill"], "Sync direction. recent fetches messages above newest cached ID; backfill fetches older messages."),
          limit: numberProp("Messages to fetch. Max TELEGRAM_MAX_SYNC_LIMIT.", 1, 500000),
          batch_size: numberProp("Telegram page size.", 1, 1000),
          offset_id: numberProp("Start older-than this message ID. 0 means latest.", 0),
          commit_cursor: boolProp("Allow an explicit offset_id backfill to advance daemon cursor state."),
          reset_backfill_exhausted: boolProp("Clear backfill exhausted state and allow backfill to run again."),
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
        description: "Search cached Telegram messages with keyword FTS, vector cosine search, and hybrid candidates.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          query: stringProp("Search query."),
          limit: numberProp("Candidates per search channel.", 1, 200),
          keyword_limit: numberProp("Keyword FTS candidates to return.", 1, 200),
          vector_limit: numberProp("Vector chunks to return.", 1, 50),
          hybrid_limit: numberProp("Hybrid candidates to return.", 1, 100),
          before_id: numberProp("Only messages older than this message ID.", 1),
          after_id: numberProp("Only messages newer than this message ID.", 1),
        }, ["query"]),
      },
      {
        name: "semantic_search_messages",
        description: "Vector/cosine search over indexed cached Telegram message chunks.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          query: stringProp("Semantic search query."),
          limit: numberProp("Vector chunks to return.", 1, 50),
          before_id: numberProp("Only chunks older than this message ID.", 1),
          after_id: numberProp("Only chunks newer than this message ID.", 1),
          include_messages: boolProp("Include source messages for each returned chunk."),
        }, ["query"]),
      },
      {
        name: "index_embeddings",
        description: "Index cached Telegram messages into vector chunks for semantic search.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          limit_chunks: numberProp("Chunks to embed in this run.", 1, 5000),
          after_message_id: numberProp("Start indexing messages after this ID.", 0),
          rebuild: boolProp("Delete existing chunks for the configured model/dimensions before indexing."),
          estimate_only: boolProp("Return privacy/cost estimate without calling the embedding API."),
          confirm_estimate: boolProp("Confirm the first-run estimate and allow external embedding API calls."),
        }),
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
        description: "Validate a Telegram send without sending anything and return a short-lived live-send approval id.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          text: stringProp("Message text."),
          parse_mode: enumProp(["none", "html", "markdown"], "Client-side parse mode."),
          reply_to_message_id: numberProp("Message ID to reply to.", 1),
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
        }, ["text"]),
      },
      {
        name: "send_message",
        description: "Send or dry-run a Telegram message with allowlist, approval, dedupe, and throttling.",
        inputSchema: objectSchema({
          chat: stringProp("Chat ID, @username, or omitted for TELEGRAM_DEFAULT_CHAT_ID."),
          text: stringProp("Message text."),
          parse_mode: enumProp(["none", "html", "markdown"], "Client-side parse mode. Default none."),
          reply_to_message_id: numberProp("Message ID to reply to.", 1),
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
          dry_run: boolProp("Force dry run."),
          approval_id: stringProp("Short-lived approval id returned by preview_message; required for live sends unless admin bypass is enabled."),
          dedupe_key: stringProp("Optional caller-provided idempotency key."),
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
          link_preview: boolProp("Enable link preview."),
          silent: boolProp("Send silently."),
          dry_run: boolProp("Force dry run."),
          approval_id: stringProp("Short-lived approval id returned by preview_message; required for live sends unless admin bypass is enabled."),
          dedupe_key: stringProp("Optional caller-provided idempotency key."),
        }, ["message_id", "text"]),
      },
    ];
  }

  async callTool(name: string, rawArgs: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      switch (name) {
        case "get_config":
          return jsonTool(ok({ config: this.safeConfig() }));
        case "get_status":
          return jsonTool(this.getStatus(rawArgs));
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
        case "semantic_search_messages":
          return jsonTool(await this.semanticSearchMessages(rawArgs));
        case "index_embeddings":
          return jsonTool(await this.indexEmbeddings(rawArgs));
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
      liveSendApprovalTtlMs: this.config.safety.liveSendApprovalTtlMs,
      liveSendApprovalBypass: this.config.safety.liveSendApprovalBypass,
      dbPath: this.config.storage.dbPath,
      isTelegramConfigured: this.telegram.isConfigured,
      sync: this.config.sync,
      embeddings: {
        enabled: this.config.embeddings.enabled,
        configured: Boolean(this.config.embeddings.apiKey),
        baseUrl: this.config.embeddings.baseUrl,
        model: this.config.embeddings.model,
        dimensions: this.config.embeddings.dimensions,
        requestTimeoutMs: this.config.embeddings.requestTimeoutMs,
        maxRetries: this.config.embeddings.maxRetries,
        retryInitialMs: this.config.embeddings.retryInitialMs,
        chunkMessages: this.config.embeddings.chunkMessages,
        chunkOverlapMessages: this.config.embeddings.chunkOverlapMessages,
        chunkMaxChars: this.config.embeddings.chunkMaxChars,
        tickChunkLimit: this.config.embeddings.tickChunkLimit,
        maxChunksPerRun: this.config.embeddings.maxChunksPerRun,
        maxCharsPerRun: this.config.embeddings.maxCharsPerRun,
        vectorCandidateLimit: this.config.embeddings.vectorCandidateLimit,
      },
      throttle: this.config.throttle,
    };
  }

  private getStatus(rawArgs: unknown): Record<string, unknown> {
    const args = chatSchema.parse(rawArgs ?? {});
    const chat = this.cacheChat(args.chat);
    const status = this.store.getChatStatus(chat.chatId);
    return ok({
      health: healthSummary(status, this.config.sync.intervalMs),
      service: {
        dbPath: this.config.storage.dbPath,
        isTelegramConfigured: this.telegram.isConfigured,
        sendEnabled: this.config.safety.sendEnabled,
        dryRunDefault: this.config.safety.dryRunDefault,
        defaultChatId: this.config.telegram.defaultChatId,
        allowedChatIds: this.config.telegram.allowedChatIds,
        sync: {
          intervalMs: this.config.sync.intervalMs,
          recentLimit: this.config.sync.recentLimit,
          backfillLimit: this.config.sync.backfillLimit,
          historyOperationTimeoutMs: this.config.sync.historyOperationTimeoutMs,
        },
      },
      chat,
      cache: {
        messageCount: status.messages.count,
        oldestMessageId: status.messages.oldestMessageId,
        newestMessageId: status.messages.newestMessageId,
      },
      sync: {
        lastRecentSyncAt: status.syncState?.lastRecentSyncAt,
        lastBackfillAt: status.syncState?.lastBackfillAt,
        lastError: status.syncState?.lastError,
        backfillExhausted: Boolean(status.syncState?.backfillExhaustedAt),
        backfillExhaustedAt: status.syncState?.backfillExhaustedAt,
        state: status.syncState,
      },
      daemon: status.daemonStatus,
      embeddings: {
        enabled: this.config.embeddings.enabled,
        configured: Boolean(this.config.embeddings.apiKey),
        model: this.config.embeddings.model,
        dimensions: this.config.embeddings.dimensions,
        coverage: status.embeddings,
      },
    });
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
        mode: z.enum(["both", "recent", "backfill"]).default("backfill"),
        limit: limitSchema.max(this.config.sync.maxSyncLimit).default(1000),
        batch_size: limitSchema.max(1000).default(this.config.sync.batchSize),
        offset_id: z.number().int().nonnegative().optional(),
        commit_cursor: z.boolean().optional(),
        reset_backfill_exhausted: z.boolean().default(false),
      })
      .parse(rawArgs ?? {});

    if (args.mode === "both") {
      const result = await this.syncer.syncOnce({
        chat: args.chat,
        recentLimit: args.limit,
        backfillLimit: args.limit,
        batchSize: args.batch_size,
      });
      return ok({
        status: syncOnceStatus(result),
        chat: result.chat == null ? undefined : { chatId: result.chat },
        result,
        stats: result.chat == null ? undefined : this.store.getStats(result.chat),
      });
    }

    const result = await this.syncer.syncDirection({
      chat: args.chat,
      mode: args.mode,
      limit: args.limit,
      batchSize: args.batch_size,
      offsetId: args.offset_id,
      resetBackfillExhausted: args.reset_backfill_exhausted,
      commitCursor: args.commit_cursor ?? args.offset_id == null,
    });
    return ok({ status: result.status, chat: result.chat, result, stats: this.store.getStats(result.chat.chatId) });
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
    const chat = this.cacheChat(args.chat);
    const messages = this.store.getHistory({
      chatId: chat.chatId,
      limit: args.limit,
      beforeId: args.before_id,
      afterId: args.after_id,
      order: args.order,
    });
    const cacheStatus = this.store.getChatStatus(chat.chatId);
    return ok({
      chat,
      applied_filters: {
        limit: args.limit,
        before_id: args.before_id,
        after_id: args.after_id,
        order: args.order,
      },
      returned_count: messages.length,
      cache: historyCacheMetadata({
        status: cacheStatus,
        beforeId: args.before_id,
        afterId: args.after_id,
        returnedCount: messages.length,
      }),
      messages,
    });
  }

  private async searchMessages(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        query: z.string().min(1),
        limit: limitSchema.max(200).default(30),
        keyword_limit: limitSchema.max(200).optional(),
        vector_limit: limitSchema.max(50).optional(),
        hybrid_limit: limitSchema.max(100).optional(),
        before_id: z.number().int().positive().optional(),
        after_id: z.number().int().positive().optional(),
      })
      .parse(rawArgs ?? {});
    const chat = this.cacheChat(args.chat);
    const keywordLimit = args.keyword_limit ?? args.limit;
    const vectorLimit = args.vector_limit ?? Math.min(args.limit, this.config.embeddings.searchLimit);
    const hybridLimit = args.hybrid_limit ?? args.limit;
    const keywordHits = this.store.searchWithRank({
      chatId: chat.chatId,
      query: args.query,
      limit: keywordLimit,
      beforeId: args.before_id,
      afterId: args.after_id,
    });
    const vector = await this.vectorRag
      .search({
        chatId: chat.chatId,
        query: args.query,
        limit: vectorLimit,
        beforeId: args.before_id,
        afterId: args.after_id,
        includeMessages: true,
      })
      .catch((error) => ({
        available: false,
        error: error instanceof Error ? error.message : String(error),
        stats: this.store.getEmbeddingStats(chat.chatId),
        hits: [],
      }));
    return ok({
      chat,
      query: args.query,
      messages: keywordHits.map((hit) => hit.message),
      keyword: {
        count: keywordHits.length,
        hits: keywordHits,
      },
      vector,
      hybrid: {
        count: Math.min(hybridLimit, keywordHits.length + vector.hits.length),
        hits: this.vectorRag.hybrid(keywordHits, vector.hits, hybridLimit),
      },
    });
  }

  private async semanticSearchMessages(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        query: z.string().min(1),
        limit: limitSchema.max(50).default(this.config.embeddings.searchLimit),
        before_id: z.number().int().positive().optional(),
        after_id: z.number().int().positive().optional(),
        include_messages: z.boolean().default(true),
      })
      .parse(rawArgs ?? {});
    const chat = this.cacheChat(args.chat);
    return ok({
      chat,
      query: args.query,
      vector: await this.vectorRag.search({
        chatId: chat.chatId,
        query: args.query,
        limit: args.limit,
        beforeId: args.before_id,
        afterId: args.after_id,
        includeMessages: args.include_messages,
      }),
    });
  }

  private async indexEmbeddings(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        limit_chunks: limitSchema.max(5000).default(this.config.embeddings.tickChunkLimit),
        after_message_id: z.number().int().nonnegative().optional(),
        rebuild: z.boolean().default(false),
        estimate_only: z.boolean().default(false),
        confirm_estimate: z.boolean().default(false),
      })
      .parse(rawArgs ?? {});
    const chat = this.cacheChat(args.chat);
    const estimate = this.vectorRag.estimateIndexCachedMessages({
      chatId: chat.chatId,
      limitChunks: args.limit_chunks,
      afterMessageId: args.after_message_id,
      rebuild: args.rebuild,
    });
    const budgetRequiresConfirmation =
      (estimate.budget.truncatedByChunkBudget || estimate.budget.truncatedByCharBudget) && !args.confirm_estimate;
    if (args.estimate_only || (estimate.requiresConfirmation && !args.confirm_estimate) || budgetRequiresConfirmation) {
      return ok({
        chat,
        estimate,
        requires_confirmation: (estimate.requiresConfirmation && !args.confirm_estimate) || budgetRequiresConfirmation,
        result: null,
      });
    }
    return ok({
      chat,
      estimate,
      result: await this.vectorRag.indexCachedMessages({
        chatId: chat.chatId,
        limitChunks: args.limit_chunks,
        afterMessageId: args.after_message_id,
        rebuild: args.rebuild,
        confirmFirstRun: args.confirm_estimate,
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
    const chat = this.cacheChat(args.chat);
    const messages = this.store.getThreadContext({
      chatId: chat.chatId,
      messageId: args.message_id,
      before: args.before,
      after: args.after,
    });
    const cacheStatus = this.store.getChatStatus(chat.chatId);
    const centerFound = messages.some((message) => message.messageId === args.message_id);
    return ok({
      chat,
      center_message_id: args.message_id,
      center_found: centerFound,
      requested_range: {
        start_message_id: Math.max(1, args.message_id - args.before),
        end_message_id: args.message_id + args.after,
        before: args.before,
        after: args.after,
      },
      returned_count: messages.length,
      cache: contextCacheMetadata({
        status: cacheStatus,
        messageId: args.message_id,
        before: args.before,
        after: args.after,
      }),
      messages,
    });
  }

  private async previewMessage(rawArgs: unknown): Promise<Record<string, unknown>> {
    const args = chatSchema
      .extend({
        text: z.string().min(1),
        parse_mode: z.enum(["none", "html", "markdown"]).default("none"),
        reply_to_message_id: z.number().int().positive().optional(),
        link_preview: z.boolean().optional(),
        silent: z.boolean().optional(),
      })
      .parse(rawArgs ?? {});
    const resolved = await this.telegram.resolveChat(args.chat);
    this.store.upsertChat(resolved.info);
    const warnings = validateSendText(args.text, this.config.safety.maxSendChars);
    const approval = this.approvals.create(
      approvalPayload({
        chatId: resolved.info.chatId,
        text: args.text,
        parseMode: args.parse_mode,
        replyToMessageId: args.reply_to_message_id,
        linkPreview: args.link_preview,
        silent: args.silent,
      }),
    );
    return ok({
      dry_run: true,
      chat: resolved.info,
      approval_id: approval.id,
      approval_expires_at: new Date(approval.expiresAt).toISOString(),
      text_chars: args.text.length,
      utf8_bytes: Buffer.byteLength(args.text, "utf8"),
      parse_mode: args.parse_mode,
      reply_to_message_id: args.reply_to_message_id,
      link_preview: args.link_preview,
      silent: args.silent,
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
        approval_id: z.string().optional(),
        dedupe_key: z.string().optional(),
      })
      .parse(rawArgs ?? {});

    const resolved = await this.telegram.resolveChat(args.chat);
    this.store.upsertChat(resolved.info);
    const warnings = validateSendText(args.text, this.config.safety.maxSendChars);
    if (warnings.some((warning) => warning.severity === "error")) {
      throw new ToolError({ category: "formatting", retryable: false, message: warnings.map((w) => w.message).join("; ") });
    }

    const hardDryRun = this.config.safety.dryRunDefault || !this.config.safety.sendEnabled;
    const dryRun = hardDryRun || args.dry_run === true;
    if (dryRun) {
      return ok({
        dry_run: true,
        hard_dry_run: hardDryRun,
        send_enabled: this.config.safety.sendEnabled,
        chat: resolved.info,
        reply_to_message_id: args.reply_to_message_id,
        text_chars: args.text.length,
        utf8_bytes: Buffer.byteLength(args.text, "utf8"),
        warnings,
      });
    }

    const payload = approvalPayload({
      chatId: resolved.info.chatId,
      text: args.text,
      parseMode: args.parse_mode,
      replyToMessageId: args.reply_to_message_id,
      linkPreview: args.link_preview,
      silent: args.silent,
    });
    if (!this.config.safety.liveSendApprovalBypass) {
      this.approvals.consume(args.approval_id, payload);
    }

    const sent = await this.throttler.run({
      chatId: resolved.info.chatId,
      dedupeKey: args.dedupe_key,
      payloadHash: sendPayloadHash(payload),
      replyToMessageId: args.reply_to_message_id,
      userKey: SERVER_SEND_USER_KEY,
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
        link_preview: z.boolean().optional(),
        silent: z.boolean().optional(),
        dry_run: z.boolean().optional(),
        approval_id: z.string().optional(),
        dedupe_key: z.string().optional(),
      })
      .parse(rawArgs ?? {});
    return this.sendMessage({
      chat: args.chat,
      text: args.text,
      parse_mode: args.parse_mode,
      reply_to_message_id: args.message_id,
      link_preview: args.link_preview,
      silent: args.silent,
      dry_run: args.dry_run,
      approval_id: args.approval_id,
      dedupe_key: args.dedupe_key,
    });
  }

  private cacheChat(chat?: string): ChatInfo {
    const chatId = chat?.trim() || this.config.telegram.defaultChatId;
    const cached = this.store.resolveCachedChat(chatId);
    if (cached) {
      this.telegram.assertChatAllowed(cached.chatId);
      return cached;
    }
    this.telegram.assertChatAllowed(chatId);
    if (chatId.startsWith("@")) {
      throw new ToolError({
        category: "peer",
        retryable: false,
        message: `Unknown cached chat alias ${chatId}. Call resolve_chat or sync_history for this username once, then retry the cache-only tool.`,
      });
    }
    return {
      chatId,
      requested: chatId,
      kind: "Cached",
    };
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

type SendApprovalPayload = {
  chatId: string;
  textHash: string;
  replyToMessageId: number | null;
  parseMode: "none" | "html" | "markdown";
  linkPreview: boolean | null;
  silent: boolean | null;
};

type SendApproval = SendApprovalPayload & {
  id: string;
  expiresAt: number;
};

class SendApprovalRegistry {
  private readonly approvals = new Map<string, SendApproval>();

  constructor(private readonly ttlMs: number) {}

  create(payload: SendApprovalPayload): SendApproval {
    const now = Date.now();
    this.gc(now);
    const approval = {
      ...payload,
      id: randomUUID(),
      expiresAt: now + this.ttlMs,
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  consume(id: string | undefined, payload: SendApprovalPayload): void {
    const now = Date.now();
    this.gc(now);
    if (!id) {
      throw approvalError("Live send requires approval_id from preview_message.");
    }
    const approval = this.approvals.get(id);
    if (!approval) {
      throw approvalError("Live send approval was not found, expired, or already consumed.");
    }
    if (approval.expiresAt <= now) {
      this.approvals.delete(id);
      throw approvalError("Live send approval expired. Preview the message again.");
    }
    if (!sameApprovalPayload(approval, payload)) {
      throw approvalError("Live send approval does not match chat, text, reply, parse mode, link preview, or silent flag.");
    }
    this.approvals.delete(id);
  }

  private gc(now: number): void {
    for (const [id, approval] of this.approvals) {
      if (approval.expiresAt <= now) {
        this.approvals.delete(id);
      }
    }
  }
}

function approvalPayload(params: {
  chatId: string;
  text: string;
  replyToMessageId?: number;
  parseMode: "none" | "html" | "markdown";
  linkPreview?: boolean;
  silent?: boolean;
}): SendApprovalPayload {
  return {
    chatId: params.chatId,
    textHash: createHash("sha256").update(params.text, "utf8").digest("hex"),
    replyToMessageId: params.replyToMessageId ?? null,
    parseMode: params.parseMode,
    linkPreview: params.linkPreview ?? null,
    silent: params.silent ?? null,
  };
}

function sameApprovalPayload(left: SendApprovalPayload, right: SendApprovalPayload): boolean {
  return (
    left.chatId === right.chatId &&
    left.textHash === right.textHash &&
    left.replyToMessageId === right.replyToMessageId &&
    left.parseMode === right.parseMode &&
    left.linkPreview === right.linkPreview &&
    left.silent === right.silent
  );
}

function sendPayloadHash(payload: SendApprovalPayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        chatId: payload.chatId,
        textHash: payload.textHash,
        replyToMessageId: payload.replyToMessageId,
        parseMode: payload.parseMode,
        linkPreview: payload.linkPreview,
        silent: payload.silent,
      }),
      "utf8",
    )
    .digest("hex");
}

function approvalError(message: string): ToolError {
  return new ToolError({
    category: "permission",
    retryable: false,
    message,
  });
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
  return { type: "integer", description, minimum, maximum };
}

function enumProp(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}

function syncOnceStatus(result: SyncOnceResult): "done" | "failed" | "partial" | "skipped" {
  const statuses = [result.recent?.status, result.backfill?.status].filter((status): status is SyncResult["status"] => status != null);
  if (statuses.length === 0) {
    return "skipped";
  }
  if (statuses.every((status) => status === "done")) {
    return "done";
  }
  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (statuses.every((status) => status === "failed")) {
    return "failed";
  }
  return "partial";
}

type HealthIssue = {
  severity: "unknown" | "warning" | "critical";
  message: string;
};

function healthSummary(status: ChatCacheStatus, intervalMs: number): Record<string, unknown> {
  const thresholds = healthThresholds(intervalMs);
  const recentLagMs = timestampAgeMs(status.syncState?.lastRecentSyncAt);
  const daemonSuccessLagMs = timestampAgeMs(status.daemonStatus?.lastSuccessAt);
  const issues: HealthIssue[] = [];

  if (!status.syncState) {
    issues.push({ severity: "unknown", message: "No sync_state row has been recorded for this chat." });
  } else {
    if (status.syncState.lastError) {
      issues.push({ severity: "warning", message: `Last sync error: ${status.syncState.lastError}` });
    }
    if (recentLagMs == null) {
      issues.push({ severity: "warning", message: "Recent sync has not recorded a successful timestamp yet." });
    } else if (recentLagMs >= thresholds.recentCriticalMs) {
      issues.push({ severity: "critical", message: "Recent sync lag is above the critical threshold." });
    } else if (recentLagMs >= thresholds.recentWarningMs) {
      issues.push({ severity: "warning", message: "Recent sync lag is above the warning threshold." });
    }
  }

  if (!status.daemonStatus) {
    issues.push({ severity: "unknown", message: "No daemon_status row has been recorded yet." });
  } else {
    if (status.daemonStatus.consecutiveFailures >= thresholds.daemonCriticalFailures) {
      issues.push({ severity: "critical", message: "Daemon has reached the critical consecutive failure threshold." });
    } else if (status.daemonStatus.consecutiveFailures > 0) {
      issues.push({ severity: "warning", message: "Daemon has consecutive failures." });
    }
    if (daemonSuccessLagMs == null) {
      issues.push({ severity: "warning", message: "Daemon has not recorded a successful tick yet." });
    } else if (daemonSuccessLagMs >= thresholds.daemonSuccessCriticalMs) {
      issues.push({ severity: "critical", message: "Daemon success lag is above the critical threshold." });
    } else if (daemonSuccessLagMs >= thresholds.daemonSuccessWarningMs) {
      issues.push({ severity: "warning", message: "Daemon success lag is above the warning threshold." });
    }
  }

  const state = issues.some((issue) => issue.severity === "critical")
    ? "critical"
    : issues.some((issue) => issue.severity === "warning")
      ? "degraded"
      : issues.some((issue) => issue.severity === "unknown")
        ? "unknown"
        : "ok";

  return {
    status: state,
    checkedAt: new Date().toISOString(),
    recentLagMs,
    daemonSuccessLagMs,
    thresholds,
    issues,
  };
}

function healthThresholds(intervalMs: number): Record<string, number> {
  return {
    recentWarningMs: Math.max(intervalMs * 3, 5 * 60_000),
    recentCriticalMs: Math.max(intervalMs * 10, 30 * 60_000),
    daemonSuccessWarningMs: Math.max(intervalMs * 3, 5 * 60_000),
    daemonSuccessCriticalMs: Math.max(intervalMs * 10, 30 * 60_000),
    daemonCriticalFailures: 3,
  };
}

function timestampAgeMs(timestamp: string | undefined): number | undefined {
  const parsed = parseTimestampMs(timestamp);
  if (parsed == null) {
    return undefined;
  }
  return Math.max(0, Date.now() - parsed);
}

function parseTimestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const normalized = timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function historyCacheMetadata(params: {
  status: ChatCacheStatus;
  beforeId?: number;
  afterId?: number;
  returnedCount: number;
}): Record<string, unknown> {
  const relation = historyCacheRelation(params);
  return {
    range: cacheRange(params.status),
    sync_state: params.status.syncState,
    returned_count: params.returnedCount,
    relation,
    empty_reason: params.returnedCount === 0 ? emptyReason(relation) : undefined,
  };
}

function contextCacheMetadata(params: {
  status: ChatCacheStatus;
  messageId: number;
  before: number;
  after: number;
}): Record<string, unknown> {
  const startMessageId = Math.max(1, params.messageId - params.before);
  const endMessageId = params.messageId + params.after;
  const relation = contextCacheRelation(params.status, startMessageId, endMessageId);
  return {
    range: cacheRange(params.status),
    sync_state: params.status.syncState,
    requested_range: {
      start_message_id: startMessageId,
      end_message_id: endMessageId,
    },
    relation,
    empty_reason: emptyReason(relation),
  };
}

function cacheRange(status: ChatCacheStatus): Record<string, unknown> {
  return {
    message_count: status.messages.count,
    oldest_message_id: status.messages.oldestMessageId,
    newest_message_id: status.messages.newestMessageId,
  };
}

function historyCacheRelation(params: {
  status: ChatCacheStatus;
  beforeId?: number;
  afterId?: number;
}): Record<string, unknown> {
  const range = params.status.messages;
  if (range.count === 0 || range.oldestMessageId == null || range.newestMessageId == null) {
    return {
      completeness: "empty_cache",
      outside_cached_range: true,
      partial_cached_range: false,
      requested_before_cached_range: false,
      requested_after_cached_range: false,
    };
  }
  const impossibleRange = params.beforeId != null && params.afterId != null && params.afterId >= params.beforeId;
  const requestedBeforeCachedRange = params.beforeId != null && params.beforeId <= range.oldestMessageId;
  const requestedAfterCachedRange = params.afterId != null && params.afterId >= range.newestMessageId;
  const mayOmitOlderMessages = params.afterId != null && params.afterId < range.oldestMessageId;
  const mayOmitNewerMessages = params.beforeId != null && params.beforeId > range.newestMessageId;
  const outsideCachedRange = requestedBeforeCachedRange || requestedAfterCachedRange;
  const partialCachedRange = !outsideCachedRange && (mayOmitOlderMessages || mayOmitNewerMessages);
  return {
    completeness: impossibleRange
      ? "no_matching_message_ids"
      : outsideCachedRange
        ? "outside_cached_range"
        : partialCachedRange
          ? "partial_cached_range"
          : "within_cached_range",
    outside_cached_range: outsideCachedRange,
    partial_cached_range: partialCachedRange,
    requested_before_cached_range: requestedBeforeCachedRange,
    requested_after_cached_range: requestedAfterCachedRange,
    may_omit_older_messages: mayOmitOlderMessages,
    may_omit_newer_messages: mayOmitNewerMessages,
  };
}

function contextCacheRelation(
  status: ChatCacheStatus,
  startMessageId: number,
  endMessageId: number,
): Record<string, unknown> {
  const range = status.messages;
  if (range.count === 0 || range.oldestMessageId == null || range.newestMessageId == null) {
    return {
      completeness: "empty_cache",
      outside_cached_range: true,
      partial_cached_range: false,
      requested_before_cached_range: false,
      requested_after_cached_range: false,
    };
  }
  const requestedBeforeCachedRange = endMessageId < range.oldestMessageId;
  const requestedAfterCachedRange = startMessageId > range.newestMessageId;
  const outsideCachedRange = requestedBeforeCachedRange || requestedAfterCachedRange;
  const partialCachedRange = !outsideCachedRange && (startMessageId < range.oldestMessageId || endMessageId > range.newestMessageId);
  return {
    completeness: outsideCachedRange
      ? "outside_cached_range"
      : partialCachedRange
        ? "partial_cached_range"
        : "within_cached_range",
    outside_cached_range: outsideCachedRange,
    partial_cached_range: partialCachedRange,
    requested_before_cached_range: requestedBeforeCachedRange,
    requested_after_cached_range: requestedAfterCachedRange,
    may_omit_older_messages: !outsideCachedRange && startMessageId < range.oldestMessageId,
    may_omit_newer_messages: !outsideCachedRange && endMessageId > range.newestMessageId,
  };
}

function emptyReason(relation: Record<string, unknown>): string | undefined {
  switch (relation.completeness) {
    case "empty_cache":
      return "cache_empty";
    case "outside_cached_range":
      return relation.requested_before_cached_range
        ? "requested_before_cached_range"
        : "requested_after_cached_range";
    case "no_matching_message_ids":
      return "filters_exclude_all_message_ids";
    default:
      return undefined;
  }
}
