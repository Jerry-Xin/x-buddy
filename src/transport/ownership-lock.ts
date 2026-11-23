// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fstatSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ChildLifecycleRefusal, observeChild, type ReconciledChild } from '../runtime/child-observer.js';

/** Expected constructor scope, never evidence or an authority-bearing receipt. */
export interface PreviousChildExitScope {
  readonly botId: string;
  readonly currentIncarnationId: string;
  readonly previousIncarnationId: string;
  readonly previousHost: { readonly pid: number; readonly start: readonly [number, number] };
  readonly previousChild: { readonly pid: number; readonly start: readonly [number, number] };
  readonly lease: readonly [number, number];
}

/** An externally owned lease: hold it through DB close, not merely registration. */
export class BotOwnershipLock {
  readonly incarnationId = randomUUID();
  readonly path: string;
  private fd: number | null = null;
  #directory: readonly [number, number] | null = null;
  private readonly content = `${process.pid} ${this.incarnationId}\n`;
  // Only this instance's successful fixed native reconciliation installs this
  // fact. JavaScript private state cannot be populated by copying a receipt or
  // the lock's public/TypeScript-private fields onto a different instance.
  #previousChild: { receipt: Readonly<ReconciledChild>; fd: number;
    incarnationId: string; dataDir: string; path: string } | null = null;
  constructor(readonly dataDir: string) { this.path = join(dataDir, 'gateway.lock'); }

  acquire(): this {
    if (this.fd !== null) { this.assertHeld(); return this; }
    this.#previousChild = null;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(this.dataDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) {
      throw new Error('Ownership requires a private, non-symlink data directory');
    }
    this.#directory = [dir.dev, dir.ino];
    try {
      this.fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot acquire ownership lock', { cause: error });
      // Refuse all existing locks. A dead parent alone does not prove that its
      // App Server child has exited. DEV04 must reconcile child start identity
      // before introducing automatic stale-lock takeover.
      let pid = 'unknown';
      try {
        const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const value = fstatSync(fd).size <= 256 ? readFileSync(fd, 'utf8') : '';
          if (/^[1-9]\d*\s/.test(value)) pid = value.split(/\s/)[0];
        } finally { closeSync(fd); }
      } catch { /* Corrupt or symlink lock remains held, never reclaimed. */ }
      throw new Error(`Another instance is running (PID ${pid}); ownership reconciliation required`, { cause: error });
    }
    try { writeFileSync(this.fd, this.content); this.assertHeld(); }
    catch { this.release(); throw new Error('Cannot initialize ownership lock'); }
    return this;
  }

  /** Explicit native previous-child prerequisite. Ordinary acquire() continues
   * to refuse every existing lock. The observer serializes on the retained
   * inode; this method accepts neither a PID nor a proof/callback from a request.
   */
  async reconcilePreviousChild(botId: string): Promise<Readonly<ReconciledChild>> {
    if (this.fd !== null) throw new ChildLifecycleRefusal('already-owned');
    this.#previousChild = null;
    // Bind the directory on both sides of the fixed native observation. Its
    // private/non-symlink predicates must continue to hold at consumer checks.
    const directory = lstatSync(this.dataDir);
    const receipt = await observeChild({ operation: 'reconcile', directory: this.dataDir,
      bot: botId, incarnation: this.incarnationId });
    if (receipt.kind !== 'reconciled') throw new ChildLifecycleRefusal('observer-unavailable');
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (st.dev !== receipt.lease[0] || st.ino !== receipt.lease[1]) throw new ChildLifecycleRefusal('ownership-lost');
      this.fd = fd;
      this.#directory = [directory.dev, directory.ino];
      this.assertHeld();
      this.#previousChild = { receipt, fd, incarnationId: this.incarnationId,
        dataDir: this.dataDir, path: this.path };
    } catch (error) {
      this.fd = null; this.#directory = null; closeSync(fd); throw error;
    }
    return Object.freeze(receipt);
  }

  /** Synchronous read-only entry/precommit check on this same canonical lock.
   * Scope describes what the constructor expects; it cannot supply the fact.
   * No process observer, lock acquisition, DB access or file write occurs here.
   */
  assertPreviousChildExited(scope: PreviousChildExitScope): void {
    this.assertHeld();
    const fact = this.#previousChild;
    if (!fact) throw new ChildLifecycleRefusal('previous-child-not-reconciled');
    const held = fstatSync(fact.fd);
    if (fact.fd !== this.fd || fact.incarnationId !== this.incarnationId
      || fact.dataDir !== this.dataDir || fact.path !== this.path
      || held.dev !== fact.receipt.lease[0] || held.ino !== fact.receipt.lease[1]) {
      this.#previousChild = null;
      throw new ChildLifecycleRefusal('ownership-lost');
    }
    const { previous, lease } = fact.receipt;
    const sameIdentity = (actual: PreviousChildExitScope['previousChild'] | undefined,
      expected: PreviousChildExitScope['previousChild']): boolean => actual?.pid === expected.pid
        && actual?.start?.[0] === expected.start[0] && actual?.start?.[1] === expected.start[1];
    if (!scope || scope.botId !== previous.bot || scope.currentIncarnationId !== fact.incarnationId
      || scope.previousIncarnationId !== previous.incarnation
      || !sameIdentity(scope.previousHost, previous.host) || !sameIdentity(scope.previousChild, previous.child)
      || scope.lease?.[0] !== lease[0] || scope.lease?.[1] !== lease[1]) {
      throw new ChildLifecycleRefusal('previous-child-scope-mismatch');
    }
  }

  assertHeld(): void {
    if (this.fd === null) {
      this.#previousChild = null;
      throw new Error('Bot ownership lock is not held');
    }
    try {
      const directory = lstatSync(this.dataDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
        || (process.getuid && directory.uid !== process.getuid())
        || directory.dev !== this.#directory?.[0] || directory.ino !== this.#directory?.[1]) {
        throw new Error('directory replacement or invalidation');
      }
      const current = lstatSync(this.path);
      const owned = fstatSync(this.fd);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
        || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new Error('replacement');
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.ino !== owned.ino || opened.dev !== owned.dev || readFileSync(fd, 'utf8') !== this.content) throw new Error('replacement');
      } finally { closeSync(fd); }
    } catch {
      this.#previousChild = null;
      throw new Error('Bot ownership lock was replaced or invalidated');
    }
  }

  release(): void {
    this.#previousChild = null;
    if (this.fd === null) return;
    try { this.assertHeld(); unlinkSync(this.path); }
    catch { /* Never delete a replacement or symlink. */ }
    finally { closeSync(this.fd); this.fd = null; this.#directory = null; }
  }
}

/** Callback owns resource cleanup; its finally runs before the lease is released. */
export async function withBotOwnership<T>(dataDir: string, run: (lock: BotOwnershipLock) => Promise<T>): Promise<T> {
  const lock = new BotOwnershipLock(dataDir).acquire();
  try { return await run(lock); }
  finally { lock.release(); }
}
