// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cron } from 'croner';
import * as e from '../../src/cron/schedule/engine.ts';
import { decideDue } from '../../src/cron/schedule/decisions.ts';

const fixtures = JSON.parse(readFileSync(new URL('./expected-fixtures.json', import.meta.url)));
const ms = value => value == null ? undefined : Date.parse(value);
for (const fixture of fixtures.verbatim) test(`R8 verbatim: ${fixture.label}`, () => {
  const { timezone, expression, now, next, previous, forcedPastCalls, prior } = fixture;
  const schedule = e.cron(expression, timezone, 'fixture', undefined, true);
  const originalNext = Cron.prototype.nextRun;
  let calls = 0;
  if (forcedPastCalls) Cron.prototype.nextRun = function (...args) {
    return calls++ < forcedPastCalls ? new Date(prior) : originalNext.apply(this, args);
  };
  try {
    assert.equal(e.next(schedule, Date.parse(now)), ms(next));
    if ('previous' in fixture) assert.equal(e.previousOrBefore(schedule, Date.parse(now)), ms(previous));
    if (forcedPastCalls) assert.ok(calls > forcedPastCalls);
  } finally { Cron.prototype.nextRun = originalNext; }
});

for (const fixture of fixtures.generated) test(`pinned generated: ${fixture.label}`, () => {
  const schedule = e.cron(fixture.schedule.expr, fixture.schedule.tz, 'fixture', undefined, true);
  assert.equal(e.next(schedule, Date.parse(fixture.now)), ms(fixture.next));
  assert.equal(e.rawPrevious(fixture.schedule, Date.parse(fixture.now)), ms(fixture.previous));
  assert.equal(e.previousOrBefore(schedule, Date.parse(fixture.now)), ms(fixture.previousOrBefore));
});

for (const [index, fixture] of fixtures.staggered.entries()) test(`pinned effective ${index}: ${fixture.label}`, () => {
  const { schedule: raw, jobId, now, resolvedWidth, offset, next, previousOrBefore } = fixture;
  const schedule = e.cron(raw.expr, raw.tz, jobId, raw.staggerMs);
  assert.equal(schedule.staggerMs, resolvedWidth);
  assert.equal(e.stableOffsetMs(jobId, schedule.staggerMs), offset);
  assert.equal(e.next(schedule, Date.parse(now)), ms(next));
  assert.equal(e.previousOrBefore(schedule, Date.parse(now)), ms(previousOrBefore));
});

for (const [index, fixture] of fixtures.every.entries()) test(`pinned every transition ${index}`, () => {
  const schedule = e.every(fixture.schedule.everyMs, fixture.schedule.anchorMs);
  assert.equal(e.next(schedule, Date.parse(fixture.now)), ms(fixture.next));
});

test('cron recovery uses effective slot for activation, watermark and occurrence identity', () => {
  const raw = Date.parse('2026-10-13T10:00:00Z');
  const slot = raw + 253353;
  const schedule = e.cron('0 * * * *', 'UTC', 'j7f3k2q');
  assert.equal(e.dueAt(schedule, slot - 1, raw + 1, null), undefined);
  assert.equal(e.dueAt(schedule, slot, raw + 1, null), slot);
  assert.equal(e.dueAt(schedule, slot + 1, raw + 1, slot), undefined);
  assert.equal(e.dueAt(schedule, slot, slot + 1, null), undefined);
  assert.equal(e.occurrenceId(schedule.jobId, 2, e.dueAt(schedule, slot, raw + 1, null)), JSON.stringify(['j7f3k2q', 2, slot]));
  assert.equal(decideDue({ enabled: true, recurring: true, nowMs: slot,
    slotMs: e.previousOrBefore(schedule, slot), activatedAtMs: raw + 1,
    watermark: null, backoffUntilMs: null, active: 'none' }), 'admit');
});

test('cron default/exact widths are resolved in the definition and exact next is strict', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  for (const expr of ['0 * * * *', '0 0 * * * *']) {
    assert.equal(e.cron(expr, 'UTC', 'j7f3k2q').staggerMs, 300000);
    const exact = e.cron(expr, 'UTC', 'j7f3k2q', undefined, true);
    assert.equal(exact.staggerMs, 0);
    assert.equal(e.previousOrBefore(exact, now), now);
    assert.equal(e.next(exact, now), now + 3600000);
  }
  assert.equal(e.cron('0 9 * * *', 'UTC', 'j7f3k2q').staggerMs, 0);
  assert.equal(e.cron('0 * * * *', 'UTC', 'j7f3k2q', 1).staggerMs, 1);
});

test('offsetless at is interpreted in job timezone and echoes an explicit offset', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  for (const [input, tz, expected] of [
    ['2026-10-13T18:00:00.123', 'Asia/Shanghai', '2026-10-13T18:00:00.123+08:00'],
    ['2026-10-13T06:00:00.123', 'America/New_York', '2026-10-13T06:00:00.123-04:00'],
    ['2026-10-13T10:00:00.123', 'UTC', '2026-10-13T10:00:00.123+00:00'],
    ['2026-10-13T10:00:00.123Z', 'Asia/Shanghai', '2026-10-13T18:00:00.123+08:00'],
  ]) {
    const normalized = e.normalizeAt(input, tz, now);
    assert.equal(normalized.iso, expected);
    assert.equal(normalized.schedule.atMs, now + 123);
    assert.equal(Date.parse(normalized.iso), normalized.schedule.atMs);
  }
});

test('offsetless at rejects DST gaps and ambiguous folds; explicit offsets identify either fold instant', () => {
  for (const [input, tz, now] of [
    ['2026-03-08T02:30:00', 'America/New_York', '2026-03-07T00:00:00Z'],
    ['2026-11-01T01:30:00', 'America/New_York', '2026-10-31T00:00:00Z'],
    ['2026-04-05T01:45:00', 'Australia/Lord_Howe', '2026-04-03T00:00:00Z'],
  ]) assert.throws(() => e.parseAt(input, tz, Date.parse(now)), /Invalid or ambiguous/);
  const now = Date.parse('2026-10-31T00:00:00Z');
  for (const [offset, expected] of [['-04:00', '2026-11-01T05:30:00Z'], ['-05:00', '2026-11-01T06:30:00Z']]) {
    assert.equal(e.parseAt('2026-11-01T01:30:00' + offset, 'America/New_York', now).atMs, Date.parse(expected));
  }
});

test('invalid cron definitions fail finitely without host timezone or dependency fallback', () => {
  for (const expr of ['', 'nonsense', '61 * * * *', '* * *', '0 0 12 * * * * *']) {
    assert.throws(() => e.cron(expr, 'UTC', 'job'), RangeError);
  }
  for (const tz of ['', '+08:00', 'Invalid/Nowhere']) assert.throws(() => e.cron('0 * * * *', tz, 'job'), RangeError);
  for (const width of [-1, 300001, 0.5, NaN, Infinity]) assert.throws(() => e.cron('0 * * * *', 'UTC', 'job', width), RangeError);
  assert.throws(() => e.cron('0 * * * *', 'UTC', ''), RangeError);
  assert.throws(() => e.next({ kind: 'cron', expr: '0 * * * *', tz: 'UTC', jobId: 'job' }, 0), RangeError);
});

test('cron epoch boundary stays within the accepted nonnegative timestamp domain', () => {
  const schedule = e.cron('* * * * * *', 'UTC', 'job', 0);
  assert.equal(e.previousOrBefore(schedule, 0), 0);
  assert.equal(e.next(schedule, 0), 1000);
});

test('cron calls are repeatable with frozen definitions and reversed explicit clocks', () => {
  const schedule = Object.freeze(e.cron('30 1 * * *', 'Europe/London', 'j7f3k2q', 300000));
  const clocks = ['2026-10-25T00:15:00Z', '2026-10-25T01:15:00Z', '2026-10-26T00:15:00Z'].map(Date.parse);
  const before = JSON.stringify(schedule);
  const evaluate = now => [e.next(schedule, now), e.previousOrBefore(schedule, now)];
  const first = clocks.map(evaluate);
  assert.deepEqual([...clocks].reverse().map(evaluate).reverse(), first);
  assert.equal(JSON.stringify(schedule), before);
});

test('rawNext and rawPrevious narrow on-exit and stream event triggers to undefined before cron resolution', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  for (const kind of ['on-exit', 'stream']) {
    assert.equal(e.rawNext({ kind }, now), undefined);
    assert.equal(e.rawPrevious({ kind }, now), undefined);
  }
  assert.equal(e.rawNext({ kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, now), now + 3600000);
  assert.equal(e.rawPrevious({ kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, now), now - 3600000);
});
