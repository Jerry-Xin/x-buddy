// SPDX-License-Identifier: Apache-2.0
/**
 * `FaultPlan` test seam (R8 §10.4).
 *
 * Product code receives a FaultPlan through constructor injection and calls
 * `plan.hit(point, context)` at each named fault point. The production default
 * is `NO_FAULTS`, which never injects anything. The point set is closed:
 * hitting or arming an unknown point throws, so a misspelled point fails the
 * test instead of silently injecting nothing.
 *
 * Every armed fault must be consumed; `assertExhausted()` fails a test whose
 * fault never fired (the scenario did not exercise what it claims).
 */

/** Named points from R8 §10.4. Parameterised points take their argument through `context`. */
export const FAULT_POINTS = Object.freeze({
  'egress.beforeFirstSend': Object.freeze({ params: [] }),
  'egress.afterFence': Object.freeze({ params: [] }),
  'egress.afterSegment': Object.freeze({ params: ['k'] }),
  'cron.afterAdmit': Object.freeze({ params: [] }),
  'cron.beforeFinalize': Object.freeze({ params: [] }),
  'runtime.dropInterruptResponse': Object.freeze({ params: [] }),
  'runtime.dropTurnCompleted': Object.freeze({ params: [] }),
  'runtime.failUnsubscribe': Object.freeze({ params: [] }),
  'runtime.killChild': Object.freeze({ params: [] }),
  'transport.dropConnack': Object.freeze({ params: [] }),
  'transport.disconnect': Object.freeze({ params: [] }),
  'api.forceStatus': Object.freeze({ params: ['endpoint'] }),
});

export const FAULT_ACTIONS = Object.freeze(['throw', 'drop', 'delay', 'status', 'kill', 'disconnect']);

export class FaultInjectedError extends Error {
  /** @param {string} point @param {string} [message] */
  constructor(point, message) {
    super(message ?? `fault injected at ${point}`);
    this.name = 'FaultInjectedError';
    this.point = point;
  }
}

/**
 * @typedef {object} FaultSpec
 * @property {'throw'|'drop'|'delay'|'status'|'kill'|'disconnect'} action
 * @property {number} [times]      how many matching hits fire (default 1; Infinity allowed)
 * @property {number} [skip]       matching hits to let pass before firing (default 0)
 * @property {Record<string, unknown>} [match] equality match on context fields (e.g. {k: 2})
 * @property {number} [status]     HTTP status for `status`
 * @property {number} [delayMs]    for `delay`
 * @property {string} [message]    error message for `throw`
 */

export class FaultPlan {
  /** @type {Array<{point:string, spec:Required<Pick<FaultSpec,'action'>> & FaultSpec, remaining:number, skip:number, fired:number}>} */
  #armed = [];
  /** @type {Array<{seq:number, point:string, context:Record<string, unknown>, fired:string|null}>} */
  #log = [];
  #seq = 0;

  /**
   * @param {string} point
   * @param {FaultSpec} spec
   */
  arm(point, spec) {
    assertKnownPoint(point);
    if (!spec || !FAULT_ACTIONS.includes(spec.action)) throw new TypeError(`unknown fault action ${spec && spec.action}`);
    if (spec.action === 'status' && !Number.isInteger(spec.status)) throw new TypeError('status fault requires an integer status');
    if (spec.action === 'delay' && !(Number.isFinite(spec.delayMs) && spec.delayMs >= 0)) throw new TypeError('delay fault requires delayMs >= 0');
    const times = spec.times ?? 1;
    if (!(times === Infinity || (Number.isInteger(times) && times > 0))) throw new TypeError('times must be a positive integer or Infinity');
    const skip = spec.skip ?? 0;
    if (!(Number.isInteger(skip) && skip >= 0)) throw new TypeError('skip must be a non-negative integer');
    if (spec.match) {
      const allowed = FAULT_POINTS[point].params;
      for (const key of Object.keys(spec.match)) {
        if (!allowed.includes(key)) throw new TypeError(`point ${point} has no parameter ${key}`);
      }
    }
    this.#armed.push({ point, spec: { ...spec }, remaining: times, skip, fired: 0 });
    return this;
  }

  /** R8 helper: `api.forceStatus(endpoint, code, count)`. */
  forceStatus(endpoint, status, count = 1) {
    if (typeof endpoint !== 'string' || endpoint === '') throw new TypeError('endpoint must be a non-empty string');
    return this.arm('api.forceStatus', { action: 'status', status, times: count, match: { endpoint } });
  }

  /**
   * Called by code under test. Returns the directive to apply, or `null`.
   * @param {string} point
   * @param {Record<string, unknown>} [context]
   * @returns {null | Readonly<FaultSpec & {point:string}>}
   */
  hit(point, context = {}) {
    assertKnownPoint(point);
    for (const key of FAULT_POINTS[point].params) {
      if (!(key in context)) throw new TypeError(`fault point ${point} requires context.${key}`);
    }
    const entry = { seq: ++this.#seq, point, context: { ...context }, fired: null };
    this.#log.push(entry);
    for (const armed of this.#armed) {
      if (armed.point !== point || armed.remaining === 0) continue;
      if (armed.spec.match && !Object.entries(armed.spec.match).every(([k, v]) => context[k] === v)) continue;
      if (armed.skip > 0) { armed.skip--; continue; }
      armed.remaining--;
      armed.fired++;
      entry.fired = armed.spec.action;
      return Object.freeze({ ...armed.spec, point });
    }
    return null;
  }

  /** Like `hit`, but throws `FaultInjectedError` for `throw` directives. */
  apply(point, context = {}) {
    const directive = this.hit(point, context);
    if (directive && directive.action === 'throw') throw new FaultInjectedError(point, directive.message);
    return directive;
  }

  /** Ordered, immutable hit log for assertions. */
  hits() { return this.#log.map(e => Object.freeze({ ...e, context: Object.freeze({ ...e.context }) })); }

  /** Faults still waiting to fire (finite `times` only). */
  pending() {
    return this.#armed.filter(a => a.remaining !== 0 && a.remaining !== Infinity)
      .map(a => Object.freeze({ point: a.point, action: a.spec.action, remaining: a.remaining }));
  }

  /** Throws if any finite fault never fired, or an unbounded fault never fired once. */
  assertExhausted() {
    const unfired = this.#armed.filter(a => (a.remaining !== Infinity && a.remaining > 0) || a.fired === 0);
    if (unfired.length > 0) {
      const desc = unfired.map(a => `${a.point}:${a.spec.action}(${a.fired} fired)`).join(', ');
      throw new Error(`FaultPlan has unconsumed faults: ${desc}`);
    }
  }
}

/** Production default: validates point names, never injects. */
export const NO_FAULTS = Object.freeze({
  hit(point, context = {}) {
    assertKnownPoint(point);
    for (const key of FAULT_POINTS[point].params) {
      if (!(key in context)) throw new TypeError(`fault point ${point} requires context.${key}`);
    }
    return null;
  },
  apply(point, context = {}) { return NO_FAULTS.hit(point, context); },
});

function assertKnownPoint(point) {
  if (!Object.hasOwn(FAULT_POINTS, point)) throw new TypeError(`unknown fault point ${String(point)}`);
}
