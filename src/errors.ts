export type NormalizedError = {
  category: "rate_limit" | "permission" | "formatting" | "reply" | "peer" | "auth" | "internal";
  telegramCode?: number;
  telegramType?: string;
  retryAfterSec?: number;
  retryable: boolean;
  message: string;
};

export class ToolError extends Error {
  readonly normalized: NormalizedError;

  constructor(normalized: NormalizedError) {
    super(normalized.message);
    this.normalized = normalized;
  }
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof ToolError) {
    return error.normalized;
  }

  const anyError = error as { message?: string; errorMessage?: string; code?: number };
  const message = String(anyError?.errorMessage || anyError?.message || error || "Unknown error");
  const upper = message.toUpperCase();
  const waitMatch = upper.match(/(?:FLOOD_WAIT|SLOWMODE_WAIT)_?(\d+)/);

  if (waitMatch) {
    return {
      category: "rate_limit",
      telegramCode: anyError?.code,
      telegramType: waitMatch[0],
      retryAfterSec: Number(waitMatch[1]),
      retryable: true,
      message,
    };
  }
  if (upper.includes("CHAT_WRITE_FORBIDDEN") || upper.includes("USER_BANNED") || upper.includes("FORBIDDEN")) {
    return {
      category: "permission",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("MESSAGE_TOO_LONG") || upper.includes("ENTITY_BOUNDS_INVALID")) {
    return {
      category: "formatting",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("REPLY_MESSAGE_ID_INVALID") || upper.includes("TOPIC_CLOSED")) {
    return {
      category: "reply",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("SESSION") || upper.includes("AUTH") || upper.includes("PHONE_CODE")) {
    return {
      category: "auth",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }
  if (upper.includes("USERNAME") || upper.includes("PEER") || upper.includes("CHANNEL_INVALID")) {
    return {
      category: "peer",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: false,
      message,
    };
  }

  return {
    category: "internal",
    telegramCode: anyError?.code,
    retryable: false,
    message,
  };
}

export function ok<T extends Record<string, unknown>>(value: T): { ok: true } & T {
  return { ok: true, ...value };
}

export function fail(error: unknown): { ok: false; error: NormalizedError } {
  return { ok: false, error: normalizeError(error) };
}
