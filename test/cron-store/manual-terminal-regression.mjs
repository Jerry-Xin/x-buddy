// SPDX-License-Identifier: Apache-2.0
// R1 local integrity regressions. Corruption occurs only after public admission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreConflict, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { manualFixture, success, scope, state } from './manual-fixture.mjs';
import { observed } from './supersession-fixture.mjs';

function reject(f, label) {
  const row = f.row();
  // A terminal replay still supplies an active-state expectation. Reflect the
  // corrupt identity in that callback to exercise stored-outcome acceptance,
  // without changing the stored lifecycle or granting execution authority.
  const expected = terminalExpectation({ ...row, status: row.started_at === null ? 'queued' : 'running' });
  const outcome = row.started_at === null ? { kind: 'neutral', reason: 'shutdown' } : success;
  const r = observed(f, s => s.finalize(scope, f.job.id, { expected, ownership: f.owner, outcome }), label);
  assert.ok(r.error instanceof StoreIntegrityError, JSON.stringify({ result: r.result, dml: r.dml }));
  assert.deepEqual(r.dml, []);
  assert.deepEqual(r.after, r.before);
}
function corruptMode(f) {
  const snapshot = JSON.parse(f.row().definition_snapshot_json);
  snapshot.manualMode = 'if-enabled';
  f.db.prepare("UPDATE cron_runs SET manual_mode='if-enabled',definition_snapshot_json=? WHERE run_id=?")
    .run(JSON.stringify(snapshot), f.id);
}

test('R1 queued due shutdown rejects ready_at corruption before watermark or keep retirement', t => {
  const f = manualFixture(t, { deleteAfterRun: false }); f.clock.value += 60000;
  assert.equal(f.reserve({ manualMode: 'due' }).kind, 'reserved');
  f.db.prepare('UPDATE cron_runs SET ready_at=ready_at+1 WHERE run_id=?').run(f.id);
  const r = observed(f, s => f.finish({ kind: 'neutral', reason: 'shutdown' }, {}, s), 'R1-queued-ready-shutdown');
  assert.ok(r.error instanceof StoreIntegrityError, JSON.stringify(r.result));
  assert.deepEqual(r.dml, []); assert.deepEqual(r.after, r.before);
});

test('R1 running due success rejects ready_at corruption before deleting retirement', t => {
  const f = manualFixture(t); f.clock.value += 60000;
  assert.equal(f.reserve({ manualMode: 'due' }).kind, 'reserved');
  assert.equal(f.start().kind, 'admitted');
  f.db.prepare('UPDATE cron_runs SET ready_at=ready_at+1 WHERE run_id=?').run(f.id);
  f.clock.value++; reject(f, 'R1-running-ready-success');
});

for (const stage of ['queued', 'running', 'terminal']) {
  test(`R1 disabled force borrow rejects matching if-enabled row and snapshot at ${stage}`, t => {
    const f = manualFixture(t, { enabled: false });
    assert.equal(f.reserve({ manualMode: 'force' }).kind, 'reserved');
    if (stage !== 'queued') assert.equal(f.start().kind, 'admitted');
    if (stage === 'terminal') assert.equal(f.finish(success).kind, 'finalized');
    corruptMode(f); reject(f, `R1-disabled-mode-${stage}`);
  });
}

for (const stage of ['queued', 'running', 'terminal']) {
  test(`R1 future borrow rejects ready_at corruption at ${stage}`, t => {
    const f = manualFixture(t);
    assert.equal(f.reserve().kind, 'reserved');
    if (stage !== 'queued') assert.equal(f.start().kind, 'admitted');
    if (stage === 'terminal') assert.equal(f.finish(success).kind, 'finalized');
    f.db.prepare('UPDATE cron_runs SET ready_at=ready_at+1 WHERE run_id=?').run(f.id);
    f.clock.value++; reject(f, `R1-borrow-ready-${stage}`);
  });
}

for (const started of [false, true]) {
  test(`R1 stored consuming outcome rejects ready_at corruption after ${started ? 'running success' : 'queued shutdown'}`, t => {
    const f = manualFixture(t, { deleteAfterRun: false }); f.clock.value += 60000;
    assert.equal(f.reserve({ manualMode: 'due' }).kind, 'reserved');
    if (started) assert.equal(f.start().kind, 'admitted');
    const outcome = started ? success : { kind: 'neutral', reason: 'shutdown' };
    assert.equal(f.finish(outcome).kind, 'finalized');
    f.db.prepare('UPDATE cron_runs SET ready_at=ready_at+1 WHERE run_id=?').run(f.id);
    reject(f, `R1-stored-consume-${started}`);
  });
}

for (const mode of ['queued-consume', 'running-consume', 'disabled-borrow']) {
  test(`R1 valid ${mode} terminal duplicate has zero DML and unchanged full state`, t => {
    const disabled = mode === 'disabled-borrow';
    const f = manualFixture(t, { enabled: !disabled, deleteAfterRun: false });
    if (!disabled) f.clock.value += 60000;
    assert.equal(f.reserve({ manualMode: disabled ? 'force' : 'due' }).kind, 'reserved');
    if (mode !== 'queued-consume') assert.equal(f.start().kind, 'admitted');
    const outcome = mode === 'queued-consume' ? { kind: 'neutral', reason: 'shutdown' } : success;
    const expected = terminalExpectation(f.row());
    assert.equal(f.finish(outcome).kind, 'finalized');
    const r = observed(f, s => s.finalize(scope, f.job.id, { expected, ownership: f.owner, outcome }), `R1-valid-duplicate-${mode}`);
    assert.ifError(r.error); assert.equal(r.result.kind, 'existing');
    assert.deepEqual(r.dml, []); assert.deepEqual(r.after, r.before);
    const job = f.store.get(scope, f.job.id);
    assert.equal(job.enabled, 0);
    assert.equal(job.last_slot_watermark, disabled ? null : f.row().authored_slot);
  });
}

for (const entry of ['startBase', 'admitRetry']) {
  test(`R1 strict legacy ${entry} rejects public manual receipt without writes`, t => {
    const f = manualFixture(t); assert.equal(f.reserve().kind, 'reserved');
    const request = f.issuer.issue(f), before = state(f.db);
    const r = observed(f, s => s[entry](scope, f.job.id, request), `R1-wrong-entry-${entry}`);
    assert.ok(r.error instanceof StoreConflict);
    assert.deepEqual(r.dml, []); assert.deepEqual(r.after, before);
  });
}
