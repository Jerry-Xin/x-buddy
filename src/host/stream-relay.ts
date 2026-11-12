// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/stream-relay.ts; changes: spdx-header, change-notice, import-path.
/**
 * Stream Relay — typing heartbeat + message splitting + plain sendMessage delivery.
 *
 * Consumes an AsyncIterable<string> of text chunks and delivers them to Octo
 * via OctoEgress with intelligent splitting.
 *
 * Design constraints:
 * - Knows nothing about the agent SDK — input is a generic async text stream.
 * - All Octo outbound calls are confined through OctoEgress.
 * - Typing indicators keep the user informed while chunks accumulate.
 */

import type { ChannelType } from "../octo/types.js";
import { OctoEgress, isOctoEgress, StringCatalog } from "../runtime/octo-egress.js";
import { resolveMentions } from "./mention-utils.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Interval (ms) between typing indicator pings. */
const TYPING_INTERVAL_MS = 5_000;

/** Maximum characters per message segment. */
const MAX_SEGMENT_CHARS = 3_500;

/** Default maximum accumulated response length before truncation (Q32). */
const DEFAULT_MAX_RESPONSE_CHARS = 524_288; // 512 KB

/** Truncation suffix appended when response exceeds limit. */
const TRUNCATION_SUFFIX = StringCatalog.responseTruncatedSuffix();

// ─── Message Splitting ─────────────────────────────────────────────────────

/** A protected range that splitMessage must not cut through. */
export interface ProtectedRange {
  /** Start offset (inclusive, UTF-16 code units). */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

/**
 * Adjust a candidate split position so it does not fall strictly inside any
 * protected range. If splitAt lands inside [start, end), prefer pushing back
 * to `start` (move the protected unit whole to the next segment).
 *
 * Returns the adjusted split position, or null if pulling back would land at 0.
 */
function adjustSplitForProtectedRanges(
  splitAt: number,
  protectedRanges: ProtectedRange[],
): number | null {
  for (const range of protectedRanges) {
    if (splitAt > range.start && splitAt < range.end) {
      // Pull BACK to range.start so the protected unit moves whole to next seg.
      if (range.start > 0) return range.start;
      // Range starts at 0 — can't pull back. Caller will deal.
      return null;
    }
  }
  return splitAt;
}

/**
 * Split a long text into segments at natural boundaries.
 *
 * Priority: paragraph break (\n\n) > newline (\n) > space > hard cut.
 * Each segment is at most `maxChars` characters.
 *
 * `protectedRanges` (P0-1): byte ranges that must NOT be split through. Used
 * by deliver() to keep resolved @name mentions intact — a name like
 * "@John Smith Junior" must be sent as one unit so the corresponding
 * MentionEntity offset/length lands cleanly in one segment.
 */
export function splitMessage(
  text: string,
  maxChars: number = MAX_SEGMENT_CHARS,
  protectedRanges: ProtectedRange[] = [],
): string[] {
  if (maxChars < 1) {
    throw new Error(`splitMessage: maxChars must be >= 1, got ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];

  const segments: string[] = [];
  let remaining = text;
  let consumed = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      segments.push(remaining);
      break;
    }

    const chunk = remaining.slice(0, maxChars);
    // Translate global ranges to local offsets relative to remaining.
    const localRanges = protectedRanges
      .filter(r => r.end > consumed && r.start < consumed + remaining.length)
      .map(r => ({ start: r.start - consumed, end: r.end - consumed }));

    let splitAt = -1;
    function tryCandidate(candidate: number): boolean {
      const adj = adjustSplitForProtectedRanges(candidate, localRanges);
      if (adj === null || adj <= 0 || adj > maxChars) return false;
      splitAt = adj;
      return true;
    }

    // 1. Paragraph break (\n\n) — prefer the last one within range.
    const paraIdx = chunk.lastIndexOf("\n\n");
    if (paraIdx > 0) tryCandidate(paraIdx + 2);

    // 2. Newline (\n)
    if (splitAt === -1) {
      const nlIdx = chunk.lastIndexOf("\n");
      if (nlIdx > 0) tryCandidate(nlIdx + 1);
    }

    // 3. Space
    if (splitAt === -1) {
      const spIdx = chunk.lastIndexOf(" ");
      if (spIdx > 0) tryCandidate(spIdx + 1);
    }

    // 4. Hard cut — avoid splitting surrogate pairs AND protected ranges.
    if (splitAt === -1) {
      splitAt = maxChars;
      // If the cut falls between a surrogate pair, back up one code unit.
      const code = remaining.charCodeAt(splitAt - 1);
      if (code >= 0xD800 && code <= 0xDBFF) splitAt--;
      // If the cut falls inside a protected range, pull back to its start.
      // Pathological case (range starts at 0 and exceeds maxChars): we fall
      // back to maxChars and accept the broken mention rather than infinite
      // loop. In practice an @[uid:name] is far shorter than maxChars=3500.
      const adj = adjustSplitForProtectedRanges(splitAt, localRanges);
      if (adj !== null && adj > 0) splitAt = Math.min(adj, maxChars);
    }

    segments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    consumed += splitAt;
  }

  return segments;
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

export class StreamRelay {
  readonly #egress?: OctoEgress;

  constructor(egress?: OctoEgress) {
    this.#egress = egress;
  }

  /**
   * Deliver an async stream of text chunks to an Octo channel.
   *
   * 1. Starts a typing indicator heartbeat (5 s interval).
   * 2. Accumulates all chunks from the async iterable.
   * 3. Sends the accumulated text via OctoEgress with splitting.
   * 4. Always cleans up the typing heartbeat.
   */
  async deliver(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
    maxResponseChars: number = DEFAULT_MAX_RESPONSE_CHARS,
    memberMap?: Map<string, string>,
    isValidUid?: (uid: string) => boolean,
  ): Promise<void> {
    const egress = isOctoEgress(this.#egress)
      ? this.#egress
      : new OctoEgress({ apiUrl, getToken: () => botToken });
    const targetChannelType = channelType as 1 | 2 | 5;
    const typingLoop = egress.startTypingLoop({
      channelId,
      channelType: targetChannelType,
      intervalMs: TYPING_INTERVAL_MS,
    });

    try {
      let accumulated = "";
      let truncated = false;
      let streamError: unknown;
      try {
        for await (const chunk of chunks) {
          accumulated += chunk;
          if (accumulated.length > maxResponseChars) {
            let cutAt = maxResponseChars;
            const code = accumulated.charCodeAt(cutAt - 1);
            if (code >= 0xD800 && code <= 0xDBFF) cutAt--;
            accumulated = accumulated.slice(0, cutAt) + TRUNCATION_SUFFIX;
            truncated = true;
            break;
          }
        }
      } catch (err) {
        streamError = err;
        console.error(`[stream-relay] agent stream threw after ${accumulated.length} char(s); flushing partial output: ${String(err)}`);
      }
      if (truncated) {
        console.warn(`[stream-relay] Response truncated at ${maxResponseChars} chars`);
      }

      if (accumulated.length > 0 && accumulated.trim() !== "NO_REPLY") {
        const {
          finalContent,
          mentionEntities: globalEntities,
          mentionAll,
        } = resolveMentions(accumulated, memberMap, isValidUid);

        const protectedRanges = globalEntities.map(e => ({
          start: e.offset,
          end: e.offset + e.length,
        }));

        const segments = splitMessage(finalContent, undefined, protectedRanges);
        let segStart = 0;
        let mentionAllConsumed = false;
        for (const segment of segments) {
          const segEnd = segStart + segment.length;
          const segEntities = globalEntities
            .filter(e => e.offset >= segStart && e.offset + e.length <= segEnd)
            .map(e => ({ uid: e.uid, offset: e.offset - segStart, length: e.length }));
          const segUids = segEntities.map(e => e.uid);
          const useMentionAll = mentionAll && !mentionAllConsumed;
          if (useMentionAll) mentionAllConsumed = true;

          try {
            await egress.sendText({
              kind: 'chat.reply',
              channelId,
              channelType: targetChannelType,
              content: segment,
              ...(segUids.length > 0 ? { mentionUids: segUids } : {}),
              ...(segEntities.length > 0 ? { mentionEntities: segEntities } : {}),
              ...(useMentionAll ? { mentionAll: true } : {}),
            });
          } catch (err) {
            console.error(`[stream-relay] sendMessage failed for segment (${segment.length} chars), continuing: ${String(err)}`);
          }
          segStart = segEnd;
        }
      }
      if (streamError !== undefined) throw streamError;
    } finally {
      typingLoop.stop();
    }
  }
}
