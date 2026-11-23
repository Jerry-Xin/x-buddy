// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as e from '../../src/cron/schedule/engine.ts';
import * as p from '../../src/cron/schedule/decisions.ts';

const now = Date.parse('2026-10-13T10:00:00Z');
const baseDue = Object.freeze({ enabled: true, recurring: true, nowMs: 200000,
  slotMs: 100000, activatedAtMs: 0, watermark: null, backoffUntilMs: null, active: 'none' });
const baseOutcome = Object.freeze({ recurring: true, currentGeneration: 7, runGeneration: 7,
  ownership: 'consume', attempt: 0, endMs: 20000, naturalNextMs: 400000,
  errors: 0, skipped: 4, targetFailures: 0, deleteAfterRun: false, result: 'ok' });
const outcome = (changes = {}) => p.decideOutcome(Object.freeze({ ...baseOutcome, ...changes }));
const stateValue = (decision, input, key) => decision[key] ?? input[key];

test('AT-01: inclusive grace and ten-year caps; reject just outside and invalid numeric classes', () => {
  for (const at of [now - 60000, now, now + e.TEN_YEARS_MS])
    assert.deepEqual(e.validateAt(at, now), { kind: 'at', atMs: at });
  for (const at of [now - 60001, now + e.TEN_YEARS_MS + 1, NaN, Infinity, -1, now + 0.5])
    assert.throws(() => e.validateAt(at, now), `at=${at}`);
});

test('AT-02: timezone and explicit-offset parsing identify known UTC instants', () => {
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    assert.equal(e.validateTimezone(tz), tz);
    assert.equal(e.parseAt('2026-10-13T18:30:00+08:00', tz, now).atMs, now + 1800000);
  }
  assert.equal(e.parseAt('2026-10-13T10:30:00', 'UTC', now).atMs, now + 1800000);
  for (const tz of ['', 'Invalid/Zone']) assert.throws(() => e.validateTimezone(tz));
  assert.throws(() => e.parseAt('not-a-date', 'UTC', now));
  assert.throws(() => e.parseAt('2026-10-13T10:30:00', 'Asia/Shanghai', now));
});

test('AT-03: strict next and inclusive previous preserve overdue one-shot eligibility', () => {
  const s = e.validateAt(now, now);
  assert.equal(e.next(s, now - 1), now);
  assert.equal(e.next(s, now), undefined);
  assert.equal(e.previousOrBefore(s, now - 1), undefined);
  assert.equal(e.previousOrBefore(s, now), now);
  assert.equal(e.dueAt(s, now + 500000, now - 1, null), now);
  assert.equal(e.dueAt(s, now + 500000, now - 1, now), undefined);
  assert.equal(e.dueAt(s, now + 500000, now + 1, null), undefined);
});

test('AT-04: timestamp integer/date domain rejects invalid classes', () => {
  for (const x of [0, 1, e.MAX_DATE_MS]) assert.equal(e.timestamp(x), x);
  for (const x of [-1, 0.1, NaN, Infinity, e.MAX_DATE_MS + 1]) assert.throws(() => e.timestamp(x));
});

test('EVERY-01: independently enumerated anchor oracle gives strict next/inclusive previous', () => {
  for (const anchor of [0, 17, 120001]) for (const interval of [1, 7, 60000]) {
    const s = e.every(interval, anchor);
    const slots = Array.from({ length: 20 }, (_, k) => anchor + k * interval);
    for (const clock of [Math.max(0, anchor - 1), anchor, anchor + interval - 1, anchor + interval, anchor + 9 * interval + 1]) {
      assert.equal(e.next(s, clock), slots.find(x => x > clock));
      assert.equal(e.previousOrBefore(s, clock), slots.filter(x => x <= clock).at(-1));
    }
  }
});

test('EVERY-02: UTC every arithmetic stays unchanged across transition-period clocks', () => {
  const a = Date.parse('2026-11-01T04:30:00Z');
  const s = e.every(3600000, a);
  for (let k = 0; k < 5; k++) {
    assert.equal(e.next(s, a + k * 3600000), a + (k + 1) * 3600000);
    assert.equal(e.previousOrBefore(s, a + k * 3600000), a + k * 3600000);
  }
});

test('EVERY-03: invalid interval and anchor classes reject', () => {
  for (const n of [0, -1, NaN, Infinity, 0.5]) assert.throws(() => e.every(n, 0));
  for (const a of [-1, NaN, Infinity, 0.5]) assert.throws(() => e.every(60000, a));
});

test('ID-01: occurrence IDs use canonical JSON including escaped job and current generation', () => {
  const job = 'job:"\\雪';
  assert.equal(e.occurrenceId(job, 7, now), JSON.stringify([job, 7, now]));
  assert.notEqual(e.occurrenceId(job, 7, now), e.occurrenceId(job, 8, now));
});

test('STAG-01: recurring-hour defaults, fixed daily, exact and explicit bounds', () => {
  assert.equal(e.defaultStaggerMs('0 * * * *'), 300000);
  assert.equal(e.defaultStaggerMs('0 0 * * * *'), 300000);
  assert.equal(e.defaultStaggerMs('0 9 * * *'), 0);
  assert.equal(e.staggerMs('cron', '0 * * * *', undefined, true), 0);
  for (const w of [0, 1, 300000]) assert.equal(e.staggerMs('cron', '0 * * * *', w), w);
  for (const w of [-1, 300001, 0.5, NaN, Infinity]) assert.throws(() => e.staggerMs('cron', '', w));
  for (const kind of ['at', 'every']) assert.throws(() => e.staggerMs(kind, '', 1));
});

test('STAG-02: published 253353-ms hash vector repeats and width 0/1 has zero offset', () => {
  for (let k = 0; k < 10; k++) assert.equal(e.stableOffsetMs('j7f3k2q', 300000), 253353);
  for (const w of [0, 1]) assert.equal(e.stableOffsetMs('j7f3k2q', w), 0);
});

const rawSlots = [now - 3600000, now, now + 3600000, now + 7200000];
const rawNext = cursor => rawSlots.find(x => x > cursor);
const rawPrevious = cursor => rawSlots.filter(x => x < cursor).at(-1);
const shifted = now + 253353;
test('STAG-03: synthetic UTC shifted boundary is next strict and previous inclusive', () => {
  for (const delta of [-1, 0, 1]) {
    assert.equal(e.effectiveNext(shifted + delta, 253353, rawNext), delta < 0 ? shifted : shifted + 3600000);
    assert.equal(e.effectivePreviousOrBefore(shifted + delta, 253353, rawPrevious), delta < 0 ? shifted - 3600000 : shifted);
  }
  assert.equal(e.effectiveNext(now, 0, rawNext), now + 3600000);
  assert.equal(e.effectivePreviousOrBefore(now, 0, rawPrevious), now);
});

test('STAG-04: effective-slot activation and watermark fences inside offset window', () => {
  const input = { ...baseDue, nowMs: shifted, slotMs: shifted, activatedAtMs: now + 1 };
  assert.equal(p.decideDue(input), 'admit');
  assert.equal(p.decideDue({ ...input, watermark: shifted }), 'ineligible');
  assert.equal(p.decideDue({ ...input, activatedAtMs: shifted + 1 }), 'ineligible');
});

test('POLICY-01: due state partitions admission, duplicate, recurring overlap and one-shot deferral', () => {
  assert.equal(p.decideDue(baseDue), 'admit');
  assert.equal(p.decideDue({ ...baseDue, active: 'same-occurrence' }), 'duplicate');
  assert.equal(p.decideDue({ ...baseDue, active: 'other-occurrence' }), 'overlap');
  assert.equal(p.decideDue({ ...baseDue, recurring: false, active: 'other-occurrence' }), 'defer-at');
});

test('POLICY-02: disabled, future, activation, watermark and backoff fences reject', () => {
  for (const changes of [{ enabled: false }, { nowMs: 99999 }, { activatedAtMs: 100001 },
    { watermark: 100000 }, { watermark: 110000 }, { backoffUntilMs: 200001 }])
    assert.equal(p.decideDue({ ...baseDue, ...changes }), 'ineligible', JSON.stringify(changes));
  assert.equal(p.decideDue({ ...baseDue, backoffUntilMs: 200000 }), 'admit');
});

test('POLICY-03: catch-up first five immediate then 5s pacing; skip applies only to recurring', () => {
  const input = { ...baseDue, skipMissedJobs: false, ordinal: 0, agentTurn: false, catchupDeferMs: 10000 };
  for (let ordinal = 0; ordinal < 8; ordinal++) {
    assert.deepEqual(p.decideCatchup({ ...input, ordinal }), { action: 'catchup', slotMs: input.slotMs,
      readyAtMs: input.nowMs + Math.max(0, ordinal - 4) * 5000 });
  }
  assert.deepEqual(p.decideCatchup({ ...input, skipMissedJobs: true }), { action: 'none' });
  assert.equal(p.decideCatchup({ ...input, skipMissedJobs: true, recurring: false }).action, 'catchup');
  assert.equal(p.decideCatchup({ ...input, agentTurn: true }).readyAtMs, input.nowMs + 10000);
});

test('POLICY-04: third schedule error disables; execution backoff ladder caps', () => {
  for (const [before, after, disable] of [[0, 1, false], [1, 2, false], [2, 3, true], [3, 4, true]])
    assert.deepEqual(p.decideScheduleError(before), { count: after, disable });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(p.backoffMs), [30000, 60000, 300000, 900000, 3600000, 3600000, 3600000]);
});

test('BUSY-01: separate admission 30s x3 preserves errors 0/9 across execution budgets 0..3', () => {
  for (const errors of [0, 9]) for (const attempt of [0, 1, 2, 3]) for (const admissionAttempt of [0, 1, 2]) {
    const input = { ...baseOutcome, result: 'session-busy', errors, attempt, admissionAttempt };
    const r = p.decideOutcome(Object.freeze(input));
    assert.equal(r.action, 'retry', JSON.stringify(input));
    assert.equal(r.admissionRetryAttempt, admissionAttempt + 1);
    assert.equal(r.nextRunAtMs, 50000);
    assert.equal(stateValue(r, input, 'errors'), errors);
    assert.equal(stateValue(r, input, 'targetFailures'), 0);
    assert.equal(r.retryAttempt, undefined);
  }
});

test('BUSY-02: admission exhaustion resumes natural cadence without execution backoff', () => {
  for (const errors of [0, 9]) for (const attempt of [0, 3]) {
    const input = { ...baseOutcome, result: 'session-busy', errors, attempt, admissionAttempt: 3, naturalNextMs: 20001 };
    const r = p.decideOutcome(input);
    assert.equal(r.action, 'schedule');
    assert.equal(r.nextRunAtMs, 20001);
    assert.equal(stateValue(r, input, 'errors'), errors);
    assert.equal(r.admissionRetryAttempt, undefined);
  }
});

test('BUSY-03: next natural slot outranks equal/later busy retry and one-shot exhaustion stays terminal', () => {
  for (const naturalNextMs of [49999, 50000]) {
    const r = outcome({ result: 'session-busy', errors: 9, naturalNextMs });
    assert.equal(r.action, 'schedule'); assert.equal(r.nextRunAtMs, naturalNextMs); assert.equal(r.errors ?? 9, 9);
  }
  assert.equal(outcome({ result: 'session-busy', naturalNextMs: 50001 }).action, 'retry');
  const terminal = outcome({ recurring: false, naturalNextMs: null, result: 'session-busy', admissionAttempt: 3, errors: 9 });
  assert.equal(terminal.action, 'disable'); assert.equal(terminal.reason, 'terminal-one-shot');
  assert.equal(terminal.errors ?? 9, 9);
});

test('EXEC-01: execution retry ladder and errors are independent of admission budget', () => {
  for (const [attempt, delay] of [[0, 30000], [1, 60000], [2, 300000]]) {
    const r = outcome({ result: 'transient', attempt, admissionAttempt: 3, naturalNextMs: 1000000 });
    assert.equal(r.action, 'retry'); assert.equal(r.retryAttempt, attempt + 1);
    assert.equal(r.nextRunAtMs, 20000 + delay); assert.equal(r.errors, 1);
    assert.equal(r.admissionRetryAttempt, undefined);
  }
});

test('EXEC-02: exhausted retry and equality use max natural slot/backoff', () => {
  for (const changes of [{ attempt: 3, naturalNextMs: 20001 }, { attempt: 0, naturalNextMs: 50000 }]) {
    const r = outcome({ result: 'transient', ...changes });
    assert.equal(r.action, 'schedule'); assert.equal(r.nextRunAtMs, 50000); assert.equal(r.errors, 1);
  }
  assert.equal(outcome({ result: 'transient', attempt: 3, naturalNextMs: 400000 }).nextRunAtMs, 400000);
});

test('EXEC-03: tenth execution error disables, one-shot permanent/exhausted remains kept terminal', () => {
  const tenth = outcome({ result: 'transient', errors: 9 });
  assert.equal(tenth.action, 'disable'); assert.equal(tenth.errors, 10); assert.equal(tenth.reason, 'consecutive-errors');
  for (const changes of [{ result: 'permanent' }, { result: 'transient', attempt: 3 }]) {
    const r = outcome({ recurring: false, naturalNextMs: null, ...changes });
    assert.equal(r.action, 'disable'); assert.equal(r.reason, 'terminal-one-shot');
  }
});

test('TARGET-01: applied permanent-failure/success/permanent-failure sequence ends at fresh count 1', () => {
  let state = { ...baseOutcome, targetFailures: 0 };
  const decisions = [];
  for (const result of ['delivery-permanent', 'ok', 'delivery-permanent']) {
    const r = p.decideOutcome(Object.freeze({ ...state, result })); decisions.push(r);
    for (const key of ['errors', 'skipped', 'targetFailures']) state[key] = stateValue(r, state, key);
  }
  assert.equal(decisions[0].targetFailures, 1); assert.equal(decisions[1].targetFailures, 0);
  assert.equal(decisions[2].targetFailures, 1); assert.equal(state.targetFailures, 1);
  assert.equal(decisions[2].action, 'schedule');
});

test('TARGET-02: third permanent target failure disables with no execution increment/backoff', () => {
  const r = outcome({ result: 'delivery-permanent', targetFailures: 2, errors: 9 });
  assert.equal(r.action, 'disable'); assert.equal(r.targetFailures, 3); assert.equal(r.reason, 'target-unavailable');
  assert.equal(r.errors ?? 9, 9);
  const transient = outcome({ result: 'delivery-transient', errors: 9, naturalNextMs: 20001 });
  assert.equal(transient.action, 'schedule'); assert.equal(transient.nextRunAtMs, 20001); assert.equal(transient.errors ?? 9, 9);
});

test('TARGET-03: successful recurring/delete/keep paths reset target/error/skip counters', () => {
  for (const [recurring, deleteAfterRun, action] of [[true, false, 'schedule'], [false, true, 'delete'], [false, false, 'disable']]) {
    const r = outcome({ recurring, deleteAfterRun, errors: 9, skipped: 7, targetFailures: 2 });
    assert.equal(r.action, action); assert.equal(r.targetFailures, 0); assert.equal(r.errors, 0); assert.equal(r.skipped, 0);
  }
});

test('FENCE-01: borrowed/none/stale outcomes preserve authored state for every result class', () => {
  for (const changes of [{ ownership: 'borrow' }, { ownership: 'none' }, { runGeneration: 6 }])
    for (const result of ['ok', 'transient', 'session-busy', 'permanent', 'delivery-transient', 'delivery-permanent', 'interrupted'])
      assert.deepEqual(outcome({ ...changes, result, errors: 9, skipped: 7, targetFailures: 2, attempt: 3, admissionAttempt: 3 }), { action: 'unchanged' });
});

test('PURE-01: frozen input and repeated fake-clock calls are deterministic', () => {
  const input = Object.freeze({ ...baseOutcome, result: 'session-busy', errors: 9 });
  const snapshot = JSON.stringify(input); const expected = p.decideOutcome(input);
  for (let k = 0; k < 30; k++) assert.deepEqual(p.decideOutcome(input), expected);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(p.decideDue(Object.freeze({ ...baseDue, nowMs: 99999 })), 'ineligible');
  assert.equal(p.decideDue(baseDue), 'admit');
});

test('PURE-02: invalid admission counter classes are rejected', () => {
  for (const admissionAttempt of [-1, 0.5, 4, NaN, Infinity])
    assert.throws(() => outcome({ result: 'session-busy', admissionAttempt }));
});
