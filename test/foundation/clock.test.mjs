// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, isClock } from './lib/clock.mjs';

test('FakeClock exposes exactly the product Clock surface through asClock()', () => {
  const view = new FakeClock().asClock();
  assert.ok(isClock(view));
  assert.deepEqual(Object.keys(view).sort(), ['clearTimeout', 'monotonicNow', 'now', 'setTimeout']);
  assert.ok(Object.isFrozen(view));
});

test('timers fire in due order and equal deadlines keep creation order', () => {
  const clock = new FakeClock({ wallMs: 1_000, monotonicMs: 0 });
  const order = [];
  clock.setTimeout(() => order.push('b'), 20);
  clock.setTimeout(() => order.push('a1'), 10);
  clock.setTimeout(() => order.push('a2'), 10);
  assert.equal(clock.advance(15), 2);
  assert.deepEqual(order, ['a1', 'a2']);
  assert.equal(clock.now(), 1_015);
  assert.equal(clock.monotonicNow(), 15);
  clock.advance(5);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
});

test('timers scheduled by callbacks fire within the same advance when due', () => {
  const clock = new FakeClock();
  const seen = [];
  clock.setTimeout(() => { seen.push(clock.monotonicNow()); clock.setTimeout(() => seen.push(clock.monotonicNow()), 5); }, 5);
  clock.advance(10);
  assert.deepEqual(seen, [5, 10]);
});

test('clearTimeout cancels and tolerates null handles', () => {
  const clock = new FakeClock();
  let fired = false;
  const h = clock.setTimeout(() => { fired = true; }, 1);
  clock.clearTimeout(h);
  clock.clearTimeout(null);
  clock.advance(5);
  assert.equal(fired, false);
  assert.equal(clock.pendingCount(), 0);
});

test('wall-clock jumps do not move monotonic time or timer deadlines', () => {
  const clock = new FakeClock({ wallMs: Date.UTC(2026, 2, 29, 0, 59, 0), monotonicMs: 100 });
  let firedAt = null;
  clock.setTimeout(() => { firedAt = clock.monotonicNow(); }, 60_000);
  clock.jumpWall(-3_600_000);
  assert.equal(clock.monotonicNow(), 100);
  clock.advance(59_999);
  assert.equal(firedAt, null);
  clock.advance(1);
  assert.equal(firedAt, 60_100);
  assert.equal(clock.now(), Date.UTC(2026, 2, 29, 0, 0, 0));
});

test('runAll bounds self-rescheduling loops instead of hanging', () => {
  const clock = new FakeClock();
  const loop = () => clock.setTimeout(loop, 1);
  loop();
  assert.throws(() => clock.runAll({ maxTimers: 50 }), /reschedule loop/);
});

test('backwards advance and non-integer inputs are rejected', () => {
  const clock = new FakeClock();
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(1.5), TypeError);
  assert.throws(() => new FakeClock({ wallMs: Number.NaN }), TypeError);
  assert.throws(() => clock.setTimeout('not a function', 1), TypeError);
});
