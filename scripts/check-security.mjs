// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { exceptionsFor, isCommentLine, isErrorStringLine, loadManifest, sha256 } from './lib/manifest.mjs';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
assert.ok(paths.length > 0, 'stage files before scanning');
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['github-pat', /github_pat_[A-Za-z0-9_]{20,}/],
  ['aws-key', /AKIA[A-Z0-9]{16}/],
  ['internal-host', /https?:\/\/[^\s"'<>]*deepminer\.com\.cn/i],
  ['private-endpoint', /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(?::|\/|\b)/i],
];
// Only private-endpoint can be excepted, and only for one listed line of a
// listed import at its pinned hash (comment, error string or test URL).
const manifest = loadManifest();
const pending = new Set(exceptionsFor(manifest, 'security').map((e) => `${e.destination}:${e.line}:${e.rule}`));
// Preserve the byte-pinned upstream config's non-executable references to
// loopback. All other lines and secret rules still run against the full file.
const configPreimage = 'docs/host-baseline/semantic/config.original.ts';
if (paths.includes(configPreimage)) {
  const overlay = manifest.imports.find(({ semanticPatch }) => semanticPatch?.original === configPreimage)?.semanticPatch;
  const bytes = readFileSync(configPreimage);
  const approvedHash = 'e87e43bfa71c46e2bfc1eb323c8e9257c89207d3fbe296746323e5096b4b6a5c';
  assert.equal(overlay?.preimageSha256, approvedHash, 'upstream config preimage pin changed');
  assert.equal(sha256(bytes), approvedHash, 'upstream config preimage hash changed');
  const lines = bytes.toString('utf8').split('\n');
  for (const [line, validateLine] of [[362, isCommentLine], [399, isErrorStringLine], [407, isErrorStringLine]]) {
    assert.ok(validateLine(lines, line - 1), `unexpected upstream loopback reference: ${configPreimage}:${line}`);
    pending.add(`${configPreimage}:${line}:private-endpoint`);
  }
}
// The retained schedule ports and fixture generator carry the upstream MIT license.
const mitLicensedFiles = new Set([
  'src/cron/schedule/engine.ts',
  'src/cron/schedule/iso-time.ts',
  'src/cron/schedule/map-size.ts',
  'src/cron/schedule/normalization.ts',
  'src/cron/schedule/parse.ts',
  'src/cron/schedule/schedule-number.ts',
  'src/cron/schedule/types.ts',
  'src/cron/schedule/upstream-schedule.ts',
  'src/cron/schedule/upstream-stagger.ts',
  'src/cron/schedule/zoned-datetime.ts',
  'test/cron-schedule/generate-fixtures.mjs',
]);
const SPDX = '// SPDX-License-Identifier: ';
let excepted = 0;
for (const path of paths) {
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  for (const [id, pattern] of patterns) {
    if (!pattern.test(content)) continue;
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      const key = `${path}:${index + 1}:${id}`;
      assert.ok(pending.has(key), `secret or private endpoint pattern (${id}) in ${path}:${index + 1}`);
      pending.delete(key);
      excepted += 1;
    });
  }
  if (/\.(?:ts|mjs)$/.test(path)) {
    // An optional single shebang line may precede the SPDX header.
    const body = content.startsWith('#!') ? content.slice(content.indexOf('\n') + 1) : content;
    const license = mitLicensedFiles.has(path) ? 'MIT' : 'Apache-2.0';
    assert.ok(body.startsWith(`${SPDX}${license}\n`), `license header missing or not ${license}: ${path}`);
  }
}
assert.deepEqual([...pending.keys()], [], 'unused security exceptions');
assert.ok(readFileSync('LICENSE', 'utf8').includes('Apache License'));
console.log(`License headers and secret/private endpoint patterns checked in ${paths.length} tracked files; ${excepted} manifest-bound line exception(s).`);
