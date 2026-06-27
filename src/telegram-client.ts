import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { AppConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { StderrGramJsLogger } from "./gramjs-logger.js";

export type ChatInfo = {
  chatId: string;
  requested: string;
  title?: string;
  username?: string;
  kind: string;
  canSendMessages?: boolean;
  isForum?: boolean;
};

type ResolvedChat = {
  input: unknown;
  entity: any;
  info: ChatInfo;
};

export class TelegramService {
  private client: TelegramClient | undefined;
  private readonly chatCache = new Map<string, ResolvedChat>();

  constructor(private readonly config: AppConfig) {}

  get isConfigured(): boolean {
    return Boolean(this.config.telegram.apiId && this.config.telegram.apiHash && this.config.telegram.session);
  }

  async getClient(): Promise<TelegramClient> {
    if (!this.config.telegram.apiId || !this.config.telegram.apiHash) {
      throw new ToolError({
        category: "auth",
        retryable: false,
        message: "TELEGRAM_API_ID and TELEGRAM_API_HASH are required.",
      });
    }
    if (!this.config.telegram.session) {
      throw new ToolError({
        category: "auth",
        retryable: false,
        message: "TELEGRAM_SESSION is missing. Run telegram-parilka-mcp-generate-session first.",
      });
    }
    if (this.client) {
      return this.client;
    }

    const session = new StringSession(this.config.telegram.session);
    const client = new TelegramClient(session, this.config.telegram.apiId, this.config.telegram.apiHash, {
      connectionRetries: this.config.telegram.connectionRetries,
      baseLogger: new StderrGramJsLogger(),
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.client.disconnect();
    this.client = undefined;
  }

  assertChatAllowed(chat: string): void {
    if (!this.config.telegram.requireAllowlistedChat) {
      return;
    }
    const allowed = new Set(this.config.telegram.allowedChatIds.map(normalizeChatRef));
    if (!allowed.has(normalizeChatRef(chat))) {
      throw new ToolError({
        category: "permission",
        retryable: false,
        message: `Chat ${chat} is not in TELEGRAM_ALLOWED_CHAT_IDS.`,
      });
    }
  }

  async resolveChat(chat?: string, refresh = false): Promise<ResolvedChat> {
    const requested = chat?.trim() || this.config.telegram.defaultChatId;
    this.assertChatAllowed(requested);
    const cacheKey = normalizeChatRef(requested);
    if (!refresh && this.chatCache.has(cacheKey)) {
      return this.chatCache.get(cacheKey)!;
    }

    const client = await this.getClient();
    const peer = coercePeer(requested);
    const input = await client.getInputEntity(peer as never);
    const entity = await client.getEntity(input as never);
    const info = entityToChatInfo(entity, requested);
    this.assertChatAllowed(info.chatId);
    const resolved = { input, entity, info };
    this.chatCache.set(cacheKey, resolved);
    this.chatCache.set(normalizeChatRef(info.chatId), resolved);
    return resolved;
  }

  async sendMessage(params: {
    chat?: string;
    text: string;
    replyToMessageId?: number;
    parseMode?: "none" | "html" | "markdown";
    linkPreview?: boolean;
    silent?: boolean;
  }): Promise<{ id?: number; chat: ChatInfo }> {
    const resolved = await this.resolveChat(params.chat);
    const client = await this.getClient();
    const sent = await client.sendMessage(resolved.input as never, {
      message: params.text,
      replyTo: params.replyToMessageId,
      parseMode: params.parseMode === "none" ? false : params.parseMode,
      linkPreview: params.linkPreview,
      silent: params.silent,
    } as never);
    return { id: (sent as any)?.id, chat: resolved.info };
  }

  async getMessages(params: {
    chat?: string;
    limit: number;
    offsetId?: number;
    minId?: number;
    maxId?: number;
    ids?: number | number[];
  }): Promise<{ chat: ChatInfo; messages: any[] }> {
    const resolved = await this.resolveChat(params.chat);
    const client = await this.getClient();
    const options: Record<string, unknown> = { limit: params.limit };
    setIfDefined(options, "offsetId", params.offsetId);
    setIfDefined(options, "minId", params.minId);
    setIfDefined(options, "maxId", params.maxId);
    setIfDefined(options, "ids", params.ids);
    const messages = await client.getMessages(resolved.input as never, options as never);
    return { chat: resolved.info, messages: Array.from(messages as any) };
  }

  async iterateMessages(params: {
    chat?: string;
    limit: number;
    offsetId?: number;
    minId?: number;
    maxId?: number;
    waitTime?: number;
  }): Promise<{ chat: ChatInfo; messages: AsyncIterable<any> }> {
    const resolved = await this.resolveChat(params.chat);
    const client = await this.getClient();
    const options: Record<string, unknown> = { limit: params.limit };
    setIfDefined(options, "offsetId", params.offsetId);
    setIfDefined(options, "minId", params.minId);
    setIfDefined(options, "maxId", params.maxId);
    setIfDefined(options, "waitTime", params.waitTime);
    const messages = client.iterMessages(resolved.input as never, options as never) as AsyncIterable<any>;

    return { chat: resolved.info, messages };
  }
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value != null) {
    target[key] = value;
  }
}

export function normalizeChatRef(chat: string): string {
  const trimmed = chat.trim();
  if (trimmed.startsWith("@")) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function coercePeer(chat: string): string | bigint {
  const trimmed = chat.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  return trimmed;
}

function entityToChatInfo(entity: any, requested: string): ChatInfo {
  const kind = entity?.className || entity?.constructor?.name || "Unknown";
  const rawId = entity?.id?.toString?.() ?? String(entity?.id ?? requested);
  let chatId = rawId;
  if (kind === "Channel" && !rawId.startsWith("-100")) {
    chatId = `-100${rawId}`;
  } else if (kind === "Chat" && !rawId.startsWith("-")) {
    chatId = `-${rawId}`;
  }

  return {
    chatId,
    requested,
    title: entity?.title,
    username: entity?.username,
    kind,
    canSendMessages: entity?.defaultBannedRights?.sendMessages !== true,
    isForum: Boolean(entity?.forum),
  };
}
