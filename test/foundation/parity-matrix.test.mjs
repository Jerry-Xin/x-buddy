// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EXPECTED_CAPABILITY_COUNT, EXPECTED_CRON_COUNT, EXPECTED_LOCK_COUNT, validate } from './parity/validate-parity-matrix.mjs';
import { SEED_PATH, seedOf, seedText } from './parity/seed.mjs';
import { URL } from 'node:url';

const matrix = JSON.parse(readFileSync(new URL('./parity/parity-matrix.json', import.meta.url), 'utf8'));
const clone = () => globalThis.structuredClone(matrix);
const row = (m, id) => m.rows.find(r => r.id === id);
const CASE = 'locks T1 packet constants';
const REF = `test/foundation/example.test.mjs#${CASE}`;
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const TAP_OK = `TAP version 13\nok 1 - ${CASE}\n1..1\n# pass 1\n# fail 0\n`;
const fakeFs = {
  'test/foundation/example.test.mjs': `test('${CASE}', () => {})\nconst note = 'mentions only: other case title';\n`,
  'package.json': `{"a": "${CASE}"}`,
  'test/foundation/evidence/run.tap': TAP_OK,
  'test/foundation/evidence/skip.tap': `ok 1 - ${CASE} # SKIP not on this host\n`,
  'test/foundation/evidence/fail.tap': `ok 1 - ${CASE}\nnot ok 2 - ${CASE}\n`,
};
const fsOpts = { fileExists: p => p in fakeFs, readFile: p => fakeFs[p] };
const tap = path => ({ kind: 'node-test-tap', path, sha256: sha(fakeFs[path]) });
const passedClaim = { executionStatus: 'passed', tests: [REF], evidence: [tap('test/foundation/evidence/run.tap')], layer: 'unit' };

test('committed matrix is complete: 155 capability ids, 59 cron ids, no errors', () => {
  const report = validate(matrix);
  assert.deepEqual(report.errors, []);
  assert.equal(report.totals.capability, EXPECTED_CAPABILITY_COUNT);
  assert.equal(report.totals.cron, EXPECTED_CRON_COUNT);
  assert.equal(report.totals.implemented, 0, 'nothing is claimed as implemented in the foundation batch');
  assert.ok(report.totals.lockRequired >= 15 + 12 + 16, 'REUSE "—" locks, BX rows and invariants are all lock rows');
});

test('matrix pins the R8 record digest and keeps bundle expansions explicit', () => {
  assert.equal(matrix.source.commentId, '709cfb70-e0aa-49e2-8163-d4a4142abc1e');
  assert.match(matrix.source.contentSha256, /^[a-f0-9]{64}$/);
  for (const id of ['EP-17', 'EP-18', 'EP-20', 'EP-27', 'O24']) assert.equal(row(matrix, id).expansion.status, 'pending', id);
  for (const id of ['T11', 'T23', 'R4', 'R5', 'I1', 'I4', 'I9', 'I26', 'I29', 'S7', 'S14', 'O2', 'O10', 'EP-13', 'EP-28']) {
    assert.equal(row(matrix, id).lockRequired, true, id);
  }
});

test('negative control: a deleted row is a silent-omission error', () => {
  const m = clone();
  m.rows = m.rows.filter(r => r.id !== 'O24');
  const report = validate(m);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(e => e.startsWith('O24: missing O row')));
  assert.ok(report.errors.some(e => e.includes('expected 155 capability rows, found 154')));
});

test('negative control: duplicate, unknown id and unknown disposition are rejected', () => {
  const m = clone();
  m.rows.push(globalThis.structuredClone(row(m, 'T1')));
  m.rows.push({ ...globalThis.structuredClone(row(m, 'T2')), id: 'T27' });
  row(m, 'T3').dispositionCodes = ['MAYBE'];
  const errors = validate(m).errors;
  assert.ok(errors.includes('T1: duplicate id'));
  assert.ok(errors.includes('T27: id is not in the expected T set'));
  assert.ok(errors.includes('T3: unknown disposition MAYBE'));
});

test('negative control: progress claims need resolvable test references and evidence', () => {
  const m = clone();
  row(m, 'T1').implementationStatus = 'implemented';
  row(m, 'T2').executionStatus = 'passed';
  row(m, 'T2').tests = [REF];
  row(m, 'T3').implementationStatus = 'partial';
  row(m, 'T3').tests = ['test/foundation/example.test.mjs#a case that does not exist'];
  row(m, 'T4').implementationStatus = 'partial';
  row(m, 'T4').tests = ['test/missing.test.mjs#x', '../escape.test.mjs#x', 'no-hash'];
  const errors = validate(m, fsOpts).errors;
  assert.ok(errors.includes('T1: status claims progress but cites no tests'));
  assert.ok(errors.includes('T2: passed requires evidence'));
  assert.ok(errors.some(e => e.startsWith('T3: cited case not declared')));
  assert.ok(errors.some(e => e.startsWith('T4: cited test file does not exist')));
  assert.ok(errors.some(e => e.startsWith('T4: test path must be repository-relative')));
  assert.ok(errors.some(e => e.startsWith('T4: test reference must be "path#case"')));
});

test('negative control: not-applicable needs an OD reference; pending bundles cannot be implemented', () => {
  const m = clone();
  Object.assign(row(m, 'I30'), { implementationStatus: 'not-applicable', odRefs: [] });
  Object.assign(row(m, 'EP-18'), { implementationStatus: 'implemented', tests: [REF] });
  const errors = validate(m, fsOpts).errors;
  assert.ok(errors.includes('I30: not-applicable requires an OD reference'));
  assert.ok(errors.includes('EP-18: bundle row cannot be implemented while its action-level expansion is pending'));
});

test('gate mode fails while any lock row has not passed, and passes once all are evidenced', () => {
  assert.equal(validate(matrix, { gate: true }).ok, false);
  const m = clone();
  for (const r of m.rows.filter(x => x.lockRequired)) Object.assign(r, globalThis.structuredClone(passedClaim));
  assert.deepEqual(validate(m, { gate: true, ...fsOpts }).errors, []);
});

test('seed: parity-seed.v1.json is the immutable part of the committed matrix and lists the 58 R8 lock rows', () => {
  const text = readFileSync(SEED_PATH, 'utf8');
  assert.equal(seedText(seedOf(matrix)), text);
  assert.equal(JSON.parse(text).lockRequired.length, EXPECTED_LOCK_COUNT);
});

test('tamper: clearing lockRequired on one row or on every row cannot pass the gate', () => {
  const one = clone();
  row(one, 'T1').lockRequired = false;
  const e1 = validate(one).errors;
  assert.ok(e1.includes('T1: lockRequired differs from the R8 seed'));
  assert.ok(e1.some(e => e.startsWith(`matrix: lock set must be exactly the ${EXPECTED_LOCK_COUNT} seeded R8 lock rows`)));

  const all = clone();
  for (const r of all.rows) r.lockRequired = false;
  const report = validate(all, { gate: true });
  assert.equal(report.ok, false);
  assert.equal(report.errors.filter(e => e.endsWith('lockRequired differs from the R8 seed')).length, EXPECTED_LOCK_COUNT);

  const extra = clone();
  row(extra, 'T8').lockRequired = true;
  assert.ok(validate(extra).errors.includes('T8: lockRequired differs from the R8 seed'));
});

test('tamper: an altered source digest, record id or amendment list is rejected', () => {
  for (const edit of [
    m => { m.source.contentSha256 = 'f'.repeat(64); },
    m => { m.source.commentId = '00000000-0000-0000-0000-000000000000'; },
    m => { m.source.amendments = []; },
  ]) {
    const m = clone();
    edit(m);
    assert.ok(validate(m).errors.some(e => e.startsWith('matrix: source must equal the pinned R8 record')));
  }
});

test('tamper: seed fields (label, disposition, stage, family, inheritance, OD refs, expansion) are immutable', () => {
  const m = clone();
  row(m, 'T1').label = 'something else';
  row(m, 'T2').dispositionCodes = ['NA'];
  row(m, 'T3').stage = 'DEV-09';
  row(m, 'EP-16').inheritsFrom = 'EP-14';
  row(m, 'T5').family = 'R';
  delete row(m, 'EP-03').expansion;
  row(m, 'EP-04').expansion.members = 'fewer';
  const withOd = m.rows.find(r => r.odRefs.length > 0);
  withOd.odRefs = [];
  const errors = validate(m).errors;
  for (const e of [
    'T1: label differs from the R8 seed', 'T2: dispositionCodes differs from the R8 seed', 'T3: stage differs from the R8 seed', 'T5: family differs from the R8 seed',
    'EP-16: inheritsFrom differs from the R8 seed', 'EP-03: expansionMembers differs from the R8 seed',
    'EP-04: expansionMembers differs from the R8 seed',
  ]) assert.ok(errors.includes(e), e);
  assert.ok(errors.some(e => e.startsWith(`${withOd.id}: R8 OD reference`)));
});

test('tamper: an edited seed file is rejected by its pinned digest', () => {
  const text = readFileSync(SEED_PATH, 'utf8').replace('"T1",', '');
  const report = validate(matrix, { seedText: text });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(e => e.startsWith('seed: parity-seed.v1.json digest')));
});

test('tamper: forged passed claims (non-test file, substring-only case, free-form or unpinned evidence) fail', () => {
  const m = clone();
  Object.assign(row(m, 'T1'), passedClaim, { tests: ['package.json#a'] });
  Object.assign(row(m, 'T2'), passedClaim, { tests: ['test/foundation/example.test.mjs#other case title'] });
  Object.assign(row(m, 'T3'), passedClaim, { evidence: ['x'] });
  Object.assign(row(m, 'T4'), passedClaim, { evidence: [{ ...tap('test/foundation/evidence/run.tap'), sha256: 'a'.repeat(64) }] });
  Object.assign(row(m, 'T5'), passedClaim, { evidence: [tap('test/foundation/evidence/skip.tap')] });
  Object.assign(row(m, 'T6'), passedClaim, { evidence: [tap('test/foundation/evidence/fail.tap')] });
  Object.assign(row(m, 'T7'), passedClaim, { evidence: [{ kind: 'node-test-tap', path: 'test/foundation/evidence/none.tap', sha256: 'b'.repeat(64) }] });
  const errors = validate(m, { gate: true, ...fsOpts }).errors;
  assert.ok(errors.includes('T1: test path must be a test/** *.test.* file: package.json'));
  assert.ok(errors.includes('T2: cited case not declared in test/foundation/example.test.mjs: other case title'));
  assert.ok(errors.some(e => e.startsWith("T3: evidence entry must be {kind:'node-test-tap', path, sha256}")));
  assert.ok(errors.includes('T4: evidence digest mismatch for test/foundation/evidence/run.tap'));
  assert.ok(errors.includes(`T5: evidence does not report cited case as ok: ${CASE}`));
  assert.ok(errors.includes(`T6: evidence reports cited case as not ok: ${CASE}`));
  assert.ok(errors.includes('T7: evidence file does not exist: test/foundation/evidence/none.tap'));
});

test('tamper: pending bundles cannot pass, expansion status is closed, OD refs must be OD ids', () => {
  const m = clone();
  Object.assign(row(m, 'EP-03'), passedClaim, { implementationStatus: 'partial' });
  row(m, 'EP-04').expansion.status = 'done';
  Object.assign(row(m, 'EP-04'), { implementationStatus: 'implemented', tests: [REF] });
  Object.assign(row(m, 'I30'), { implementationStatus: 'not-applicable', odRefs: ['x'] });
  const errors = validate(m, fsOpts).errors;
  assert.ok(errors.includes('EP-03: bundle row cannot be passed while its action-level expansion is pending'));
  assert.ok(errors.includes('EP-04: bad expansion.status done'));
  assert.ok(errors.includes('I30: odRefs entry must be an OD id (OD-<n>): x'));
});

test('real TAP from node --test is accepted as evidence; skipped and todo results are not', () => {
  const tapText = ['TAP version 13', `ok 1 - ${CASE}`, 'ok 2 - a \\# hash # SKIP', '    ok 1 - nested case', '1..2', ''].join('\n');
  const files = {
    'test/foundation/example.test.mjs': `test('${CASE}', () => {}); test('a # hash', () => {}); test("nested case", () => {});`,
    'test/foundation/evidence/run.tap': tapText,
  };
  const io = { fileExists: p => p in files, readFile: p => files[p] };
  const ev = [{ kind: 'node-test-tap', path: 'test/foundation/evidence/run.tap', sha256: sha(tapText) }];
  const m = clone();
  Object.assign(row(m, 'T1'), { executionStatus: 'passed', tests: [REF, 'test/foundation/example.test.mjs#nested case'], evidence: ev });
  Object.assign(row(m, 'T2'), { executionStatus: 'passed', tests: ['test/foundation/example.test.mjs#a # hash'], evidence: ev });
  const errors = validate(m, io).errors;
  assert.equal(errors.filter(e => e.startsWith('T1:')).length, 0, errors.join('\n'));
  assert.ok(errors.includes('T2: evidence does not report cited case as ok: a # hash'));
});

test('tamper: deleting or renaming expansion.status, or dropping the expansion, cannot unlock a pending bundle', () => {
  const m = clone();
  delete row(m, 'EP-03').expansion.status;
  Object.assign(row(m, 'EP-03'), { implementationStatus: 'implemented', tests: [REF] });
  const e4 = row(m, 'EP-04').expansion;
  e4.state = e4.status; delete e4.status;
  Object.assign(row(m, 'EP-04'), passedClaim);
  delete row(m, 'EP-12').expansion;
  Object.assign(row(m, 'EP-12'), passedClaim, { implementationStatus: 'implemented' });
  const report = validate(m, { gate: true, ...fsOpts });
  assert.equal(report.ok, false);
  for (const e of ['EP-03: bad expansion.status undefined', 'EP-04: bad expansion.status undefined', 'EP-12: expansionMembers differs from the R8 seed']) {
    assert.ok(report.errors.includes(e), e);
  }
});
