// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { repairFixture, observe } from './restart-fixture.mjs';
test('actual restart repair: replacing an instance method cannot bypass the canonical lease check', async t => {
  const f = await repairFixture(t), bytes = readFileSync(f.lock.path), held = f.lock.assertHeld;
  let result;
  try {
    f.lock.assertHeld = () => {}; // Controlled in-process corruption of the consumer object.
    writeFileSync(f.lock.path, 'invalidated owned fixture\n');
    result = observe(f, () => f.repair());
  } finally { f.lock.assertHeld = held; writeFileSync(f.lock.path, bytes); }
  assert.ok(result.error, 'Canonical lease validation must not dispatch through the substituted instance method');
  assert.deepEqual(result.after, result.before); assert.equal(result.afterChanges, result.beforeChanges);
  assert.equal(result.sql.length, 0);
  assert.throws(() => f.repair(), /not-reconciled|ownership|invalidated/i);
});
