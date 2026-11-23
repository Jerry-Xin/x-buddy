// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './tools/check-scope.mjs';

test('scope guard accepts owned paths and rejects product source and shared files', () => {
  const { outside } = classify([
    'A\ttest/foundation/lib/clock.mjs', 'M\tpackage.json', 'A\tdocs/test-foundation/README.md', 'M\t.github/workflows/ci.yml',
    'M\tsrc/index.ts', 'A\tsrc/octo/socket.ts', 'R100\ttest/foundation/a.mjs\tsrc/a.ts', 'M\tscripts/check-security.mjs',
  ]);
  assert.deepEqual(outside.map(c => c.paths.at(-1)), ['src/index.ts', 'src/octo/socket.ts', 'src/a.ts', 'scripts/check-security.mjs']);
});
