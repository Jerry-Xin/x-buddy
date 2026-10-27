// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { exceptionsFor, loadManifest } from './lib/manifest.mjs';
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
const pending = new Map(exceptionsFor(loadManifest(), 'security').map((e) => [`${e.destination}:${e.line}:${e.rule}`, e]));
const SPDX = '// SPDX-License-Identifier: Apache-2.0\n';
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
    assert.ok(body.startsWith(SPDX), `license header missing: ${path}`);
  }
}
assert.deepEqual([...pending.keys()], [], 'unused security exceptions');
assert.ok(readFileSync('LICENSE', 'utf8').includes('Apache License'));
console.log(`License headers and secret/private endpoint patterns checked in ${paths.length} tracked files; ${excepted} manifest-bound line exception(s).`);
