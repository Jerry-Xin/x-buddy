// SPDX-License-Identifier: Apache-2.0
// Negative tests for the manifest-bound lint and security exceptions: an
// exception must stop applying as soon as the file, the line or the rule moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const LOOPBACK = ['http', '://', 'localhost'].join('');
const SRC = [
  '// SPDX-License-Identifier: Apache-2.0',
  `// rejects ${LOOPBACK}:1 here`,
  `throw new Error(\`must be https:// or ${LOOPBACK}\`);`,
  'export {};',
  '',
].join('\n');
const TEST = ['// SPDX-License-Identifier: Apache-2.0', `const u = '${LOOPBACK}/x';`, ''].join('\n');

function exception(destination, text, line, extra) {
  return { check: 'security', destination, line, rule: 'private-endpoint', lineSha256: sha256(text.split('\n')[line - 1]), reason: 'test', ...extra };
}

function makeRepo({ src = SRC, testFile = TEST, exceptions, mutate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-checks-'));
  mkdirSync(join(dir, 'src/host'), { recursive: true });
  mkdirSync(join(dir, 'test/host'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'LICENSE'), 'Apache License\n');
  writeFileSync(join(dir, 'src/host/a.ts'), src);
  writeFileSync(join(dir, 'test/host/a.test.ts'), testFile);
  const imports = [
    { kind: 'imported', destination: 'src/host/a.ts', destinationSha256: sha256(src) },
    { kind: 'imported', destination: 'test/host/a.test.ts', destinationSha256: sha256(testFile) },
  ];
  const list = exceptions ?? [
    exception('src/host/a.ts', src, 2, { kind: 'comment' }),
    exception('src/host/a.ts', src, 3, { kind: 'error-string' }),
    exception('test/host/a.test.ts', testFile, 2, { kind: 'test-url' }),
  ];
  writeFileSync(join(dir, 'docs/import-manifest.json'), JSON.stringify({ schemaVersion: 2, imports, exceptions: list }));
  mutate?.(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

function runSecurity(dir) {
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts/check-security.mjs')], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test('security: exact listed lines of a pinned import pass', () => {
  const r = runSecurity(makeRepo());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 manifest-bound line exception/);
});

test('security: an unlisted hit on another line fails', () => {
  const src = SRC + `// and ${LOOPBACK}:2\n`;
  const r = runSecurity(makeRepo({ src, exceptions: [exception('src/host/a.ts', src, 2, { kind: 'comment' }), exception('src/host/a.ts', src, 3, { kind: 'error-string' }), exception('test/host/a.test.ts', TEST, 2, { kind: 'test-url' })] }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /src\/host\/a\.ts:5/);
});

test('security: editing the file after import invalidates every exception for it', () => {
  const r = runSecurity(makeRepo({ mutate: (dir) => writeFileSync(join(dir, 'src/host/a.ts'), SRC + '\n') }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exception file changed since import/);
});

test('security: a shifted line or wrong line hash is rejected', () => {
  const list = [exception('src/host/a.ts', SRC, 2, { kind: 'comment', line: 3 })];
  const r = runSecurity(makeRepo({ exceptions: list }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exception line changed|comment exception/);
});

test('security: test-url kind is refused for a source file, comment kind for a code line', () => {
  let r = runSecurity(makeRepo({ exceptions: [exception('src/host/a.ts', SRC, 3, { kind: 'test-url' })] }));
  assert.match(r.stderr, /test-url exception outside test/);
  r = runSecurity(makeRepo({ exceptions: [exception('src/host/a.ts', SRC, 3, { kind: 'comment' })] }));
  assert.match(r.stderr, /comment exception is not a comment line/);
});

test('security: only the private-endpoint pattern can be excepted', () => {
  const r = runSecurity(makeRepo({ exceptions: [exception('src/host/a.ts', SRC, 2, { kind: 'comment', rule: 'github-token' })] }));
  assert.match(r.stderr, /security exception rule not allowed/);
});

test('security: an unused exception fails', () => {
  const extra = exception('src/host/a.ts', SRC, 4, { kind: 'error-string' });
  const r = runSecurity(makeRepo({ exceptions: [exception('src/host/a.ts', SRC, 2, { kind: 'comment' }), exception('src/host/a.ts', SRC, 3, { kind: 'error-string' }), exception('test/host/a.test.ts', TEST, 2, { kind: 'test-url' }), extra] }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unused security exceptions/);
});

test('security: exceptions are refused for files that are not listed imports', () => {
  const r = runSecurity(makeRepo({ mutate: (dir) => {
    const m = { schemaVersion: 2, imports: [], exceptions: [exception('src/host/a.ts', SRC, 2, { kind: 'comment' })] };
    writeFileSync(join(dir, 'docs/import-manifest.json'), JSON.stringify(m));
  } }));
  assert.match(r.stderr, /not a listed import/);
});

test('security: an optional shebang may precede the SPDX header, nothing else may', () => {
  const shebang = '#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\nexport {};\n';
  let r = runSecurity(makeRepo({ exceptions: [], src: shebang, testFile: '// SPDX-License-Identifier: Apache-2.0\n' }));
  assert.equal(r.status, 0, r.stderr);
  r = runSecurity(makeRepo({ exceptions: [], src: '// note\n// SPDX-License-Identifier: Apache-2.0\n', testFile: '// SPDX-License-Identifier: Apache-2.0\n' }));
  assert.match(r.stderr, /license header missing/);
});

test('eslint: exceptions are limited to the reviewed rule set and to pinned lines', () => {
  const src = '// SPDX-License-Identifier: Apache-2.0\nconst a: any = 1;\n';
  const dir = makeRepo({ src, exceptions: [{ check: 'eslint', destination: 'src/host/a.ts', line: 2, rule: '@typescript-eslint/no-explicit-any', lineSha256: sha256('const a: any = 1;'), reason: 'test' }] });
  const probe = `import { loadManifest, exceptionsFor } from ${JSON.stringify(join(repoRoot, 'scripts/lib/manifest.mjs'))}; exceptionsFor(loadManifest(), 'eslint');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /eslint exception rule not allowed/);
});
