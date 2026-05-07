import crypto from 'crypto';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalizeValue(value: unknown): JsonValue {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (typeof value === 'object') {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeValue(nestedValue)] as const);

    return Object.fromEntries(normalizedEntries);
  }

  return String(value);
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

export function sha256Hex(value: unknown): `0x${string}` {
  const canonical = typeof value === 'string' ? value : canonicalJsonStringify(value);
  return `0x${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}
