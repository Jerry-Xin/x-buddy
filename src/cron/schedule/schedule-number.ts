// SPDX-License-Identifier: MIT
// Ported from pinned OpenClaw; see NOTICE and import-proof.json.
/** Coerces cron schedule time fields with strict Date-range parsing. */
import {
  asDateTimestampMs,
  parseStrictFiniteNumber,
} from "./normalization.js";

/** Coerces temporal schedule fields without accepting partial, non-finite, or invalid-Date values. */
export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  return asDateTimestampMs(parsed);
}
