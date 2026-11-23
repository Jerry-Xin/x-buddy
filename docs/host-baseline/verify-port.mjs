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

// Only explicitly pinned host and test overlays are admitted. JSON cannot extend
// this allowlist or refresh its byte pins. All six mechanical transforms remain.
const SEMANTIC_PATCHES = {
  "test/host/e2e.test.ts": {
    "original": "docs/host-baseline/semantic/test-e2e.original.txt",
    "patch": "docs/host-baseline/semantic/test-e2e.patch",
    "preimageSha256": "1338cd66749df5858bd22781d82ebc620b2e0ea0f8c0f460757bbf068cd8c1cd",
    "patchSha256": "a867433ef30216cd152375614a1b6567f85921460f9b856976b49976d951f399",
    "postimageSha256": "d0b8ad62bcdcdc06e7b69ae54ed59d9103c75e08ac96a6bcc9608c29f27bee5b"
  },
  "test/host/session-router.test.ts": {
    "original": "docs/host-baseline/semantic/test-session-router.original.txt",
    "patch": "docs/host-baseline/semantic/test-session-router.patch",
    "preimageSha256": "bcdab4e290911016721f17ba41f12c052654b11ada06fbadba166bf63a354cf2",
    "patchSha256": "451075af4dbcf4bf05d95a6aa69d78feb543ab5d2b9bca2dcdebfd9ecf46dcb4",
    "postimageSha256": "3d1535ea9535379dd101d61ccc7310eb0acc870326934526418a68859683de43"
  },
  "test/host/stream-relay.test.ts": {
    "original": "docs/host-baseline/semantic/test-stream-relay.original.txt",
    "patch": "docs/host-baseline/semantic/test-stream-relay.patch",
    "preimageSha256": "e05a0e2f9dd9ab7794133a091c51b499e4385325030032ef6cb17663531c5a61",
    "patchSha256": "aea6416ac2c2fcff6d3a386f85a3fa2bb9d026ac4eb80c850a9fd27455f0026f",
    "postimageSha256": "15cf0b995ce6504c2d5014c99fc07646ca5cddf15dbc85d5356e2a08d97edd38"
  },
  "test/host/inbound-wiring.test.ts": {
    "original": "docs/host-baseline/semantic/test-inbound-wiring.original.txt",
    "patch": "docs/host-baseline/semantic/test-inbound-wiring.patch",
    "preimageSha256": "416a50833d6ebdc145f405c910f31f5d9d542f188199c43c65026e593bfbf081",
    "patchSha256": "60f1158c38bf036263d7018692e789a1388755d1dbc23ba1775c2e20f8a0f0ed",
    "postimageSha256": "4377fcd138fba78da20e6d3fa245f462b61a9f8577f1b779f7b10f28b288ab95"
  },
  "test/host/shutdown.test.ts": {
    "original": "docs/host-baseline/semantic/test-shutdown.original.txt",
    "patch": "docs/host-baseline/semantic/test-shutdown.patch",
    "preimageSha256": "4dff403c8c108bd7f77097c3f3bcbe76c644cd72972a7e2effc86e6cec47cad7",
    "patchSha256": "d3f5367dd22f367ed08f3c60727d13261488c1645dd09911e49a44d85f644124",
    "postimageSha256": "34c41faf1965d3b08b8c01f07cef1b6243f523cadc3e6173a19a1c5d0fc0eac9"
  },
  "test/host/p2-polish.test.ts": {
    "original": "docs/host-baseline/semantic/test-p2-polish.original.txt",
    "patch": "docs/host-baseline/semantic/test-p2-polish.patch",
    "preimageSha256": "1f697511cb9abb510eb72de512a56dffb84e5e2b6543ed172ebfc418e7d32a16",
    "patchSha256": "2ec6bbe57caa6cb4f96b2d35ad819598d4f126dbdc068a6688931d04ddc060ac",
    "postimageSha256": "d0193f21a6dee80cc85bc742f27c80cf0606b005827835a34803f9eae52b3c4d"
  },
  "test/host/gateway.test.ts": {
    "original": "docs/host-baseline/semantic/test-gateway.original.txt",
    "patch": "docs/host-baseline/semantic/test-gateway.patch",
    "preimageSha256": "43de6c546ec3f584c3f588d1d5c9229af2545ad288ce86d9844939edfb43d9b0",
    "patchSha256": "fd6dc7eb33a1c932cfcf791c940fda92ad33607923ea60acb1ac3b07d2ac2e75",
    "postimageSha256": "0730cd0675b4db0412585366730bf61691fc83d2c84ceeec87226a7786dd7976"
  },
  "test/host/g3-g8-g12-g13.test.ts": {
    "original": "docs/host-baseline/semantic/test-g3-g8-g12-g13.original.txt",
    "patch": "docs/host-baseline/semantic/test-g3-g8-g12-g13.patch",
    "preimageSha256": "b12487043f39017525a6fa73ddb22d5799775af6e9239fade6410b0d7a71f53a",
    "patchSha256": "9bda43e49f8e09f38aa66696cf38dc71c7a9b8d57aaf568b0cb35650db7980f1",
    "postimageSha256": "4179ffb7e02727eaa8b24d8bc86b9b2cfaaa849f58fef8ad06bbfa54f730081a"
  },
  "test/host/commands.test.ts": {
    "original": "docs/host-baseline/semantic/test-commands.original.txt",
    "patch": "docs/host-baseline/semantic/test-commands.patch",
    "preimageSha256": "8dd2c47085ae7fe52ea2b1adeb6c8bc2b6508b00ce0fe213a4ac942ca838ab75",
    "patchSha256": "d5a4190721ae8fec90d42677ba55003d345a279d537cc795ae03dc49403fc507",
    "postimageSha256": "44d7dfec7d1fb2d370aba50854a16a6f6aad14f2e7520d31af46ce136138a219"
  },
  "test/host/agent-bridge.test.ts": {
    "original": "docs/host-baseline/semantic/test-agent-bridge.original.txt",
    "patch": "docs/host-baseline/semantic/test-agent-bridge.patch",
    "preimageSha256": "d0d1d7af6be43b57419d0bd70068e7d1a3dd9571b59fa292ffafbd1c30c45c93",
    "patchSha256": "86e925a6624549c4b1171ebc0fbcfed5c57b176bcd02bf3701d83bb5da288045",
    "postimageSha256": "0580624cad22420008b129444d6ccb23425e331bccd789f7d6142658c39928cd"
  },
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
