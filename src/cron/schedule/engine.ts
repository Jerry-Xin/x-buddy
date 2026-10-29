// SPDX-License-Identifier: MIT
// Stagger detection, offset and cursor arithmetic adapted from OpenClaw
// f6065d67762f2c87fbdeff119f34f54266a95b87. See NOTICE and LICENSE-MIT.
import { createHash } from 'node:crypto';

export const MAX_DATE_MS = 8_640_000_000_000_000;
export const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;
export type Schedule = Readonly<
  { kind: 'at'; atMs: number } | { kind: 'every'; everyMs: number; anchorMs: number }
>;

export function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new RangeError('Expected integer UTC milliseconds in the supported date range');
  }
  return value;
}

export function validateTimezone(tz: string): string {
  // Never infer a timezone from the machine running the scheduler.
  if (typeof tz !== 'string' || !tz || /^[+-]/.test(tz)) {
    throw new RangeError('Expected an explicit IANA timezone');
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
}

export function validateAt(atMs: number, nowMs: number): Schedule {
  timestamp(atMs); timestamp(nowMs);
  if (atMs < nowMs - 60_000 || atMs > nowMs + TEN_YEARS_MS) {
    throw new RangeError('One-shot time must be within -1 minute and +10 years');
  }
  return { kind: 'at', atMs };
}

/** Numeric offsets identify instants. Offsetless non-UTC conversion awaits the pinned adapter. */
export function parseAt(input: string, tz: string, nowMs: number): Schedule {
  const zone = validateTimezone(tz);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(input);
  if (!match) throw new RangeError('Expected an ISO timestamp with second precision');
  if (!match[4] && zone !== 'UTC') {
    throw new RangeError('Pending integration: offsetless zoned at requires croner@10.0.1 adapter');
  }
  // Check calendar fields before Date.parse can normalize a nonexistent date.
  const wall = `${match[1]}T${match[2]}${match[3] ?? ''}`;
  const wallMs = Date.parse(`${wall}Z`);
  const canonicalWall = `${match[1]}T${match[2]}${(match[3] ?? '.000').padEnd(4, '0')}Z`;
  if (!Number.isFinite(wallMs) || new Date(wallMs).toISOString() !== canonicalWall) {
    throw new RangeError('Invalid calendar date or time');
  }
  return validateAt(Date.parse(`${wall}${match[4] ?? 'Z'}`), nowMs);
}

export function every(everyMs: number, anchorMs: number): Schedule {
  timestamp(everyMs); timestamp(anchorMs);
  if (everyMs < 1) throw new RangeError('everyMs must be positive');
  return { kind: 'every', everyMs, anchorMs };
}

function validateSchedule(schedule: Schedule): void {
  if (schedule.kind === 'at') timestamp(schedule.atMs);
  else if (schedule.kind === 'every') every(schedule.everyMs, schedule.anchorMs);
  else throw new RangeError('Unsupported schedule kind');
}

function bounded(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS ? value : undefined;
}

/** Strictly after now; an overdue at remains due through dueAt(), not this query. */
export function next(schedule: Schedule, nowMs: number): number | undefined {
  validateSchedule(schedule); timestamp(nowMs);
  if (schedule.kind === 'at') return schedule.atMs > nowMs ? schedule.atMs : undefined;
  if (nowMs < schedule.anchorMs) return schedule.anchorMs;
  return bounded(schedule.anchorMs + (Math.floor((nowMs - schedule.anchorMs) / schedule.everyMs) + 1) * schedule.everyMs);
}

/** Latest authored slot at or before now. No wall clock or timer is consulted. */
export function previousOrBefore(schedule: Schedule, nowMs: number): number | undefined {
  validateSchedule(schedule); timestamp(nowMs);
  if (schedule.kind === 'at') return schedule.atMs <= nowMs ? schedule.atMs : undefined;
  if (nowMs < schedule.anchorMs) return undefined;
  return bounded(schedule.anchorMs + Math.floor((nowMs - schedule.anchorMs) / schedule.everyMs) * schedule.everyMs);
}

export function dueAt(schedule: Schedule, nowMs: number, activatedAtMs: number, watermark: number | null): number | undefined {
  timestamp(activatedAtMs);
  if (watermark !== null) timestamp(watermark);
  const slot = previousOrBefore(schedule, nowMs);
  return slot !== undefined && slot >= activatedAtMs && (watermark === null || slot > watermark) ? slot : undefined;
}

export function occurrenceId(jobId: string, generation: number, effectiveSlotMs: number): string {
  if (typeof jobId !== 'string' || !jobId || !Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError('Expected a nonempty job ID and positive generation');
  }
  return JSON.stringify([jobId, generation, timestamp(effectiveSlotMs)]);
}

const HOUR_LIST_PART = /^(?:\d+|\d+-\d+)(?:\/\d+)?$|^[*?](?:\/\d+)?$/;
/** Detection only: this helper does not validate or evaluate a cron expression. */
export function defaultStaggerMs(expr: string): number {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  const hour = fields.length === 5 && fields[0] === '0' ? fields[1]
    : fields.length === 6 && fields[0] === '0' && fields[1] === '0' ? fields[2] : undefined;
  const parts = hour?.split(',');
  return parts && parts.every(p => HOUR_LIST_PART.test(p)) && parts.some(p => p.startsWith('*') || p.startsWith('?')) ? 300_000 : 0;
}

/** R8 definition validation is stricter than OC's permissive config coercion. */
export function staggerMs(kind: 'at' | 'every' | 'cron', expr = '', explicit?: number, exact = false): number {
  if (!['at', 'every', 'cron'].includes(kind)) throw new RangeError('Unsupported schedule kind');
  if (explicit !== undefined && (!Number.isInteger(explicit) || explicit < 0 || explicit > 300_000)) {
    throw new RangeError('staggerMs must be an integer in 0..300000');
  }
  if (kind !== 'cron') {
    if (explicit) throw new RangeError('Only cron supports positive stagger');
    return 0;
  }
  return exact ? 0 : explicit ?? defaultStaggerMs(expr);
}

export function stableOffsetMs(jobId: string, widthMs: number): number {
  if (typeof jobId !== 'string' || !jobId) throw new RangeError('Expected a job ID');
  staggerMs('cron', '', widthMs);
  return widthMs <= 1 ? 0 : createHash('sha256').update(jobId, 'utf8').digest().readUInt32BE(0) % widthMs;
}

// The production cron adapter is deliberately absent until the exact approved
// dependency is available. Inject only a strict, DST-normalized raw lookup.
export type RawLookup = (cursorMs: number) => number | undefined;

export function effectiveNext(nowMs: number, offsetMs: number, rawNext: RawLookup): number | undefined {
  timestamp(nowMs); staggerMs('cron', '', offsetMs);
  let cursor = Math.max(0, nowMs - offsetMs);
  for (let probe = 0; probe < 4; probe++) {
    const base = rawNext(cursor);
    if (base === undefined) return undefined;
    timestamp(base);
    if (base <= cursor) throw new RangeError('Raw next must be strict');
    const shifted = bounded(base + offsetMs);
    if (shifted !== undefined && shifted > nowMs) return shifted;
    cursor = Math.max(cursor + 1, base + 1000);
    if (bounded(cursor) === undefined) return undefined;
  }
  return undefined;
}

function effectivePrevious(nowMs: number, offsetMs: number, rawPrevious: RawLookup): number | undefined {
  let cursor = Math.max(0, nowMs - offsetMs);
  for (let probe = 0; probe < 4; probe++) {
    const base = rawPrevious(cursor);
    if (base === undefined) return undefined;
    timestamp(base);
    if (base >= cursor) throw new RangeError('Raw previous must be strict');
    const shifted = bounded(base + offsetMs);
    if (shifted !== undefined && shifted <= nowMs) return shifted;
    cursor = Math.max(0, base - 1000);
  }
  return undefined;
}

export function effectivePreviousOrBefore(nowMs: number, offsetMs: number, rawPrevious: RawLookup): number | undefined {
  timestamp(nowMs); staggerMs('cron', '', offsetMs);
  const previous = effectivePrevious(nowMs, offsetMs, rawPrevious);
  if (bounded(nowMs + 1000) === undefined) return previous;
  const boundary = effectivePrevious(nowMs + 1000, offsetMs, rawPrevious);
  return boundary !== undefined && boundary <= nowMs && (previous === undefined || boundary > previous) ? boundary : previous;
}
