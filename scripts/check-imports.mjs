// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import assert from 'node:assert/strict';
import { exceptionsFor, loadManifest, sha256 } from './lib/manifest.mjs';
const manifest = loadManifest();
const TRANSFORMS = new Set(['none', 'import-path', 'path-literal', 'spdx-header', 'change-notice', 'shebang']);
assert.deepEqual(new Set(manifest.transformEnum), TRANSFORMS, 'transform enum changed');
const IMPORTED_PATHS = /^(?:src\/octo|src\/host|test\/host)\//;
// The authoritative source set of the pin, held in reviewed code rather than
// in the editable JSON: every file under src/ at codex-channel-octo@dd12980,
// as `git ls-tree -r <pin> src`, one `<sourcePath>\t<git blob SHA-1>\n` line
// per file, sorted by path. Dropping, adding or re-pointing a file, even
// together with its manifest entries, changes this digest.
const PIN_SOURCE_SET = { count: 84, sha256: 'dcba872fc0befd9cb2df5d899f99a38afea64018d595521c9007856bc8aefc0c' };
const PIN_COMMIT = 'dd1298083d014d8e82376c01edb38a2e6914366f';
const SPDX = '// SPDX-License-Identifier: Apache-2.0\n';
const SHEBANG = '#!/usr/bin/env node\n';
// The only path-literal transforms recorded by DEV-00: [destination text, pin text].
const PATH_LITERALS = {
  'src/gateway.ts': ["_require('../../package.json')", "_require('../package.json')"],
  'src/cli.ts': ["new URL('../../package.json', import.meta.url)", "new URL('../package.json', import.meta.url)"],
};
const gitBlob = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
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

const importedEntries = manifest.imports.filter((e) => e.kind !== 'authored');
const pinLines = importedEntries.map((e) => `${e.sourcePath}\t${e.sourceGitBlob}\n`).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
assert.equal(new Set(importedEntries.map((e) => e.sourcePath)).size, importedEntries.length, 'duplicate sourcePath in manifest imports');
assert.equal(importedEntries.length, PIN_SOURCE_SET.count, `expected ${PIN_SOURCE_SET.count} imported pin sources, found ${importedEntries.length}`);
assert.equal(sha256(pinLines.join('')), PIN_SOURCE_SET.sha256, 'imported (sourcePath, sourceGitBlob) set differs from the pinned dd12980 src/ tree');

// Port fidelity without a pin checkout: undo the recorded transforms on the
// destination bytes and require the git blob SHA-1 and raw sha256 of the
// result to equal the pinned source. Any edit to an imported file, including
// one with refreshed manifest hashes, fails here.
const destToSource = new Map(importedEntries.map((e) => [e.destination, e.sourcePath]));
let rewrites = 0;
for (const entry of importedEntries) {
  assert.equal(entry.sourceCommit, PIN_COMMIT, `unexpected sourceCommit: ${entry.destination}`);
  let text = readFileSync(entry.destination, 'utf8');
  const notice = `// Derived from Mininglamp-OSS/codex-channel-octo@${PIN_COMMIT.slice(0, 12)} ${entry.sourcePath}; changes: ${entry.transforms.join(', ')}.\n`;
  assert.ok(entry.transforms.includes('spdx-header') && entry.transforms.includes('change-notice'), `header transforms missing: ${entry.destination}`);
  assert.ok(text.startsWith(SPDX + notice), `header or change notice mismatch: ${entry.destination}`);
  text = text.slice(SPDX.length + notice.length);
  if (entry.transforms.includes('shebang')) text = SHEBANG + text;
  const literal = PATH_LITERALS[entry.sourcePath];
  assert.equal(entry.transforms.includes('path-literal'), Boolean(literal), `path-literal record mismatch: ${entry.destination}`);
  if (literal) {
    assert.equal(text.split(literal[0]).length, 2, `path literal not found exactly once: ${entry.destination}`);
    text = text.replace(literal[0], literal[1]);
  }
  let fileRewrites = 0;
  text = text.replace(/(['"])(\.\.?\/[^'"\n]+?\.js)\1/g, (match, quote, spec) => {
    const target = posix.normalize(posix.join(posix.dirname(entry.destination), spec)).replace(/\.js$/, '.ts');
    const targetSource = destToSource.get(target);
    if (!targetSource) return match;
    let rel = posix.relative(posix.dirname(entry.sourcePath), targetSource.replace(/\.ts$/, '.js'));
    if (!rel.startsWith('.')) rel = './' + rel;
    if (rel !== spec) fileRewrites += 1;
    return quote + rel + quote;
  });
  assert.equal(fileRewrites > 0, entry.transforms.includes('import-path'), `import-path record mismatch: ${entry.destination}`);
  rewrites += fileRewrites;
  const source = Buffer.from(text, 'utf8');
  assert.equal(gitBlob(source), entry.sourceGitBlob, `inverted bytes do not match the pinned git blob: ${entry.destination}`);
  assert.equal(sha256(source), entry.sourceSha256, `inverted bytes do not match the pinned source sha256: ${entry.destination}`);
}

// The DEV-00 entry data must stay identical to what verify-port.mjs proves.
const portEntries = JSON.parse(readFileSync('docs/host-baseline/import-entries.json', 'utf8')).entries;
const strip = ({ kind, ...rest }) => ({ kind: kind ?? 'imported', ...rest });
const normalize = (list) => JSON.stringify(list.map(strip).map((e) => Object.fromEntries(Object.entries(e).sort())).sort((a, b) => a.destination.localeCompare(b.destination)));
assert.equal(normalize(manifest.imports), normalize(portEntries), 'manifest imports differ from docs/host-baseline/import-entries.json');

const tracked = execFileSync('git', ['ls-files', '-z', 'src/octo', 'src/host', 'test/host'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const path of tracked) assert.ok(destinations.has(path), `unlisted file under selective-import paths: ${path}`);

const exceptionCount = exceptionsFor(manifest, 'eslint').length + exceptionsFor(manifest, 'security').length;
console.log(`Import manifest v2 verified: LICENSE asset, ${imported} imported files equal to the pinned dd12980 blobs after inverting their transforms (${rewrites} specifier rewrites), ${authored} authored entries, ${exceptionCount} line-bound exceptions.`);
