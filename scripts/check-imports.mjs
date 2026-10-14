// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('docs/import-manifest.json', 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.assets.length, 1);
const destinations = new Set();
for (const asset of manifest.assets) {
  assert.match(asset.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(asset.sourceLicense, 'Apache-2.0');
  assert.equal(asset.destination, 'LICENSE');
  assert.ok(!destinations.has(asset.destination));
  destinations.add(asset.destination);
  assert.equal(createHash('sha256').update(readFileSync(asset.destination)).digest('hex'), asset.sha256);
}
console.log('Pinned import checksums verified; LICENSE is the sole imported asset.');
