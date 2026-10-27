// SPDX-License-Identifier: Apache-2.0
// DEV-00 port-fidelity proof. Not wired into npm scripts or CI; the foundation
// writer owns validator integration.
//
// Usage: node docs/host-baseline/verify-port.mjs <codex-channel-octo checkout>
//
// For every imported entry in import-entries.json this script
//   1. checks destinationSha256 against the working tree;
//   2. reads the pinned source blob from the given checkout (git cat-file) and
//      checks sourceSha256 and sourceGitBlob;
//   3. inverts the recorded transforms (strip SPDX + change notice, restore the
//      shebang, revert the listed path literals, map relative specifiers back)
//      and requires the result to be byte-identical to the pinned source.
// It also fails on unlisted files under the DEV-00 paths and on transforms
// outside the enum. Step 3 is what proves that the listed transforms are the
// only differences from the pin.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { URL } from 'node:url';
import assert from 'node:assert/strict';

const sourceRepo = process.argv[2];
assert.ok(sourceRepo, 'usage: verify-port.mjs <codex-channel-octo checkout>');

const TRANSFORMS = new Set(['none', 'import-path', 'path-literal', 'spdx-header', 'change-notice', 'shebang']);
const OWNED = /^(?:src\/octo|src\/host|test\/host)\//;
const SPDX = '// SPDX-License-Identifier: Apache-2.0\n';
const PATH_LITERALS = {
  'src/gateway.ts': ["_require('../../package.json')", "_require('../package.json')"],
  'src/cli.ts': ["new URL('../../package.json', import.meta.url)", "new URL('../package.json', import.meta.url)"],
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const { entries } = JSON.parse(readFileSync(new URL('./import-entries.json', import.meta.url), 'utf8'));

const imported = entries.filter((e) => e.kind !== 'authored');
const destToSource = new Map(imported.map((e) => [e.destination, e.sourcePath]));
const destinations = new Set();
let lineDeltas = 0;

for (const entry of entries) {
  assert.ok(!destinations.has(entry.destination), `duplicate destination ${entry.destination}`);
  destinations.add(entry.destination);
  assert.match(entry.destination, OWNED, `destination outside DEV-00 paths: ${entry.destination}`);
  const dest = readFileSync(entry.destination);
  assert.equal(sha256(dest), entry.destinationSha256, `destination hash mismatch: ${entry.destination}`);
  if (entry.kind === 'authored') continue;

  assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/);
  for (const t of entry.transforms) assert.ok(TRANSFORMS.has(t), `unknown transform ${t} in ${entry.destination}`);
  const source = execFileSync('git', ['-C', sourceRepo, 'cat-file', 'blob', `${entry.sourceCommit}:${entry.sourcePath}`]);
  assert.equal(sha256(source), entry.sourceSha256, `source hash mismatch: ${entry.sourcePath}`);
  const blob = execFileSync('git', ['-C', sourceRepo, 'rev-parse', `${entry.sourceCommit}:${entry.sourcePath}`], { encoding: 'utf8' }).trim();
  assert.equal(blob, entry.sourceGitBlob, `git blob mismatch: ${entry.sourcePath}`);

  let text = dest.toString('utf8');
  const notice = `// Derived from Mininglamp-OSS/codex-channel-octo@${entry.sourceCommit.slice(0, 12)} ${entry.sourcePath}; changes: ${entry.transforms.join(', ')}.\n`;
  assert.ok(text.startsWith(SPDX + notice), `header or change notice mismatch: ${entry.destination}`);
  text = text.slice(SPDX.length + notice.length);
  if (entry.transforms.includes('shebang')) text = '#!/usr/bin/env node\n' + text;
  if (entry.transforms.includes('path-literal')) {
    const [now, was] = PATH_LITERALS[entry.sourcePath];
    assert.equal(text.split(now).length, 2, `path literal not found exactly once: ${entry.destination}`);
    text = text.replace(now, was);
  }
  let rewrites = 0;
  text = text.replace(/(['"])(\.\.?\/[^'"\n]+?\.js)\1/g, (match, quote, spec) => {
    const target = posix.normalize(posix.join(posix.dirname(entry.destination), spec)).replace(/\.js$/, '.ts');
    const targetSource = destToSource.get(target);
    if (!targetSource) return match;
    let rel = posix.relative(posix.dirname(entry.sourcePath), targetSource.replace(/\.ts$/, '.js'));
    if (!rel.startsWith('.')) rel = './' + rel;
    if (rel !== spec) rewrites += 1;
    return quote + rel + quote;
  });
  assert.equal(rewrites > 0, entry.transforms.includes('import-path'), `import-path transform record mismatch: ${entry.destination}`);
  assert.ok(Buffer.from(text, 'utf8').equals(source), `inverse transform is not byte-identical to the pin: ${entry.destination}`);
  lineDeltas += rewrites;
}

const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src/octo', 'src/host', 'test/host'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
for (const path of tracked) assert.ok(destinations.has(path), `unlisted file under DEV-00 paths: ${path}`);

const authored = entries.length - imported.length;
console.log(`Port fidelity verified: ${imported.length} imported files byte-identical to the pin after inverting the listed transforms (${lineDeltas} specifier rewrites); ${authored} authored file(s); no unlisted files.`);
