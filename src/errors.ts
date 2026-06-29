import { ZodError } from "zod";

export type NormalizedError = {
  category: "rate_limit" | "permission" | "formatting" | "reply" | "peer" | "auth" | "validation" | "internal";
  telegramCode?: number;
  telegramType?: string;
  retryAfterSec?: number;
  retryable: boolean;
  message: string;
  fields?: Array<{ path: string; message: string }>;
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
  if (error instanceof ZodError) {
    return {
      category: "validation",
      retryable: false,
      message: "Invalid tool arguments.",
      fields: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const anyError = error as {
    message?: string;
    errorMessage?: string;
    code?: number;
    seconds?: unknown;
    name?: string;
    constructor?: { name?: string };
  };
  const message = String(anyError?.errorMessage || anyError?.message || error || "Unknown error");
  const className = String(anyError?.constructor?.name ?? "");
  const errorName = String(anyError?.name ?? "");
  const telegramTypeSource = className || errorName || anyError?.errorMessage || "";
  const upper = message.toUpperCase();
  const typeUpper = [className, errorName, anyError?.errorMessage, message].filter(Boolean).join(" ").toUpperCase();
  const waitMatch = typeUpper.match(/(?:FLOOD(?:_PREMIUM)?_WAIT|SLOWMODE_WAIT)_?(\d+(?:\.\d+)?)/);
  const retryAfterSec = waitMatch ? Number(waitMatch[1]) : retryAfterSeconds(anyError?.seconds);

  if (waitMatch || isGramJsFloodWait(typeUpper, anyError?.code, retryAfterSec)) {
    return {
      category: "rate_limit",
      telegramCode: anyError?.code,
      telegramType: waitMatch?.[0] ?? telegramTypeSource,
      retryAfterSec,
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
  if (
    upper.includes("ECONNRESET") ||
    upper.includes("ECONNREFUSED") ||
    upper.includes("ETIMEDOUT") ||
    upper.includes("EAI_AGAIN") ||
    upper.includes("TIMEOUT") ||
    upper.includes("NETWORK") ||
    upper.includes("CONNECTION") ||
    upper.includes("SOCKET")
  ) {
    return {
      category: "internal",
      telegramCode: anyError?.code,
      telegramType: upper,
      retryable: true,
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

function retryAfterSeconds(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isGramJsFloodWait(typeUpper: string, code: number | undefined, retryAfterSec: number | undefined): boolean {
  if (retryAfterSec == null) {
    return false;
  }
  return (
    code === 420 ||
    typeUpper.includes("FLOODWAITERROR") ||
    typeUpper.includes("SLOWMODEWAITERROR") ||
    typeUpper.includes("FLOOD_WAIT") ||
    typeUpper.includes("SLOWMODE_WAIT") ||
    typeUpper.includes("FLOOD")
  );
}

export function ok<T extends Record<string, unknown>>(value: T): { ok: true } & T {
  return { ok: true, ...value };
}

export function fail(error: unknown): { ok: false; error: NormalizedError } {
  return { ok: false, error: normalizeError(error) };
}
