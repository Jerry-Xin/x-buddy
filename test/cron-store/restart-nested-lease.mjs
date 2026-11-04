// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { repairFixture, observe, record, state } from './restart-fixture.mjs';

// Controlled synchronous re-entry, after public reserve/start and genuine native
// exit. Only the instance method changes; both canonical methods stay intact.
for (const loss of ['content', 'directory']) {
  for (const path of ['repair-entry', 'beforeRestartCas', 'beforeRestartCommit',
    'admission-entry', 'beforeExecutionCas', 'afterExecutionCas']) {
    test(`nested lease loss: ${loss} at ${path}, persistent rollback and revocation after restoration`, async t => {
      const admission = path.includes('admission') || path.includes('Execution');
      const f = await repairFixture(t, { running: !admission });
      if (admission) assert.equal(f.repair().kind, 'resumed');
      const request = admission ? f.issuer.issue(f) : undefined;
      const bytes = readFileSync(f.lock.path), original = f.lock.assertHeld;
      let armed = path.endsWith('entry'), injected = 0;
      f.lock.assertHeld = function () {
        if (armed && new Error().stack.includes('assertPreviousChildExited')) {
          injected++;
          if (loss === 'content') writeFileSync(f.lock.path, 'nested re-entry invalidated owned lease\n');
          else chmodSync(f.o.dir, 0o755);
        }
      };
      let observed;
      try {
        const store = f.makeStore(path.endsWith('entry') ? {} : { [path]() { armed = true; } });
        observed = observe(f, () => admission ? f.start(store, request) : f.repair(store));
        f.db.close(); f.db = f.connect();
        const reopened = state(f.db);
        record({ phase: 'nested-lease-reopen', loss, path, injected, ...observed, reopened,
          error: observed.error && { name: observed.error.name, message: observed.error.message } });
        assert.equal(injected, 1);
        assert.ok(observed.error, 'Final canonical lease validation must refuse');
        assert.deepEqual(observed.after, observed.before);
        assert.deepEqual(reopened, observed.before);
        if (['beforeRestartCommit', 'afterExecutionCas'].includes(path)) {
          assert.ok(observed.afterChanges > observed.beforeChanges, 'Precommit rollback includes attempted DML');
        } else {
          assert.equal(observed.afterChanges, observed.beforeChanges);
          assert.equal(observed.sql.filter(sql => /^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)).length, 0);
          if (path.endsWith('entry')) assert.equal(observed.sql.length, 0);
        }
      } finally {
        f.lock.assertHeld = original;
        writeFileSync(f.lock.path, bytes); chmodSync(f.o.dir, 0o700);
      }
      // Restoring a sampled invalid lease cannot recreate its revoked native fact.
      const restored = observe(f, () => admission ? f.start(f.makeStore(), request) : f.repair(f.makeStore()));
      assert.ok(restored.error);
      assert.deepEqual(restored.after, restored.before);
      assert.equal(restored.afterChanges, restored.beforeChanges); assert.equal(restored.sql.length, 0);
    });
  }
}
