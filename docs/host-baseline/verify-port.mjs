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
import { loadManifest, exceptionsFor } from '../../scripts/lib/manifest.mjs';

const sourceRepo = process.argv[2];
assert.ok(sourceRepo, 'usage: verify-port.mjs <codex-channel-octo checkout>');

// Only the seven explicitly approved host overlays are admitted. JSON cannot extend
// this allowlist or refresh its byte pins. All six mechanical transforms remain.
const SEMANTIC_PATCHES = {
  "src/host/index.ts": {
    "original": "docs/host-baseline/semantic/index.original.ts",
    "patch": "docs/host-baseline/semantic/index.patch",
    "preimageSha256": "aa08b47bd6b7dbafe266495c43a77c9a735a9c6d4bf931c03d4c132be9ea3367",
    "patchSha256": "75e85cfb12055b4d3c85ddf7975252c169461855c02774692b5503b481dd5e0d",
    "postimageSha256": "857c27ba154890591acef24edb472a5d256674287a253c892815799ecca016d9"
  },
  "src/host/gateway.ts": {
    "original": "docs/host-baseline/semantic/gateway.original.ts",
    "patch": "docs/host-baseline/semantic/gateway.patch",
    "preimageSha256": "43f0765b9f5826384c320c1b449bbd8fc49fce23dfff2f1833ddfcd61315266a",
    "patchSha256": "1253d69752f83c9bfa7d4a7f25b64dd9b58ebc977aeb78444600a1d0b4ebe19b",
    "postimageSha256": "dff8be3ce07ffda7ff46a82532dc1725a91897669df46de793e7cbc976c78c43"
  },
  "src/host/bot-manager.ts": {
    "original": "docs/host-baseline/semantic/bot-manager.original.ts",
    "patch": "docs/host-baseline/semantic/bot-manager.patch",
    "preimageSha256": "b4f1cb48316ea54ce6f421434fca53314ad5e83fecbf061be55fa1b3c42fb621",
    "patchSha256": "f305bc8e4dc21413cf6939a8e2a35fcc88c00f100076dc2b1984e4c6116784e1",
    "postimageSha256": "39e7e11980c5299dc891b6d8219c79da4f5f680ee21a43f4398b83bdc47227ec"
  },
  "src/host/agent-bridge.ts": {
    "original": "docs/host-baseline/semantic/agent-bridge.original.ts",
    "patch": "docs/host-baseline/semantic/agent-bridge.patch",
    "preimageSha256": "6edc2cacf9564d9215c0e9d542bb3a2295d50012a1a9e1c6b29b373c55ea9fb8",
    "patchSha256": "6b937125acac6401bf09da437c23d3919b2dc91dc04e0a6de804a1beea86a49b",
    "postimageSha256": "61b51cf3f5027eb328e7830a09e46a64251972ee054beb49b2a1e9a4c956d6a6"
  },
  "src/host/session-router.ts": {
    "original": "docs/host-baseline/semantic/session-router.original.ts",
    "patch": "docs/host-baseline/semantic/session-router.patch",
    "preimageSha256": "075922777f80c0981555a3e9193383ce8d94d88247e2a0b7afe63c92bb906794",
    "patchSha256": "4511a0f55d57b9a7b57746105e1620430c4419b00e05f66fad542f2e8e932b41",
    "postimageSha256": "81e9d268ed04cf21b60ee874012942b2958a86858edf0cf7a4aba410e537ceae"
  },
  "src/host/session-store.ts": {
    "original": "docs/host-baseline/semantic/session-store.original.ts",
    "patch": "docs/host-baseline/semantic/session-store.patch",
    "preimageSha256": "942367a2c35cd846c7bed5660ff1c4cc180625002ebce69125ef358369d045af",
    "patchSha256": "0405c973745e2ddaea3993eaa10dcf7db889d237eec136095c6d839759c82625",
    "postimageSha256": "1a48b1057383be346550697885b3b3fe5ec00056fdca4f16d0e2a7b14f6ae44b"
  },
  "src/host/db-adapter.ts": {
    "original": "docs/host-baseline/semantic/db-adapter.original.ts",
    "patch": "docs/host-baseline/semantic/db-adapter.patch",
    "preimageSha256": "d891cc8a9107e314b667c0d3d4e0cefc6c41a0c2ea0ae8a481e760b931f0b0ec",
    "patchSha256": "ff145e8683d87dd57f9703363f05d3462b44e94ea020ed5919f97f84254dc4f1",
    "postimageSha256": "018a17926d9531cbacf5a0ee5a11b22c3e6dcd5fc1fcfbdeb0766142f8f4a365"
  }
};
function invertSemanticPatch(entry, destination) {
  const expected = SEMANTIC_PATCHES[entry.destination];
  if (!expected) {
    assert.equal(entry.semanticPatch, undefined, `semantic patch not approved: ${entry.destination}`);
    return destination;
  }
  assert.deepEqual(entry.semanticPatch, expected, `semantic patch record mismatch: ${entry.destination}`);
  const original = readFileSync(expected.original, 'utf8');
  const patch = readFileSync(expected.patch, 'utf8');
  assert.equal(sha256(original), expected.preimageSha256, 'semantic preimage hash mismatch');
  assert.equal(sha256(patch), expected.patchSha256, 'semantic patch hash mismatch');
  assert.equal(sha256(destination), expected.postimageSha256, 'semantic postimage hash mismatch');
  const lines = patch.split('\n');
  assert.equal(lines.shift(), `diff --git a/${entry.destination} b/${entry.destination}`);
  assert.match(lines.shift(), /^index [a-f0-9]+\.\.[a-f0-9]+ 100644$/);
  assert.equal(lines.shift(), `--- a/${entry.destination}`);
  assert.equal(lines.shift(), `+++ b/${entry.destination}`);
  assert.equal(lines.pop(), '');
  function apply(text, reverse) {
    assert.ok(text.endsWith('\n'), 'semantic input must end in a newline');
    const input = text.slice(0, -1).split('\n'), output = [];
    let cursor = 0, i = 0;
    while (i < lines.length) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[i++]);
      assert.ok(h, 'invalid semantic hunk');
      const oldStart = Number(h[reverse ? 3 : 1]) - 1;
      const oldCount = Number(h[reverse ? 4 : 2] ?? 1), newCount = Number(h[reverse ? 2 : 4] ?? 1);
      assert.ok(oldStart >= cursor && oldStart <= input.length, 'overlapping semantic hunk');
      output.push(...input.slice(cursor, oldStart)); cursor = oldStart;
      let consumed = 0, produced = 0;
      while (i < lines.length && !lines[i].startsWith('@@ ')) {
        const line = lines[i++]; let op = line[0]; const body = line.slice(1);
        assert.ok([' ', '+', '-'].includes(op), 'unexpected semantic patch data');
        if (reverse && op !== ' ') op = op === '+' ? '-' : '+';
        if (op !== '+') { assert.equal(input[cursor++], body, 'semantic preimage/context mismatch'); consumed++; }
        if (op !== '-') { output.push(body); produced++; }
      }
      assert.equal(consumed, oldCount); assert.equal(produced, newCount);
    }
    output.push(...input.slice(cursor)); return output.join('\n')+'\n';
  }
  assert.equal(apply(original, false), destination, 'semantic forward patch mismatch');
  const inverted = apply(destination, true);
  assert.equal(inverted, original, 'semantic inverse patch mismatch');
  return inverted;
}
// END SEMANTIC PATCH VALIDATION
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
assert.equal(imported.length, 84, 'expected 84 imported pin sources');
const pinLines = imported.map(e => `${e.sourcePath}\t${e.sourceGitBlob}\n`).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
assert.equal(sha256(pinLines.join('')), 'dcba872fc0befd9cb2df5d899f99a38afea64018d595521c9007856bc8aefc0c', 'pinned source set mismatch');
const manifest = loadManifest();
const normalize = list => JSON.stringify(list.map(({kind, ...rest}) => ({kind:kind ?? 'imported',...rest})).map(e => Object.fromEntries(Object.entries(e).sort())).sort((a,b) => a.destination.localeCompare(b.destination)));
assert.equal(normalize(manifest.imports), normalize(entries), 'synchronized import entries differ');
exceptionsFor(manifest, 'eslint'); exceptionsFor(manifest, 'security');

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

  let text = invertSemanticPatch(entry, dest.toString('utf8'));
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
