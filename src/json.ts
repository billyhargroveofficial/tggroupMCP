export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value != null && typeof value === "object" && "toString" in value) {
    const maybe = value as { constructor?: { name?: string }; toString?: () => string };
    if (maybe.constructor?.name === "BigInteger") {
      return maybe.toString?.();
    }
  }
  return value;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2);
}
