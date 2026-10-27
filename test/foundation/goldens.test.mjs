// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check } from './tools/check-goldens.mjs';
import { URL } from 'node:url';

test('golden manifest: digests, regeneration and spec-source pins verify', async () => {
  const report = await check();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.verified, ['wire.v1']);
});

test('planned generators are listed as pending, not omitted', async () => {
  const report = await check();
  assert.deepEqual(report.pending, ['b-pure-functions', 'oc-schedule']);
});

test('every source pin names a 40-hex commit, a blob id and a license', () => {
  const pins = JSON.parse(readFileSync(new URL('../../docs/test-foundation/source-pins.json', import.meta.url), 'utf8'));
  for (const s of pins.sources) {
    assert.match(s.commit, /^[a-f0-9]{40}$/, s.id);
    assert.match(s.blob, /^[a-f0-9]{40}$/, s.id);
    assert.ok(['Apache-2.0', 'MIT'].includes(s.license), s.id);
  }
});
