// SPDX-License-Identifier: Apache-2.0
// R8 scheduling policy intentions only. Callers must validate and atomically
// fence receipts/definitions in the future store; these functions perform no effects.
export type DueInput = Readonly<{
  enabled: boolean;
  recurring: boolean;
  nowMs: number;
  slotMs: number;
  activatedAtMs: number;
  watermark: number | null;
  backoffUntilMs: number | null;
  active: 'none' | 'same-occurrence' | 'other-occurrence';
}>;

function ms(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new RangeError('Invalid milliseconds');
  return value;
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid counter');
  return value;
}

export function decideDue(input: DueInput): 'ineligible' | 'duplicate' | 'admit' | 'overlap' | 'defer-at' {
  const { enabled, recurring, nowMs, slotMs, activatedAtMs, watermark, backoffUntilMs, active } = input;
  if (typeof enabled !== 'boolean' || typeof recurring !== 'boolean' || !['none', 'same-occurrence', 'other-occurrence'].includes(active)) throw new RangeError('Invalid due state');
  [nowMs, slotMs, activatedAtMs].forEach(ms);
  if (watermark !== null) ms(watermark);
  if (backoffUntilMs !== null) ms(backoffUntilMs);
  // Caller has already validated this stored receipt's immutable provenance.
  // A reserved lower slot is not a new base admission against a later watermark.
  if (active === 'same-occurrence') return 'duplicate';
  if (!enabled || slotMs > nowMs || slotMs < activatedAtMs || (watermark !== null && slotMs <= watermark)
    || (backoffUntilMs !== null && nowMs < backoffUntilMs)) return 'ineligible';
  if (active === 'other-occurrence') return recurring ? 'overlap' : 'defer-at';
  return 'admit';
}

export function backoffMs(errors: number): number {
  count(errors);
  return [30_000, 60_000, 300_000, 900_000, 3_600_000][Math.max(0, Math.min(errors - 1, 4))]!;
}

export type OutcomeInput = Readonly<{
  recurring: boolean;
  currentGeneration: number;
  runGeneration: number;
  ownership: 'consume' | 'borrow' | 'none';
  // Admission retries have a separate budget from execution quick retries.
  admissionAttempt?: number;
  attempt: number;
  endMs: number;
  naturalNextMs: number | null;
  errors: number;
  skipped: number;
  targetFailures: number;
  deleteAfterRun: boolean;
  result: 'ok' | 'transient' | 'session-busy' | 'permanent' | 'delivery-transient' | 'delivery-permanent' | 'interrupted';
}>;
export type OutcomeDecision = Readonly<{
  action: 'unchanged' | 'schedule' | 'retry' | 'disable' | 'delete';
  nextRunAtMs?: number | null;
  retryAttempt?: number;
  admissionRetryAttempt?: number;
  errors?: number;
  skipped?: number;
  targetFailures?: number;
  reason?: 'consecutive-errors' | 'target-unavailable' | 'terminal-one-shot';
}>;

/** naturalNextMs must be the effective natural slot strictly after max(now, authored slot). */
export function decideOutcome(input: OutcomeInput): OutcomeDecision {
  const i = input;
  ms(i.endMs); [i.errors, i.skipped, i.targetFailures, i.currentGeneration, i.runGeneration].forEach(count);
  if (i.currentGeneration < 1 || i.runGeneration < 1 || !['consume', 'borrow', 'none'].includes(i.ownership)
    || !['ok', 'transient', 'session-busy', 'permanent', 'delivery-transient', 'delivery-permanent', 'interrupted'].includes(i.result)
    || typeof i.recurring !== 'boolean' || typeof i.deleteAfterRun !== 'boolean') throw new RangeError('Invalid outcome state');
  if (!Number.isInteger(i.attempt) || i.attempt < 0 || i.attempt > 3) throw new RangeError('Invalid retry attempt');
  if (i.admissionAttempt !== undefined && (!Number.isInteger(i.admissionAttempt) || i.admissionAttempt < 0 || i.admissionAttempt > 3)) throw new RangeError('Invalid admission retry attempt');
  if (i.naturalNextMs !== null && ms(i.naturalNextMs) <= i.endMs) throw new RangeError('Natural next must be after completion');
  if (i.currentGeneration !== i.runGeneration || i.ownership !== 'consume') return { action: 'unchanged' };
  if (i.result === 'ok') {
    return i.recurring ? { action: 'schedule', nextRunAtMs: i.naturalNextMs, errors: 0, skipped: 0, targetFailures: 0 }
      : { action: i.deleteAfterRun ? 'delete' : 'disable', nextRunAtMs: null, errors: 0, skipped: 0, targetFailures: 0 };
  }
  if (i.result === 'delivery-transient' || i.result === 'delivery-permanent') {
    const targetFailures = i.targetFailures + (i.result === 'delivery-permanent' ? 1 : 0);
    if (targetFailures >= 3) return { action: 'disable', nextRunAtMs: null, targetFailures, reason: 'target-unavailable' };
    return i.recurring ? { action: 'schedule', nextRunAtMs: i.naturalNextMs, targetFailures }
      : { action: 'disable', nextRunAtMs: null, targetFailures, reason: 'terminal-one-shot' };
  }
  if (i.result === 'session-busy') {
    const admissionAttempt = i.admissionAttempt ?? 0;
    if (admissionAttempt < 3) {
      const retryAt = ms(i.endMs + 30_000);
      if (!i.recurring || (i.naturalNextMs !== null && retryAt < i.naturalNextMs)) {
        return { action: 'retry', admissionRetryAttempt: admissionAttempt + 1, nextRunAtMs: retryAt, errors: i.errors };
      }
    }
    // A skipped admission never adds an execution error or execution backoff.
    return i.recurring ? { action: 'schedule', nextRunAtMs: i.naturalNextMs, errors: i.errors }
      : { action: 'disable', nextRunAtMs: null, errors: i.errors, reason: 'terminal-one-shot' };
  }
  const errors = count(i.errors + 1);
  if (i.recurring && errors >= 10) return { action: 'disable', nextRunAtMs: null, errors, reason: 'consecutive-errors' };
  if (i.result === 'transient' && i.attempt < 3) {
    const delay = [30_000, 60_000, 300_000][i.attempt]!;
    const retryAt = ms(i.endMs + delay);
    if (!i.recurring || (i.naturalNextMs !== null && retryAt < i.naturalNextMs)) {
      return { action: 'retry', retryAttempt: i.attempt + 1, nextRunAtMs: retryAt, errors };
    }
  }
  if (!i.recurring) return { action: 'disable', nextRunAtMs: null, errors, reason: 'terminal-one-shot' };
  return { action: 'schedule', nextRunAtMs: i.naturalNextMs === null ? null : Math.max(i.naturalNextMs, ms(i.endMs + backoffMs(errors))), errors };
}

/** Candidate is the single latest effective occurrence, never a list of missed slots. */
export function decideCatchup(input: DueInput & Readonly<{
  skipMissedJobs: boolean; ordinal: number; agentTurn: boolean; catchupDeferMs: number;
}>): Readonly<{ action: 'none' } | { action: 'catchup'; slotMs: number; readyAtMs: number }> {
  count(input.ordinal); ms(input.catchupDeferMs);
  if ((input.recurring && input.skipMissedJobs) || decideDue(input) !== 'admit') return { action: 'none' };
  const pace = Math.max(0, input.ordinal - 4) * 5000;
  return { action: 'catchup', slotMs: input.slotMs, readyAtMs: ms(input.nowMs + pace + (input.agentTurn ? input.catchupDeferMs : 0)) };
}

export function decideScheduleError(previousErrors: number): Readonly<{ count: number; disable: boolean }> {
  const errors = count(count(previousErrors) + 1);
  return { count: errors, disable: errors >= 3 };
}
