// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPECTED_CAPABILITY_COUNT, EXPECTED_CRON_COUNT, validate } from './parity/validate-parity-matrix.mjs';
import { URL } from 'node:url';

const matrix = JSON.parse(readFileSync(new URL('./parity/parity-matrix.json', import.meta.url), 'utf8'));
const clone = () => globalThis.structuredClone(matrix);
const row = (m, id) => m.rows.find(r => r.id === id);
const fakeFs = { 'test/foundation/example.test.mjs': "test('locks T1 packet constants', () => {})" };
const fsOpts = { fileExists: p => p in fakeFs, readFile: p => fakeFs[p] };

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
  row(m, 'T2').tests = ['test/foundation/example.test.mjs#locks T1 packet constants'];
  row(m, 'T3').implementationStatus = 'partial';
  row(m, 'T3').tests = ['test/foundation/example.test.mjs#a case that does not exist'];
  row(m, 'T4').implementationStatus = 'partial';
  row(m, 'T4').tests = ['test/missing.test.mjs#x', '../escape.test.mjs#x', 'no-hash'];
  const errors = validate(m, fsOpts).errors;
  assert.ok(errors.includes('T1: status claims progress but cites no tests'));
  assert.ok(errors.includes('T2: passed requires evidence'));
  assert.ok(errors.some(e => e.startsWith('T3: cited case not found')));
  assert.ok(errors.some(e => e.startsWith('T4: cited test file does not exist')));
  assert.ok(errors.some(e => e.startsWith('T4: test path must be repository-relative')));
  assert.ok(errors.some(e => e.startsWith('T4: test reference must be "path#case"')));
});

test('negative control: not-applicable needs an OD reference; pending bundles cannot be implemented', () => {
  const m = clone();
  Object.assign(row(m, 'I30'), { implementationStatus: 'not-applicable', odRefs: [] });
  Object.assign(row(m, 'EP-18'), { implementationStatus: 'implemented', tests: ['test/foundation/example.test.mjs#locks T1 packet constants'] });
  const errors = validate(m, fsOpts).errors;
  assert.ok(errors.includes('I30: not-applicable requires an OD reference'));
  assert.ok(errors.includes('EP-18: bundle row cannot be implemented while its action-level expansion is pending'));
});

test('gate mode fails while any lock row has not passed, and passes once all are evidenced', () => {
  assert.equal(validate(matrix, { gate: true }).ok, false);
  const m = clone();
  for (const r of m.rows.filter(x => x.lockRequired)) {
    Object.assign(r, { executionStatus: 'passed', tests: ['test/foundation/example.test.mjs#locks T1 packet constants'], evidence: ['junit.xml'] });
  }
  assert.deepEqual(validate(m, { gate: true, ...fsOpts }).errors, []);
});
