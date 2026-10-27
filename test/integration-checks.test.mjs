// SPDX-License-Identifier: Apache-2.0
// Negative tests for the manifest-bound lint and security exceptions: an
// exception must stop applying as soon as the file, the line or the rule moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  assert.match(r.stderr, /comment exception is not a whole comment line/);
});

test('security: only the private-endpoint pattern can be excepted', () => {
  const r = runSecurity(makeRepo({ exceptions: [exception('src/host/a.ts', SRC, 2, { kind: 'comment', rule: 'github-token' })] }));
  assert.match(r.stderr, /security exception rule not allowed/);
});

test('security: an unused exception fails', () => {
  const extra = exception('test/host/a.test.ts', TEST, 1, { kind: 'test-url' });
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

function copyImportTree() {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-imports-'));
  const files = execFileSync('git', ['ls-files', '-z', 'LICENSE', 'docs/import-manifest.json', 'docs/host-baseline/import-entries.json', 'src/octo', 'src/host', 'test/host'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), readFileSync(join(repoRoot, file)));
  }
  return dir;
}

function runImports(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts/check-imports.mjs')], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test('imports: the committed tree passes the pinned source-set check', () => {
  const r = runImports(copyImportTree());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /84 imported files equal to the pinned dd12980 blobs/);
});

test('imports: deleting an imported test together with both of its entries fails', () => {
  const dir = copyImportTree();
  const victim = 'test/host/prompt-safety.test.ts';
  rmSync(join(dir, victim));
  for (const [file, key] of [['docs/import-manifest.json', 'imports'], ['docs/host-baseline/import-entries.json', 'entries']]) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const before = doc[key].length;
    doc[key] = doc[key].filter((e) => e.destination !== victim);
    assert.equal(doc[key].length, before - 1);
    writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
  }
  const r = runImports(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /expected 84 imported pin sources, found 83/);
});

test('imports: swapping one source path for another keeps the count but fails the set digest', () => {
  const dir = copyImportTree();
  for (const [file, key] of [['docs/import-manifest.json', 'imports'], ['docs/host-baseline/import-entries.json', 'entries']]) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const entry = doc[key].find((e) => e.destination === 'test/host/prompt-safety.test.ts');
    entry.sourcePath = 'src/__tests__/not-in-the-pin.test.ts';
    writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
  }
  const r = runImports(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\(sourcePath, sourceGitBlob\) set differs from the pinned dd12980 src\/ tree/);
});

// Reviewer probes (XIN-2527): each edit refreshes every hash the JSON files
// carry, so only checks held in code can catch it.
function runScript(dir, script) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return spawnSync(process.execPath, [join(repoRoot, 'scripts', script)], { cwd: dir, encoding: 'utf8' });
}

function editDocs(dir, edit) {
  for (const [file, key] of [['docs/import-manifest.json', 'imports'], ['docs/host-baseline/import-entries.json', 'entries']]) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    edit(doc, key, file);
    writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
  }
}

function injectLine(dir, destination, line, kind, { refreshBlob = false } = {}) {
  const path = join(dir, destination);
  const text = readFileSync(path, 'utf8') + line + '\n';
  writeFileSync(path, text);
  const lineNo = text.split('\n').length - 1;
  editDocs(dir, (doc, key, file) => {
    const entry = doc[key].find((e) => e.destination === destination);
    entry.destinationSha256 = sha256(text);
    if (refreshBlob) {
      entry.sourceSha256 = sha256(text);
      entry.sourceGitBlob = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
    }
    if (file === 'docs/import-manifest.json') doc.exceptions.push({ check: 'security', destination, line: lineNo, rule: 'private-endpoint', kind, lineSha256: sha256(line), reason: 'probe' });
  });
}

function probeBoth(dir) {
  const copy = mkdtempSync(join(tmpdir(), 'x-buddy-probe-'));
  execFileSync('cp', ['-R', `${dir}/.`, copy]);
  const imports = runScript(dir, 'check-imports.mjs');
  const security = runScript(copy, 'check-security.mjs');
  rmSync(dir, { recursive: true, force: true });
  rmSync(copy, { recursive: true, force: true });
  return { imports, security };
}

test('probe B1: deleting inbound-ssrf.test.ts with both entries and its exceptions fails check-imports', () => {
  const dir = copyImportTree();
  const victim = 'test/host/inbound-ssrf.test.ts';
  rmSync(join(dir, victim));
  editDocs(dir, (doc, key, file) => {
    doc[key] = doc[key].filter((e) => e.destination !== victim);
    if (file === 'docs/import-manifest.json') {
      const before = doc.exceptions.length;
      doc.exceptions = doc.exceptions.filter((e) => e.destination !== victim);
      assert.equal(before - doc.exceptions.length, 3);
    }
  });
  const { imports, security } = probeBoth(dir);
  assert.equal(security.status, 0, 'the security scan alone cannot see a missing file');
  assert.notEqual(imports.status, 0);
  assert.match(imports.stderr, /expected 84 imported pin sources, found 83/);
});

const PRIVATE = (host, path) => ['http', '://', host, path].join('');

for (const [name, line, kind] of [
  ['comment-prefixed code', `/* x */ await fetch('${PRIVATE('127.0.0.1', ':8080/admin')}');`, 'comment'],
  ['a plain constant', `const PROBE_URL = '${PRIVATE('10.0.0.5', '/api')}';`, 'error-string'],
]) {
  test(`probe B2: ${name} in src/host/url-policy.ts with refreshed hashes fails both gates`, () => {
    const dir = copyImportTree();
    injectLine(dir, 'src/host/url-policy.ts', line, kind);
    const { imports, security } = probeBoth(dir);
    assert.notEqual(imports.status, 0);
    assert.match(imports.stderr, /inverted bytes do not match the pinned git blob: src\/host\/url-policy\.ts/);
    assert.notEqual(security.status, 0);
    assert.match(security.stderr, kind === 'comment' ? /not a whole comment line/ : /not a literal Error message/);
  });

  test(`probe B2: ${name} with the source blob and sha256 also rewritten fails the pinned set`, () => {
    const dir = copyImportTree();
    injectLine(dir, 'src/host/url-policy.ts', line, kind, { refreshBlob: true });
    const { imports } = probeBoth(dir);
    assert.notEqual(imports.status, 0);
    assert.match(imports.stderr, /\(sourcePath, sourceGitBlob\) set differs from the pinned dd12980 src\/ tree/);
  });
}

test('kinds: block-comment continuation, one-line and multi-line Error literals pass; code shapes fail', async () => {
  const { isCommentLine, isErrorStringLine } = await import(join(repoRoot, 'scripts/lib/manifest.mjs'));
  const T = '`';
  const L = (s) => s.split('\n');
  assert.equal(isCommentLine(L('/**\n * rejects a loopback URL\n */'), 1), true);
  assert.equal(isCommentLine(L('// rejects a loopback URL'), 0), true);
  assert.equal(isCommentLine(L('/* x */ await fetch(u);'), 0), false);
  assert.equal(isCommentLine(L('/*\n * x */ fetch(u)'), 1), false);
  assert.equal(isCommentLine(L('const a = 1\n  * fetch(u)'), 1), false);
  assert.equal(isErrorStringLine(L(`throw new Error(${T}bad \${opts.apiUrl} url${T})`), 0), true);
  assert.equal(isErrorStringLine(L(`throw new Error(\n  ${T}a${T} +\n  ${T}b${T},\n);`), 2), true);
  assert.equal(isErrorStringLine(L(`throw new Error(${T}\${await fetch(u)}${T})`), 0), false);
  assert.equal(isErrorStringLine(L(`throw new Error(${T}x${T}); fetch(u)`), 0), false);
  assert.equal(isErrorStringLine(L(`throw new Error('a' + fetch(u))`), 0), false);
  assert.equal(isErrorStringLine(L(`log(\n  ${T}y${T},\n);`), 1), false);
  assert.equal(isErrorStringLine(L(`const PROBE_URL = 'u';`), 0), false);
});

// Test-coverage gate (XIN-2526): a dropped or renamed suite must fail before npm test runs.
function copyTestTree() {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-tests-'));
  const files = execFileSync('git', ['ls-files', '-z', 'package.json', 'vitest.config.mjs', 'docs/import-manifest.json', 'src', 'scripts', 'test'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), readFileSync(join(repoRoot, file)));
  }
  return dir;
}

function runTestsGate(mutate) {
  const dir = copyTestTree();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mutate?.(dir);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts/check-tests.mjs')], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const CANARY = "// SPDX-License-Identifier: Apache-2.0\nimport test from 'node:test';\ntest('canary', () => {});\n";

test('tests gate: the committed tree passes', () => {
  const r = runTestsGate();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /17 node:test files \(17 reviewed\)/);
});

test('tests gate S1: renaming client.test.mjs to .spec.mjs fails', () => {
  const r = runTestsGate((dir) => {
    const from = join(dir, 'test/app-server/client.test.mjs');
    writeFileSync(join(dir, 'test/app-server/client.spec.mjs'), readFileSync(from));
    rmSync(from);
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /reviewed node:test suite missing: test\/app-server\/client\.test\.mjs/);
  assert.match(r.stderr, /not collected by npm test or test:host: test\/app-server\/client\.spec\.mjs/);
});

test('tests gate: deleting a reviewed suite fails', () => {
  const r = runTestsGate((dir) => rmSync(join(dir, 'test/foundation/scope.test.mjs')));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /reviewed node:test suite missing: test\/foundation\/scope\.test\.mjs/);
});

test('tests gate S2: a nested app-server suite is collected and reported as new', () => {
  const r = runTestsGate((dir) => {
    mkdirSync(join(dir, 'test/app-server/sub'), { recursive: true });
    writeFileSync(join(dir, 'test/app-server/sub/nested.test.mjs'), CANARY);
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 new: test\/app-server\/sub\/nested\.test\.mjs/);
});

test('tests gate: a test outside every runner glob fails', () => {
  const r = runTestsGate((dir) => {
    mkdirSync(join(dir, 'test/misc'), { recursive: true });
    writeFileSync(join(dir, 'test/misc/orphan.test.mjs'), CANARY);
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not collected by npm test or test:host: test\/misc\/orphan\.test\.mjs/);
});

test('tests gate: a node:test file with a non-test name fails', () => {
  const r = runTestsGate((dir) => writeFileSync(join(dir, 'test/foundation/lib/hidden-suite.mjs'), CANARY));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not collected by npm test or test:host: test\/foundation\/lib\/hidden-suite\.mjs/);
});

test('tests gate: narrowing the npm test globs fails', () => {
  const r = runTestsGate((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.scripts.test = pkg.scripts.test.replace('"test/app-server/**/*.test.mjs"', '"test/app-server/*.test.mjs"');
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /npm test globs changed/);
});

test('tests gate: a renamed host test outside the vitest include fails', () => {
  const r = runTestsGate((dir) => {
    const from = join(dir, 'test/host/api-timeout.test.ts');
    writeFileSync(join(dir, 'test/host/api-timeout.spec.ts'), readFileSync(from));
    rmSync(from);
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not collected by npm test or test:host: test\/host\/api-timeout\.spec\.ts/);
});
