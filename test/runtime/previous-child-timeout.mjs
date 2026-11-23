// SPDX-License-Identifier: Apache-2.0
// Explicit long selection: real native 30s wait plus collection exceeds the normal file deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { owned, gone, trace } from './lifecycle-fixture.mjs';
test('real 30-second maximum refuses a late child; elapsed time never certifies exit', { timeout: 45_000 }, async t => {
  const o = await owned(t, 31_500); await o.killParent(); const start = performance.now();
  const lock = new BotOwnershipLock(o.dir); const before = readFileSync(lock.path, 'utf8');
  let dbAccess = 0, homeAccess = 0;
  await assert.rejects(async () => { await lock.reconcilePreviousChild('owned-test-bot'); dbAccess++; homeAccess++; },
    error => error.reason === 'exit-timeout');
  assert.equal(dbAccess, 0); assert.equal(homeAccess, 0); assert.equal(readFileSync(lock.path, 'utf8'), before);
  trace({ phase: 'refusal', reason: 'exit-timeout', dbAccess, homeAccess, retainedLock: before });
  const elapsed = performance.now() - start; assert.ok(elapsed >= 30_000 && elapsed < 34_000);
  assert.equal(gone(o.record.child.pid), false); trace({ phase: '30-second-timeout', elapsed, child: o.record.child });
});
