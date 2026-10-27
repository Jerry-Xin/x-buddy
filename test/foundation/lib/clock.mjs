// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic `Clock` test double (R8 §10.4).
 *
 * Product code receives a `Clock` through constructor injection only; it is
 * never selectable from configuration. The structural contract is:
 *
 *   interface Clock {
 *     now(): number;              // wall clock, epoch milliseconds
 *     monotonicNow(): number;     // never decreases, unaffected by wall jumps
 *     setTimeout(fn, ms, ...args): TimerHandle;
 *     clearTimeout(handle): void;
 *   }
 *
 * `FakeClock` adds test-only controls: `advance`, `runNext`, `runAll`,
 * `jumpWall` (wall-clock jumps for DST / NTP cases) and timer inspection.
 * Timers fire in (dueMonotonic, creationOrder) order, so equal deadlines are
 * stable. Nothing here touches the real event loop.
 */

export const CLOCK_METHODS = Object.freeze(['now', 'monotonicNow', 'setTimeout', 'clearTimeout']);

/** @typedef {{ readonly id: number }} TimerHandle */

export class FakeClock {
  #wall;
  #mono;
  #seq = 0;
  /** @type {Map<number, {id:number, due:number, order:number, fn:Function, args:unknown[]}>} */
  #timers = new Map();
  #firing = false;

  /** @param {{ wallMs?: number, monotonicMs?: number }} [start] */
  constructor(start = {}) {
    const wall = start.wallMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
    const mono = start.monotonicMs ?? 0;
    assertFiniteInteger(wall, 'wallMs');
    assertFiniteInteger(mono, 'monotonicMs');
    this.#wall = wall;
    this.#mono = mono;
  }

  now() { return this.#wall; }
  monotonicNow() { return this.#mono; }

  /**
   * @param {Function} fn
   * @param {number} [ms]
   * @param {...unknown} args
   * @returns {TimerHandle}
   */
  setTimeout(fn, ms = 0, ...args) {
    if (typeof fn !== 'function') throw new TypeError('FakeClock.setTimeout requires a function');
    const delay = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
    const id = ++this.#seq;
    this.#timers.set(id, { id, due: this.#mono + delay, order: id, fn, args });
    return Object.freeze({ id });
  }

  /** @param {TimerHandle | null | undefined} handle */
  clearTimeout(handle) {
    if (handle && typeof handle.id === 'number') this.#timers.delete(handle.id);
  }

  /** Number of pending timers. */
  pendingCount() { return this.#timers.size; }

  /** Monotonic due time of the next timer, or `undefined`. */
  nextDue() {
    const next = this.#peek();
    return next ? next.due : undefined;
  }

  /**
   * Advance both clocks by `ms`, firing every timer that becomes due (including
   * timers scheduled by fired callbacks) in deterministic order.
   * @param {number} ms
   * @returns {number} timers fired
   */
  advance(ms) {
    assertFiniteInteger(ms, 'ms');
    if (ms < 0) throw new RangeError('FakeClock.advance cannot move backwards; use jumpWall for wall-clock jumps');
    const target = this.#mono + ms;
    let fired = 0;
    for (;;) {
      const next = this.#peek();
      if (!next || next.due > target) break;
      this.#step(next.due);
      this.#fire(next);
      fired++;
    }
    this.#step(target);
    return fired;
  }

  /** Fire exactly the next timer (advancing time to it). Returns false when idle. */
  runNext() {
    const next = this.#peek();
    if (!next) return false;
    this.#step(next.due);
    this.#fire(next);
    return true;
  }

  /**
   * Drain timers until none remain. A bound guards against self-rescheduling
   * loops so a broken retry ladder fails the test instead of hanging it.
   * @param {{ maxTimers?: number }} [opts]
   */
  runAll(opts = {}) {
    const max = opts.maxTimers ?? 10_000;
    let fired = 0;
    while (this.runNext()) {
      if (++fired >= max) throw new Error(`FakeClock.runAll exceeded ${max} timers; possible reschedule loop`);
    }
    return fired;
  }

  /**
   * Move only the wall clock (NTP correction, manual change, VM resume).
   * Monotonic time and timer deadlines are unaffected, as on a real host.
   * @param {number} deltaMs may be negative
   */
  jumpWall(deltaMs) {
    assertFiniteInteger(deltaMs, 'deltaMs');
    this.#wall += deltaMs;
  }

  /** Narrow view exposing only the product `Clock` surface. */
  asClock() {
    return Object.freeze({
      now: () => this.now(),
      monotonicNow: () => this.monotonicNow(),
      setTimeout: (fn, ms, ...args) => this.setTimeout(fn, ms, ...args),
      clearTimeout: (handle) => this.clearTimeout(handle),
    });
  }

  #peek() {
    let best;
    for (const t of this.#timers.values()) {
      if (!best || t.due < best.due || (t.due === best.due && t.order < best.order)) best = t;
    }
    return best;
  }

  #step(mono) {
    if (mono < this.#mono) return;
    this.#wall += mono - this.#mono;
    this.#mono = mono;
  }

  #fire(timer) {
    this.#timers.delete(timer.id);
    if (this.#firing) throw new Error('FakeClock: re-entrant advance from inside a timer callback');
    this.#firing = true;
    try { timer.fn(...timer.args); } finally { this.#firing = false; }
  }
}

/** True when `value` structurally satisfies the product `Clock` contract. */
export function isClock(value) {
  return value !== null && typeof value === 'object' && CLOCK_METHODS.every(m => typeof value[m] === 'function');
}

function assertFiniteInteger(v, name) {
  if (!Number.isSafeInteger(v)) throw new TypeError(`${name} must be a safe integer`);
}
