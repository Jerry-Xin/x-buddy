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

// Only the ten explicitly approved host overlays are admitted. JSON cannot extend
// this allowlist or refresh its byte pins. All six mechanical transforms remain.
const SEMANTIC_PATCHES = {
  "src/host/index.ts": {
    "original": "docs/host-baseline/semantic/index.original.ts",
    "patch": "docs/host-baseline/semantic/index.patch",
    "preimageSha256": "aa08b47bd6b7dbafe266495c43a77c9a735a9c6d4bf931c03d4c132be9ea3367",
    "patchSha256": "6d9ae57d4eae3face3eef876f8709a89be30a6e8b788e1b2a6bfb834ad04fc39",
    "postimageSha256": "26d42c0ddbe5e6730f57d622070c304771bab00f947ba54977de1b0df8187e35"
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
    "patchSha256": "2b12c533eff7074f23b05115c0c7d492b6a968ddb22a2a7512bd2e7d2fcfbfe1",
    "postimageSha256": "93d4026dbe382d4955b45f84037d5084cccc09c861ffbcaf95c37382a883dbf8"
  },
  "src/host/session-router.ts": {
    "original": "docs/host-baseline/semantic/session-router.original.ts",
    "patch": "docs/host-baseline/semantic/session-router.patch",
    "preimageSha256": "075922777f80c0981555a3e9193383ce8d94d88247e2a0b7afe63c92bb906794",
    "patchSha256": "07cfff124ceae1a2a83c4aef1a58239cff186d4a5a4d1687c579406d8063dc50",
    "postimageSha256": "f0f1f5e44039f3fad84618eaa38b22a69a4f8a5fe9447f990c46dcd34ac18c84"
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
  },
  "src/host/commands.ts": {
    "original": "docs/host-baseline/semantic/commands.original.ts",
    "patch": "docs/host-baseline/semantic/commands.patch",
    "preimageSha256": "9c357d7680167ae2e936a7021ef269b8ece66740a16bbaecde42d554c698a326",
    "patchSha256": "97d1ee0ff8f6c188f8c7cfd0f5d2789f03444dd7579dc9e732c0e956d8ef7ae0",
    "postimageSha256": "07055a1ef36690bd1d0a6ac7306327789b31c6aa16390d958aefd9ca6157bdc8"
  },
  "src/host/stream-relay.ts": {
    "original": "docs/host-baseline/semantic/stream-relay.original.ts",
    "patch": "docs/host-baseline/semantic/stream-relay.patch",
    "preimageSha256": "2a4488d5f6a32ff1477cef196b5f5c3cc19b4d7b388ded187e43c0168c7f42cc",
    "patchSha256": "61d05f392535466dc4920c867654086a160f37c00a9959164fe783add0b9a6a9",
    "postimageSha256": "e2ba79e32c91c008eeb3cc6f9697228b44c45630b851da08dca7b15eb868acd1"
  },
  "src/host/config.ts": {
    "original": "docs/host-baseline/semantic/config.original.ts",
    "patch": "docs/host-baseline/semantic/config.patch",
    "preimageSha256": "e87e43bfa71c46e2bfc1eb323c8e9257c89207d3fbe296746323e5096b4b6a5c",
    "patchSha256": "53fba6ab0710611798a52743ecacdd042ed92c228a6a904e601b98a9046c6e4e",
    "postimageSha256": "b57e4b29a53ca1bc4edf46461513c687ff776cf545857e37d4f587175a0f9f62"
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
function verifyOutboundConfinement() {
  const candidates = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src/host', 'src/runtime'], { encoding: 'utf8' })
    .split('\0')
    .filter((p) => p.endsWith('.ts') && p !== 'src/runtime/octo-egress.ts');
  const forbiddenApiSpec = /(?:import|export)\s+(?:type\s+)?([^;\n]*?)\s+from\s+['"][^'"]*octo\/api\.js['"]/g;
  const forbiddenDynamic = /(?:import|require)\s*\(\s*['"][^'"]*octo\/api(?:\.js)?['"]\s*\)/;
  const forbiddenClient = /(?:import|export)\s+[^;\n]*?\bOctoApiClient\b[^;\n]*?from\s+['"][^'"]*api-client\.js['"]/;
  const forbiddenSymbols = /\b(?:sendMessage|sendTyping|sendReadReceipt)\b/;
  for (const file of candidates) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!forbiddenDynamic.test(content), `B5 outbound confinement violation (dynamic octo/api import): ${file}`);
    assert.ok(!forbiddenClient.test(content), `B5 outbound confinement violation (direct OctoApiClient import): ${file}`);
    for (const match of content.matchAll(forbiddenApiSpec)) {
      const clause = match[1] ?? '';
      assert.ok(!clause.includes('*'), `B5 outbound confinement violation (wildcard octo/api import/re-export): ${file}`);
      assert.ok(!forbiddenSymbols.test(clause), `B5 outbound confinement violation (direct outbound API import/re-export): ${file}`);
    }
  }
}
verifyOutboundConfinement();
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
