// SPDX-License-Identifier: Apache-2.0
import { BotOwnershipLock } from '../../transport/ownership-lock.js';
import type { PreviousChildExitScope } from '../../transport/ownership-lock.js';
import type { RestartBinding, RestartReconciliationRequest, TerminalRequest } from './types.js';
import * as v from './validation.js';

/** Data can describe the expected scope, never supply the native observation. */
function data<T>(value: T): T {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.map(data) as T;
    v.object(value);
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) throw new TypeError('Restart data cannot contain accessors');
      copy[key] = data(descriptor.value);
    }
    return copy as T;
  }
  if (['function', 'symbol', 'bigint'].includes(typeof value)) throw new TypeError('Expected restart data');
  return value;
}

export function bind(input: RestartBinding) {
  v.keys(input, ['lock', 'expected']);
  const lock = input.lock, expected: PreviousChildExitScope = v.freeze(data(input.expected));
  v.keys(expected, ['botId', 'currentIncarnationId', 'previousIncarnationId', 'previousHost', 'previousChild', 'lease']);
  for (const key of ['botId', 'currentIncarnationId', 'previousIncarnationId'] as const) v.text(expected[key]);
  // Pin both implementations; the private native fact rejects structural copies.
  // The previous-child check itself dispatches through this.assertHeld(), so
  // sample the canonical lease again after that possible instance re-entry.
  const check = BotOwnershipLock.prototype.assertPreviousChildExited;
  const held = BotOwnershipLock.prototype.assertHeld;
  return Object.freeze({ expected, assertCurrent() { held.call(lock); check.call(lock, expected); held.call(lock); } });
}

/** Capture the immutable old receipt and current ownership guard once. */
export function capture(input: RestartReconciliationRequest): TerminalRequest {
  v.keys(input, ['expected', 'ownership']);
  const expected = v.freeze(data(input.expected)), original = input.ownership;
  v.keys(original, ['ownerIncarnation', 'resetGeneration', 'assertHeld']);
  if (Object.values(Object.getOwnPropertyDescriptors(original)).some(d => !('value' in d))) {
    throw new TypeError('Restart ownership cannot contain accessors');
  }
  const { ownerIncarnation, resetGeneration, assertHeld } = original;
  if (typeof assertHeld !== 'function') throw new TypeError('Missing ownership guard');
  return v.freeze({ expected, ownership: { ownerIncarnation, resetGeneration,
    assertHeld() {
      if (original.ownerIncarnation !== ownerIncarnation || original.resetGeneration !== resetGeneration) throw new TypeError('Restart ownership/reset changed');
      return assertHeld.call(original);
    } }, outcome: { kind: 'restart' as const } });
}
