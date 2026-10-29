// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDue, backoffMs, decideOutcome, decideCatchup, decideScheduleError } from '../../src/cron/schedule/decisions.ts';
import { every, dueAt, occurrenceId, stableOffsetMs, effectivePreviousOrBefore } from '../../src/cron/schedule/engine.ts';

const due = Object.freeze({ enabled: true, recurring: true, nowMs: 20_000, slotMs: 10_000, activatedAtMs: 0, watermark: null, backoffUntilMs: null, active: 'none' });
const outcome = Object.freeze({ recurring: true, currentGeneration: 2, runGeneration: 2, ownership: 'consume', attempt: 0, endMs: 20_000, naturalNextMs: 400_000, errors: 0, skipped: 4, targetFailures: 0, deleteAfterRun: true, result: 'ok' });

test('R8 rows 1/2/3 and one-shot boundary select pure admission intentions', () => {
  assert.equal(decideDue(due), 'admit');
  assert.equal(decideDue({ ...due, active: 'same-occurrence' }), 'duplicate');
  assert.equal(decideDue({ ...due, active: 'same-occurrence', watermark: 15_000 }), 'duplicate');
  assert.equal(decideDue({ ...due, active: 'other-occurrence' }), 'overlap');
  assert.equal(decideDue({ ...due, recurring: false, active: 'other-occurrence' }), 'defer-at');
  for (const patch of [{ enabled: false }, { slotMs: 20_001 }, { activatedAtMs: 10_001 }, { watermark: 10_000 }, { backoffUntilMs: 20_001 }]) assert.equal(decideDue({ ...due, ...patch }), 'ineligible');
});

test('R8 row 4/10: recurring success resets errors/skips; authored at deletes or stays disabled', () => {
  assert.deepEqual(decideOutcome(outcome), { action: 'schedule', nextRunAtMs: 400_000, errors: 0, skipped: 0 });
  assert.equal(decideOutcome({ ...outcome, recurring: false }).action, 'delete');
  assert.equal(decideOutcome({ ...outcome, recurring: false, deleteAfterRun: false }).action, 'disable');
});

test('R8 rows 5/6: retries keep natural recurrence separate and exhaust at equality', () => {
  for (const [attempt, delay] of [[0, 30_000], [1, 60_000], [2, 300_000]]) {
    assert.deepEqual(decideOutcome({ ...outcome, result: 'transient', attempt }), { action: 'retry', retryAttempt: attempt + 1, nextRunAtMs: 20_000 + delay, errors: 1 });
    assert.equal(decideOutcome({ ...outcome, result: 'session-busy', attempt }).nextRunAtMs, 50_000);
  }
  assert.deepEqual(decideOutcome({ ...outcome, result: 'transient', naturalNextMs: 50_000 }), { action: 'schedule', nextRunAtMs: 50_000, errors: 1 });
  assert.equal(decideOutcome({ ...outcome, result: 'transient', attempt: 3 }).action, 'schedule');
});

test('R8 rows 6/7/8: backoff ladder caps; ten consecutive execution errors disable', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 99].map(backoffMs), [30_000, 60_000, 300_000, 900_000, 3600_000, 3600_000]);
  assert.deepEqual(decideOutcome({ ...outcome, result: 'permanent', errors: 3 }), { action: 'schedule', nextRunAtMs: 920_000, errors: 4 });
  assert.deepEqual(decideOutcome({ ...outcome, result: 'transient', errors: 9 }), { action: 'disable', nextRunAtMs: null, errors: 10, reason: 'consecutive-errors' });
});

test('R8 row 9: delivery-only failure never adds execution backoff or deletes a one-shot', () => {
  assert.deepEqual(decideOutcome({ ...outcome, result: 'delivery-transient', errors: 8 }), { action: 'schedule', nextRunAtMs: 400_000, targetFailures: 0 });
  assert.deepEqual(decideOutcome({ ...outcome, result: 'delivery-permanent', targetFailures: 2 }), { action: 'disable', nextRunAtMs: null, targetFailures: 3, reason: 'target-unavailable' });
  assert.equal(decideOutcome({ ...outcome, recurring: false, result: 'delivery-transient' }).action, 'disable');
});

test('R8 rows 11/12/15: consuming at retries only transient errors and never replays interruption', () => {
  assert.equal(decideOutcome({ ...outcome, recurring: false, result: 'transient' }).action, 'retry');
  for (const patch of [{ result: 'permanent' }, { result: 'transient', attempt: 3 }, { result: 'interrupted' }]) {
    assert.deepEqual(decideOutcome({ ...outcome, recurring: false, ...patch }), { action: 'disable', nextRunAtMs: null, errors: 1, reason: 'terminal-one-shot' });
  }
  assert.equal(decideOutcome({ ...outcome, result: 'interrupted' }).nextRunAtMs, 400_000);
});

test('R8 row 19 / manual borrow: stale or borrowed results preserve authored state', () => {
  for (const result of ['ok', 'transient', 'permanent', 'delivery-permanent', 'interrupted']) {
    for (const patch of [{ runGeneration: 1 }, { ownership: 'borrow' }, { ownership: 'none' }]) assert.deepEqual(decideOutcome({ ...outcome, result, ...patch }), { action: 'unchanged' });
  }
  assert.equal(outcome.errors, 0); assert.equal(due.watermark, null);
});

test('R8 rows 13/14/18: single latest catchup, five immediate, paced overflow, at ignores skip flag', () => {
  const base = { ...due, skipMissedJobs: false, ordinal: 0, agentTurn: false, catchupDeferMs: 120_000 };
  for (let ordinal = 0; ordinal < 5; ordinal++) assert.deepEqual(decideCatchup({ ...base, ordinal }), { action: 'catchup', slotMs: 10_000, readyAtMs: 20_000 });
  assert.equal(decideCatchup({ ...base, ordinal: 5 }).readyAtMs, 25_000);
  assert.equal(decideCatchup({ ...base, ordinal: 6, agentTurn: true }).readyAtMs, 150_000);
  assert.deepEqual(decideCatchup({ ...base, skipMissedJobs: true }), { action: 'none' });
  assert.equal(decideCatchup({ ...base, skipMissedJobs: true, recurring: false }).action, 'catchup');
  assert.deepEqual(decideCatchup({ ...base, watermark: 10_000 }), { action: 'none' });
});

test('R8 row 17: backwards fake clock and pruned display receipt cannot bypass supplied watermark', () => {
  const s = every(1000, 0);
  assert.equal(dueAt(s, 10_000, 0, null), 10_000);
  for (const clock of [8000, 9000, 10_000]) assert.equal(dueAt(s, clock, 0, 10_000), undefined);
  assert.equal(dueAt(s, 11_000, 0, 10_000), 11_000);
  assert.notEqual(occurrenceId('job', 1, 10_000), occurrenceId('job', 2, 10_000));
});

test('effective restart boundary uses shifted activation and supplied watermark fences', () => {
  const base = Date.parse('2026-10-13T10:00:00Z');
  const offset = stableOffsetMs('j7f3k2q', 300_000);
  const raw = cursor => [base, base - 3600_000].find(slot => slot < cursor);
  const nowMs = base + offset;
  const slotMs = effectivePreviousOrBefore(nowMs, offset, raw);
  const input = { ...due, nowMs, slotMs, activatedAtMs: base + 1, skipMissedJobs: false, ordinal: 0, agentTurn: false, catchupDeferMs: 0 };
  assert.equal(decideCatchup(input).action, 'catchup');
  assert.equal(decideCatchup({ ...input, watermark: slotMs }).action, 'none');
  assert.equal(decideCatchup({ ...input, activatedAtMs: slotMs + 1 }).action, 'none');
});

test('three schedule failures disable by a pure decision; invalid inputs reject', () => {
  assert.deepEqual(decideScheduleError(1), { count: 2, disable: false });
  assert.deepEqual(decideScheduleError(2), { count: 3, disable: true });
  assert.throws(() => decideDue({ ...due, nowMs: NaN }), RangeError);
  assert.throws(() => decideDue({ ...due, active: 'unknown' }), RangeError);
  assert.throws(() => decideOutcome({ ...outcome, result: 'unknown' }), RangeError);
  assert.throws(() => decideOutcome({ ...outcome, currentGeneration: 0 }), RangeError);
  assert.throws(() => decideOutcome({ ...outcome, attempt: 4 }), RangeError);
  assert.throws(() => decideOutcome({ ...outcome, naturalNextMs: 20_000 }), RangeError);
  assert.throws(() => decideScheduleError(-1), RangeError);
});
