// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { exceptionsFor, loadManifest, sha256 } from './lib/manifest.mjs';
const manifest = loadManifest();
const TRANSFORMS = new Set(['none', 'import-path', 'path-literal', 'spdx-header', 'change-notice', 'shebang']);
assert.deepEqual(new Set(manifest.transformEnum), TRANSFORMS, 'transform enum changed');
const IMPORTED_PATHS = /^(?:src\/octo|src\/host|test\/host)\//;
const destinations = new Set();
const claim = (destination) => {
  assert.ok(!destinations.has(destination), `duplicate destination ${destination}`);
  destinations.add(destination);
};

// The LICENSE asset keeps its original v1 record.
assert.equal(manifest.assets.length, 1);
for (const asset of manifest.assets) {
  assert.match(asset.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(asset.sourceLicense, 'Apache-2.0');
  assert.equal(asset.destination, 'LICENSE');
  claim(asset.destination);
  assert.equal(sha256(readFileSync(asset.destination)), asset.sha256);
}

let imported = 0;
let authored = 0;
for (const entry of manifest.imports) {
  claim(entry.destination);
  assert.match(entry.destination, IMPORTED_PATHS, `import outside the selective-import paths: ${entry.destination}`);
  assert.equal(sha256(readFileSync(entry.destination)), entry.destinationSha256, `destination hash mismatch: ${entry.destination}`);
  if (entry.kind === 'authored') {
    assert.match(entry.reason ?? '', /\S/);
    authored += 1;
    continue;
  }
  assert.equal(entry.kind, 'imported');
  assert.match(entry.sourceRepository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(entry.sourceGitBlob, /^[a-f0-9]{40}$/, `sourceGitBlob must be a git SHA-1: ${entry.destination}`);
  assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(entry.sourceLicense, 'Apache-2.0');
  assert.ok(entry.transforms.length > 0, `no transforms recorded: ${entry.destination}`);
  for (const t of entry.transforms) assert.ok(TRANSFORMS.has(t), `unknown transform ${t} in ${entry.destination}`);
  imported += 1;
}

// The DEV-00 entry data must stay identical to what verify-port.mjs proves.
const portEntries = JSON.parse(readFileSync('docs/host-baseline/import-entries.json', 'utf8')).entries;
const strip = ({ kind, ...rest }) => ({ kind: kind ?? 'imported', ...rest });
const normalize = (list) => JSON.stringify(list.map(strip).map((e) => Object.fromEntries(Object.entries(e).sort())).sort((a, b) => a.destination.localeCompare(b.destination)));
assert.equal(normalize(manifest.imports), normalize(portEntries), 'manifest imports differ from docs/host-baseline/import-entries.json');

const tracked = execFileSync('git', ['ls-files', '-z', 'src/octo', 'src/host', 'test/host'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const path of tracked) assert.ok(destinations.has(path), `unlisted file under selective-import paths: ${path}`);

const exceptionCount = exceptionsFor(manifest, 'eslint').length + exceptionsFor(manifest, 'security').length;
console.log(`Import manifest v2 verified: LICENSE asset, ${imported} imported and ${authored} authored entries, ${exceptionCount} line-bound exceptions.`);
