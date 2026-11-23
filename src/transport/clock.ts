// SPDX-License-Identifier: Apache-2.0
import { performance } from 'node:perf_hooks';

export interface Clock {
  now(): number;
  monotonicNow(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Operation cancelled')); return; }
    const abort = () => { clock.clearTimeout(timer); reject(new Error('Operation cancelled')); };
    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
