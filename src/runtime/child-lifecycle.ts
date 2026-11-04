// SPDX-License-Identifier: Apache-2.0
import { spawn, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BotOwnershipLock } from '../transport/ownership-lock.js';
import { ChildLifecycleRefusal, observeChild } from './child-observer.js';

const lifecycles = new WeakSet<BotOwnershipLock>();

/** Native observations are bound here to our actual spawn and exit events.
 * This owns no DB, CODEX_HOME, authority, turn, or receipt-repair permission.
 */
export class BotChildLifecycle {
  #active?: ChildProcessWithoutNullStreams;
  #settled: Promise<void> = Promise.resolve();
  #failure?: Error;

  constructor(readonly lock: BotOwnershipLock, readonly botId: string) {
    if (!botId || botId.length > 256) throw new ChildLifecycleRefusal('invalid-scope');
    lock.assertHeld();
    if (lifecycles.has(lock)) throw new ChildLifecycleRefusal('lifecycle-already-bound');
    lifecycles.add(lock);
  }

  /** Collected by AppServerClient.close; a failed diagnostic never implies exit. */
  get settled(): Promise<void> { return this.#settled; }

  spawn(bin: string, args: string[], options: SpawnOptionsWithoutStdio): {
    child: ChildProcessWithoutNullStreams; recorded: Promise<void>;
  } {
    this.lock.assertHeld();
    if (process.platform !== 'darwin') throw new ChildLifecycleRefusal('unsupported-platform');
    if (this.#failure) throw this.#failure;
    if (this.#active) throw new ChildLifecycleRefusal('previous-child-unsettled');
    const child = spawn(bin, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#active = child;
    const scope = { directory: this.lock.dataDir, bot: this.botId, incarnation: this.lock.incarnationId };
    let identity: unknown;
    let spawned = false;
    const recorded = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        spawned = true;
        void observeChild({ ...scope, operation: 'spawn', pid: child.pid }).then(result => {
          if (result.kind !== 'recorded') throw new ChildLifecycleRefusal('observer-unavailable');
          this.lock.assertHeld(); identity = result.record.child; resolve();
        }).catch(reject);
      });
    });
    // A rejection is retained even if a caller abandons start().
    void recorded.catch(error => { this.#failure = error; });
    this.#settled = new Promise<void>(resolve => {
      // Only the directly owned process exit establishes termination. Descendants
      // can retain its pipes indefinitely; their close event is not this proof.
      child.once('exit', (code, signal) => {
        void recorded.then(async () => {
          this.lock.assertHeld();
          await observeChild({ ...scope, operation: 'exit', child: identity,
            exit: { source: 'owned-child-exit', code, signal } });
          this.lock.assertHeld();
          this.#active = undefined;
        }).catch(error => { this.#failure = error; }).finally(resolve);
      });
      // A failed creation has no exit event and produces no durable exit record.
      // recorded's rejection retains the failure and forbids another spawn.
      child.once('error', () => { if (!spawned) resolve(); });
    });
    return { child, recorded };
  }
}
