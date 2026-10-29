// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  MAX_DATE_MS, TEN_YEARS_MS, validateAt, parseAt, validateTimezone, every,
  next, previousOrBefore, dueAt, occurrenceId, defaultStaggerMs, staggerMs,
  stableOffsetMs, effectiveNext, effectivePreviousOrBefore,
} from '../../src/cron/schedule/engine.ts';

const now = Date.parse('2026-10-13T10:00:00Z');

test('at validation includes exact grace and ten-year boundaries', () => {
  for (const at of [now - 60_000, now, now + TEN_YEARS_MS]) assert.deepEqual(validateAt(at, now), { kind: 'at', atMs: at });
  for (const at of [now - 60_001, now + TEN_YEARS_MS + 1, NaN, Infinity, -1, 1.5, MAX_DATE_MS + 1]) assert.throws(() => validateAt(at, now), RangeError);
  assert.throws(() => validateAt(now, NaN), RangeError);
});

test('known UTC and explicit-offset times normalize to the same instant without host timezone', () => {
  for (const [input, zone] of [
    ['2026-10-13T10:00:00', 'UTC'],
    ['2026-10-13T10:00:00Z', 'Asia/Shanghai'],
    ['2026-10-13T18:00:00+08:00', 'Asia/Shanghai'],
    ['2026-10-13T06:00:00-04:00', 'America/New_York'],
  ]) assert.deepEqual(parseAt(input, zone, now), { kind: 'at', atMs: now });
  assert.equal(parseAt('2026-10-13T10:00:00.1Z', 'UTC', now).atMs, now + 100);
  assert.equal(validateTimezone('Etc/UTC'), 'UTC');
  assert.throws(() => parseAt('2026-10-13T18:00:00', 'Asia/Shanghai', now), /Pending integration/);
});

test('invalid dates, offset syntax, timezones and implicit local dates are rejected', () => {
  for (const input of ['2026-02-30T10:00:00Z', '2026-10-13T24:00:00Z', '2026-10-13', 'today', '2026-10-13T10:00:00+25:00', '2026-10-13T10:00:60Z']) {
    assert.throws(() => parseAt(input, 'UTC', now), RangeError);
  }
  for (const zone of ['', 'Invalid/Nowhere', '+08:00']) assert.throws(() => validateTimezone(zone), RangeError);
});

test('at strict next and inclusive previous preserve overdue eligibility until consumed', () => {
  const s = validateAt(now, now);
  assert.equal(next(s, now - 1), now);
  assert.equal(next(s, now), undefined);
  assert.equal(previousOrBefore(s, now - 1), undefined);
  assert.equal(previousOrBefore(s, now), now);
  assert.equal(dueAt(s, now + 1000, now - 60_000, null), now);
  assert.equal(dueAt(s, now + 1000, now - 60_000, now), undefined);
});

test('every uses a fixed explicit anchor and strict/inclusive boundaries', () => {
  const s = every(1000, now);
  assert.equal(next(s, now - 1), now);
  assert.equal(previousOrBefore(s, now - 1), undefined);
  assert.equal(next(s, now), now + 1000);
  assert.equal(previousOrBefore(s, now), now);
  assert.equal(next(s, now + 1001), now + 2000);
  assert.equal(previousOrBefore(s, now + 1001), now + 1000);
});

test('every is monotonic and repeatable across forward/backward fake-clock inputs', () => {
  const s = every(997, now);
  const values = Array.from({ length: 500 }, (_, n) => now - 100 + n * 19);
  const first = values.map(t => [next(s, t), previousOrBefore(s, t)]);
  assert.deepEqual(values.map(t => [next(s, t), previousOrBefore(s, t)]), first);
  assert.deepEqual([...values].reverse().map(t => [next(s, t), previousOrBefore(s, t)]).reverse(), first);
  for (let n = 1; n < first.length; n++) {
    assert.ok(first[n][0] >= first[n - 1][0]);
    assert.ok(first[n][0] > values[n]);
    if (first[n][1] !== undefined) assert.ok(first[n][1] <= values[n]);
  }
});

test('every remains UTC arithmetic across a timezone transition', () => {
  const anchor = Date.parse('2026-03-08T06:30:00Z');
  const s = every(3600_000, anchor);
  assert.equal(next(s, anchor), Date.parse('2026-03-08T07:30:00Z'));
  assert.equal(next(s, anchor + 3600_000), Date.parse('2026-03-08T08:30:00Z'));
});

test('schedule bounds and activation/watermark fences fail closed', () => {
  for (const [interval, anchor] of [[0, now], [-1, now], [0.1, now], [Infinity, now], [1, NaN], [1, -1]]) assert.throws(() => every(interval, anchor), RangeError);
  const s = every(1000, now);
  assert.equal(dueAt(s, now + 2000, now + 2001, null), undefined);
  assert.equal(dueAt(s, now + 2000, now, now + 2000), undefined);
  assert.equal(dueAt(s, now + 2000, now, now + 1000), now + 2000);
  assert.equal(next(every(1, MAX_DATE_MS), MAX_DATE_MS), undefined);
  assert.equal(previousOrBefore(every(1, MAX_DATE_MS), MAX_DATE_MS), MAX_DATE_MS);
  assert.throws(() => next({ kind: 'every', everyMs: 0, anchorMs: now }, now), RangeError);
});

test('canonical IDs distinguish generations and escape job IDs without trigger identity', () => {
  assert.equal(occurrenceId('j7f3k2q', 1, now), JSON.stringify(['j7f3k2q', 1, now]));
  assert.notEqual(occurrenceId('j7f3k2q', 1, now), occurrenceId('j7f3k2q', 2, now));
  assert.deepEqual(JSON.parse(occurrenceId('job"\\日本', 3, now)), ['job"\\日本', 3, now]);
  for (const args of [['', 1, now], ['job', 0, now], ['job', 1.5, now], ['job', 1, NaN]]) assert.throws(() => occurrenceId(...args), RangeError);
});

const corpus = JSON.parse(readFileSync(new URL('./stagger-corpus.json', import.meta.url)));
for (const [expr, width] of corpus.cases) test(`pinned OC default corpus: ${expr}`, () => assert.equal(defaultStaggerMs(expr), width));

test('exact and explicit widths override defaults; at/every have no positive stagger', () => {
  assert.equal(staggerMs('cron', '0 * * * *'), 300_000);
  assert.equal(staggerMs('cron', '0 * * * *', undefined, true), 0);
  assert.equal(staggerMs('cron', '0 * * * *', 0), 0);
  assert.equal(staggerMs('cron', '0 * * * *', 30_000), 30_000);
  assert.equal(staggerMs('cron', '0 9 * * *'), 0);
  assert.equal(staggerMs('at'), 0); assert.equal(staggerMs('every'), 0);
  for (const width of [NaN, Infinity, -1, 0.1, 300_001, '300000']) assert.throws(() => stableOffsetMs('job', width), RangeError);
  assert.throws(() => staggerMs('at', '', 1), RangeError);
  assert.throws(() => staggerMs('unknown'), RangeError);
});

test('STAG arithmetic vector hashes only the first four bytes and stays stable', () => {
  assert.equal(stableOffsetMs('j7f3k2q', 300_000), 253_353);
  assert.equal(stableOffsetMs('j7f3k2q', 300_000), stableOffsetMs('j7f3k2q', 300_000));
  assert.equal(stableOffsetMs('j7f3k2q', 0), 0); assert.equal(stableOffsetMs('j7f3k2q', 1), 0);
  const digest = createHash('sha256').update('j7f3k2q').digest('hex');
  assert.notEqual(Number(BigInt(`0x${digest}`) % 300000n), 253_353);
});

// R8's explicit UTC arithmetic vector, NOT generated cron/DST fixtures.
const slots = [now - 3600_000, now, now + 3600_000, now + 7200_000];
const rawNext = t => slots.find(s => s > t);
const rawPrevious = t => [...slots].reverse().find(s => s < t);
const shifted = now + 253_353;
test('effective next/previous include exact shifted boundary and preserve strict next', () => {
  assert.equal(effectiveNext(shifted - 1, 253_353, rawNext), shifted);
  assert.equal(effectiveNext(shifted, 253_353, rawNext), shifted + 3600_000);
  assert.equal(effectivePreviousOrBefore(shifted, 253_353, rawPrevious), shifted);
  assert.equal(effectivePreviousOrBefore(shifted + 1, 253_353, rawPrevious), shifted);
  assert.equal(effectivePreviousOrBefore(shifted - 1, 253_353, rawPrevious), shifted - 3600_000);
  assert.equal(effectiveNext(now - 1, 0, rawNext), now);
  assert.equal(effectiveNext(now, 0, rawNext), now + 3600_000);
  assert.equal(effectivePreviousOrBefore(now, 0, rawPrevious), now);
});

test('effective wrappers reject invalid lookup contracts and handle exhaustion/date bounds', () => {
  assert.equal(effectiveNext(now, 1, () => undefined), undefined);
  assert.equal(effectivePreviousOrBefore(now, 1, () => undefined), undefined);
  assert.throws(() => effectiveNext(now, 0, t => t), /strict/);
  assert.throws(() => effectivePreviousOrBefore(now, 0, t => t), /strict/);
  assert.throws(() => effectiveNext(NaN, 0, rawNext), RangeError);
  assert.equal(effectiveNext(MAX_DATE_MS - 1, 2, () => MAX_DATE_MS), undefined);
  assert.equal(effectivePreviousOrBefore(MAX_DATE_MS, 0, t => t - 1), MAX_DATE_MS - 1);
});
