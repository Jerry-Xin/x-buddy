// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { owned, clean, trace } from '../runtime/lifecycle-fixture.mjs';

const BOT = 'owned-test-bot';
const scopeFor = (lock, receipt) => ({ botId: BOT, currentIncarnationId: lock.incarnationId,
  previousIncarnationId: receipt.previous.incarnation, previousHost: receipt.previous.host,
  previousChild: receipt.previous.child, lease: receipt.lease });

// Local counter harness only. The lock and expected scope are fixed at construction.
// No store, DB, CODEX_HOME, request verifier or receipt registry is involved.
class BoundaryConsumer {
  #lock; #scope;
  events = []; protectedEffects = 0;
  constructor(lock, scope) { this.#lock = lock; this.#scope = structuredClone(scope); }
  enter() { this.#lock.assertPreviousChildExited(this.#scope); this.events.push('entry-checked'); }
  commit() {
    this.#lock.assertPreviousChildExited(this.#scope);
    this.events.push('precommit-checked');
    this.protectedEffects++; this.events.push('modeled-effect');
  }
}
function refuses(consumer, phase = 'enter', reason) {
  assert.throws(() => consumer[phase](), error => reason ? error.reason === reason :
    error.reason === 'previous-child-not-reconciled' || error.reason === 'ownership-lost'
      || /Bot ownership lock/.test(error.message));
  assert.equal(consumer.protectedEffects, 0);
}
async function reconciled(t, persisted = false) {
  const o = await owned(t, persisted ? 10 : 650);
  const inode = statSync(join(o.dir, 'gateway.lock')).ino;
  if (persisted) {
    const closed = once(o.parent, 'message'); o.parent.send('close');
    assert.equal((await closed)[0].closed, true);
  }
  await o.killParent();
  const lock = new BotOwnershipLock(o.dir);
  t.after(() => lock.release());
  const receipt = await lock.reconcilePreviousChild(BOT);
  assert.equal(receipt.exit.code, 7); assert.equal(receipt.exit.signal, null);
  assert.equal(statSync(lock.path).ino, inode);
  trace({ phase: 'consumer-native-reconciliation', receipt, currentIncarnation: lock.incarnationId,
    retainedInode: inode, diagnosticBytes: readFileSync(o.recordPath, 'utf8') });
  return { o, lock, receipt, scope: scopeFor(lock, receipt) };
}

test('native exit on the same held lock supports synchronous entry and precommit checks', async t => {
  const { lock, receipt, scope } = await reconciled(t);
  assert.equal(receipt.exit.source, 'kqueue-note-exit');
  const consumer = new BoundaryConsumer(lock, scope);
  consumer.enter(); consumer.commit();
  assert.equal(consumer.protectedEffects, 1);
  assert.deepEqual(consumer.events, ['entry-checked', 'precommit-checked', 'modeled-effect']);
  assert.equal(lock.assertPreviousChildExited(scope), undefined); // Synchronous, no promise.
  assert.equal(lock.acquire(), lock); lock.assertPreviousChildExited(scope); // Same held lease.
  await assert.rejects(lock.reconcilePreviousChild(BOT), e => e.reason === 'already-owned');
  lock.assertPreviousChildExited(scope); // A repeated acquisition refusal does not revoke the held fact.
  trace({ phase: 'consumer-positive', source: receipt.exit.source, events: consumer.events,
    modeledProtectedEffects: consumer.protectedEffects, actualDbAccess: 0, actualHomeAccess: 0 });
});

test('genuine persisted owned exit supports the same canonical consumer boundary', async t => {
  const { lock, receipt, scope } = await reconciled(t, true);
  assert.equal(receipt.exit.source, 'owned-child-exit');
  const consumer = new BoundaryConsumer(lock, scope); consumer.enter(); consumer.commit();
  assert.equal(consumer.protectedEffects, 1);
  trace({ phase: 'consumer-positive', source: receipt.exit.source, events: consumer.events,
    modeledProtectedEffects: 1, actualDbAccess: 0, actualHomeAccess: 0 });
});

test('scope mismatches refuse at entry and precommit without a protected effect', async t => {
  const { lock, scope } = await reconciled(t);
  const cases = [
    ['bot', s => { s.botId = 'wrong'; }],
    ['previous-incarnation', s => { s.previousIncarnationId = lock.incarnationId; }],
    ['current-incarnation', s => { s.currentIncarnationId = s.previousIncarnationId; }],
    ['host-pid', s => { s.previousHost.pid++; }],
    ['host-start', s => { s.previousHost.start[1]++; }],
    ['child-pid', s => { s.previousChild.pid++; }],
    ['child-start-seconds', s => { s.previousChild.start[0]++; }],
    ['child-start-microseconds', s => { s.previousChild.start[1]++; }],
    ['device', s => { s.lease[0]++; }],
    ['inode', s => { s.lease[1]++; }],
    ['missing-child', s => { delete s.previousChild; }],
  ];
  for (const [name, change] of cases) {
    const wrong = structuredClone(scope); change(wrong);
    const consumer = new BoundaryConsumer(lock, wrong);
    refuses(consumer, 'enter', 'previous-child-scope-mismatch'); refuses(consumer, 'commit', 'previous-child-scope-mismatch');
    trace({ phase: 'consumer-scope-refusal', name, modeledProtectedEffects: consumer.protectedEffects });
  }
  assert.throws(() => lock.assertPreviousChildExited(null));
  lock.assertPreviousChildExited(scope);
});

test('serialized or forged receipts and another lock object cannot supply the private observation', async t => {
  const { o, lock, receipt, scope } = await reconciled(t);
  const copy = JSON.parse(JSON.stringify(receipt)); assert.deepEqual(copy, receipt);
  const other = new BotOwnershipLock(o.dir);
  // Even copied public/TypeScript-private fields are not the canonical instance's fact.
  Object.assign(other, lock, { receipt: copy, previousChild: copy, reconciled: true });
  refuses(new BoundaryConsumer(other, scope));
  assert.throws(() => BotOwnershipLock.prototype.assertPreviousChildExited.call(copy, scope));
  const consumer = new BoundaryConsumer(lock, scope); consumer.enter(); consumer.commit();
  assert.equal(consumer.protectedEffects, 1);
});

test('ordinary acquisition plus serialized fields never manufactures previous-child authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xin2739-ordinary-')); const lock = new BotOwnershipLock(dir).acquire();
  try {
    const forged = { botId: BOT, currentIncarnationId: lock.incarnationId,
      previousIncarnationId: '00000000-0000-4000-8000-000000000001',
      previousHost: { pid: process.pid, start: [1, 2] }, previousChild: { pid: process.pid, start: [1, 2] },
      lease: [statSync(lock.path).dev, statSync(lock.path).ino] };
    Object.assign(lock, { receipt: forged, reconciled: true }); lock.assertHeld();
    refuses(new BoundaryConsumer(lock, forged));
  } finally { lock.release(); clean(dir); assert.equal(existsSync(dir), false); }
});

test('release and same-object reacquisition cannot replay a verified observation', async t => {
  const { lock, scope } = await reconciled(t);
  const consumer = new BoundaryConsumer(lock, scope); consumer.enter();
  lock.release(); refuses(consumer, 'commit');
  lock.acquire(); lock.assertHeld(); refuses(consumer, 'commit'); refuses(new BoundaryConsumer(lock, scope));
  trace({ phase: 'consumer-reacquired-refusal', events: consumer.events, modeledProtectedEffects: 0 });
});

test('observed content loss irreversibly revokes evidence even if fixture bytes are restored', async t => {
  const { lock, scope } = await reconciled(t);
  const consumer = new BoundaryConsumer(lock, scope); consumer.enter(); const bytes = readFileSync(lock.path);
  writeFileSync(lock.path, 'invalidated owned fixture\n');
  assert.throws(() => lock.assertHeld()); refuses(consumer, 'commit');
  writeFileSync(lock.path, bytes); lock.assertHeld(); refuses(consumer, 'commit');
});

test('inode replacement between entry and precommit refuses and never deletes the replacement', async t => {
  const { o, lock, scope } = await reconciled(t);
  const consumer = new BoundaryConsumer(lock, scope); consumer.enter();
  const bytes = readFileSync(lock.path); renameSync(lock.path, join(o.dir, 'retired.lock'));
  writeFileSync(lock.path, bytes, { mode: 0o600 });
  refuses(consumer, 'commit'); lock.release();
  assert.deepEqual(readFileSync(lock.path), bytes);
  trace({ phase: 'consumer-inode-loss-refusal', events: consumer.events, modeledProtectedEffects: 0 });
});

test('changing the current incarnation revokes the fact permanently', async t => {
  const { lock, scope } = await reconciled(t);
  const original = lock.incarnationId; lock.incarnationId = scope.previousIncarnationId;
  refuses(new BoundaryConsumer(lock, scope));
  lock.incarnationId = original; refuses(new BoundaryConsumer(lock, scope));
});
