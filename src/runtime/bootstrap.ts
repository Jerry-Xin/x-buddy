// SPDX-License-Identifier: Apache-2.0
import { lstatSync } from 'node:fs';
import { BotOwnershipLock, type PreviousChildExitScope } from '../transport/ownership-lock.js';
import { BotChildLifecycle } from './child-lifecycle.js';
import { ChildLifecycleRefusal } from './child-observer.js';

// Capture canonical implementations before construction or nested dispatch.
const construction = Symbol();
const held = BotOwnershipLock.prototype.assertHeld;
const previous = BotOwnershipLock.prototype.assertPreviousChildExited;
const release = BotOwnershipLock.prototype.release;

/** Host-owned lifetime, not an execution permit or a repair authority. */
export class BotStartupOwnership {
  #lock: BotOwnershipLock;
  #bot: string;
  #directory: string;
  #scope?: PreviousChildExitScope;
  #children: BotChildLifecycle;
  #incarnation: string;
  #path: string;
  #lease: readonly [number, number];
  #invalidated = false;
  private constructor(key: symbol, lock: BotOwnershipLock, bot: string, scope?: PreviousChildExitScope) {
    if (key !== construction) throw new ChildLifecycleRefusal('startup-ownership-required');
    this.#lock = lock; this.#bot = bot; this.#directory = lock.dataDir; this.#scope = scope;
    this.#incarnation = lock.incarnationId; this.#path = lock.path;
    const st = lstatSync(lock.path); this.#lease = [st.dev, st.ino];
    this.#children = new BotChildLifecycle(lock, bot);
  }
  static async acquire(directory: string, bot: string): Promise<BotStartupOwnership> {
    if (!bot || bot.length > 256) throw new ChildLifecycleRefusal('invalid-scope');
    if (process.platform !== 'darwin') throw new ChildLifecycleRefusal('unsupported-platform');
    const lock = new BotOwnershipLock(directory);
    let exists = true;
    try { lstatSync(lock.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
    let scope: PreviousChildExitScope | undefined;
    if (exists) {
      const r = await lock.reconcilePreviousChild(bot);
      scope = Object.freeze({ botId: bot, currentIncarnationId: lock.incarnationId,
        previousIncarnationId: r.previous.incarnation, previousHost: r.previous.host,
        previousChild: r.previous.child, lease: r.lease });
    } else { lock.acquire(); }
    try {
      const ownership = new BotStartupOwnership(construction, lock, bot, scope);
      assertStartupOwnership(ownership, directory, bot);
      return ownership;
    } catch (error) { release.call(lock); throw error; }
  }
  assertFor(directory: string, bot: string): void {
    if (directory !== this.#directory || bot !== this.#bot) throw new ChildLifecycleRefusal('startup-scope-mismatch');
    try {
      if (this.#invalidated || this.#lock.dataDir !== this.#directory || this.#lock.path !== this.#path
        || this.#lock.incarnationId !== this.#incarnation) throw new ChildLifecycleRefusal('ownership-lost');
      held.call(this.#lock);
      const st = lstatSync(this.#path);
      if (st.dev !== this.#lease[0] || st.ino !== this.#lease[1]) throw new ChildLifecycleRefusal('ownership-lost');
      if (this.#scope) previous.call(this.#lock, this.#scope);
      held.call(this.#lock);
    } catch (error) { this.#invalidated = true; throw error; }
  }
  get lifecycle(): BotChildLifecycle { return this.#children; }
  async drain(): Promise<void> { await this.#children.drainOwnedChild(); }
  release(): void {
    this.#children.assertQuiescent();
    release.call(this.#lock);
  }
}
const assertFor = BotStartupOwnership.prototype.assertFor;
/** Branded, constructor-bound canonical check; no caller-selected verifier. */
export function assertStartupOwnership(ownership: BotStartupOwnership | undefined, directory: string, bot: string): void {
  if (!ownership) throw new ChildLifecycleRefusal('startup-ownership-required');
  assertFor.call(ownership, directory, bot);
}
