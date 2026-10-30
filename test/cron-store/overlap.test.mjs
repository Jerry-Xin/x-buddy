// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, StoreConflict, StoreIntegrityError, JobNotFound } from '../../src/cron/store/index.ts';
import { consumePredicates, projectNewOverlap } from '../../src/cron/store/terminal-projection.ts';
import { fixture, input, scope, now, receipt, state } from './helpers.mjs';

function req(f, changes = {}) {
  return { trigger: 'scheduled', generation: f.job.generation, slot: f.slot, runId: 'r_overlap',
    authority: { jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: 'new-owner', resetGeneration: 7, policy: { tools: 'none' } },
    ownership: { ownerIncarnation: 'new-owner', resetGeneration: 7, assertHeld() { assert.equal(f.db.inTransaction, true); } }, ...changes };
}
function busy(t, overrides = {}, active = {}) {
  const f = fixture(t), job = f.store.create(input(overrides)), slot = job.next_run_at;
  f.clock.value = slot;
  const original = receipt(f.db, job, { owner_incarnation: 'preserved-owner', reset_generation: 3, ...active });
  return { ...f, job, slot, original };
}
const admit = (f, changes = {}, store = f.store) => store.admitBase(scope, f.job.id, req(f, changes));
function unchanged(f, work, error) {
  const before = state(f.db);
  if (error) assert.throws(work, error); else work();
  assert.deepEqual(state(f.db), before);
}
function assertTerminal(f, result, trigger, kind = 'overlap') {
  assert.equal(result.kind, kind);
  const r = result.run, canonical = JSON.stringify([f.job.id, f.job.generation, r.scheduled_for]);
  assert.deepEqual(r, { run_id: 'r_overlap', job_id: f.job.id, trigger, manual_mode: null, schedule_ownership: 'consume',
    authored_occurrence_id: canonical, authored_slot: r.scheduled_for, admitted_enabled: 1, admitted_next_run_at: f.slot,
    scheduled_for: r.scheduled_for, attempt: 0, occurrence_id: canonical, ready_at: r.scheduled_for,
    status: 'skipped', phase: null, completion: null, delivery_state: 'not-requested', segments_sent: 0,
    history_state: 'not-published', reason: 'overlap', error: null, admitted_generation: f.job.generation,
    definition_snapshot_json: r.definition_snapshot_json, reset_generation: 7, owner_incarnation: 'new-owner', exec_mode: f.job.exec_mode,
    thread_id: null, turn_id: null, model: null, usage_json: null, summary: null, lane_wait_ms: null,
    queued_at: f.clock.value, started_at: null, ended_at: f.clock.value });
  const snap = JSON.parse(r.definition_snapshot_json);
  assert.deepEqual(snap, { ...f.store.definition(scope, f.job.id), occurrenceId: canonical, policy: { tools: 'none' },
    scheduleOwnership: 'consume', authoredOccurrenceId: canonical, authoredSlot: r.scheduled_for,
    admittedEnabled: true, admittedNextRunAt: f.slot });
  assert.deepEqual(f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.original.run_id), f.original);
  assert.equal(f.db.prepare("SELECT count(*) n FROM cron_runs WHERE status IN ('queued','running')").get().n, 1);
  assert.equal(Object.isFrozen(r), true);
}

for (const [label, schedule, nextAt] of [
  ['every', { kind: 'every', everyMs: 60000, anchorMs: 0 }, now + 120000],
  ['exact cron', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', exact: true }, now + 7200000],
  ['staggered cron', { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, now + 3853353],
]) for (const trigger of ['scheduled', 'catchup']) for (const active of [
  { trigger: 'manual', status: 'running' }, { trigger: 'manual', status: 'queued', started_at: null, phase: null },
  { trigger: 'retry', status: 'running', attempt: 1 },
  { trigger: 'scheduled', status: 'running', admitted_generation: 0 },
]) test(`terminal ${label}/${trigger} alongside ${active.trigger}/${active.status}/g${active.admitted_generation ?? 1}`, t => {
  const f = busy(t, { schedule }, active), result = admit(f, { trigger });
  assertTerminal(f, result, trigger);
  const job = f.store.get(scope, f.job.id);
  assert.equal(job.last_slot_watermark, f.slot); assert.equal(job.consecutive_skipped, 1); assert.equal(job.next_run_at, nextAt);
  const changed = { ...f.job, last_slot_watermark: f.slot, consecutive_skipped: 1, next_run_at: nextAt,
    last_run_at: f.clock.value, last_status: 'skipped', last_completion: null, last_error: null, last_error_reason: 'overlap', last_duration_ms: 0 };
  assert.deepEqual(job, changed);
  unchanged(f, () => assert.deepEqual(admit(f, { trigger: trigger === 'scheduled' ? 'catchup' : 'scheduled', runId: 'unused' }), { kind: 'existing', run: result.run }));
});
for (const trigger of ['scheduled', 'catchup']) test(`late ${trigger} overlap advances strictly after observed now`, t => {
  const f = busy(t); f.clock.value = f.slot + 255000;
  const slot = trigger === 'scheduled' ? f.slot : f.slot + 240000;
  const result = admit(f, { trigger, slot }); assertTerminal(f, result, trigger);
  assert.equal(f.store.get(scope, f.job.id).next_run_at, f.slot + 300000);
});
for (const watermark of [null, now, now + 60000]) test(`W=${watermark}: fresh versus consumed, exactly one skipped increment`, t => {
  const f = busy(t); f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,consecutive_skipped=4,consecutive_errors=9,consecutive_target_failures=2').run(watermark);
  if (watermark === f.slot) unchanged(f, () => assert.deepEqual(admit(f), { kind: 'already-consumed' }));
  else {
    const r = admit(f); assert.equal(r.kind, 'overlap'); const job = f.store.get(scope, f.job.id);
    assert.equal(job.last_slot_watermark, f.slot); assert.equal(job.consecutive_skipped, 5);
    assert.equal(job.consecutive_errors, 9); assert.equal(job.consecutive_target_failures, 2); assert.equal(job.enabled, 1);
    unchanged(f, () => assert.deepEqual(admit(f), { kind: 'existing', run: r.run }));
  }
});
for (const delta of [-1, 0, 1]) test(`information newer fence delta ${delta}`, t => {
  const f = busy(t), previous = { last_run_at: f.slot + delta, last_status: 'error', last_completion: 'failed', last_error: 'prior', last_error_reason: 'network', last_duration_ms: 123 };
  f.db.prepare('UPDATE cron_jobs SET last_run_at=?,last_status=?,last_completion=?,last_error=?,last_error_reason=?,last_duration_ms=?').run(...Object.values(previous));
  admit(f); const job = f.store.get(scope, f.job.id);
  if (delta < 0) { assert.equal(job.last_status, 'skipped'); assert.equal(job.last_error, null); assert.equal(job.last_run_at, f.slot); }
  else for (const k of Object.keys(previous)) assert.equal(job[k], previous[k]);
});
test('projection keeps a later cadence and higher W; predicates separate current, consume and base', t => {
  const f = busy(t), r = admit(f).run, definition = f.store.definition(scope, f.job.id);
  // Direct helper boundary only: future terminal CAS is not implemented or claimed here.
  const high = f.slot + 600000;
  f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?').run(high, high + 60000);
  const job = f.store.get(scope, f.job.id);
  assert.deepEqual(consumePredicates(job, definition, r), { currentDefinition: true, validConsume: true, baseConsume: true });
  assert.equal(consumePredicates({ ...job, generation: 2 }, definition, r).baseConsume, false);
  assert.equal(consumePredicates({ ...job, deleted_at: now }, definition, r).currentDefinition, false);
  assert.deepEqual(consumePredicates(job, definition, { ...r, schedule_ownership: 'borrow' }), { currentDefinition: true, validConsume: false, baseConsume: false });
  assert.equal(consumePredicates(job, definition, { ...r, attempt: 1 }).baseConsume, false);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    projectNewOverlap(f.db, job, definition, r, f.slot + 60000);
    assert.equal(f.store.get(scope, f.job.id).next_run_at, high + 60000);
    assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, high);
  } finally { f.db.exec('ROLLBACK'); }
  unchanged(f, () => assert.deepEqual(admit(f), { kind: 'existing', run: r }));
});
test('reserved lower slot stays dedupable under a later overlap watermark', t => {
  const f = fixture(t), job = f.store.create(input()); f.clock.value = job.next_run_at;
  Object.assign(f, { job, slot: job.next_run_at }); const first = admit(f).run;
  f.clock.value += 60000; const overlap = admit(f, { slot: f.slot + 60000, runId: 'later' });
  assert.equal(overlap.kind, 'overlap');
  unchanged(f, () => assert.deepEqual(admit(f), { kind: 'existing', run: first }));
  assert.equal(f.store.get(scope, job.id).last_slot_watermark, f.slot + 60000);
});
for (const variant of ['queued consume','running consume','running retry','old generation running']) test(`real reserved provenance: ${variant} remains byte identical beside overlap`, t => {
  const f = fixture(t); f.job = f.store.create(input()); f.slot = f.job.next_run_at; f.clock.value = f.slot;
  const lower = admit(f,{runId:'lower'}).run;
  if (variant === 'running retry') {
    // Retained terminal base and retry chain are fixture facts; this task adds no retry writer.
    f.db.prepare("UPDATE cron_runs SET status='error',completion='failed',ended_at=? WHERE run_id='lower'").run(f.slot);
    f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(f.slot);
    const retry = {...lower,run_id:'retry',trigger:'retry',attempt:1,status:'running',phase:'executing',started_at:f.slot,ready_at:f.slot+30000};
    const cols=Object.keys(retry);
    f.db.prepare(`INSERT INTO cron_runs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(retry));
    f.original=f.db.prepare("SELECT * FROM cron_runs WHERE run_id='retry'").get();
  } else {
    if (variant !== 'queued consume') f.db.prepare("UPDATE cron_runs SET status='running',phase='executing',thread_id='preserved-thread',turn_id='preserved-turn',started_at=? WHERE run_id='lower'").run(f.slot);
    f.original=f.db.prepare("SELECT * FROM cron_runs WHERE run_id='lower'").get();
    if (variant === 'old generation running') f.store.edit(scope,f.job.id,1,{name:'replacement'});
  }
  f.job=f.store.get(scope,f.job.id); f.slot=f.job.next_run_at; f.clock.value=f.slot;
  const before=state(f.db); const r=admit(f); assertTerminal(f,r,'scheduled');
  assert.deepEqual(f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.original.run_id),f.original);
  if (variant === 'running retry') assert.deepEqual(f.db.prepare("SELECT * FROM cron_runs WHERE run_id='lower'").get(),before.runs.find(r => r.run_id==='lower'));
  assert.equal(f.store.get(scope,f.job.id).last_slot_watermark,f.slot);
  assert.equal(f.store.get(scope,f.job.id).next_run_at,f.slot+60000);
  if (variant === 'running consume' || variant === 'queued consume') unchanged(f,() => {
    const request=req(f,{slot:lower.authored_slot,runId:'unused'});
    assert.deepEqual(f.store.admitBase(scope,f.job.id,request),{kind:'existing',run:f.original});
  });
});
test('pruned terminal display receipt cannot replay at or below W', t => {
  const f = busy(t); admit(f); f.db.prepare('DELETE FROM cron_runs WHERE run_id=?').run('r_overlap');
  // Simulate already-pruned display evidence; actual guarded retention remains deferred.
  f.clock.value = now;
  unchanged(f, () => assert.deepEqual(admit(f), { kind: 'already-consumed' }));
});
test('dedupe survives no active row, higher W, later cadence, backward clock and changed caller ownership', t => {
  const f = busy(t), r = admit(f).run;
  f.db.prepare("UPDATE cron_runs SET status='interrupted' WHERE run_id=?").run(f.original.run_id);
  f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?').run(f.slot + 600000, f.slot + 660000); f.clock.value = now;
  const request = req(f, { runId: 'unused', trigger: 'catchup' });
  request.authority.ownerIncarnation = request.ownership.ownerIncarnation = 'replacement-owner';
  request.authority.resetGeneration = request.ownership.resetGeneration = 8;
  unchanged(f, () => assert.deepEqual(f.store.admitBase(scope, f.job.id, request), { kind: 'existing', run: r }));
});
for (const [column, value] of [ ['phase','executing'], ['completion','failed'], ['delivery_state','delivered'], ['segments_sent',1],
  ['history_state','published'], ['thread_id','thread'], ['turn_id','turn'], ['started_at',now], ['ended_at',now],
  ['owner_incarnation',''], ['authored_slot',now], ['authored_occurrence_id','bad'], ['definition_snapshot_json','{}'],
]) test(`malformed retained overlap ${column} is integrity failure before W dedupe`, t => {
  const f = busy(t); admit(f); f.db.prepare(`UPDATE cron_runs SET ${column}=? WHERE run_id='r_overlap'`).run(value);
  unchanged(f, () => admit(f), StoreIntegrityError);
});
for (const [name, alter, error] of [
  ['wrong generation', (f,r) => { r.generation++; }, StoreConflict],
  ['disabled', f => f.db.exec('UPDATE cron_jobs SET enabled=0'), StoreConflict],
  ['tombstone', f => f.db.exec('UPDATE cron_jobs SET deleted_at=1'), JobNotFound],
  ['activation', f => f.db.prepare('UPDATE cron_jobs SET schedule_activated_at=?').run(f.slot + 1), StoreConflict],
  ['not effective', (f,r) => { r.slot++; }, StoreConflict],
  ['not yet due', f => { f.clock.value--; }, StoreConflict],
  ['target authority', (f,r) => { r.authority.targetAuthorized=false; }, TypeError],
  ['creator authority', (f,r) => { r.authority.creatorAuthorized=false; }, TypeError],
  ['definition authority', (f,r) => { r.authority.definition={}; }, TypeError],
  ['reset authority', (f,r) => { r.authority.resetGeneration++; }, TypeError],
]) test(`overlap ${name} rejected before any mutation`, t => {
  const f = busy(t), r = req(f); alter(f,r);
  unchanged(f, () => f.store.admitBase(scope, f.job.id, r), error);
});
test('idle job reserves an execution receipt; no generic terminal path', t => {
  const f = busy(t); f.db.prepare("UPDATE cron_runs SET status='interrupted' WHERE run_id=?").run(f.original.run_id);
  const result = admit(f); assert.equal(result.kind, 'reserved'); assert.equal(result.run.status, 'queued');
  assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, null);
});
test('queued retry supersession remains distinct and completely read only', t => {
  const f = busy(t, {}, { trigger: 'retry', status: 'queued', attempt: 1, started_at: null });
  unchanged(f, () => assert.deepEqual(admit(f), { kind: 'deferred', reason: 'queued-retry-supersession', activeRunId: f.original.run_id, recheckAfterMs: 30000 }));
});
for (const status of ['queued','running']) test(`borrowed at due during ${status} keeps original slot and W`, t => {
  const f = busy(t, { schedule: { kind: 'at', atMs: now + 60000 } }, { status });
  f.clock.value += 3600000;
  unchanged(f, () => assert.deepEqual(admit(f, { trigger: 'catchup' }), { kind: 'deferred', reason: 'one-shot-busy', activeRunId: f.original.run_id, recheckAfterMs: 30000 }));
});
for (const seam of ['afterReceiptInsert','afterJobProjection']) for (const mode of ['throw','async']) test(`overlap fault ${seam}/${mode} rolls both changes back`, t => {
  const f = busy(t), broken = new CronStore(f.db,f.clock,{[seam]() {
    const rows = f.db.prepare('SELECT * FROM cron_runs ORDER BY run_id').all();
    assert.equal(rows.length, 2); assert.equal(rows.find(r => r.run_id === 'r_overlap').status, 'skipped');
    assert.deepEqual(rows.find(r => r.run_id === f.original.run_id), f.original);
    assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, seam === 'afterReceiptInsert' ? null : f.slot);
    if (mode === 'throw') throw new Error('injected'); return Promise.resolve();
  }});
  unchanged(f, () => admit(f, {}, broken), mode === 'throw' ? /injected/ : /synchronous/);
  assert.equal(f.db.inTransaction, false); assert.equal(admit(f).kind, 'overlap');
});
for (const failAt of [1,2]) test(`ownership loss check ${failAt} rolls back overlap and projection`, t => {
  const f = busy(t), request = req(f); let calls=0;
  request.ownership.assertHeld = () => { assert.equal(f.db.inTransaction,true); if (++calls === failAt) throw new StoreConflict('lost lock'); };
  unchanged(f, () => f.store.admitBase(scope, f.job.id, request), StoreConflict); assert.equal(calls, failAt);
});
test('generation predicate miss after INSERT rolls everything back', t => {
  const f = busy(t), store = new CronStore(f.db,f.clock,{afterReceiptInsert() {f.db.exec('UPDATE cron_jobs SET generation=generation+1');}});
  unchanged(f, () => admit(f,{},store), StoreIntegrityError);
});
test('unrelated primary key conflict is an integrity failure with no projection', t => {
  const f = busy(t); unchanged(f, () => admit(f,{runId:f.original.run_id}), StoreIntegrityError);
});
test('two connections serialize terminal entry; loser rereads exact stored outcome after winner commit', t => {
  const f = busy(t), dbB = f.connect(), storeB = new CronStore(dbB,f.clock), requestB = req(f,{runId:'loser'});
  requestB.ownership.assertHeld = () => assert.equal(dbB.inTransaction,true);
  let contended=false;
  const winner = new CronStore(f.db,f.clock,{afterJobProjection() {
    assert.equal(f.store.get(scope,f.job.id).last_slot_watermark,f.slot);
    assert.equal(storeB.get(scope,f.job.id).last_slot_watermark,null);
    assert.throws(() => storeB.admitBase(scope,f.job.id,requestB), error => error.code === 'SQLITE_BUSY'); contended=true;
  }});
  const r = admit(f,{},winner); assert.equal(contended,true);
  unchanged(f, () => assert.deepEqual(storeB.admitBase(scope,f.job.id,requestB),{kind:'existing',run:r.run}));
});
for (const seam of ['afterReceiptInsert','afterJobProjection','afterCommit']) for (const mode of ['exit','sigkill']) test(`real process ${mode}/${seam}: reopen sees atomic terminal facts`, t => {
  const f = busy(t), before = state(f.db), request = req(f);
  f.db.exec('PRAGMA journal_mode=WAL'); f.db.close();
  const child = spawnSync(process.execPath,['--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),
    fileURLToPath(new URL('./overlap-crash-child.mjs',import.meta.url)),f.path,JSON.stringify(request),seam,mode],
    { env: process.env, encoding:'utf8', timeout:20000 });
  assert.equal(child.error,undefined,child.stderr);
  if (mode === 'sigkill') assert.equal(child.signal,'SIGKILL',child.stderr); else assert.equal(child.status,83,child.stderr);
  f.db = f.connect(); f.store = new CronStore(f.db,f.clock);
  if (seam !== 'afterCommit') {
    assert.deepEqual(state(f.db),before); assertTerminal(f,admit(f),'scheduled');
  } else {
    const stored=f.db.prepare("SELECT * FROM cron_runs WHERE run_id='r_overlap'").get();
    assert.equal(stored.status,'skipped'); assert.equal(f.store.get(scope,f.job.id).last_slot_watermark,f.slot);
    assert.equal(f.store.get(scope,f.job.id).consecutive_skipped,1);
    assert.equal(f.store.get(scope,f.job.id).next_run_at,f.slot+60000);
    unchanged(f, () => {
      const result=admit(f); assert.deepEqual(result,{kind:'existing',run:stored});
      assertTerminal(f,result,'scheduled','existing');
    });
  }
});
test('external call trap and SQL trace: one terminal INSERT, no active intermediate or history write', t => {
  const f = busy(t), trace=[], attempts=[];
  const originalFetch=globalThis.fetch; globalThis.fetch=(...args) => {attempts.push(args);throw new Error('unexpected external call');};
  t.after(() => {globalThis.fetch=originalFetch;});
  const traced={get inTransaction() {return f.db.inTransaction;},exec(sql) {trace.push(sql);return f.db.exec(sql);},prepare(sql) {
    trace.push(sql);return f.db.prepare(sql);
  }};
  const store=new CronStore(traced,f.clock,{afterReceiptInsert() {
    assert.equal(f.db.prepare("SELECT status FROM cron_runs WHERE run_id='r_overlap'").get().status,'skipped');
    assert.equal(f.db.prepare("SELECT count(*) n FROM cron_runs WHERE status IN ('queued','running')").get().n,1);
  }});
  admit(f,{},store);
  assert.equal(trace.filter(s => /^INSERT INTO cron_runs/.test(s)).length,1);
  assert.equal(trace.filter(s => /^UPDATE cron_jobs/.test(s)).length,1);
  assert.equal(trace.some(s => /UPDATE cron_runs|INSERT INTO context_notes|sdk_sessions/i.test(s)),false);
  assert.deepEqual(attempts,[]);
});
