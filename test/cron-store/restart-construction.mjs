// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { repairFixture, observe, record, state } from './restart-fixture.mjs';

for (const admission of [false, true]) {
  for (const boundary of ['entry', 'pre-CAS', 'precommit']) {
    test(`constructor substitution: ${admission ? 'resumed admission' : 'repair'} ${boundary} refuses and revokes after restoration`, async t => {
      const f = await repairFixture(t, { running: !admission });
      if (admission) assert.equal(f.repair().kind, 'resumed');
      const request = admission ? f.issuer.issue(f) : undefined;
      const proto = BotOwnershipLock.prototype, held = proto.assertHeld;
      const instanceHeld = f.lock.assertHeld, bytes = readFileSync(f.lock.path);
      const point = admission
        ? boundary === 'pre-CAS' ? 'beforeExecutionCas' : 'afterExecutionCas'
        : boundary === 'pre-CAS' ? 'beforeRestartCas' : 'beforeRestartCommit';
      const invalidate = () => {
        f.lock.assertHeld = function () {};
        writeFileSync(f.lock.path, 'owned constructor substitution fixture\n');
      };
      let store;
      try {
        proto.assertHeld = function () {};
        store = f.makeStore(boundary === 'entry' ? {} : { [point]: invalidate });
      } finally { proto.assertHeld = held; }
      assert.equal(proto.assertHeld, held, 'Restore the original before the public operation');
      try {
        if (boundary === 'entry') invalidate();
        const observation = observe(f, () => admission ? f.start(store, request) : f.repair(store));
        f.db.close(); f.db = f.connect();
        const reopened = state(f.db);
        record({ phase: 'constructor-substitution-reopen', admission, boundary,
          canonicalPrototypeRestoredBeforeOperation: proto.assertHeld === held,
          ...observation, reopened, error: observation.error && { message: observation.error.message } });
        assert.ok(observation.error, 'The constructor cannot replace the canonical lease check');
        assert.deepEqual(observation.before, observation.after);
        assert.deepEqual(reopened, observation.before);
        assert.equal(observation.afterChanges - observation.beforeChanges,
          boundary === 'precommit' ? admission ? 1 : 2 : 0);
        if (boundary !== 'precommit') {
          assert.equal(observation.sql.filter(sql => /^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)).length, 0);
          if (boundary === 'entry') assert.equal(observation.sql.length, 0);
        }
      } finally {
        f.lock.assertHeld = instanceHeld;
        writeFileSync(f.lock.path, bytes);
      }
      const restored = observe(f, () => admission ? f.start(f.makeStore(), request) : f.repair(f.makeStore()));
      assert.ok(restored.error);
      assert.deepEqual(restored.before, restored.after);
      assert.equal(restored.beforeChanges, restored.afterChanges);
      assert.equal(restored.sql.length, 0);
    });
  }

  test(`constructor substitution: pinned previous-child method still requires a native fact for ${admission ? 'resumed admission' : 'repair'}`, async t => {
    const f = await repairFixture(t, { running: !admission });
    if (admission) assert.equal(f.repair().kind, 'resumed');
    const request = admission ? f.issuer.issue(f) : undefined;
    // A valid ordinary lease has no native previous-child observation.
    const other = new BotOwnershipLock(f.dir + '/ordinary-lease').acquire();
    const proto = BotOwnershipLock.prototype, previous = proto.assertPreviousChildExited;
    let store;
    try {
      proto.assertPreviousChildExited = function () {};
      store = f.makeStore({}, { lock: other, expected: f.binding.expected });
    } finally { proto.assertPreviousChildExited = previous; }
    assert.equal(proto.assertPreviousChildExited, previous);
    try {
      const observation = observe(f, () => admission ? f.start(store, request) : f.repair(store));
      assert.ok(observation.error);
      assert.deepEqual(observation.before, observation.after);
      assert.equal(observation.beforeChanges, observation.afterChanges);
      assert.equal(observation.sql.length, 0);
    } finally { other.release(); }
  });

  test(`authentic binding preserves healthy ${admission ? 'resumed admission' : 'repair'} after later prototype mutation`, async t => {
    const f = await repairFixture(t, { running: !admission });
    if (admission) assert.equal(f.repair().kind, 'resumed');
    const request = admission ? f.issuer.issue(f) : undefined;
    const store = f.makeStore(), proto = BotOwnershipLock.prototype;
    const held = proto.assertHeld, previous = proto.assertPreviousChildExited;
    let observation;
    try {
      // Preserve instance dispatch while proving later prototype properties are
      // not selected as either canonical implementation.
      f.lock.assertHeld = held;
      proto.assertHeld = proto.assertPreviousChildExited = function () { throw new Error('later prototype replacement'); };
      observation = observe(f, () => admission ? f.start(store, request) : f.repair(store));
    } finally {
      proto.assertHeld = held; proto.assertPreviousChildExited = previous;
      delete f.lock.assertHeld;
    }
    assert.equal(observation.error, undefined);
    assert.equal(observation.result.kind, admission ? 'admitted' : 'repaired');
    f.db.close(); f.db = f.connect();
    assert.deepEqual(state(f.db), observation.after);
    record({ phase: 'authentic-construction-reopen', admission, ...observation, reopened: state(f.db) });
  });
}
