// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { owned, trace } from '../runtime/lifecycle-fixture.mjs';

// Constructor-bound counter model; no DB, shared home or caller verifier.
class Consumer {
  #lock; #scope;
  effects = 0;
  constructor(lock, scope) { this.#lock = lock; this.#scope = structuredClone(scope); }
  enter() { this.#lock.assertPreviousChildExited(this.#scope); }
  commit() { this.#lock.assertPreviousChildExited(this.#scope); this.effects++; }
}
function snapshot(o, lock) {
  const d = lstatSync(o.dir), f = lstatSync(lock.path);
  return { directory: { dev: d.dev, ino: d.ino, mode: d.mode & 0o777,
    uid: d.uid, symlink: d.isSymbolicLink() }, lock: { dev: f.dev, ino: f.ino,
    bytes: readFileSync(lock.path, 'utf8') }, recordBytes: readFileSync(o.recordPath, 'utf8') };
}
const mutations = {
  permissions(dir) {
    chmodSync(dir, 0o755);
    return () => chmodSync(dir, 0o700);
  },
  symlink(dir) {
    const moved = dir + '-moved'; renameSync(dir, moved); symlinkSync(moved, dir, 'dir');
    return () => { unlinkSync(dir); renameSync(moved, dir); };
  },
  'directory-inode'(dir) {
    // Preserve the lock/diagnostic inodes and bytes in a different private
    // directory: pathname equality and final-file identity alone cannot admit it.
    const moved = dir + '-moved'; renameSync(dir, moved); mkdirSync(dir, { mode: 0o700 });
    for (const n of readdirSync(moved)) renameSync(join(moved, n), join(dir, n));
    return () => {
      for (const n of readdirSync(dir)) renameSync(join(dir, n), join(moved, n));
      rmdirSync(dir); renameSync(moved, dir);
    };
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`observed ${name} directory loss refuses entry/precommit and cannot restore the fact`, async t => {
    const o = await owned(t, 650); await o.killParent();
    const lock = new BotOwnershipLock(o.dir); t.after(() => lock.release());
    const receipt = await lock.reconcilePreviousChild('owned-test-bot');
    assert.equal(receipt.exit.source, 'kqueue-note-exit');
    assert.equal(receipt.exit.code, 7); assert.equal(receipt.exit.signal, null);
    const scope = { botId: receipt.previous.bot, currentIncarnationId: lock.incarnationId,
      previousIncarnationId: receipt.previous.incarnation, previousHost: receipt.previous.host,
      previousChild: receipt.previous.child, lease: receipt.lease };
    const healthy = new Consumer(lock, scope); healthy.enter(); healthy.commit();
    assert.equal(healthy.effects, 1); // Genuine native origin remains usable.
    const consumer = new Consumer(lock, scope); consumer.enter();
    const before = snapshot(o, lock); const restore = mutate(o.dir);
    let invalid;
    try {
      invalid = snapshot(o, lock);
      assert.deepEqual(invalid.lock, before.lock); assert.equal(invalid.recordBytes, before.recordBytes);
      assert.throws(() => consumer.enter()); assert.throws(() => consumer.commit());
      assert.equal(consumer.effects, 0);
    } finally { restore(); }
    lock.assertHeld(); // Restored ownership alone cannot reinstall the lost fact.
    assert.throws(() => consumer.enter(), e => e.reason === 'previous-child-not-reconciled');
    assert.throws(() => consumer.commit(), e => e.reason === 'previous-child-not-reconciled');
    assert.equal(consumer.effects, 0);
    const restored = snapshot(o, lock); assert.deepEqual(restored, before);
    trace({ phase: 'consumer-directory-revocation', name, receipt, scope, before, invalid, restored,
      healthyModeledEffects: healthy.effects, refusedModeledEffects: consumer.effects,
      actualDbAccess: 0, actualSharedHomeAccess: 0 });
  });
}
