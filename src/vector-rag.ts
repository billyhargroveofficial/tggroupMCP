import type { AppConfig } from "./config.js";
import {
  blobToVector,
  cosineSimilarity,
  EmbeddingClient,
  EMBEDDING_NORMALIZATION_VERSION,
  embeddingNamespace,
  type EmbeddingChunkInput,
} from "./embeddings.js";
import { ToolError } from "./errors.js";
import { MessageStore, type KeywordSearchHit, type StoredEmbeddingChunk, type StoredMessage } from "./store.js";

export type EmbeddingIndexResult = {
  ok: true;
  chatId: string;
  model: string;
  dimensions?: number;
  namespace: string;
  normalizationVersion: string;
  chunksCreated: number;
  messagesCovered: number;
  nextAfterMessageId?: number;
  deletedChunks?: number;
  dirtyChunksDeleted?: number;
  budget: EmbeddingRunBudget;
  coverage: Record<string, number>;
  stats: Array<Record<string, unknown>>;
};

export type EmbeddingRunBudget = {
  requestedLimitChunks: number;
  effectiveLimitChunks: number;
  maxChunksPerRun: number;
  maxCharsPerRun: number;
  truncatedByChunkBudget: boolean;
  truncatedByCharBudget: boolean;
};

export type EmbeddingIndexEstimate = {
  provider: string;
  baseUrl: string;
  model: string;
  dimensions?: number;
  namespace: string;
  normalizationVersion: string;
  chatId: string;
  limitChunks: number;
  requestedLimitChunks: number;
  estimatedChunks: number;
  estimatedMessages: number;
  estimatedChars: number;
  existingChunks: number;
  budget: EmbeddingRunBudget;
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
    namespace: string;
    model: string;
    dimensions: number;
  };
  messages: StoredMessage[];
};

export type HybridSearchHit = {
  rank: number;
  source: "keyword" | "vector" | "hybrid";
  sources: Array<"keyword" | "vector">;
  score: number;
  messageId?: number;
  startMessageId?: number;
  endMessageId?: number;
  text: string;
};

export class VectorRag {
  private readonly embeddings: EmbeddingClient;
  private readonly namespace: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store: MessageStore,
  ) {
    this.embeddings = new EmbeddingClient(config);
    this.namespace = embeddingNamespace(config);
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
          namespace: this.namespace,
          model: this.config.embeddings.model,
          dimensions: this.config.embeddings.dimensions,
        })
      : undefined;
    let afterMessageId = params.afterMessageId;

    const plan = this.buildChunks(params.chatId, {
      afterMessageId,
      limitChunks,
      includeCovered: params.rebuild,
    });
    const inputs = plan.chunks;
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
          namespace: this.namespace,
          model: this.config.embeddings.model,
          dimensions: this.config.embeddings.dimensions,
          messageIds: inputs.flatMap((chunk) => chunk.messageIds),
        });

    return {
      ok: true,
      chatId: params.chatId,
      model: this.config.embeddings.model,
      dimensions: this.config.embeddings.dimensions,
      namespace: this.namespace,
      normalizationVersion: EMBEDDING_NORMALIZATION_VERSION,
      chunksCreated,
      messagesCovered,
      nextAfterMessageId: afterMessageId,
      deletedChunks,
      dirtyChunksDeleted,
      budget: { ...estimate.budget, truncatedByCharBudget: plan.truncatedByCharBudget },
      coverage: this.store.getEmbeddingCoverageStats({
        chatId: params.chatId,
        namespace: this.namespace,
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
    const requestedLimitChunks = Math.max(1, params.limitChunks ?? this.config.embeddings.tickChunkLimit);
    const limitChunks = Math.min(requestedLimitChunks, this.config.embeddings.maxChunksPerRun);
    const stats = this.store.getEmbeddingStats(params.chatId, { namespace: this.namespace });
    const plan = this.buildChunks(params.chatId, {
      afterMessageId: params.afterMessageId,
      limitChunks,
      includeCovered: params.rebuild,
    });
    const inputs = plan.chunks;
    const existingChunks = stats.reduce((sum, row) => sum + Number(row.chunks ?? 0), 0);
    const estimatedChunks = inputs.length;
    const firstRun = existingChunks === 0;

    return {
      provider: embeddingProvider(this.config.embeddings.baseUrl),
      baseUrl: this.config.embeddings.baseUrl,
      model: this.config.embeddings.model,
      dimensions: this.config.embeddings.dimensions,
      namespace: this.namespace,
      normalizationVersion: EMBEDDING_NORMALIZATION_VERSION,
      chatId: params.chatId,
      limitChunks,
      requestedLimitChunks,
      estimatedChunks,
      estimatedMessages: inputs.reduce((sum, chunk) => sum + chunk.messageCount, 0),
      estimatedChars: inputs.reduce((sum, chunk) => sum + chunk.text.length, 0),
      existingChunks,
      budget: {
        requestedLimitChunks,
        effectiveLimitChunks: limitChunks,
        maxChunksPerRun: this.config.embeddings.maxChunksPerRun,
        maxCharsPerRun: this.config.embeddings.maxCharsPerRun,
        truncatedByChunkBudget: requestedLimitChunks > limitChunks,
        truncatedByCharBudget: plan.truncatedByCharBudget,
      },
      coverage: this.store.getEmbeddingCoverageStats({
        chatId: params.chatId,
        namespace: this.namespace,
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
    candidateLimit?: number;
    candidateCount?: number;
    hits: VectorSearchHit[];
  }> {
    const stats = this.store.getEmbeddingStats(params.chatId, { namespace: this.namespace });
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
    const searchDimensions = this.config.embeddings.dimensions ?? queryVector.length;
    const chunks = this.store.getEmbeddingChunks({
      chatId: params.chatId,
      namespace: this.namespace,
      model: this.config.embeddings.model,
      dimensions: searchDimensions,
      beforeId: params.beforeId,
      afterId: params.afterId,
      limit: this.config.embeddings.vectorCandidateLimit + 1,
    });
    if (chunks.length > this.config.embeddings.vectorCandidateLimit) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: `Vector search candidate limit ${this.config.embeddings.vectorCandidateLimit} exceeded for model ${this.config.embeddings.model} and dimensions ${searchDimensions}. Narrow the search with before_id/after_id or raise TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT after benchmarking.`,
      });
    }
    const mismatchedChunk = chunks.find((chunk) => chunk.dimensions !== queryVector.length);
    if (mismatchedChunk) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: `Refusing mixed-dimension vector comparison: query has ${queryVector.length} dimensions but chunk ${mismatchedChunk.id} has ${mismatchedChunk.dimensions}.`,
      });
    }

    const scored = chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, blobToVector(chunk.embedding)) }))
      .sort((left, right) => right.score - left.score);
    const hits = scored
      .map((hit) =>
        this.toVectorHit(hit.chunk, hit.score, params.includeMessages ?? true, {
          beforeId: params.beforeId,
          afterId: params.afterId,
        }),
      )
      .filter((hit): hit is VectorSearchHit => hit != null)
      .slice(0, limit)
      .map((hit, index) => ({ ...hit, rank: index + 1 }));

    return {
      available: true,
      stats,
      candidateLimit: this.config.embeddings.vectorCandidateLimit,
      candidateCount: chunks.length,
      hits,
    };
  }

  hybrid(keywordHits: KeywordSearchHit[], vectorHits: VectorSearchHit[], limit: number): HybridSearchHit[] {
    type DraftHit = Omit<HybridSearchHit, "rank" | "source"> & { bestRank: number };
    const results = new Map<string, DraftHit>();
    const vectorKeyByMessageId = new Map<number, string>();

    for (const [index, hit] of vectorHits.entries()) {
      const key = `chunk:${hit.chunk.id}`;
      for (const message of hit.messages) {
        vectorKeyByMessageId.set(message.messageId, key);
      }
      results.set(key, mergeHybridHit(results.get(key), {
        sources: ["vector"],
        score: reciprocalRank(index),
        bestRank: index + 1,
        startMessageId: hit.chunk.startMessageId,
        endMessageId: hit.chunk.endMessageId,
        text: hit.chunk.text,
      }));
    }

    for (const [index, hit] of keywordHits.entries()) {
      const vectorKey = vectorKeyByMessageId.get(hit.message.messageId);
      const key = vectorKey ?? `message:${hit.message.chatId}:${hit.message.messageId}`;
      results.set(key, mergeHybridHit(results.get(key), {
        sources: ["keyword"],
        score: reciprocalRank(index),
        bestRank: index + 1,
        messageId: hit.message.messageId,
        text: vectorKey ? (results.get(vectorKey)?.text ?? formatMessage(hit.message)) : formatMessage(hit.message),
      }));
    }

    return [...results.values()]
      .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank)
      .slice(0, limit)
      .map((hit, index) => ({
        rank: index + 1,
        source: hit.sources.length > 1 ? "hybrid" : hit.sources[0]!,
        sources: hit.sources,
        score: hit.score,
        messageId: hit.messageId,
        startMessageId: hit.startMessageId,
        endMessageId: hit.endMessageId,
        text: hit.text,
      }));
  }

  private buildChunks(
    chatId: string,
    params: { afterMessageId?: number; limitChunks: number; includeCovered?: boolean },
  ): { chunks: EmbeddingChunkInput[]; truncatedByCharBudget: boolean } {
    const chunks: EmbeddingChunkInput[] = [];
    let cursor = params.afterMessageId;
    let buffer: StoredMessage[] = [];
    let bufferChars = 0;
    const fetchLimit = Math.max(this.config.embeddings.chunkMessages * params.limitChunks * 2, 500);
    let totalChars = 0;
    let truncatedByCharBudget = false;
    let bufferHasNewMessages = false;
    const overlapMessages = Math.min(
      this.config.embeddings.chunkOverlapMessages,
      Math.max(0, this.config.embeddings.chunkMessages - 1),
    );

    const bufferTextLength = (messages: StoredMessage[]): number =>
      messages.reduce((sum, message, index) => sum + formatMessageForChunk(message, this.config.embeddings.chunkMaxChars).length + (index > 0 ? 1 : 0), 0);

    const flush = (retainOverlap: boolean): void => {
      if (buffer.length === 0 || chunks.length >= params.limitChunks) {
        return;
      }
      const first = buffer[0]!;
      const last = buffer[buffer.length - 1]!;
      const text = buffer.map((message) => formatMessageForChunk(message, this.config.embeddings.chunkMaxChars)).join("\n");
      chunks.push({
        chatId,
        startMessageId: first.messageId,
        endMessageId: last.messageId,
        messageIds: buffer.map((message) => message.messageId),
        messageCount: buffer.length,
        text,
      });
      totalChars += text.length;
      buffer = retainOverlap && overlapMessages > 0 ? buffer.slice(-overlapMessages) : [];
      bufferChars = bufferTextLength(buffer);
      bufferHasNewMessages = false;
    };

    outer: while (chunks.length < params.limitChunks && !truncatedByCharBudget) {
      const messages = params.includeCovered
        ? this.store.getMessagesForEmbedding({
            chatId,
            afterId: cursor,
            limit: fetchLimit,
          })
        : this.store.getMessagesNeedingEmbedding({
            chatId,
            namespace: this.namespace,
            model: this.config.embeddings.model,
            dimensions: this.config.embeddings.dimensions,
            afterId: cursor,
            limit: fetchLimit,
          });
      if (messages.length === 0) {
        break;
      }

      for (const message of messages) {
        const formatted = formatMessageForChunk(message, this.config.embeddings.chunkMaxChars);
        let additionalChars = formatted.length + (buffer.length > 0 ? 1 : 0);
        if (buffer.length > 0 && bufferChars + additionalChars > this.config.embeddings.chunkMaxChars) {
          if (bufferHasNewMessages) {
            flush(false);
          } else {
            buffer = [];
            bufferChars = 0;
          }
          additionalChars = formatted.length;
        }
        if (chunks.length >= params.limitChunks) {
          break;
        }
        if (totalChars + bufferChars + additionalChars > this.config.embeddings.maxCharsPerRun) {
          truncatedByCharBudget = true;
          break outer;
        }
        cursor = message.messageId;
        buffer.push(message);
        bufferHasNewMessages = true;
        bufferChars += additionalChars;
        if (buffer.length >= this.config.embeddings.chunkMessages) {
          flush(true);
        }
      }

      if (messages.length < fetchLimit) {
        break;
      }
    }
    if (bufferHasNewMessages) {
      flush(false);
    }
    return { chunks: chunks.slice(0, params.limitChunks), truncatedByCharBudget };
  }

  private toVectorHit(
    chunk: StoredEmbeddingChunk,
    score: number,
    includeMessages: boolean,
    window: { beforeId?: number; afterId?: number },
  ): VectorSearchHit | undefined {
    const messageIds = chunk.messageIds.filter((messageId) => messageIdInWindow(messageId, window));
    if (messageIds.length === 0) {
      return undefined;
    }
    const trimmed = messageIds.length !== chunk.messageIds.length;
    const visibleMessages =
      includeMessages || trimmed
        ? this.store.getMessagesByIds({
            chatId: chunk.chatId,
            messageIds,
          })
        : [];
    const visibleText = trimmed
      ? visibleMessages.map((message) => formatMessage(message)).join("\n")
      : chunk.text;
    return {
      rank: 0,
      score,
      chunk: {
        id: chunk.id,
        startMessageId: Math.min(...messageIds),
        endMessageId: Math.max(...messageIds),
        messageIds,
        messageCount: messageIds.length,
        text: visibleText,
        namespace: chunk.namespace,
        model: chunk.model,
        dimensions: chunk.dimensions,
      },
      messages: includeMessages ? visibleMessages : [],
    };
  }
}

function messageIdInWindow(messageId: number, window: { beforeId?: number; afterId?: number }): boolean {
  if (window.beforeId != null && messageId >= window.beforeId) {
    return false;
  }
  if (window.afterId != null && messageId <= window.afterId) {
    return false;
  }
  return true;
}

export function formatMessage(message: StoredMessage): string {
  const sender = message.senderName || message.senderId || "unknown";
  const date = message.date ?? "no-date";
  const text = message.text.replace(/\s+/g, " ").trim();
  return `[${message.messageId} ${date}] ${sender}: ${text}`;
}

function formatMessageForChunk(message: StoredMessage, maxChars: number): string {
  const formatted = formatMessage(message);
  if (formatted.length <= maxChars) {
    return formatted;
  }
  const marker = " [truncated]";
  if (maxChars <= marker.length) {
    return formatted.slice(0, maxChars);
  }
  return `${formatted.slice(0, maxChars - marker.length)}${marker}`;
}

function reciprocalRank(index: number): number {
  return 1 / (60 + index + 1);
}

function mergeHybridHit<T extends Omit<HybridSearchHit, "rank" | "source"> & { bestRank: number }>(
  existing: T | undefined,
  incoming: T,
): T {
  if (!existing) {
    return incoming;
  }
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value != null)),
    sources: [...new Set([...existing.sources, ...incoming.sources])],
    score: existing.score + incoming.score,
    bestRank: Math.min(existing.bestRank, incoming.bestRank),
    text: existing.text || incoming.text,
  } as T;
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
