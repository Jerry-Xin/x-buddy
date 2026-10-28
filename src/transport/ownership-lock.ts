// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fstatSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** An externally owned lease: hold it through DB close, not merely registration. */
export class BotOwnershipLock {
  readonly incarnationId = randomUUID();
  readonly path: string;
  private fd: number | null = null;
  private readonly content = `${process.pid} ${this.incarnationId}\n`;
  constructor(readonly dataDir: string) { this.path = join(dataDir, 'gateway.lock'); }

  acquire(): this {
    if (this.fd !== null) { this.assertHeld(); return this; }
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(this.dataDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) {
      throw new Error('Ownership requires a private, non-symlink data directory');
    }
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
    try { writeFileSync(this.fd, this.content); }
    catch { this.release(); throw new Error('Cannot initialize ownership lock'); }
    return this;
  }

  assertHeld(): void {
    if (this.fd === null) throw new Error('Bot ownership lock is not held');
    try {
      const current = lstatSync(this.path);
      const owned = fstatSync(this.fd);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
        || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new Error('replacement');
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.ino !== owned.ino || opened.dev !== owned.dev || readFileSync(fd, 'utf8') !== this.content) throw new Error('replacement');
      } finally { closeSync(fd); }
    } catch { throw new Error('Bot ownership lock was replaced or invalidated'); }
  }

  release(): void {
    if (this.fd === null) return;
    try { this.assertHeld(); unlinkSync(this.path); }
    catch { /* Never delete a replacement or symlink. */ }
    finally { closeSync(this.fd); this.fd = null; }
  }
}

/** Callback owns resource cleanup; its finally runs before the lease is released. */
export async function withBotOwnership<T>(dataDir: string, run: (lock: BotOwnershipLock) => Promise<T>): Promise<T> {
  const lock = new BotOwnershipLock(dataDir).acquire();
  try { return await run(lock); }
  finally { lock.release(); }
}
