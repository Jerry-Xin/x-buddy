// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, StoreConflict, StoreIntegrityError, JobNotFound } from '../../src/cron/store/index.ts';
import { queued, observed, noWrites, scope, state } from './supersession-fixture.mjs';

for (const trigger of ['scheduled', 'catchup']) for (const attempt of [1, 2, 3]) {
  test(`${attempt === 1 ? 'REAL API' : 'SEEDED aggregate / API receipt chain'} supersede retry${attempt}/${trigger}, then execute new base`, t => {
    const f = queued(t, attempt), before = state(f.db), old = f.retry;
    f.clock.value = old.ready_at;
    const retryRequest = f.issuer.issue(f, old);
    f.clock.value = f.slot;
    const outcome = observed(f, s => f.reserve(s, { trigger }), `supersede-${attempt}-${trigger}`);
    if (outcome.error) throw outcome.error;
    const result = outcome.result;
    assert.equal(result.kind, 'reserved');
    const retired = f.row();
    assert.deepEqual(retired, { ...old, status: 'skipped', phase: null, completion: null,
      delivery_state: 'not-requested', history_state: 'skipped_not_requested', reason: 'retry-superseded', error: null, ended_at: f.slot });
    assert.equal(result.run.attempt, 0); assert.equal(result.run.status, 'queued');
    assert.equal(result.run.started_at, null); assert.equal(result.run.phase, null);
    assert.equal(result.run.occurrence_id, JSON.stringify([f.job.id, f.job.generation, f.slot]));
    const job = f.store.get(scope, f.job.id);
    assert.equal(job.last_slot_watermark, before.jobs[0].last_slot_watermark);
    for (const key of ['enabled', 'consecutive_errors', 'consecutive_skipped', 'consecutive_target_failures', 'schedule_error_count']) assert.equal(job[key], before.jobs[0][key]);
    assert.equal(job.next_run_at, f.slot + 3600000);
    assert.deepEqual(job, { ...before.jobs[0], next_run_at: f.slot + 3600000, last_run_at: f.slot,
      last_status: 'skipped', last_completion: null, last_error: null, last_error_reason: 'retry-superseded', last_duration_ms: f.slot - old.queued_at });
    assert.equal(state(f.db).runs.filter(x => ['queued', 'running'].includes(x.status)).length, 1);
    assert.deepEqual(state(f.db).runs.filter(x => x.run_id !== old.run_id && x.run_id !== result.run.run_id), before.runs.filter(x => x.run_id !== old.run_id));
    assert.equal(outcome.sql.filter(x => x === 'BEGIN IMMEDIATE').length, 1);
    assert.equal(outcome.sql.filter(x => x === 'COMMIT').length, 1);
    assert.deepEqual(outcome.dml.map(x => x.sql.trim().match(/^(UPDATE|INSERT INTO)\s+(\w+)/i).slice(1)),
      [['UPDATE', 'cron_runs'], ['UPDATE', 'cron_jobs'], ['INSERT INTO', 'cron_runs'], ['UPDATE', 'cron_jobs']]);
    noWrites(f, s => s.admitRetry(scope, f.job.id, retryRequest), { kind: 'existing', run: retired }, 'retired-retry-cannot-start');
    noWrites(f, s => f.reserve(s, { runId: 'duplicate' }), result.kind === 'reserved' ? { kind: 'existing', run: result.run } : null, 'duplicate-base');
    f.id = result.run.run_id;
    assert.equal(f.store.startBase(scope, f.job.id, f.issuer.issue(f)).kind, 'admitted');
    f.clock.value++;
    assert.equal(f.finish({ kind: 'success', deliveryState: 'not-requested' }).kind, 'finalized');
    assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, f.slot);
    assert.equal(f.store.get(scope, f.job.id).consecutive_errors, 0);
    noWrites(f, s => s.admitRetry(scope, f.job.id, retryRequest), { kind: 'existing', run: retired }, 'retired-retry-after-base-success');
  });
}
for (const offset of [-1, 0, 1]) test(`REAL API supersession due boundary ${offset}`, t => {
  const f = queued(t); f.clock.value += offset;
  if (offset < 0) noWrites(f, s => f.reserve(s), StoreConflict, 'before-due');
  else assert.equal(f.reserve().kind, 'reserved');
});
for (const [name, alter, expected] of [
  ['missing-W', f => f.db.exec('UPDATE cron_jobs SET last_slot_watermark=NULL'), StoreIntegrityError],
  ['higher-W', f => f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(f.slot), { kind: 'already-consumed' }],
  ['disabled', f => f.db.exec('UPDATE cron_jobs SET enabled=0'), StoreConflict],
  ['deleted', f => f.db.exec('UPDATE cron_jobs SET deleted_at=1'), JobNotFound],
  ['generation', f => f.db.exec('UPDATE cron_jobs SET generation=generation+1'), StoreConflict],
  ['missing-base', f => f.db.exec('DELETE FROM cron_runs WHERE attempt=0'), StoreIntegrityError],
  ['predecessor-start', f => f.db.exec('UPDATE cron_runs SET started_at=NULL WHERE attempt=0'), StoreIntegrityError],
  ['owner', f => f.db.exec("UPDATE cron_runs SET owner_incarnation='foreign' WHERE attempt=1"), 'deferred'],
  ['reset', f => f.db.exec('UPDATE cron_runs SET reset_generation=99 WHERE attempt=1'), 'deferred'],
]) test(`SEEDED negative ${name}: zero DML and complete snapshots`, t => {
  const f = queued(t); alter(f);
  noWrites(f, s => f.reserve(s), expected === 'deferred' ? { kind: 'deferred', reason: 'queued-retry-supersession', activeRunId: f.id, recheckAfterMs: 30000 } : expected, name);
});
for (const field of ['creatorAuthorized', 'targetAuthorized', 'definition', 'policy']) test(`authority ${field}: no writes`, t => {
  const f = queued(t), r = f.request();
  r.authority = { ...r.authority, [field]: field === 'definition' ? {} : field === 'policy' ? { tools: 'doc-task' } : false };
  noWrites(f, s => s.admitBase(scope, f.job.id, r), field === 'policy' ? StoreConflict : TypeError, `authority-${field}`);
});
for (const point of ['afterTerminalCas', 'afterReceiptInsert', 'afterJobProjection']) for (const fault of ['throw', 'async', 'owner']) test(`rollback ${point}/${fault}`, t => {
  const f = queued(t), before = state(f.db);
  const r = observed(f, s => f.reserve(s), `${point}-${fault}`, { [point]() {
    if (fault === 'throw') throw new Error('injected');
    if (fault === 'async') return Promise.resolve();
    f.held = false;
  } });
  assert.ok(r.error); assert.deepEqual(state(f.db), before);
});
test('entry ownership loss is zero DML', t => {
  const f = queued(t); f.held = false;
  noWrites(f, s => f.reserve(s), StoreConflict, 'entry-ownership');
});
test('two connections serialize supersession and dedupe the winner', t => {
  const f = queued(t), second = f.connect(), loser = new CronStore(second, f.clock);
  const winner = new CronStore(f.db, f.clock, { afterTerminalCas() {
    assert.throws(() => f.reserve(loser), { code: 'SQLITE_BUSY' });
  } });
  const result = f.reserve(winner); assert.equal(result.kind, 'reserved');
  assert.deepEqual(f.reserve(loser), { kind: 'existing', run: result.run });
  assert.equal(state(second).runs.filter(x => ['queued', 'running'].includes(x.status)).length, 1);
});
test('unrelated new-base primary-key collision rolls old CAS back', t => {
  const f = queued(t), before = state(f.db);
  assert.throws(() => f.reserve(f.store, { runId: 'base' }), StoreIntegrityError);
  assert.deepEqual(state(f.db), before);
});

for (const point of ['before', 'after-cas', 'after-insert', 'after-projection', 'committed']) for (const mode of ['exit', 'kill']) test(`actual ${mode}/WAL supersession ${point}`, t => {
  const f = queued(t); f.db.pragma('journal_mode=WAL'); const before = state(f.db);
  const r = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./register.mjs', import.meta.url)),
    fileURLToPath(new URL('./supersession-crash-child.mjs', import.meta.url)), f.path, String(f.slot), point, mode],
    { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.error, undefined); assert.equal(r.stderr, '');
  if (mode === 'kill') assert.equal(r.signal, 'SIGKILL'); else assert.equal(r.status, 79);
  const reopened = f.connect(), after = state(reopened);
  if (point !== 'committed') assert.deepEqual(after, before);
  else {
    assert.equal(after.runs.length, before.runs.length + 1);
    const retry = after.runs.find(x => x.run_id === f.id), base = after.runs.find(x => x.run_id === 'next-base');
    assert.deepEqual(retry, { ...f.retry, status: 'skipped', completion: null, phase: null, delivery_state: 'not-requested',
      history_state: 'skipped_not_requested', reason: 'retry-superseded', ended_at: f.slot });
    assert.equal(base.status, 'queued'); assert.equal(base.started_at, null); assert.equal(base.attempt, 0);
    assert.deepEqual(after.jobs, [{ ...before.jobs[0], next_run_at: f.slot + 3600000, last_run_at: f.slot,
      last_status: 'skipped', last_completion: null, last_error: null, last_error_reason: 'retry-superseded', last_duration_ms: f.slot - f.retry.queued_at }]);
    assert.deepEqual(after.runs.filter(x => x.run_id !== f.id && x.run_id !== 'next-base'), before.runs.filter(x => x.run_id !== f.id));
    assert.deepEqual(f.reserve(new CronStore(reopened, f.clock)), { kind: 'existing', run: base });
    assert.deepEqual(state(reopened), after);
  }
  if (process.env.SUPERSESSION_TRACE) {
    // Also retain the reopen receipt through the common full-snapshot observer.
    observed(f, () => ({ point, mode, pid: r.pid, status: r.status, signal: r.signal, original: before, reopened: after }), `crash-${point}-${mode}`);
  }
});
for (const [label, schedule, createdAt, expectedBase, expectedNext] of [
  ['stagger', { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, '2026-10-29T12:00:00Z', '2026-10-29T12:04:13.353Z', '2026-10-29T13:04:13.353Z'],
  ['fall first occurrence', { kind: 'cron', expr: '30 1 * * *', tz: 'America/New_York', exact: true }, '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z'],
  ['spring gap skipped', { kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York', exact: true }, '2027-03-13T06:00:00Z', '2027-03-13T07:30:00Z', '2027-03-15T06:30:00Z'],
]) test(`REAL API effective ${label} supersession`, t => {
  const f = queued(t, 1, { schedule, tz: schedule.tz }, Date.parse(createdAt));
  assert.equal(f.retry.authored_slot, Date.parse(expectedBase)); assert.equal(f.slot, Date.parse(expectedNext));
  f.clock.value = f.slot - 1; noWrites(f, s => f.reserve(s), StoreConflict, `${label}-before`);
  f.clock.value++; assert.equal(f.reserve().kind, 'reserved');
  assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, Date.parse(expectedBase));
});
for (const field of ['phase', 'started_at', 'ended_at', 'authored_slot', 'authored_occurrence_id', 'definition_snapshot_json', 'attempt', 'ready_at', 'queued_at']) test(`SEEDED invalid retry ${field}: zero DML`, t => {
  const f = queued(t);
  const values = { phase: 'admission', started_at: f.slot, ended_at: f.slot, authored_slot: f.slot, authored_occurrence_id: 'foreign',
    definition_snapshot_json: '{}', attempt: 3, ready_at: f.retry.ready_at + 1, queued_at: f.retry.queued_at + 1 };
  f.db.prepare(`UPDATE cron_runs SET ${field}=? WHERE run_id=?`).run(values[field], f.id);
  noWrites(f, s => f.reserve(s), StoreIntegrityError, `corrupt-${field}`);
});
for (const [field, value, reason] of [['completion', 'unknown', 'outcome-policy'], ['reason', 'restart', 'outcome-policy'],
  ['history_state', 'published', 'publication-or-delivery'], ['segments_sent', 1, 'publication-or-delivery'], ['delivery_state', 'started', 'publication-or-delivery']]) test(`SEEDED unsupported ${field}: defer before CAS`, t => {
  const f = queued(t); f.db.prepare(`UPDATE cron_runs SET ${field}=? WHERE run_id=?`).run(value, f.id);
  noWrites(f, s => f.reserve(s), { kind: 'deferred', reason }, `unsupported-${field}`);
});
for (const fault of ['chain', 'new-receipt', 'job', 'clock', 'authority']) test(`precommit ${fault} mutation rolls everything back`, t => {
  const f = queued(t), before = state(f.db), request = f.request();
  const store = new CronStore(f.db, f.clock, { afterJobProjection() {
    if (fault === 'chain') f.db.exec("UPDATE cron_runs SET ended_at=ended_at+1 WHERE run_id='base'");
    if (fault === 'new-receipt') f.db.exec("UPDATE cron_runs SET ready_at=ready_at+1 WHERE run_id='next-base'");
    if (fault === 'job') f.db.exec('UPDATE cron_jobs SET consecutive_errors=consecutive_errors+1');
    if (fault === 'clock') f.clock.value--;
    if (fault === 'authority') request.authority = { ...request.authority, targetAuthorized: false };
  } });
  assert.throws(() => store.admitBase(scope, f.job.id, request)); assert.deepEqual(state(f.db), before);
});
for (const delta of [-1, 0, 1]) test(`newer informational outcome fence ${delta}`, t => {
  const f = queued(t); f.db.prepare("UPDATE cron_jobs SET last_run_at=?,last_status='error',last_error_reason='network'").run(f.slot + delta);
  const before = f.store.get(scope, f.job.id); assert.equal(f.reserve().kind, 'reserved'); const after = f.store.get(scope, f.job.id);
  if (delta < 0) assert.equal(after.last_error_reason, 'retry-superseded');
  else for (const key of Object.keys(before).filter(x => x.startsWith('last_'))) assert.equal(after[key], before[key]);
});
for (const at of [false, true]) test(`REAL API running ${at ? 'one-shot' : 'recurring'} retry is untouched`, t => {
  const f = queued(t, 1, at ? { schedule: { kind: 'at', atMs: Date.parse('2026-10-29T12:01:00Z') }, deleteAfterRun: false } : {});
  f.clock.value = f.retry.ready_at; assert.equal(f.admit().kind, 'admitted'); const live = f.row();
  f.clock.value = at ? f.retry.ready_at + 3600000 : f.slot;
  if (at) noWrites(f, s => f.reserve(s, { trigger: 'catchup', slot: f.retry.authored_slot }), { kind: 'existing', run: state(f.db).runs.find(x => x.run_id === 'base') }, 'one-shot-duplicate');
  else { assert.equal(f.reserve().kind, 'overlap'); assert.deepEqual(f.row(), live); }
});
test('lower/higher duplicate callbacks preserve superseded chain and receipts', t => {
  const f = queued(t), base = f.reserve().run, retired = f.row();
  assert.equal(base.status, 'queued');
  f.clock.value = f.slot + 3600000;
  const higherRequest = f.request({ slot: f.clock.value, runId: 'higher' });
  const higher = f.store.admitBase(scope, f.job.id, higherRequest);
  assert.equal(higher.kind, 'overlap');
  noWrites(f, s => f.reserve(s), { kind: 'existing', run: base }, 'duplicate-lower-behind-higher-W');
  noWrites(f, s => s.admitBase(scope, f.job.id, higherRequest), { kind: 'existing', run: higher.run }, 'duplicate-higher');
  assert.deepEqual(f.row(), retired);
  f.id = base.run_id;
  assert.equal(f.store.startBase(scope, f.job.id, f.issuer.issue(f)).kind, 'admitted');
  f.clock.value++;
  assert.equal(f.finish({ kind: 'success', deliveryState: 'not-requested' }).kind, 'finalized');
  assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, higher.run.authored_slot);
  assert.equal(f.store.get(scope, f.job.id).next_run_at, higher.run.authored_slot + 3600000);
});
test('replacement generation defers old queued retry without consuming the new definition', t => {
  const f = queued(t);
  // Representation of a separately managed replacement; mutation itself is held
  // while queued work exists in this slice. No replacement writer is introduced.
  f.db.prepare('UPDATE cron_jobs SET generation=generation+1,last_slot_watermark=NULL,schedule_activated_at=?').run(f.slot);
  const request = f.request({ generation: f.job.generation + 1 });
  request.authority = { ...request.authority, definition: f.store.definition(scope, f.job.id) };
  noWrites(f, s => s.admitBase(scope, f.job.id, request), { kind: 'deferred', reason: 'queued-retry-supersession', activeRunId: f.id, recheckAfterMs: 30000 }, 'replacement-generation');
});
test('CAS mismatch rolls back the injected identity change', t => {
  const f = queued(t), before = state(f.db);
  const s = new CronStore(f.db, f.clock, { beforeSupersessionCas() { f.db.prepare('UPDATE cron_runs SET ready_at=ready_at+1 WHERE run_id=?').run(f.id); } });
  assert.throws(() => f.reserve(s), StoreConflict); assert.deepEqual(state(f.db), before);
});
test('reservation mints no permit; default issuer still defers execution without writes', t => {
  const f = queued(t), r = f.reserve(); assert.equal(r.kind, 'reserved'); f.id = r.run.run_id;
  const request = f.issuer.issue(f);
  noWrites(f, () => new CronStore(f.db, f.clock).startBase(scope, f.job.id, request),
    { kind: 'deferred', reason: 'execution-admission', prerequisite: 'issuer-unavailable' }, 'default-issuer-new-base');
  request.executionProof.admissionDeadlineMs = f.clock.value;
  noWrites(f, s => s.startBase(scope, f.job.id, f.issuer.issue(f, f.row(), { executionProof: {
    ...request.executionProof, permitGrantedAtMs: f.clock.value - 1000, admissionDeadlineMs: f.clock.value } })),
    { kind: 'deferred', reason: 'execution-admission', prerequisite: 'permit-not-current' }, 'expired-permit-new-base');
});
for (const mutation of ['phase', 'completion', 'history', 'end', 'owner', 'reset', 'snapshot']) test(`SEEDED retained predecessor ${mutation} quarantines before CAS`, t => {
  const f = queued(t);
  const sql = { phase: "UPDATE cron_runs SET phase='executing' WHERE attempt=0", completion: "UPDATE cron_runs SET completion='succeeded' WHERE attempt=0",
    history: "UPDATE cron_runs SET history_state='published' WHERE attempt=0", end: 'UPDATE cron_runs SET ended_at=ended_at+1 WHERE attempt=0',
    owner: "UPDATE cron_runs SET owner_incarnation='foreign' WHERE attempt=0", reset: 'UPDATE cron_runs SET reset_generation=3 WHERE attempt=0',
    snapshot: "UPDATE cron_runs SET definition_snapshot_json=json_set(definition_snapshot_json,'$.policy.tools','doc-task') WHERE attempt=0" }[mutation];
  f.db.exec(sql); noWrites(f, s => f.reserve(s), StoreIntegrityError, `predecessor-${mutation}`);
});
test('SEEDED aggregate thresholds stay neutral; later failure still requires disable notice', t => {
  const f = queued(t); f.db.exec('UPDATE cron_jobs SET consecutive_errors=9,consecutive_target_failures=2,consecutive_skipped=4,schedule_error_count=3');
  const r = f.reserve(); assert.equal(r.kind, 'reserved'); const job = f.store.get(scope, f.job.id);
  assert.equal(job.consecutive_errors, 9); assert.equal(job.consecutive_target_failures, 2); assert.equal(job.consecutive_skipped, 4);
  assert.equal(job.schedule_error_count, 3); assert.equal(job.enabled, 1); assert.equal(job.auto_disabled_reason, null);
  f.id = r.run.run_id; assert.equal(f.store.startBase(scope, f.job.id, f.issuer.issue(f)).kind, 'admitted'); f.clock.value++;
  const before = state(f.db);
  assert.deepEqual(f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: 'must-not-exist' }), { kind: 'deferred', reason: 'disable-notice-required' });
  assert.deepEqual(state(f.db), before);
});
for (const ending of ['keep', 'delete']) test(`REAL API one-shot ${ending} queued retry never supersedes`, t => {
  const f = queued(t, 1, { schedule: { kind: 'at', atMs: Date.parse('2026-10-29T12:01:00Z') }, deleteAfterRun: ending === 'delete' });
  const base = state(f.db).runs.find(x => x.run_id === 'base'); f.clock.value += 7200000;
  noWrites(f, s => f.reserve(s, { slot: f.retry.authored_slot, trigger: 'catchup' }), { kind: 'existing', run: base }, `one-shot-${ending}-existing`);
  noWrites(f, s => f.reserve(s), StoreConflict, `one-shot-${ending}-non-authored-slot`);
  assert.deepEqual(f.row(), f.retry);
});
