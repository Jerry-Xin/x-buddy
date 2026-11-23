// SPDX-License-Identifier: Apache-2.0
// Negative tests for the manifest-bound lint and security exceptions: an
// exception must stop applying as soon as the file, the line or the rule moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync, existsSync, symlinkSync } from 'node:fs';
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
  const probePath = join(dir, 'lint-manifest-probe.mjs');
  writeFileSync(probePath, probe);
  const r = spawnSync(process.execPath, [probePath], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /eslint exception rule not allowed/);
});

// These additional controls exercise the optional offline preload. The original
// manifest assertion above also runs without that preload.
for (const mutation of ['byte', 'argv', 'path', 'cwd', 'fixture', 'manifest', 'symlink']) {
  test(`lint probe guard refuses near-miss ${mutation}`, { skip: !process.env.CALLER_GUARD_ROOT }, () => {
    const src = '// SPDX-License-Identifier: Apache-2.0\nconst a: any = 1;\n';
    const dir = makeRepo({src,exceptions:[{check:'eslint',destination:'src/host/a.ts',line:2,rule:'@typescript-eslint/no-explicit-any',lineSha256:sha256('const a: any = 1;'),reason:'test'}]});
    const path = join(dir,'lint-manifest-probe.mjs');
    const probe = `import { loadManifest, exceptionsFor } from ${JSON.stringify(join(repoRoot, 'scripts/lib/manifest.mjs'))}; exceptionsFor(loadManifest(), 'eslint');`;
    writeFileSync(path, probe + (mutation === 'byte' ? '\n' : ''));
    let args=[path],cwd=dir;
    if(mutation==='argv')args=['--trace-warnings',path];
    if(mutation==='path'){const other=join(dir,'other.mjs');writeFileSync(other,probe);args=[other]}
    if(mutation==='cwd')cwd=repoRoot;
    if(mutation==='fixture')appendFileSync(join(dir,'src/host/a.ts'),'\n');
    if(mutation==='manifest')appendFileSync(join(dir,'docs/import-manifest.json'),'\n');
    if(mutation==='symlink'){const other=join(dir,'other.mjs');writeFileSync(other,probe);rmSync(path);symlinkSync(other,path)}
    try { assert.throws(()=>spawnSync(process.execPath,args,{cwd,encoding:'utf8'}),/offline guard refused: constructor\/spawn/); }
    finally {rmSync(dir,{recursive:true,force:true})}
  });
}

function copyImportTree() {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-imports-'));
  const files = execFileSync('git', ['ls-files', '-z', 'LICENSE', 'docs/import-manifest.json', 'docs/host-baseline/import-entries.json', 'docs/host-baseline/semantic', 'src/octo', 'src/host', 'test/host'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
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
  assert.match(r.stdout, /\d+ node:test files \(22 reviewed(?:, \d+ new: [^)]+)?\)/);
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

for (const suite of ['test/dev02-api.test.mjs', 'test/dev02-lock.test.mjs', 'test/dev02-transport.test.mjs']) {
  test(`tests gate DEV02: deleting ${suite} fails`, () => {
    const r = runTestsGate((dir) => rmSync(join(dir, suite)));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`reviewed node:test suite missing: ${suite}`), r.stderr);
  });
}

test('tests gate S2: a nested app-server suite is collected and reported as new', () => {
  const r = runTestsGate((dir) => {
    mkdirSync(join(dir, 'test/app-server/sub'), { recursive: true });
    writeFileSync(join(dir, 'test/app-server/sub/nested.test.mjs'), CANARY);
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+ node:test files \(22 reviewed, \d+ new:/);
  assert.match(r.stdout, /\d+ new: [^\n]*test\/app-server\/sub\/nested\.test\.mjs/);
});

test('tests gate: multiple added suites remain collected and individually reported', () => {
  const r = runTestsGate((dir) => {
    writeFileSync(join(dir, 'test/app-server/extra-a.test.mjs'), CANARY);
    writeFileSync(join(dir, 'test/app-server/extra-b.test.mjs'), CANARY);
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+ node:test files \(22 reviewed, \d+ new:/);
  assert.match(r.stdout, /new: [^\n]*test\/app-server\/extra-a\.test\.mjs/);
  assert.match(r.stdout, /new: [^\n]*test\/app-server\/extra-b\.test\.mjs/);
});

for (const suite of ['test/runtime/process.test.mjs', 'test/runtime/runtime.test.mjs']) {
  test(`tests gate DEV04: deleting ${suite} fails`, () => {
    const r = runTestsGate((dir) => rmSync(join(dir, suite)));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`reviewed node:test suite missing: ${suite}`), r.stderr);
  });

  for (const suffix of ['renamed.test.mjs', 'spec.mjs']) {
    test(`tests gate DEV04: renaming ${suite} to ${suffix} fails`, () => {
      const renamed = suite.replace('test.mjs', suffix);
      const r = runTestsGate((dir) => {
        writeFileSync(join(dir, renamed), readFileSync(join(dir, suite)));
        rmSync(join(dir, suite));
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.ok(r.stderr.includes(`reviewed node:test suite missing: ${suite}`), r.stderr);
      if (suffix === 'spec.mjs') {
        assert.ok(r.stderr.includes(`not collected by npm test or test:host: ${renamed}`), r.stderr);
      }
    });
  }
}

test('tests gate DEV04: a nested runtime suite is collected and individually reported', () => {
  const suite = 'test/runtime/sub/nested.test.mjs';
  const r = runTestsGate((dir) => {
    mkdirSync(join(dir, 'test/runtime/sub'), { recursive: true });
    writeFileSync(join(dir, suite), CANARY);
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+ node:test files \(22 reviewed, \d+ new:/);
  assert.ok(r.stdout.includes(suite), r.stdout);
});

test('tests gate DEV04: multiple runtime suites are collected and individually reported', () => {
  const suites = ['test/runtime/extra-a.test.mjs', 'test/runtime/sub/extra-b.test.mjs'];
  const r = runTestsGate((dir) => {
    mkdirSync(join(dir, 'test/runtime/sub'), { recursive: true });
    for (const suite of suites) writeFileSync(join(dir, suite), CANARY);
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+ node:test files \(22 reviewed, \d+ new:/);
  for (const suite of suites) assert.ok(r.stdout.includes(suite), r.stdout);
});

for (const [name, replacement] of [
  ['removing', ''],
  ['narrowing', "  'test/runtime/*.test.mjs',"],
]) {
  test(`tests gate DEV04: ${name} the runtime glob fails`, () => {
    const r = runTestsGate((dir) => {
      const path = join(dir, 'scripts/lib/test-suites.mjs');
      writeFileSync(path, readFileSync(path, 'utf8').replace("  'test/runtime/**/*.test.mjs',", replacement));
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /node:test runner bytes changed/);
  });
}

test('tests gate DEV04: a runtime node:test file with a non-test name fails', () => {
  const suite = 'test/runtime/hidden-suite.mjs';
  const r = runTestsGate((dir) => writeFileSync(join(dir, suite), CANARY));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(`not collected by npm test or test:host: ${suite}`), r.stderr);
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
    const path = join(dir, 'scripts/lib/test-suites.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace('test/app-server/**/*.test.mjs', 'test/app-server/*.test.mjs'));
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /node:test runner bytes changed/);
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

test('tests gate X1: a vitest exclusion cannot omit the SSRF suite', () => {
  const r = runTestsGate((dir) => {
    const path = join(dir, 'vitest.config.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace('test: {', "test: {\n    exclude: ['test/host/inbound-ssrf.test.ts'],"));
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /vitest config bytes changed/);
});

test('tests gate X2: a skip flag cannot omit node:test cases', () => {
  const r = runTestsGate((dir) => {
    const path = join(dir, 'scripts/run-tests.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace("'--test',", "'--test', '--test-skip-pattern=.',"));
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node:test runner bytes changed/);
});

// Both validators must enforce exact semantic forward/inverse bytes and pins.
for (const name of ['wrong-preimage','wrong-path','extra-hunk','deletion','postimage-drift','manifest-repin','unlisted-import','unlisted-overlay','stale-pin','stale-exception']) {
  test(`semantic host overlays: router ${name} refuses in both validators`, () => {
    const results = overlayGates('router-' + name, dir => {
      const path = join(dir, 'src/host/session-router.ts');
      const patch = join(dir, 'docs/host-baseline/semantic/session-router.patch');
      if (name === 'wrong-preimage') writeFileSync(join(dir, 'docs/host-baseline/semantic/session-router.original.ts'), 'wrong owned fixture\n');
      if (name === 'wrong-path') writeFileSync(patch, readFileSync(patch, 'utf8').replace('a/src/host/session-router.ts', 'a/src/host/url-policy.ts'));
      if (name === 'extra-hunk') appendFileSync(patch, '@@ -1 +1 @@\n-x\n+y\n');
      if (name === 'deletion') writeFileSync(patch, 'diff --git a/src/host/session-router.ts b/src/host/session-router.ts\ndeleted file mode 100644\n');
      if (name === 'postimage-drift' || name === 'manifest-repin') {
        appendFileSync(path, '// extra unapproved router edit\n');
        editDocs(dir, (doc, key) => { const entry = doc[key].find(e => e.destination === 'src/host/session-router.ts');
          entry.destinationSha256 = sha256(readFileSync(path)); if (name === 'manifest-repin') entry.semanticPatch.postimageSha256 = entry.destinationSha256; });
      }
      if (name === 'unlisted-import') writeFileSync(join(dir, 'src/host/unlisted.ts'), '// SPDX-License-Identifier: Apache-2.0\n');
      if (name === 'unlisted-overlay') editDocs(dir, (doc, key) => { doc[key].find(e => e.destination === 'src/host/url-policy.ts').semanticPatch = { approved: true }; });
      if (name === 'stale-pin') editDocs(dir, (doc, key) => { doc[key].find(e => e.destination === 'src/host/session-router.ts').semanticPatch.patchSha256 = '0'.repeat(64); });
      if (name === 'stale-exception') {
        const p = join(dir, 'docs/import-manifest.json'), doc = JSON.parse(readFileSync(p, 'utf8'));
        doc.exceptions.push({ check: 'eslint', destination: 'src/host/session-router.ts', line: 1, rule: 'preserve-caught-error', lineSha256: '0'.repeat(64), reason: 'stale fixture' });
        writeFileSync(p, JSON.stringify(doc));
      }
    });
    for (const result of results) {
      assert.notEqual(result.status, 0, result.validator + ' accepted router ' + name);
      assert.doesNotMatch(result.stderr, /ENOENT/, 'missing fixture is not semantic rejection evidence');
      assert.match(result.stderr, /semantic|unlisted|exception/i, 'reject the intended provenance mutation');
    }
  });
}
for (const name of ['wrong-preimage','wrong-path','extra-hunk','deletion','postimage-drift','manifest-repin','unlisted-import','unlisted-overlay','stale-exception']) {
  test(`semantic host overlays: bridge ${name} refuses in both validators`, () => {
    const results = overlayGates('bridge-' + name, dir => {
      const path = join(dir, 'src/host/agent-bridge.ts');
      const patch = join(dir, 'docs/host-baseline/semantic/agent-bridge.patch');
      if (name === 'wrong-preimage') writeFileSync(join(dir, 'docs/host-baseline/semantic/agent-bridge.original.ts'), 'wrong owned fixture\n');
      if (name === 'wrong-path') writeFileSync(patch, readFileSync(patch, 'utf8').replace('a/src/host/agent-bridge.ts', 'a/src/host/url-policy.ts'));
      if (name === 'extra-hunk') appendFileSync(patch, '@@ -1 +1 @@\n-x\n+y\n');
      if (name === 'deletion') writeFileSync(patch, 'diff --git a/src/host/agent-bridge.ts b/src/host/agent-bridge.ts\ndeleted file mode 100644\n');
      if (name === 'postimage-drift' || name === 'manifest-repin') {
        appendFileSync(path, '// extra unapproved bridge edit\n');
        editDocs(dir, (doc, key) => { const entry = doc[key].find(e => e.destination === 'src/host/agent-bridge.ts');
          entry.destinationSha256 = sha256(readFileSync(path)); if (name === 'manifest-repin') entry.semanticPatch.postimageSha256 = entry.destinationSha256; });
      }
      if (name === 'unlisted-import') writeFileSync(join(dir, 'src/host/unlisted.ts'), '// SPDX-License-Identifier: Apache-2.0\n');
      if (name === 'unlisted-overlay') editDocs(dir, (doc, key) => { doc[key].find(e => e.destination === 'src/host/url-policy.ts').semanticPatch = { approved: true }; });
      if (name === 'stale-exception') {
        const p = join(dir, 'docs/import-manifest.json'), doc = JSON.parse(readFileSync(p, 'utf8'));
        doc.exceptions.push({ check: 'eslint', destination: 'src/host/agent-bridge.ts', line: 1, rule: 'preserve-caught-error', lineSha256: '0'.repeat(64), reason: 'stale fixture' });
        writeFileSync(p, JSON.stringify(doc));
      }
    });
    for (const result of results) assert.notEqual(result.status, 0, result.validator + ' accepted bridge ' + name);
  });
}

function overlayGates(name, mutate) {
  const dir = copyImportTree();
  for (const file of ['docs/host-baseline/verify-port.mjs','scripts/lib/manifest.mjs']) {
    mkdirSync(join(dir,file,'..'),{recursive:true});writeFileSync(join(dir,file),readFileSync(join(repoRoot,file)));
  }
  mutate?.(dir);
  execFileSync('git',['init','-q'],{cwd:dir});execFileSync('git',['add','-A'],{cwd:dir});
  const results=[];
  try {
    for (const [validator,args] of [['imports',[join(repoRoot,'scripts/check-imports.mjs')]],
      ['port',[join(dir,'docs/host-baseline/verify-port.mjs'),process.env.HOST_PIN_REPO]]]) {
      assert.ok(args.every(Boolean),'explicit offline source pin repository required');
      const r=spawnSync(process.execPath,args,{cwd:dir,encoding:'utf8'});
      const row={name,validator,command:[process.execPath,...args],status:r.status,stdout:r.stdout,stderr:r.stderr};results.push(row);
      if(process.env.PROVENANCE_EVIDENCE)appendFileSync(process.env.PROVENANCE_EVIDENCE,JSON.stringify(row)+'\n');
    }
    return results;
  } finally {rmSync(dir,{recursive:true,force:true});assert.equal(existsSync(dir),false)}
}
for (const leaf of ['session-store', 'db-adapter']) {
  for (const mutation of ['wrong-preimage','wrong-path','extra-hunk','deletion','postimage-drift','manifest-repin','unlisted-overlay','identity-drift','transform-widening']) {
    test(`v154 persistence provenance: ${leaf} ${mutation} refuses both exact validators`, () => {
      const destination = `src/host/${leaf}.ts`;
      const results = overlayGates(`v154-${leaf}-${mutation}`, dir => {
        const patch = join(dir, `docs/host-baseline/semantic/${leaf}.patch`);
        if (mutation === 'wrong-preimage') appendFileSync(join(dir, `docs/host-baseline/semantic/${leaf}.original.ts`), '// changed preimage\n');
        if (mutation === 'wrong-path') writeFileSync(patch, readFileSync(patch, 'utf8').replace(`a/${destination}`, 'a/src/host/url-policy.ts'));
        if (mutation === 'extra-hunk') appendFileSync(patch, '@@ -1 +1 @@\n-x\n+y\n');
        if (mutation === 'deletion') writeFileSync(patch, `diff --git a/${destination} b/${destination}\ndeleted file mode 100644\n`);
        if (['postimage-drift','manifest-repin'].includes(mutation)) {
          appendFileSync(join(dir, destination), '// unapproved persistence change\n');
          editDocs(dir, (doc, key) => {
            const entry = doc[key].find(e => e.destination === destination);
            entry.destinationSha256 = sha256(readFileSync(join(dir, destination)));
            if (mutation === 'manifest-repin') entry.semanticPatch.postimageSha256 = entry.destinationSha256;
          });
        }
        if (mutation === 'unlisted-overlay') editDocs(dir, (doc, key) => {
          doc[key].find(e => e.destination === 'src/host/url-policy.ts').semanticPatch = structuredClone(doc[key].find(e => e.destination === destination).semanticPatch);
        });
        if (mutation === 'identity-drift') editDocs(dir, (doc, key) => { doc[key].find(e => e.destination === destination).sourceSha256 = '0'.repeat(64); });
        if (mutation === 'transform-widening') editDocs(dir, (doc, key) => { doc[key].find(e => e.destination === destination).transforms.push('unapproved-transform'); });
      });
      for (const result of results) {
        assert.notEqual(result.status, 0, result.validator + ' accepted ' + mutation);
        assert.doesNotMatch(result.stderr, /ENOENT|MODULE_NOT_FOUND/, 'a setup failure is not rejection evidence');
      }
    });
  }
}
for (const leaf of ['commands', 'stream-relay', 'config']) {
  for (const mutation of ['wrong-preimage', 'manifest-repin']) {
    test(`v155 spine provenance: ${leaf} ${mutation} refuses both exact validators`, () => {
      const destination = `src/host/${leaf}.ts`;
      const results = overlayGates(`v155-${leaf}-${mutation}`, dir => {
        if (mutation === 'wrong-preimage') appendFileSync(join(dir, `docs/host-baseline/semantic/${leaf}.original.ts`), '// changed v155 preimage\n');
        if (mutation === 'manifest-repin') {
          appendFileSync(join(dir, destination), '// unapproved v155 spine change\n');
          editDocs(dir, (doc, key) => {
            const entry = doc[key].find(e => e.destination === destination);
            entry.destinationSha256 = sha256(readFileSync(join(dir, destination)));
            entry.semanticPatch.postimageSha256 = entry.destinationSha256;
          });
        }
      });
      for (const result of results) {
        assert.notEqual(result.status, 0, result.validator + ' accepted ' + leaf + ' ' + mutation);
        assert.doesNotMatch(result.stderr, /ENOENT|MODULE_NOT_FOUND/, 'a setup failure is not rejection evidence');
      }
    });
  }
}
test('semantic host overlays: exact forward/inverse proof passes both validators',()=>{
  for(const r of overlayGates('healthy'))assert.equal(r.status,0,r.stderr);
});
for (const [label, targetFile, snippet] of [
  ['alias-import', 'src/host/commands.ts', "import { sendMessage as sneakSend } from '../octo/api.js';\nvoid sneakSend;\n"],
  ['re-export', 'src/host/stream-relay.ts', "export { sendTyping } from '../octo/api.js';\n"],
  ['wildcard-import', 'src/host/session-router.ts', "import * as octoApi from '../octo/api.js';\nvoid octoApi;\n"],
  ['direct-api-client', 'src/host/index.ts', "import { OctoApiClient as DirectClient } from '../transport/api-client.js';\nvoid DirectClient;\n"],
]) {
  test(`B5 outbound confinement: ${label} in ${targetFile} is refused by static validator scan`, () => {
    const dir = copyImportTree();
    appendFileSync(join(dir, targetFile), snippet);
    const r = runImports(dir);
    assert.notEqual(r.status, 0, `check-imports accepted ${label}`);
    assert.match(r.stderr, /B5 outbound confinement violation/);
  });
}
test('config.ts manifest line-pins: all 4 shifted config.ts exceptions match exact rule/kind/lineSha256 and refuse line drift', async () => {
  const { loadManifest, exceptionsFor } = await import(join(repoRoot, 'scripts/lib/manifest.mjs'));
  const manifest = loadManifest();
  const eslintConfig = exceptionsFor(manifest, 'eslint').filter(e => e.destination === 'src/host/config.ts');
  const secConfig = exceptionsFor(manifest, 'security').filter(e => e.destination === 'src/host/config.ts');
  assert.equal(eslintConfig.length, 1);
  assert.equal(eslintConfig[0].line, 423);
  assert.equal(eslintConfig[0].rule, 'preserve-caught-error');
  assert.equal(secConfig.length, 3);
  assert.deepEqual(secConfig.map(e => e.line), [507, 544, 552]);
  assert.deepEqual(secConfig.map(e => e.kind), ['comment', 'error-string', 'error-string']);
  for (const check of ['eslint', 'security']) {
    const drifted = structuredClone(manifest);
    const target = drifted.exceptions.find(e => e.check === check && e.destination === 'src/host/config.ts');
    target.line += 1;
    assert.throws(() => exceptionsFor(drifted, check), /exception line changed: src\/host\/config\.ts:/);
  }
});
for(const name of ['wrong-preimage','wrong-path','extra-hunk','deletion','unlisted-import','unlisted-overlay','postimage-drift','stale-exception']) {
  test(`semantic host overlays: ${name} refuses in both validators`,()=>{
    const results=overlayGates(name,dir=>{
      const patch=join(dir,'docs/host-baseline/semantic/index.patch');
      if(name==='wrong-preimage')writeFileSync(join(dir,'docs/host-baseline/semantic/index.original.ts'),'wrong owned fixture\n');
      if(name==='wrong-path')writeFileSync(patch,readFileSync(patch,'utf8').replace('a/src/host/index.ts','a/src/host/agent-bridge.ts'));
      if(name==='extra-hunk')appendFileSync(patch,'@@ -1 +1 @@\n-x\n+y\n');
      if(name==='deletion')writeFileSync(patch,'diff --git a/src/host/index.ts b/src/host/index.ts\ndeleted file mode 100644\n');
      if(name==='unlisted-import')writeFileSync(join(dir,'src/host/unlisted.ts'),'// SPDX-License-Identifier: Apache-2.0\n');
      if(name==='unlisted-overlay')editDocs(dir,(doc,key)=>{doc[key].find(e=>e.destination==='src/host/url-policy.ts').semanticPatch={approved:true}});
      if(name==='postimage-drift'){
        const p=join(dir,'src/host/index.ts');appendFileSync(p,'// unapproved extra change\n');
        editDocs(dir,(doc,key)=>{doc[key].find(e=>e.destination==='src/host/index.ts').destinationSha256=sha256(readFileSync(p))});
      }
      if(name==='stale-exception'){
        const p=join(dir,'docs/import-manifest.json'),doc=JSON.parse(readFileSync(p,'utf8'));
        doc.exceptions.push({check:'eslint',destination:'src/host/gateway.ts',line:224,rule:'preserve-caught-error',lineSha256:'1a6d8a602aa91796943a4c8f9cf402ea82596ed8841cb4833dc7e2eb79dc97f0',reason:'stale owned fixture'});writeFileSync(p,JSON.stringify(doc));
      }
    });
    for(const r of results){
      assert.notEqual(r.status,0,r.validator+' accepted '+name);
      assert.doesNotMatch(r.stderr,/ENOENT/,'missing fixture is not semantic rejection evidence');
    }
  });
}

for (const name of ['wrong-preimage','wrong-path','extra-hunk','deletion','postimage-drift','manifest-repin','unlisted-fourth']) {
  test(`semantic host overlays: manager ${name} refuses in both validators`, () => {
    const results = overlayGates('manager-' + name, dir => {
      const path = join(dir, 'src/host/bot-manager.ts');
      const patch = join(dir, 'docs/host-baseline/semantic/bot-manager.patch');
      if (name === 'wrong-preimage') writeFileSync(join(dir, 'docs/host-baseline/semantic/bot-manager.original.ts'), 'wrong owned fixture\n');
      if (name === 'wrong-path') writeFileSync(patch, readFileSync(patch,'utf8').replace('a/src/host/bot-manager.ts','a/src/host/agent-bridge.ts'));
      if (name === 'extra-hunk') appendFileSync(patch, '@@ -1 +1 @@\n-x\n+y\n');
      if (name === 'deletion') writeFileSync(patch, 'diff --git a/src/host/bot-manager.ts b/src/host/bot-manager.ts\ndeleted file mode 100644\n');
      if (name === 'postimage-drift' || name === 'manifest-repin') {
        appendFileSync(path, '// unapproved extra change\n');
        editDocs(dir, (doc,key) => {
          const entry = doc[key].find(e => e.destination === 'src/host/bot-manager.ts');
          entry.destinationSha256 = sha256(readFileSync(path));
          if (name === 'manifest-repin') entry.semanticPatch.postimageSha256 = entry.destinationSha256;
        });
      }
      if (name === 'unlisted-fourth') editDocs(dir, (doc,key) => {
        doc[key].find(e => e.destination === 'src/host/agent-bridge.ts').semanticPatch =
          structuredClone(doc[key].find(e => e.destination === 'src/host/bot-manager.ts').semanticPatch);
      });
    });
    for (const r of results) assert.notEqual(r.status, 0, r.validator + ' accepted manager ' + name);
  });
}
