// SPDX-License-Identifier: MIT
// Ported from pinned OpenClaw; see NOTICE and import-proof.json.
/** Parses cron schedule timestamps from user-facing absolute time strings. */
import { parseStrictPositiveInteger } from "./normalization.js";
import { hasValidIsoCalendarComponents, normalizeUtcIso } from "./iso-time.js";

/** Parses absolute cron timestamps from epoch milliseconds or ISO-like strings normalized to UTC. */
export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const n = parseStrictPositiveInteger(raw);
    if (n !== undefined && Number.isFinite(new Date(n).getTime())) {
      return n;
    }
    return null;
  }
  if (!hasValidIsoCalendarComponents(raw)) {
    return null;
  }
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}
