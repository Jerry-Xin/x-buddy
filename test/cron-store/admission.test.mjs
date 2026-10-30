// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, StoreConflict, StoreIntegrityError, JobNotFound } from '../../src/cron/store/index.ts';
import { fixture, input, scope, now, receipt, state } from './helpers.mjs';

function request(f, job, extra = {}) {
  return { trigger: 'scheduled', generation: job.generation, slot: job.next_run_at, runId: 'r_admitted',
    authority: { jobId: job.id, definition: f.store.definition(scope, job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: 'owner-current', resetGeneration: 7, policy: { tools: 'none' } },
    ownership: { ownerIncarnation: 'owner-current', resetGeneration: 7, assertHeld() { assert.equal(f.db.inTransaction, true); } }, ...extra };
}
function due(t, overrides = {}) {
  const f = fixture(t), job = f.store.create(input(overrides));
  f.clock.value = job.next_run_at;
  return { ...f, job };
}
function unchanged(f, fn, error) {
  const before = state(f.db);
  if (error) assert.throws(fn, error); else fn();
  assert.deepEqual(state(f.db), before);
}
function reserve(f, extra = {}, store = f.store) { return store.admitBase(scope, f.job.id, request(f, f.job, extra)); }

for (const [name, schedule, expectedSlot, nextSlot] of [
  ['every', { kind: 'every', everyMs: 60_000, anchorMs: 0 }, now + 60_000, now + 120_000],
  ['at', { kind: 'at', atMs: now + 60_000 }, now + 60_000, now + 60_000],
  ['cron exact', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', exact: true }, now + 3_600_000, now + 7_200_000],
  ['cron effective stagger', { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, now + 253_353, now + 3_853_353],
]) for (const trigger of ['scheduled', 'catchup']) test(`${trigger} ${name}: reserve complete immutable base receipt and natural next only`, t => {
  const f = due(t, { schedule });
  assert.equal(f.job.next_run_at, expectedSlot);
  const result = reserve(f, { trigger });
  assert.equal(result.kind, 'reserved');
  const canonical = JSON.stringify([f.job.id, 1, expectedSlot]);
  const r = result.run, snapshot = JSON.parse(r.definition_snapshot_json);
  assert.equal(r.run_id, 'r_admitted'); assert.equal(r.job_id, f.job.id);
  assert.equal(r.trigger, trigger); assert.equal(r.manual_mode, null);
  assert.equal(r.occurrence_id, canonical); assert.equal(r.authored_occurrence_id, canonical);
  assert.equal(r.scheduled_for, expectedSlot); assert.equal(r.authored_slot, expectedSlot);
  assert.equal(r.attempt, 0); assert.equal(r.ready_at, expectedSlot); assert.equal(r.status, 'queued');
  assert.equal(r.admitted_enabled, 1); assert.equal(r.admitted_next_run_at, expectedSlot);
  assert.equal(r.admitted_generation, 1); assert.equal(r.owner_incarnation, 'owner-current'); assert.equal(r.reset_generation, 7);
  assert.equal(r.exec_mode, 'isolated'); assert.equal(r.queued_at, f.clock.value);
  for (const key of ['phase', 'completion', 'history_state', 'reason', 'error', 'thread_id', 'turn_id', 'model', 'usage_json', 'summary', 'lane_wait_ms', 'started_at', 'ended_at']) assert.equal(r[key], null, key);
  assert.equal(r.delivery_state, 'not-started'); assert.equal(r.segments_sent, 0);
  assert.deepEqual(snapshot, { ...f.store.definition(scope, f.job.id), occurrenceId: canonical, policy: {tools:'none'},
    scheduleOwnership: 'consume', authoredOccurrenceId: canonical, authoredSlot: expectedSlot, admittedEnabled: true, admittedNextRunAt: expectedSlot });
  assert.deepEqual(f.store.get(scope, f.job.id), { ...f.job, next_run_at: nextSlot });
  assert(Object.isFrozen(r)); assert.throws(() => { r.owner_incarnation = 'changed'; }, TypeError);
});

test('catch-up reserves only the latest effective slot and projects next after observed now', t => {
  const f = due(t); f.clock.value += 240_500;
  const result = reserve(f, { trigger: 'catchup', slot: now + 300_000 });
  assert.equal(result.run.scheduled_for, now + 300_000);
  assert.equal(result.run.admitted_next_run_at, now + 60_000);
  assert.equal(f.store.get(scope, f.job.id).next_run_at, now + 360_000);
  assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, null);
});
test('catch-up rejects an older missed slot without any mutation', t => {
  const f = due(t); f.clock.value += 240_000;
  unchanged(f, () => reserve(f, { trigger: 'catchup' }), StoreConflict);
});
test('scheduled admission uses slot(S), even when observation is later than several slots', t => {
  const f = due(t); f.clock.value += 240_000; reserve(f);
  assert.equal(f.store.get(scope, f.job.id).next_run_at, now + 120_000);
});
test('clock and held ownership proof are evaluated in the transaction, with proof rechecked before commit', t => {
  const f = due(t); let proofs = 0, reads = 0;
  const store = new CronStore(f.db, { now() { assert(f.db.inTransaction); reads++; return f.clock.value; } });
  const req = request(f, f.job); req.ownership.assertHeld = () => { assert(f.db.inTransaction); proofs++; };
  store.admitBase(scope, f.job.id, req);
  assert.equal(reads, 1); assert.equal(proofs, 2);
});
test('caller policy mutation cannot change the persisted immutable snapshot', t => {
  const f = due(t), req = request(f, f.job); req.authority.policy = {tools:'octo-standard',egressAllowlist:['fixture']};
  const run = f.store.admitBase(scope, f.job.id, req).run;
  req.authority.policy.egressAllowlist.push('foreign');
  assert.deepEqual(JSON.parse(run.definition_snapshot_json).policy, {tools:'octo-standard',egressAllowlist:['fixture']});
});
for (const variation of ['same call', 'other trigger/run ID', 'later watermark/cadence', 'clock moved backward', 'replacement owner/reset']) test(`duplicate ${variation}: exact stored reservation before fresh eligibility`, t => {
  const f = due(t), first = reserve(f);
  let extra = {};
  if (variation === 'other trigger/run ID') extra = {trigger:'catchup',runId:'r_unused'};
  if (variation === 'later watermark/cadence') f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?').run(now + 300_000, now + 360_000);
  if (variation === 'clock moved backward') f.clock.value = now;
  const req = request(f, f.job, extra);
  if (variation === 'replacement owner/reset') {
    req.authority.ownerIncarnation = req.ownership.ownerIncarnation = 'new-owner';
    req.authority.resetGeneration = req.ownership.resetGeneration = 8;
  }
  unchanged(f, () => assert.deepEqual(f.store.admitBase(scope, f.job.id, req), {kind:'existing',run:first.run}));
});
for (const status of ['ok','error','skipped','interrupted']) test(`valid retained ${status} receipt returns its exact outcome without effects`, t => {
  const f = due(t); reserve(f);
  f.db.prepare('UPDATE cron_runs SET status=?,ended_at=?').run(status, f.clock.value);
  f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(f.job.next_run_at);
  const stored = f.db.prepare('SELECT * FROM cron_runs').get();
  unchanged(f, () => assert.deepEqual(reserve(f), {kind:'existing',run:stored}));
});
test('canonical consuming manual receipt dedupes scheduled admission without changing trigger or ownership', t => {
  const f = due(t), first = reserve(f).run, snapshot = JSON.parse(first.definition_snapshot_json);
  snapshot.manualMode = 'due';
  f.db.prepare("UPDATE cron_runs SET trigger='manual',manual_mode='due',definition_snapshot_json=?").run(JSON.stringify(snapshot));
  const stored = f.db.prepare('SELECT * FROM cron_runs').get();
  unchanged(f, () => assert.deepEqual(reserve(f), {kind:'existing',run:stored}));
});
for (const watermark of [now + 60_000, now + 300_000]) test(`no receipt at/below W=${watermark}: already consumed without writes`, t => {
  const f = due(t); f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?').run(watermark, now + 360_000);
  unchanged(f, () => assert.deepEqual(reserve(f), {kind:'already-consumed'}));
});
test('high W distinguishes a reserved lower slot, a new lower slot and an unconsumed higher slot', t => {
  const f = due(t), first = reserve(f).run;
  f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?').run(now + 180_000, now + 240_000);
  f.clock.value = now + 240_000;
  unchanged(f, () => assert.deepEqual(reserve(f), {kind:'existing',run:first}));
  unchanged(f, () => assert.deepEqual(reserve(f,{slot:now + 120_000}), {kind:'already-consumed'}));
  unchanged(f, () => assert.equal(reserve(f,{slot:now + 240_000}).reason, 'recurring-overlap'));
});

for (const [name, mutate] of [
  ['wrong authored ID', (f) => f.db.exec("UPDATE cron_runs SET authored_occurrence_id='foreign'")],
  ['wrong authored slot', (f) => f.db.exec('UPDATE cron_runs SET authored_slot=0')],
  ['wrong occurrence ID', (f) => f.db.exec("UPDATE cron_runs SET occurrence_id='foreign'")],
  ['wrong job', (f) => f.db.exec("UPDATE cron_runs SET job_id='j7f3k2r'")],
  ['wrong admitted generation', (f) => f.db.exec('UPDATE cron_runs SET admitted_generation=2')],
  ['borrow cannot masquerade as consume', (f) => f.db.exec("UPDATE cron_runs SET schedule_ownership='borrow'")],
  ['wrong ready_at', (f) => f.db.exec('UPDATE cron_runs SET ready_at=0')],
  ['disabled admission', (f) => f.db.exec('UPDATE cron_runs SET admitted_enabled=0')],
  ['wrong mode', (f) => f.db.exec("UPDATE cron_runs SET exec_mode='session'")],
  ['empty owner', (f) => f.db.exec("UPDATE cron_runs SET owner_incarnation=''")],
  ['invalid reset generation', (f) => f.db.exec('UPDATE cron_runs SET reset_generation=-1')],
  ['invalid JSON', (f) => f.db.exec("UPDATE cron_runs SET definition_snapshot_json='{' ")],
  ['terminal without watermark', (f) => f.db.exec("UPDATE cron_runs SET status='skipped',reason='overlap'")],
]) test(`stored provenance integrity: ${name} fails closed before watermark dedupe`, t => {
  const f = due(t); reserve(f); mutate(f);
  unchanged(f, () => reserve(f), StoreIntegrityError);
});
for (const [name, change] of [
  ['schema version', s => {s.schemaVersion=2;}], ['definition schedule', s => {s.schedule.everyMs=30_000;}],
  ['foreign target', s => {s.target.channelId='foreign';}], ['creator', s => {s.creatorUid='foreign';}],
  ['missing policy', s => {delete s.policy;}], ['invalid policy', s => {s.policy={tools:'other'};}],
  ['extra policy field', s => {s.policy.token='forbidden';}], ['snapshot ownership', s => {s.scheduleOwnership='borrow';}],
  ['snapshot admitted next', s => {s.admittedNextRunAt++;}], ['snapshot ID', s => {s.occurrenceId='foreign';}],
  ['manual mode on timed receipt', s => {s.manualMode='due';}],
]) test(`snapshot integrity: ${name} cannot be reported as duplicate success`, t => {
  const f = due(t), run = reserve(f).run, snapshot = JSON.parse(run.definition_snapshot_json); change(snapshot);
  f.db.prepare('UPDATE cron_runs SET definition_snapshot_json=?').run(JSON.stringify(snapshot));
  unchanged(f, () => reserve(f), StoreIntegrityError);
});

for (const [name, alter, error] of [
  ['stale requested generation', (f,r) => {r.generation=2;}, StoreConflict],
  ['disabled job after candidate lookup', f => f.db.exec('UPDATE cron_jobs SET enabled=0'), StoreConflict],
  ['tombstone after lookup', f => f.db.exec('UPDATE cron_jobs SET deleted_at=1'), JobNotFound],
  ['new activation', f => f.db.prepare('UPDATE cron_jobs SET schedule_activated_at=?').run(now + 60_001), StoreConflict],
  ['future slot', f => {f.clock.value=now;}, StoreConflict],
  ['backoff gate', f => f.db.prepare('UPDATE cron_jobs SET next_run_at=?').run(now + 90_000), StoreConflict],
  ['null cadence', f => f.db.exec('UPDATE cron_jobs SET next_run_at=NULL'), StoreConflict],
  ['foreign job authority', (f,r) => {r.authority.jobId='j7f3k2r';}, TypeError],
  ['foreign definition authority', (f,r) => {r.authority.definition={...r.authority.definition,creatorUid:'foreign'};}, TypeError],
  ['revoked creator', (f,r) => {r.authority.creatorAuthorized=false;}, TypeError],
  ['revoked target', (f,r) => {r.authority.targetAuthorized=false;}, TypeError],
  ['mismatched incarnation', (f,r) => {r.authority.ownerIncarnation='old';}, TypeError],
  ['mismatched reset', (f,r) => {r.authority.resetGeneration=6;}, TypeError],
  ['unheld ownership', (f,r) => {r.ownership.assertHeld=() => {throw new StoreConflict('ownership lost');};}, StoreConflict],
  ['asynchronous proof', (f,r) => {r.ownership.assertHeld=() => Promise.resolve();}, TypeError],
  ['invalid policy', (f,r) => {r.authority.policy={tools:'all'};}, TypeError],
  ['unsupported trigger', (f,r) => {r.trigger='retry';}, TypeError],
  ['off-grid effective slot', (f,r) => {r.slot++; f.clock.value++;}, StoreConflict],
]) test(`rejected ${name}: job and receipts unchanged`, t => {
  const f = due(t), req = request(f, f.job); alter(f,req);
  unchanged(f, () => f.store.admitBase(scope, f.job.id, req), error);
});
test('scope cannot admit a foreign conversation', t => {
  const f = due(t);
  unchanged(f, () => f.store.admitBase({targetSession:'foreign'},f.job.id,request(f,f.job)), JobNotFound);
});
test('activation and effective stagger boundaries: raw hour is not an authored slot', t => {
  const f = due(t,{schedule:{kind:'cron',expr:'0 * * * *',tz:'UTC'}});
  unchanged(f, () => reserve(f,{slot:now}), StoreConflict);
  f.clock.value = now + 253_352;
  unchanged(f, () => reserve(f), StoreConflict);
  f.clock.value++;
  assert.equal(reserve(f).kind,'reserved');
});
for (const [trigger,status,generation,reason] of [
  ['manual','queued',1,'recurring-overlap'], ['manual','running',1,'recurring-overlap'],
  ['retry','running',1,'recurring-overlap'], ['scheduled','running',1,'recurring-overlap'],
  ['manual','running',0,'recurring-overlap'], ['retry','queued',1,'queued-retry-supersession'],
]) test(`active ${trigger}/${status}/g${generation}: explicit ${reason} deferral with no writes`, t => {
  const f = due(t);
  receipt(f.db,f.job,{trigger,status,admitted_generation:generation});
  unchanged(f, () => assert.deepEqual(reserve(f),{kind:'deferred',reason,activeRunId:'r_fixture',recheckAfterMs:30000}));
});
for (const outcome of ['ok','error','interrupted']) test(`one-shot crosses due during borrow: no writes; after fixture ${outcome}, original slot reserves once`, t => {
  const f = due(t,{schedule:{kind:'at',atMs:now + 60_000}});
  receipt(f.db,f.job,{queued_at:now,started_at:now});
  unchanged(f, () => assert.equal(reserve(f).reason,'one-shot-busy'));
  // Fixture terminal state only: this slice does not implement borrower finalization/recovery.
  f.db.prepare('UPDATE cron_runs SET status=?,ended_at=?').run(outcome,f.clock.value);
  const result = reserve(f,{trigger:'catchup'});
  assert.equal(result.kind,'reserved'); assert.equal(result.run.scheduled_for,now + 60_000);
  assert.deepEqual(f.store.get(scope,f.job.id), f.job);
  unchanged(f, () => assert.deepEqual(reserve(f),{kind:'existing',run:result.run}));
});
for (const seam of ['afterReceiptInsert','afterJobProjection']) test(`fault ${seam}: receipt and projection roll back together, retry reserves once`, t => {
  const f = due(t), broken = new CronStore(f.db,f.clock,{[seam]() {throw new Error('injected fault');}});
  unchanged(f, () => reserve(f,{},broken), /injected fault/);
  assert.equal(f.db.inTransaction,false);
  assert.equal(reserve(f).kind,'reserved');
});
test('generation guard after receipt insertion rolls back both the injected edit and receipt', t => {
  const f = due(t), broken = new CronStore(f.db,f.clock,{afterReceiptInsert() {f.db.exec('UPDATE cron_jobs SET generation=generation+1');}});
  unchanged(f, () => reserve(f,{},broken), StoreConflict);
});
test('ownership loss before commit rolls back receipt and cadence', t => {
  const f = due(t), req = request(f,f.job); let checks = 0;
  req.ownership.assertHeld=() => {if (++checks===2) throw new StoreConflict('ownership lost');};
  unchanged(f, () => f.store.admitBase(scope,f.job.id,req), StoreConflict);
});
test('reentrant admission during transaction fails without disturbing the outer reservation', t => {
  const f = due(t), store = new CronStore(f.db,f.clock,{afterReceiptInsert() {
    assert.throws(() => reserve(f),StoreConflict);
  }});
  assert.equal(reserve(f,{},store).kind,'reserved');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cron_runs').get().n,1);
});
test('unrelated run-id uniqueness conflict is an integrity error, never duplicate consumption', t => {
  const f = due(t), other=f.store.create(input({id:'j7f3k2r'}));
  receipt(f.db,other,{run_id:'r_admitted',status:'ok'});
  unchanged(f, () => reserve(f),StoreIntegrityError);
});
test('two independent connections: loser is busy during insertion/projection, then rereads exact winner', t => {
  const f = due(t), db2=f.connect(), store2=new CronStore(db2,f.clock); let competed=0;
  const req=request(f,f.job); req.ownership.assertHeld=() => {assert(db2.inTransaction);};
  const store1=new CronStore(f.db,f.clock,{afterReceiptInsert() {
    assert.throws(() => store2.admitBase(scope,f.job.id,req),{code:'SQLITE_BUSY'}); competed++;
    assert.equal(db2.prepare('SELECT COUNT(*) n FROM cron_runs').get().n,0);
    assert.deepEqual(db2.prepare('SELECT * FROM cron_jobs').get(),f.job);
  }, afterJobProjection() {
    assert.throws(() => store2.admitBase(scope,f.job.id,req),{code:'SQLITE_BUSY'}); competed++;
  }});
  const result=reserve(f,{},store1); assert.equal(competed,2);
  const before=state(f.db);
  assert.deepEqual(store2.admitBase(scope,f.job.id,req),{kind:'existing',run:result.run});
  assert.deepEqual(state(f.db),before);
});
test('two connections: rollback leaves no reservation or projection; another writer can reserve', t => {
  const f=due(t), db2=f.connect(), store2=new CronStore(db2,f.clock);
  const broken=new CronStore(f.db,f.clock,{afterJobProjection() {throw new Error('rollback');}});
  unchanged(f,()=>reserve(f,{},broken),/rollback/);
  const req=request(f,f.job); req.ownership.assertHeld=() => {assert(db2.inTransaction);};
  assert.equal(store2.admitBase(scope,f.job.id,req).kind,'reserved');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cron_runs').get().n,1);
});
for (const point of ['afterReceiptInsert','afterJobProjection']) test(`subprocess crash ${point}: reopen restores pre-transaction DB, legal retry commits once`, t => {
  const f=due(t), before=state(f.db), req=request(f,f.job);
  f.db.close();
  const result=spawnSync(process.execPath,['--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),
    fileURLToPath(new URL('./admission-crash-child.mjs',import.meta.url)),f.path,JSON.stringify(req),point],
    {env:process.env,encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined); assert.equal(result.status,83,result.stderr);
  const reopened=f.connect(), store=new CronStore(reopened,f.clock);
  assert.deepEqual(state(reopened),before);
  req.ownership.assertHeld=() => {assert(reopened.inTransaction);};
  assert.equal(store.admitBase(scope,f.job.id,req).kind,'reserved');
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM cron_runs').get().n,1);
});
test('committed reservation survives connection close/reopen without reconsumption', t => {
  const f=due(t), first=reserve(f); f.db.close();
  const db=f.connect(), store=new CronStore(db,f.clock), req=request({...f,store},f.job);
  req.ownership.assertHeld=() => {assert(db.inTransaction);};
  const before=state(db);
  assert.deepEqual(store.admitBase(scope,f.job.id,req),{kind:'existing',run:first.run});
  assert.deepEqual(state(db),before);
});
test('two different receipts claiming the same base slot fail integrity instead of deduping', t => {
  const f=due(t), first=reserve(f).run;
  f.db.exec("UPDATE cron_runs SET status='ok'");
  f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(f.job.next_run_at);
  const cols=Object.keys(first);
  const second={...first,run_id:'r_inconsistent',trigger:'manual',manual_mode:'due',occurrence_id:'manual:inconsistent',status:'ok'};
  f.db.prepare(`INSERT INTO cron_runs (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>second[k]));
  unchanged(f,()=>reserve(f),StoreIntegrityError);
});
test('another connection edits after candidate/authority lookup: admission rereads generation and rejects without writes', t => {
  const f=due(t), req=request(f,f.job), candidates=f.store.dueCandidates(scope,f.clock.value);
  assert.equal(candidates.length,1);
  const db2=f.connect(), store2=new CronStore(db2,f.clock);
  store2.edit(scope,f.job.id,1,{name:'new definition'});
  unchanged(f,()=>f.store.admitBase(scope,candidates[0].id,req),StoreConflict);
});
