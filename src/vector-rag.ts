import type { AppConfig } from "./config.js";
import { blobToVector, cosineSimilarity, EmbeddingClient, type EmbeddingChunkInput } from "./embeddings.js";
import { ToolError } from "./errors.js";
import { MessageStore, type KeywordSearchHit, type StoredEmbeddingChunk, type StoredMessage } from "./store.js";

export type EmbeddingIndexResult = {
  ok: true;
  chatId: string;
  model: string;
  dimensions?: number;
  chunksCreated: number;
  messagesCovered: number;
  nextAfterMessageId?: number;
  deletedChunks?: number;
  dirtyChunksDeleted?: number;
  coverage: Record<string, number>;
  stats: Array<Record<string, unknown>>;
};

export type EmbeddingIndexEstimate = {
  provider: string;
  baseUrl: string;
  model: string;
  dimensions?: number;
  chatId: string;
  limitChunks: number;
  estimatedChunks: number;
  estimatedMessages: number;
  estimatedChars: number;
  existingChunks: number;
  coverage: Record<string, number>;
  firstRun: boolean;
  requiresConfirmation: boolean;
  privacy: string;
};

export type VectorSearchHit = {
  rank: number;
  score: number;
  chunk: {
    id: number;
    startMessageId: number;
    endMessageId: number;
    messageCount: number;
    messageIds: number[];
    text: string;
    model: string;
    dimensions: number;
  };
  messages: StoredMessage[];
};

export type HybridSearchHit = {
  rank: number;
  source: "keyword" | "vector";
  score: number;
  messageId?: number;
  startMessageId?: number;
  endMessageId?: number;
  text: string;
};

export class VectorRag {
  private readonly embeddings: EmbeddingClient;

  constructor(
    private readonly config: AppConfig,
    private readonly store: MessageStore,
  ) {
    this.embeddings = new EmbeddingClient(config);
  }

  get isConfigured(): boolean {
    return this.embeddings.isConfigured;
  }

  async indexCachedMessages(params: {
    chatId: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
    confirmFirstRun?: boolean;
  }): Promise<EmbeddingIndexResult> {
    this.embeddings.assertConfigured();
    const estimate = this.estimateIndexCachedMessages(params);
    if (estimate.requiresConfirmation && !params.confirmFirstRun) {
      throw new ToolError({
        category: "permission",
        retryable: false,
        message:
          "First embedding index requires explicit confirmation. Review the estimate and retry with confirm_estimate:true.",
      });
    }

    const limitChunks = estimate.limitChunks;
    const deletedChunks = params.rebuild
      ? this.store.deleteEmbeddingChunks({
          chatId: params.chatId,
          model: this.config.embeddings.model,
          dimensions: this.config.embeddings.dimensions,
        })
      : undefined;
    let afterMessageId = params.afterMessageId;

    const inputs = this.buildChunks(params.chatId, {
      afterMessageId,
      limitChunks,
      includeCovered: params.rebuild,
    });
    let chunksCreated = 0;
    let messagesCovered = 0;

    for (let index = 0; index < inputs.length; index += this.config.embeddings.apiBatchSize) {
      const batch = inputs.slice(index, index + this.config.embeddings.apiBatchSize);
      const vectors = await this.embeddings.embedChunks(batch);
      chunksCreated += this.store.upsertEmbeddingChunks(vectors);
      messagesCovered += batch.reduce((sum, chunk) => sum + chunk.messageCount, 0);
      afterMessageId = batch[batch.length - 1]?.endMessageId ?? afterMessageId;
    }
    const dirtyChunksDeleted = params.rebuild
      ? undefined
      : this.store.deleteDirtyEmbeddingChunksForMessages({
          chatId: params.chatId,
          model: this.config.embeddings.model,
          dimensions: this.config.embeddings.dimensions,
          messageIds: inputs.flatMap((chunk) => chunk.messageIds),
        });

    return {
      ok: true,
      chatId: params.chatId,
      model: this.config.embeddings.model,
      dimensions: this.config.embeddings.dimensions,
      chunksCreated,
      messagesCovered,
      nextAfterMessageId: afterMessageId,
      deletedChunks,
      dirtyChunksDeleted,
      coverage: this.store.getEmbeddingCoverageStats({
        chatId: params.chatId,
        model: this.config.embeddings.model,
        dimensions: this.config.embeddings.dimensions,
      }),
      stats: this.store.getEmbeddingStats(params.chatId),
    };
  }

  estimateIndexCachedMessages(params: {
    chatId: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
  }): EmbeddingIndexEstimate {
    this.embeddings.assertConfigured();
    const limitChunks = Math.max(1, params.limitChunks ?? this.config.embeddings.tickChunkLimit);
    const stats = this.store.getEmbeddingStats(params.chatId);
    const inputs = this.buildChunks(params.chatId, {
      afterMessageId: params.afterMessageId,
      limitChunks,
      includeCovered: params.rebuild,
    });
    const existingChunks = stats.reduce((sum, row) => sum + Number(row.chunks ?? 0), 0);
    const estimatedChunks = inputs.length;
    const firstRun = existingChunks === 0;

    return {
      provider: embeddingProvider(this.config.embeddings.baseUrl),
      baseUrl: this.config.embeddings.baseUrl,
      model: this.config.embeddings.model,
      dimensions: this.config.embeddings.dimensions,
      chatId: params.chatId,
      limitChunks,
      estimatedChunks,
      estimatedMessages: inputs.reduce((sum, chunk) => sum + chunk.messageCount, 0),
      estimatedChars: inputs.reduce((sum, chunk) => sum + chunk.text.length, 0),
      existingChunks,
      coverage: this.store.getEmbeddingCoverageStats({
        chatId: params.chatId,
        model: this.config.embeddings.model,
        dimensions: this.config.embeddings.dimensions,
      }),
      firstRun,
      requiresConfirmation: firstRun && estimatedChunks > 0,
      privacy: "Embedding indexing sends cached Telegram message text to the configured external embeddings provider.",
    };
  }

  async search(params: {
    chatId: string;
    query: string;
    limit?: number;
    beforeId?: number;
    afterId?: number;
    includeMessages?: boolean;
  }): Promise<{
    available: boolean;
    error?: string;
    stats: Array<Record<string, unknown>>;
    hits: VectorSearchHit[];
  }> {
    const stats = this.store.getEmbeddingStats(params.chatId);
    if (!this.embeddings.isConfigured) {
      return {
        available: false,
        error: this.config.embeddings.enabled
          ? "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY."
          : "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.",
        stats,
        hits: [],
      };
    }
    if (stats.length === 0) {
      return {
        available: false,
        error: "No vector chunks indexed yet. Run index_embeddings first.",
        stats,
        hits: [],
      };
    }

    const limit = Math.max(1, Math.min(params.limit ?? this.config.embeddings.searchLimit, 50));
    const queryVector = await this.embeddings.embedQuery(params.query);
    const chunks = this.store.getEmbeddingChunks({
      chatId: params.chatId,
      model: this.config.embeddings.model,
      dimensions: this.config.embeddings.dimensions,
      beforeId: params.beforeId,
      afterId: params.afterId,
    });

    const scored = chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, blobToVector(chunk.embedding)) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return {
      available: true,
      stats,
      hits: scored.map((hit, index) => this.toVectorHit(hit.chunk, hit.score, index + 1, params.includeMessages ?? true)),
    };
  }

  hybrid(keywordHits: KeywordSearchHit[], vectorHits: VectorSearchHit[], limit: number): HybridSearchHit[] {
    const results: HybridSearchHit[] = [];
    for (const [index, hit] of keywordHits.entries()) {
      results.push({
        rank: index + 1,
        source: "keyword",
        score: reciprocalRank(index),
        messageId: hit.message.messageId,
        text: formatMessage(hit.message),
      });
    }
    for (const [index, hit] of vectorHits.entries()) {
      results.push({
        rank: index + 1,
        source: "vector",
        score: hit.score + reciprocalRank(index),
        startMessageId: hit.chunk.startMessageId,
        endMessageId: hit.chunk.endMessageId,
        text: hit.chunk.text,
      });
    }
    return results.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  private buildChunks(
    chatId: string,
    params: { afterMessageId?: number; limitChunks: number; includeCovered?: boolean },
  ): EmbeddingChunkInput[] {
    const chunks: EmbeddingChunkInput[] = [];
    let cursor = params.afterMessageId;
    let buffer: StoredMessage[] = [];
    let bufferChars = 0;
    const fetchLimit = Math.max(this.config.embeddings.chunkMessages * params.limitChunks * 2, 500);

    const flush = (): void => {
      if (buffer.length === 0 || chunks.length >= params.limitChunks) {
        return;
      }
      const first = buffer[0]!;
      const last = buffer[buffer.length - 1]!;
      chunks.push({
        chatId,
        startMessageId: first.messageId,
        endMessageId: last.messageId,
        messageIds: buffer.map((message) => message.messageId),
        messageCount: buffer.length,
        text: buffer.map(formatMessage).join("\n"),
      });
      buffer = [];
      bufferChars = 0;
    };

    while (chunks.length < params.limitChunks) {
      const messages = params.includeCovered
        ? this.store.getMessagesForEmbedding({
            chatId,
            afterId: cursor,
            limit: fetchLimit,
          })
        : this.store.getMessagesNeedingEmbedding({
            chatId,
            model: this.config.embeddings.model,
            dimensions: this.config.embeddings.dimensions,
            afterId: cursor,
            limit: fetchLimit,
          });
      if (messages.length === 0) {
        break;
      }

      for (const message of messages) {
        cursor = message.messageId;
        const formatted = formatMessage(message);
        if (buffer.length > 0 && bufferChars + formatted.length > this.config.embeddings.chunkMaxChars) {
          flush();
        }
        if (chunks.length >= params.limitChunks) {
          break;
        }
        buffer.push(message);
        bufferChars += formatted.length;
        if (buffer.length >= this.config.embeddings.chunkMessages) {
          flush();
        }
      }

      if (messages.length < fetchLimit) {
        break;
      }
    }
    flush();
    return chunks.slice(0, params.limitChunks);
  }

  private toVectorHit(chunk: StoredEmbeddingChunk, score: number, rank: number, includeMessages: boolean): VectorSearchHit {
    return {
      rank,
      score,
      chunk: {
        id: chunk.id,
        startMessageId: chunk.startMessageId,
        endMessageId: chunk.endMessageId,
        messageIds: chunk.messageIds,
        messageCount: chunk.messageCount,
        text: chunk.text,
        model: chunk.model,
        dimensions: chunk.dimensions,
      },
      messages: includeMessages
        ? this.store.getMessagesByIds({
            chatId: chunk.chatId,
            messageIds: chunk.messageIds,
          })
        : [],
    };
  }
}

export function formatMessage(message: StoredMessage): string {
  const sender = message.senderName || message.senderId || "unknown";
  const date = message.date ?? "no-date";
  const text = message.text.replace(/\s+/g, " ").trim();
  return `[${message.messageId} ${date}] ${sender}: ${text}`;
}

function reciprocalRank(index: number): number {
  return 1 / (60 + index + 1);
}

function embeddingProvider(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    return host.endsWith("openai.com") ? "OpenAI" : `OpenAI-compatible (${host})`;
  } catch {
    return "OpenAI-compatible";
  }
}

export function assertVectorSearchReady(result: { available: boolean; error?: string }): void {
  if (!result.available) {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: result.error ?? "Vector search is unavailable.",
    });
  }
}
