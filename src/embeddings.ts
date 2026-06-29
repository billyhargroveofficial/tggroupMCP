import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { ToolError } from "./errors.js";

export type EmbeddingChunkInput = {
  chatId: string;
  startMessageId: number;
  endMessageId: number;
  messageIds: number[];
  messageCount: number;
  text: string;
};

export type EmbeddingChunkVector = EmbeddingChunkInput & {
  model: string;
  dimensions: number;
  embedding: Buffer;
  contentHash: string;
};

type EmbeddingsResponse = {
  data?: Array<{
    index?: number;
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
};

export class EmbeddingClient {
  constructor(private readonly config: AppConfig) {}

  get isEnabled(): boolean {
    return this.config.embeddings.enabled;
  }

  get isConfigured(): boolean {
    return this.isEnabled && Boolean(this.config.embeddings.apiKey);
  }

  assertConfigured(): void {
    if (!this.config.embeddings.enabled) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.",
      });
    }
    if (!this.config.embeddings.apiKey) {
      throw new ToolError({
        category: "auth",
        retryable: false,
        message: "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY.",
      });
    }
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    this.assertConfigured();
    if (texts.length === 0) {
      return [];
    }

    const body: Record<string, unknown> = {
      model: this.config.embeddings.model,
      input: texts,
      encoding_format: "float",
    };
    if (this.config.embeddings.dimensions != null) {
      body.dimensions = this.config.embeddings.dimensions;
    }

    const response = await fetch(`${this.config.embeddings.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.embeddings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as EmbeddingsResponse;

    if (!response.ok) {
      throw new ToolError({
        category: response.status === 429 ? "rate_limit" : "internal",
        retryable: response.status >= 500 || response.status === 429,
        message: payload.error?.message || `Embedding API request failed with HTTP ${response.status}.`,
      });
    }

    const vectors = [...(payload.data ?? [])]
      .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
      .map((item) => item.embedding);
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector))) {
      throw new ToolError({
        category: "internal",
        retryable: true,
        message: "Embedding API returned an unexpected response shape.",
      });
    }
    return vectors as number[][];
  }

  async embedQuery(query: string): Promise<number[]> {
    const [embedding] = await this.embedTexts([query]);
    return normalizeVector(embedding);
  }

  async embedChunks(chunks: EmbeddingChunkInput[]): Promise<EmbeddingChunkVector[]> {
    const vectors = await this.embedTexts(chunks.map((chunk) => chunk.text));
    return chunks.map((chunk, index) => {
      const normalized = normalizeVector(vectors[index]);
      return {
        ...chunk,
        model: this.config.embeddings.model,
        dimensions: normalized.length,
        embedding: vectorToBlob(normalized),
        contentHash: hashText(chunk.text),
      };
    });
  }
}

export function vectorToBlob(vector: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index], index * Float32Array.BYTES_PER_ELEMENT);
  }
  return buffer;
}

export function blobToVector(blob: Uint8Array): Float32Array {
  const buffer = Buffer.from(blob);
  const values = new Float32Array(buffer.length / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  return values;
}

export function cosineSimilarity(normalizedLeft: ArrayLike<number>, normalizedRight: ArrayLike<number>): number {
  const length = Math.min(normalizedLeft.length, normalizedRight.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += normalizedLeft[index] * normalizedRight[index];
  }
  return score;
}

function normalizeVector(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
