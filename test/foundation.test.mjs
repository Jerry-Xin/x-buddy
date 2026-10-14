// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foundation } from '../dist/index.js';
test('published entry identifies the bootstrap without runtime side effects', () => {
  assert.deepEqual(foundation, { name: 'x-buddy', stage: 'bootstrap' });
  assert.ok(Object.isFrozen(foundation));
});
