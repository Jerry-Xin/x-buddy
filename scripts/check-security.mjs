// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
assert.ok(paths.length > 0, 'stage files before scanning');
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /https?:\/\/[^\s"'<>]*deepminer\.com\.cn/i,
  /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(?::|\/|\b)/i,
];
for (const path of paths) {
  const content = readFileSync(path, 'utf8');
  for (const pattern of patterns) assert.ok(!pattern.test(content), `secret or private endpoint pattern in ${path}`);
  if (/\.(?:ts|mjs)$/.test(path)) assert.ok(content.startsWith('// SPDX-License-Identifier: Apache-2.0\n'), `license header missing: ${path}`);
}
assert.ok(readFileSync('LICENSE', 'utf8').includes('Apache License'));
console.log(`License headers and secret/private endpoint patterns checked in ${paths.length} tracked files.`);
