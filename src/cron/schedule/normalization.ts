// SPDX-License-Identifier: MIT
// Selected pinned OpenClaw normalization helpers; see NOTICE and import-proof.json.
export const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function asFiniteNumberInRange(
  value: unknown,
  range: {
    min?: number;
    max?: number;
    minExclusive?: boolean;
    maxExclusive?: boolean;
  },
): number | undefined {
  const number = asFiniteNumber(value);
  if (number === undefined) {
    return undefined;
  }
  if (range.min !== undefined) {
    if (range.minExclusive ? number <= range.min : number < range.min) {
      return undefined;
    }
  }
  if (range.max !== undefined) {
    if (range.maxExclusive ? number >= range.max : number > range.max) {
      return undefined;
    }
  }
  return number;
}
export function asSafeIntegerInRange(
  value: unknown,
  range: {
    min?: number;
    max?: number;
  },
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  if (range.min !== undefined && value < range.min) {
    return undefined;
  }
  if (range.max !== undefined && value > range.max) {
    return undefined;
  }
  return value;
}
export function parseStrictInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const normalized = normalizeOptionalString(value);
  if (!normalized || !/^[+-]?\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
export function parseStrictFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return asFiniteNumber(value);
  }
  const normalized = normalizeOptionalString(value);
  if (!normalized || !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(normalized)) {
    return undefined;
  }
  return asFiniteNumber(Number(normalized));
}
export function parseStrictNonNegativeInteger(value: unknown): number | undefined {
  const parsed = parseStrictInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

export function parseStrictPositiveInteger(value: unknown): number | undefined {
  const parsed = parseStrictInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}
export function asDateTimestampMs(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, {
    min: -MAX_DATE_TIMESTAMP_MS,
    max: MAX_DATE_TIMESTAMP_MS,
  });
}
export function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
