// SPDX-License-Identifier: Apache-2.0
import { HostExecutionRefusal } from './executor.js';
import { runtimeError } from './support.js';
import type { RuntimeClock } from './types.js';

export class HostDeliveryUnknownError extends Error {
  override readonly name = 'HostDeliveryUnknownError';
  constructor() { super('Host delivery did not settle safely; no resend'); }
}
export interface CompletionScope {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  publish<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T>;
  notice<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
interface Entry {
  key: string; generation: number; controller: AbortController; delivery: AbortController;
  guard: () => void; work: (scope: CompletionScope) => Promise<unknown>;
  resolve: (value: unknown) => void; reject: (error: unknown) => void;
  active: boolean; finished: boolean; effects: Set<Promise<unknown>>; notices: Set<Promise<unknown>>;
  deliveryDeadline?: number; queueTimer?: unknown; removeAbort?: () => void;
}
interface Lane { active?: Entry; queue: Entry[] }

/** Host completion only: no thread map, delivery primitive, reset producer or durable state. */
export class HostCompletionQueue {
  readonly #lanes = new Map<string, Lane>();
  readonly #owners = new Set<Entry>();
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #effects = new Set<Promise<unknown>>();
  #stoppingAt?: number;
  constructor(readonly clock: RuntimeClock, readonly now: () => number, readonly maxQueued: number) {}

  run<T>(key: string, generation: number, deadline: number, controller: AbortController,
    originalSignal: AbortSignal | undefined, guard: () => void,
    work: (scope: CompletionScope) => Promise<T>): Promise<T> {
    if (this.#stoppingAt !== undefined) throw new HostExecutionRefusal('caller-stopped');
    const lane = this.#lanes.get(key) ?? { queue: [] };
    if (lane.active && lane.queue.length >= this.maxQueued) throw runtimeError('LaneOverflowError');
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const entry: Entry = { key, generation, controller, delivery: new AbortController(), guard, work,
      resolve: value => resolve(value as T), reject,
      active: false, finished: false, effects: new Set(), notices: new Set() };
    promise.catch(() => {});
    this.#lanes.set(key, lane); this.#owners.add(entry); lane.queue.push(entry);
    const abort = (): void => this.#cancel(entry, new HostExecutionRefusal('permit-not-current'));
    originalSignal?.addEventListener('abort', abort, { once: true });
    entry.removeAbort = () => originalSignal?.removeEventListener('abort', abort);
    entry.queueTimer = this.clock.setTimeout(() => this.#cancel(entry, new HostExecutionRefusal('deadline')),
      Math.max(0, deadline - this.now()));
    if (originalSignal?.aborted) abort();
    this.#pump(key, lane);
    return promise;
  }

  cancelBefore(key: string, generation: number): boolean {
    let cancelled = false;
    for (const entry of this.#owners) if (entry.key === key && entry.generation < generation) {
      cancelled = true; this.#cancel(entry, new HostExecutionRefusal('permit-not-current'));
    }
    return cancelled;
  }
  stop(): void {
    this.#stoppingAt ??= this.clock.monotonicNow();
    for (const entry of this.#owners) this.#cancel(entry, new HostExecutionRefusal('caller-stopped'));
  }
  async drain(): Promise<void> {
    this.stop();
    if (!this.#jobs.size && !this.#effects.size) return;
    const remaining = this.#stoppingAt! + 10_000 - this.clock.monotonicNow();
    if (remaining <= 0) throw runtimeError('HostCompletionDrainError', 'host completion remains owned');
    let timer: unknown;
    try {
      await Promise.race([Promise.allSettled([...this.#jobs, ...this.#effects]), new Promise<never>((_, reject) => {
        timer = this.clock.setTimeout(() => reject(runtimeError('HostCompletionDrainError', 'host completion remains owned')), remaining);
      })]);
    } finally { this.clock.clearTimeout(timer); }
  }

  #current(entry: Entry): void {
    if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
    entry.guard();
  }
  #scope(entry: Entry): CompletionScope {
    return Object.freeze({ signal: entry.controller.signal, assertCurrent: () => this.#current(entry),
      publish: <T>(effect: (signal: AbortSignal) => Promise<T>) => this.#call(entry, effect, false),
      notice: <T>(effect: (signal: AbortSignal) => Promise<T>) => {
        const promise = this.#call(entry, effect, true); entry.notices.add(promise);
        promise.then(() => entry.notices.delete(promise), () => entry.notices.delete(promise));
        return promise;
      } });
  }
  #pump(key: string, lane: Lane): void {
    if (lane.active || this.#stoppingAt !== undefined) return;
    const entry = lane.queue.shift();
    if (!entry) { this.#lanes.delete(key); return; }
    entry.active = true; lane.active = entry; this.clock.clearTimeout(entry.queueTimer);
    const job = (async () => {
      this.#current(entry);
      const value = await entry.work(this.#scope(entry));
      await Promise.allSettled([...entry.notices]);
      this.#current(entry);
      return value;
    })();
    this.#jobs.add(job);
    job.then(value => entry.resolve(value), error => entry.reject(error)).finally(() => {
      this.#jobs.delete(job); entry.finished = true; entry.removeAbort?.();
      lane.active = undefined; this.#forget(entry); this.#pump(key, lane);
    }).catch(() => {});
  }
  #cancel(entry: Entry, reason: Error): void {
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    if (!entry.delivery.signal.aborted) entry.delivery.abort(reason);
    if (entry.active || entry.finished) return;
    const lane = this.#lanes.get(entry.key);
    if (lane) { const index = lane.queue.indexOf(entry); if (index >= 0) lane.queue.splice(index, 1); }
    entry.finished = true; this.clock.clearTimeout(entry.queueTimer); entry.removeAbort?.();
    entry.reject(reason); this.#forget(entry);
    if (lane) this.#pump(entry.key, lane);
  }
  #forget(entry: Entry): void { if (entry.finished && !entry.effects.size) this.#owners.delete(entry); }

  async #call<T>(entry: Entry, effect: (signal: AbortSignal) => Promise<T>, notice: boolean): Promise<T> {
    this.#current(entry);
    const now = this.clock.monotonicNow();
    if (!notice) entry.deliveryDeadline ??= now + 60_000;
    const deadline = Math.min(now + (notice ? 30_000 : 60_000), entry.deliveryDeadline ?? Infinity);
    if (now >= deadline) throw new HostDeliveryUnknownError();
    const controller = new AbortController();
    const abort = (): void => controller.abort(entry.controller.signal.reason ?? entry.delivery.signal.reason);
    entry.controller.signal.addEventListener('abort', abort, { once: true });
    entry.delivery.signal.addEventListener('abort', abort, { once: true });
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = (): void => rejectAbort(controller.signal.reason ?? new HostDeliveryUnknownError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = this.clock.setTimeout(() => controller.abort(new HostDeliveryUnknownError()), deadline - now);
    const actual = Promise.resolve().then(() => { this.#current(entry); if (controller.signal.aborted) throw controller.signal.reason; return effect(controller.signal); });
    entry.effects.add(actual); this.#effects.add(actual);
    const collected = (): void => { entry.effects.delete(actual); this.#effects.delete(actual); this.#forget(entry); };
    actual.then(collected, collected);
    try {
      const result = await Promise.race([actual, aborted]);
      this.#current(entry);
      if (controller.signal.aborted) throw controller.signal.reason;
      return result;
    } catch (error) {
      if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
      if (error instanceof HostExecutionRefusal) throw error;
      throw new HostDeliveryUnknownError();
    } finally {
      this.clock.clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
      entry.controller.signal.removeEventListener('abort', abort); entry.delivery.signal.removeEventListener('abort', abort);
    }
  }
}
