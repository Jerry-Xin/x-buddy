// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import assert from 'node:assert/strict';
import { exceptionsFor, loadManifest, sha256 } from './lib/manifest.mjs';
const manifest = loadManifest();
// Only the ten explicitly approved host overlays are admitted. JSON cannot extend
// this allowlist or refresh its byte pins. All six mechanical transforms remain.
const SEMANTIC_PATCHES = {
  "src/host/index.ts": {
    "original": "docs/host-baseline/semantic/index.original.ts",
    "patch": "docs/host-baseline/semantic/index.patch",
    "preimageSha256": "aa08b47bd6b7dbafe266495c43a77c9a735a9c6d4bf931c03d4c132be9ea3367",
    "patchSha256": "937ceb87aaf156cd96b66494f1b1cfac43200e7cc63abb888bedec38e8c2b0bc",
    "postimageSha256": "20f3e82d1c16e68c7afd658bda5c94aad8e73190c9a663f9cdf8bc5eb3df4fbc"
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
    "patchSha256": "b9482cf6f6596e4ab8f4efd0f92ec6109b790f16ab4aa70aa84e7152089a1349",
    "postimageSha256": "0dfcad186344b6c506d3b13b9319699b16cb308f9a96ccb7b36b69f335f5c92e"
  },
  "src/host/agent-bridge.ts": {
    "original": "docs/host-baseline/semantic/agent-bridge.original.ts",
    "patch": "docs/host-baseline/semantic/agent-bridge.patch",
    "preimageSha256": "6edc2cacf9564d9215c0e9d542bb3a2295d50012a1a9e1c6b29b373c55ea9fb8",
    "patchSha256": "60415356fcbd023af3fd14316547a236058a2a0ace57788d031cf754ea1750f2",
    "postimageSha256": "b23262a88a83a09f4a248f9c89faae13895318104ed3c9597fe7776eabadcaf0"
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
    "patchSha256": "984c923bd9b0a18b2ee8c9b3e0408589104f2381d3b387ead1c5c41ba8998d88",
    "postimageSha256": "7f61819ea7c967e31912681992b9de06cbf48e50f0ed704622e09e5a5300ca33"
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
  let text = invertSemanticPatch(entry, readFileSync(entry.destination, 'utf8'));
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

const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src/octo', 'src/host', 'test/host'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const path of tracked) assert.ok(destinations.has(path), `unlisted file under selective-import paths: ${path}`);

const exceptionCount = exceptionsFor(manifest, 'eslint').length + exceptionsFor(manifest, 'security').length;
console.log(`Import manifest v2 verified: LICENSE asset, ${imported} imported files equal to the pinned dd12980 blobs after inverting their transforms (${rewrites} specifier rewrites), ${authored} authored entries, ${exceptionCount} line-bound exceptions.`);
