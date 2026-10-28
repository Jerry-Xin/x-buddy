// SPDX-License-Identifier: Apache-2.0
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { capMessage } from '../app-server/errors.js';
import type { RuntimeClock } from './types.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export const realClock: RuntimeClock = {
  now: () => Date.now(), monotonicNow: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};
export class RuntimeError extends Error {
  constructor(readonly code: string, message = code) { super(capMessage(message)); this.name = code; }
}
export function runtimeError(code: string, message?: string): RuntimeError { return new RuntimeError(code, message); }
export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}
export function identifier(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
export function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) throw new RangeError(`invalid ${name}`);
  return v;
}

/** A bounded, nonblocking, single-consumer stream. Never pauses process stdout. */
export class EventQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #wake = deferred<void>();
  #ended = false;
  #consumed = false;
  push(value: T): boolean {
    if (this.#ended) return true;
    if (this.#items.length >= 10_000) return false;
    this.#items.push(value); this.#wake.resolve(); return true;
  }
  end(discard = false): void { this.#ended = true; if (discard) this.#items = []; this.#wake.resolve(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    if (this.#consumed) throw runtimeError('RuntimeUnavailableError', 'turn events already consumed');
    this.#consumed = true;
    for (;;) {
      if (this.#items.length > 0) { yield this.#items.shift()!; continue; }
      if (this.#ended) return;
      this.#wake = deferred<void>(); await this.#wake.promise;
    }
  }
}
