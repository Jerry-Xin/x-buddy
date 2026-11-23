// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, terminalExpectation, StoreConflict, StoreIntegrityError, JobNotFound } from '../../src/cron/store/index.ts';
import { fixture, input, scope, now, state } from './helpers.mjs';

const success = { kind: 'success', deliveryState: 'not-requested' };
export function reserved(t, overrides = {}, status = 'running', trigger = 'scheduled') {
  const f = fixture(t); f.job = f.store.create(input({ deliveryMode: 'none', ...overrides }));
  f.slot = f.job.next_run_at; f.clock.value = f.slot;
  f.run = f.store.admitBase(scope, f.job.id, { trigger: trigger === 'manual' ? 'scheduled' : trigger,
    generation: 1, slot: f.slot, runId: 'base',
    authority: { jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: 'owner', resetGeneration: 2, policy: { tools: 'none' } },
    ownership: { ownerIncarnation: 'owner', resetGeneration: 2, assertHeld() {} } }).run;
  if (trigger === 'manual') {
    const snap = { ...JSON.parse(f.run.definition_snapshot_json), manualMode: 'due' };
    f.db.prepare("UPDATE cron_runs SET trigger='manual',manual_mode='due',definition_snapshot_json=? WHERE run_id='base'").run(JSON.stringify(snap));
  }
  if (status === 'running') f.db.prepare("UPDATE cron_runs SET status='running',phase='executing',started_at=?,thread_id='fixture-thread',turn_id='fixture-turn' WHERE run_id='base'").run(f.slot);
  f.run = f.db.prepare("SELECT * FROM cron_runs WHERE run_id='base'").get();
  f.clock.value += 1500;
  return f;
}
function request(f, outcome = success, changes = {}) {
  return { expected: terminalExpectation(f.run), outcome,
    ownership: { ownerIncarnation: 'owner', resetGeneration: 2, assertHeld() { assert.equal(f.db.inTransaction, true); } }, ...changes };
}
const finalize = (f, outcome = success, store = f.store, changes = {}) => store.finalize(scope, f.job.id, request(f, outcome, changes));
function unchanged(f, work, error) {
  const before = state(f.db);
  if (error) assert.throws(work, error); else work();
  assert.deepEqual(state(f.db), before);
}
function seedCounters(f) {
  f.db.prepare('UPDATE cron_jobs SET consecutive_errors=9,consecutive_skipped=8,consecutive_target_failures=2,schedule_error_count=2,alert_incident_key=?,alert_occurrence=3,last_alert_at=?').run('preserve', now);
}
function manual(f, ownership = 'borrow') {
  const row = { ...f.run, trigger: 'manual', manual_mode: 'if-enabled', schedule_ownership: ownership,
    occurrence_id: 'manual:00000000-0000-4000-8000-000000000001', scheduled_for: null,
    authored_slot: f.job.schedule_kind === 'at' ? f.slot : null,
    authored_occurrence_id: f.job.schedule_kind === 'at' ? f.run.authored_occurrence_id : null };
  const snap = { ...JSON.parse(row.definition_snapshot_json), occurrenceId: row.occurrence_id, manualMode: row.manual_mode,
    scheduleOwnership: ownership, authoredSlot: row.authored_slot, authoredOccurrenceId: row.authored_occurrence_id };
  row.definition_snapshot_json = JSON.stringify(snap);
  f.db.prepare(`UPDATE cron_runs SET ${Object.keys(row).map(k => `${k}=?`).join(',')} WHERE run_id='base'`).run(...Object.values(row));
  f.run = f.db.prepare("SELECT * FROM cron_runs WHERE run_id='base'").get();
  return row;
}

for (const trigger of ['scheduled', 'catchup', 'manual']) for (const schedule of [
  { kind: 'every', everyMs: 60000, anchorMs: 0 },
  { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
]) test(`SUCCESS ${trigger}/${schedule.kind}: same-TX W, counters, effective cadence and immutable receipt`, t => {
  const f = reserved(t, { schedule }, 'running', trigger); seedCounters(f);
  const r = finalize(f); assert.equal(r.kind, 'finalized'); assert.equal(Object.isFrozen(r.run), true);
  assert.deepEqual(r.run, { ...f.run, status: 'ok', phase: null, completion: 'succeeded', delivery_state: 'not-requested',
    history_state: 'skipped_not_requested', reason: null, error: null, ended_at: f.clock.value });
  const j = f.store.get(scope, f.job.id);
  assert.equal(j.last_slot_watermark, f.slot); assert.equal(j.consecutive_errors, 0); assert.equal(j.consecutive_skipped, 0);
  assert.equal(j.consecutive_target_failures, 0); assert.equal(j.schedule_error_count, 2);
  assert.equal(j.alert_incident_key, 'preserve'); assert.equal(j.alert_occurrence, 3); assert.equal(j.last_alert_at, now);
  assert.equal(j.next_run_at, f.slot + (schedule.kind === 'cron' ? 3600000 : 60000));
  assert.equal(j.last_status, 'ok'); assert.equal(j.last_duration_ms, 1500);
  unchanged(f, () => assert.deepEqual(finalize(f), { kind: 'existing', run: r.run }));
  unchanged(f, () => assert.deepEqual(finalize(f, { kind: 'error' }), { kind: 'existing', run: r.run }));
});

for (const status of ['queued', 'running']) for (const reason of ['stopped', 'reset', 'reload', 'shutdown'])
for (const trigger of ['scheduled', 'manual']) test(`neutral ${reason}/${status}/${trigger}: retires reserved base without counter/retry effects`, t => {
  const f = reserved(t, {}, status, trigger); seedCounters(f); const before = f.store.get(scope, f.job.id);
  const r = finalize(f, { kind: 'neutral', reason }); assert.equal(r.kind, 'finalized');
  assert.equal(r.run.status, status === 'queued' ? 'skipped' : 'interrupted'); assert.equal(r.run.reason, reason);
  assert.equal(r.run.completion, null); assert.equal(r.run.history_state, 'skipped_not_requested');
  const j = f.store.get(scope, f.job.id); assert.equal(j.last_slot_watermark, f.slot);
  for (const k of ['consecutive_errors','consecutive_skipped','consecutive_target_failures','schedule_error_count','enabled','alert_incident_key','alert_occurrence','last_alert_at']) assert.equal(j[k], before[k], k);
  assert.equal(state(f.db).runs.length, 1);
  unchanged(f, () => assert.equal(finalize(f, { kind: 'neutral', reason }).kind, 'existing'));
});

for (const del of [true, false]) for (const deliveryState of ['not-requested', 'suppressed'])
for (const trigger of ['scheduled','manual']) test(`one-shot success ${trigger}/delete=${del}/${deliveryState}: W precedes fenced retirement`, t => {
  const f = reserved(t, { schedule: { kind: 'at', atMs: now + 60000 }, deleteAfterRun: del,
    deliveryMode: deliveryState === 'suppressed' ? 'announce' : 'none' }, 'running', trigger);
  const observations = [];
  const proxy = { get inTransaction() { return f.db.inTransaction; }, exec: sql => f.db.exec(sql), prepare(sql) {
    const stmt = f.db.prepare(sql);
    return { ...stmt, get: (...a) => stmt.get(...a), all: (...a) => stmt.all(...a), run(...a) {
      if (sql.includes('SET deleted_at=')) observations.push(f.db.prepare('SELECT * FROM cron_jobs').get());
      return stmt.run(...a);
    } };
  } };
  const store = new CronStore(proxy, f.clock); const r = finalize(f, { kind: 'success', deliveryState }, store);
  assert.equal(r.kind, 'finalized'); const j = f.store.get(scope, f.job.id);
  assert.equal(j.last_slot_watermark, f.slot); assert.equal(j.enabled, 0); assert.equal(j.next_run_at, null);
  assert.equal(j.generation, 1); assert.equal(j.deleted_at, del ? f.clock.value : null);
  assert.equal(r.run.history_state, deliveryState === 'suppressed' ? 'skipped_suppressed' : 'skipped_not_requested');
  if (del) { assert.equal(observations.length, 1); assert.equal(observations[0].last_slot_watermark, f.slot); }
  assert.equal(state(f.db).runs.length, 1);
  unchanged(f, () => assert.equal(finalize(f, { kind: 'success', deliveryState }).kind, 'existing'));
});
for (const status of ['queued', 'running']) test(`neutral one-shot ${status} disables consumed retained base without success deletion`, t => {
  const f = reserved(t, { schedule: { kind: 'at', atMs: now + 60000 } }, status); seedCounters(f);
  finalize(f, { kind: 'neutral', reason: 'shutdown' }); const j = f.store.get(scope, f.job.id);
  assert.equal(j.enabled, 0); assert.equal(j.next_run_at, null); assert.equal(j.deleted_at, null);
  assert.equal(j.last_slot_watermark, f.slot); assert.equal(j.consecutive_errors, 9);
});

for (const outcome of [success, { kind: 'neutral', reason: 'shutdown' }])
test(`borrow ${outcome.kind} completion updates only own receipt/newer information`, t => {
  const f = reserved(t); manual(f); seedCounters(f); const j = f.store.get(scope, f.job.id);
  finalize(f, outcome); const after = f.store.get(scope, f.job.id);
  for (const k of Object.keys(j).filter(k => !k.startsWith('last_') || k === 'last_slot_watermark' || k === 'last_alert_at')) assert.equal(after[k], j[k], k);
  assert.equal(after.last_status, outcome.kind === 'success' ? 'ok' : 'interrupted');
});
for (const outcome of [success, { kind: 'neutral', reason: 'shutdown' }]) {
  test(`legacy manual none refuses ${outcome.kind} completion without writes`, t => {
    const f = reserved(t); manual(f, 'none'); seedCounters(f);
    unchanged(f, () => finalize(f, outcome), StoreIntegrityError);
  });
}
for (const enabled of [0,1]) for (const outcome of [success, { kind: 'neutral', reason: 'shutdown' }])
test(`future borrowed at crossing due enabled=${enabled}/${outcome.kind} preserves authored eligibility`, t => {
  const f = reserved(t, { schedule: { kind: 'at', atMs: now + 60000 } });
  // This is a seeded future-manual receipt; there is no manual admission writer in this slice.
  f.db.prepare('UPDATE cron_runs SET queued_at=?,started_at=?,ready_at=?').run(now, now, now);
  f.run = f.db.prepare('SELECT * FROM cron_runs').get(); manual(f);
  if (!enabled) {
    f.db.prepare('UPDATE cron_jobs SET enabled=0,next_run_at=NULL').run();
    const snap = { ...JSON.parse(f.run.definition_snapshot_json), admittedEnabled: false, admittedNextRunAt: null, manualMode: 'force' };
    f.db.prepare("UPDATE cron_runs SET admitted_enabled=0,admitted_next_run_at=NULL,manual_mode='force',definition_snapshot_json=?").run(JSON.stringify(snap));
    f.run = f.db.prepare('SELECT * FROM cron_runs').get();
  }
  const before = f.store.get(scope, f.job.id); f.clock.value = f.slot + 600000;
  finalize(f, outcome); const after = f.store.get(scope, f.job.id);
  for (const k of ['generation','enabled','deleted_at','next_run_at','last_slot_watermark','consecutive_errors','consecutive_skipped','consecutive_target_failures']) assert.equal(after[k], before[k], k);
  if (enabled) {
    const r = f.store.admitBase(scope, f.job.id, { trigger:'scheduled',generation:1,slot:f.slot,runId:'authored-after-borrow',
      authority:{jobId:f.job.id,definition:f.store.definition(scope,f.job.id),creatorAuthorized:true,targetAuthorized:true,ownerIncarnation:'owner',resetGeneration:2,policy:{tools:'none'}},
      ownership:{ownerIncarnation:'owner',resetGeneration:2,assertHeld(){}} });
    assert.equal(r.kind,'reserved'); assert.equal(r.run.authored_slot,f.slot);
  }
});

for (const variant of ['edit-away-back','tombstone','missing']) for (const outcome of [success,{kind:'neutral',reason:'reset'}])
test(`${variant}/${outcome.kind}: old callbacks cannot change replacement W/cadence/counters/delete`, t => {
  const f = reserved(t, { schedule:{kind:'at',atMs:now+60000} }); seedCounters(f);
  if (variant === 'edit-away-back') {
    f.store.edit(scope,f.job.id,1,{schedule:{kind:'every',everyMs:60000,anchorMs:0}});
    f.store.edit(scope,f.job.id,2,{schedule:{kind:'at',atMs:f.slot}});
    f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?').run(now, f.slot+700000);
  } else if (variant === 'tombstone') f.db.prepare('UPDATE cron_jobs SET deleted_at=?,enabled=0,generation=2,last_slot_watermark=NULL,next_run_at=NULL').run(f.clock.value);
  else f.db.prepare('DELETE FROM cron_jobs').run();
  const before = state(f.db); assert.equal(finalize(f,outcome).kind,'finalized');
  const after = state(f.db);
  for (const j of before.jobs) for (const k of Object.keys(j).filter(k => !['last_run_at','last_status','last_completion','last_error','last_error_reason','last_duration_ms'].includes(k))) assert.equal(after.jobs[0][k],j[k],k);
  if (variant === 'missing') assert.deepEqual(after.jobs,[]);
});

for (const delta of [-1,0,1]) for (const ownership of ['consume','borrow']) test(`strict newer information delta=${delta}/${ownership}`,t => {
  const f=reserved(t); if(ownership==='borrow') manual(f);
  f.db.prepare("UPDATE cron_jobs SET last_run_at=?,last_status='error',last_error='prior',last_error_reason='network',last_completion='failed',last_duration_ms=42").run(f.clock.value+delta);
  const before=f.store.get(scope,f.job.id);finalize(f);const after=f.store.get(scope,f.job.id);
  if(delta<0) assert.equal(after.last_status,'ok'); else for(const k of ['last_run_at','last_status','last_error','last_error_reason','last_completion','last_duration_ms']) assert.equal(after[k],before[k],k);
});
test('older running success after later overlap cannot lower W/cadence and resets skipped once',t => {
  const f=reserved(t);seedCounters(f);f.clock.value=f.slot+60000;
  const r=f.store.admitBase(scope,f.job.id,{trigger:'scheduled',generation:1,slot:f.clock.value,runId:'later-overlap',
    authority:{jobId:f.job.id,definition:f.store.definition(scope,f.job.id),creatorAuthorized:true,targetAuthorized:true,ownerIncarnation:'owner',resetGeneration:2,policy:{tools:'none'}},
    ownership:{ownerIncarnation:'owner',resetGeneration:2,assertHeld(){}}});
  assert.equal(r.kind,'overlap'); const high=f.store.get(scope,f.job.id);assert.equal(high.consecutive_skipped,9);
  // A backward clock is still later than execution start; it cannot move committed cadence back.
  f.clock.value=f.slot+500;finalize(f);const after=f.store.get(scope,f.job.id);
  assert.equal(after.last_slot_watermark,high.last_slot_watermark);assert.equal(after.next_run_at,high.next_run_at);
  assert.equal(after.consecutive_errors,0);assert.equal(after.consecutive_skipped,0);assert.equal(after.last_status,'skipped');
  unchanged(f,()=>assert.equal(finalize(f).kind,'existing'));
});
for(const watermark of [null,now+60000,now+120000]) test(`NULL/equal/higher W=${watermark} uses max`,t=>{
  const f=reserved(t);f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(watermark);finalize(f);
  assert.equal(f.store.get(scope,f.job.id).last_slot_watermark,Math.max(f.slot,watermark??0));
});

for(const field of ['owner_incarnation','admitted_generation','reset_generation','occurrence_id','definition_snapshot_json','schedule_ownership','authored_slot','admitted_next_run_at','trigger','manual_mode','attempt'])
test(`exact CAS expectation miss on ${field} writes nothing`,t=>{
  const f=reserved(t),r=request(f),e={...r.expected};
  e[field]=typeof e[field]==='number'?e[field]+1:e[field]===null?'different':e[field]+'different';
  unchanged(f,()=>assert.equal(f.store.finalize(scope,f.job.id,{...r,expected:e}).kind,'miss'));
});
for(const status of ['queued','running']) test(`wrong expected status ${status} or owner proof misses`,t=>{
  const f=reserved(t,{},status);const r=request(f);
  unchanged(f,()=>assert.equal(f.store.finalize(scope,f.job.id,{...r,expected:{...r.expected,status:status==='queued'?'running':'queued'}}).kind,'miss'));
  unchanged(f,()=>assert.equal(f.store.finalize(scope,f.job.id,{...r,ownership:{...r.ownership,ownerIncarnation:'wrong'}}).kind,'miss'));
});
test('missing receipt and foreign scope never write',t=>{
  const f=reserved(t),r=request(f);
  unchanged(f,()=>assert.deepEqual(f.store.finalize(scope,f.job.id,{...r,expected:{...r.expected,run_id:'missing'}}),{kind:'miss'}));
  unchanged(f,()=>f.store.finalize({targetSession:'foreign'},f.job.id,r),JobNotFound);
});

for(const outcome of [{kind:'error'},{kind:'target-failure'},{kind:'restart'},{kind:'session-busy'},{kind:'retry-superseded'},
  ...['delivered','not-delivered','unknown'].map(deliveryState=>({kind:'success',deliveryState}))])
test(`unreached ${JSON.stringify(outcome)} is typed NO-WRITES deferred`,t=>{
  const f=reserved(t);
  unchanged(f,()=>assert.deepEqual(finalize(f,outcome),{kind:'deferred',reason:outcome.kind==='success'?'publication-or-delivery':'outcome-policy'}));
});
for(const attempt of [1,2,3]) test(`retry success attempt${attempt} explicitly defers without advancing W`,t=>{
  const f=reserved(t);
  f.db.prepare("UPDATE cron_runs SET attempt=?,trigger='retry'").run(attempt);
  f.run=f.db.prepare('SELECT * FROM cron_runs').get();
  f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(f.slot);
  unchanged(f,()=>assert.deepEqual(finalize(f),{kind:'deferred',reason:'retry-chain'}));
});
for(const delivery of ['started','delivered','not-delivered','unknown']) for(const outcome of [success,{kind:'neutral',reason:'shutdown'}])
test(`observed delivery ${delivery}/${outcome.kind} cannot be erased by bounded finalizer`,t=>{
  const f=reserved(t);f.db.prepare('UPDATE cron_runs SET delivery_state=?,segments_sent=1').run(delivery);f.run=f.db.prepare('SELECT * FROM cron_runs').get();
  unchanged(f,()=>assert.deepEqual(finalize(f,outcome),{kind:'deferred',reason:'publication-or-delivery'}));
});
test('queued success deferred; mismatched delivery policy rejected before CAS',t=>{
  const f=reserved(t,{},'queued');unchanged(f,()=>assert.deepEqual(finalize(f),{kind:'deferred',reason:'queued-success'}));
  const g=reserved(t,{deliveryMode:'announce'});unchanged(g,()=>finalize(g),TypeError);
});

for(const [column,value] of [ ['authored_slot',now+1],['schedule_ownership','borrow'],['authored_occurrence_id','invalid'],
  ['admitted_enabled',0],['admitted_next_run_at',null],['scheduled_for',null],['exec_mode','session'],['trigger','manual'],
  ['manual_mode','due'],['occurrence_id','invalid'],['definition_snapshot_json','{}'],['ready_at',now+1]])
test(`malformed immutable ${column} rejects with integrity signal and no writes`,t=>{
  const f=reserved(t);f.db.prepare(`UPDATE cron_runs SET ${column}=?`).run(value);f.run=f.db.prepare('SELECT * FROM cron_runs').get();
  unchanged(f,()=>finalize(f),StoreIntegrityError);
});
test('same-generation snapshot tamper and terminal without W are integrity errors',t=>{
  const f=reserved(t);const snap={...JSON.parse(f.run.definition_snapshot_json),payload:{kind:'agentTurn',message:'tampered'}};
  f.db.prepare('UPDATE cron_runs SET definition_snapshot_json=?').run(JSON.stringify(snap));
  unchanged(f,()=>finalize(f),StoreIntegrityError);
  const g=reserved(t);finalize(g);g.db.prepare('UPDATE cron_jobs SET last_slot_watermark=NULL').run();
  unchanged(g,()=>finalize(g),StoreIntegrityError);
});

for(const point of ['afterTerminalCas','afterJobProjection']) for(const mode of ['throw','promise','generation','tombstone'])
test(`atomic rollback ${point}/${mode} restores active receipt and entire projection`,t=>{
  const f=reserved(t,{schedule:{kind:'at',atMs:now+60000}});
  const seams={ [point]:()=>{
    if(mode==='throw') throw Error('fault'); if(mode==='promise') return Promise.resolve();
    f.db.prepare(mode==='generation'?'UPDATE cron_jobs SET generation=generation+1':'UPDATE cron_jobs SET deleted_at=123').run();
    if(point==='afterJobProjection') throw Error('fault after effects');
  }};
  unchanged(f,()=>finalize(f,success,new CronStore(f.db,f.clock,seams)),Error);
  assert.equal(finalize(f).kind,'finalized');
});
for(const check of [1,2]) test(`ownership loss at assertion ${check} rolls back all writes`,t=>{
  const f=reserved(t);let checks=0;const r=request(f);r.ownership.assertHeld=()=>{if(++checks===check) throw Error('ownership lost');};
  unchanged(f,()=>f.store.finalize(scope,f.job.id,r),/ownership lost/);assert.equal(checks,check);
});
test('caller transaction and asynchronous ownership proof rejected',t=>{
  const f=reserved(t),r=request(f);r.ownership.assertHeld=async()=>{};
  unchanged(f,()=>f.store.finalize(scope,f.job.id,r),TypeError);
  f.db.exec('BEGIN IMMEDIATE');assert.throws(()=>finalize(f),StoreConflict);f.db.exec('ROLLBACK');
});
for(const point of ['afterTerminalCas','afterJobProjection']) test(`two connections contend at ${point}; winner alone projects; repeated callbacks dedupe`,t=>{
  const f=reserved(t),other=f.connect(),second=new CronStore(other,f.clock);
  const store=new CronStore(f.db,f.clock,{[point]:()=>{
    assert.throws(()=>finalize(f,success,second),e=>e.code==='SQLITE_BUSY');
    assert.equal(other.prepare('SELECT status FROM cron_runs').get().status,'running');
    assert.equal(other.prepare('SELECT last_slot_watermark FROM cron_jobs').get().last_slot_watermark,null);
  }});
  const won=finalize(f,success,store);const r=request(f);r.ownership.assertHeld=()=>assert.equal(other.inTransaction,true);
  unchanged(f,()=>assert.deepEqual(second.finalize(scope,f.job.id,r),{kind:'existing',run:won.run}));
});
for(const point of ['afterTerminalCas','afterJobProjection','afterCommit']) for(const mode of ['exit','sigkill'])
for(const once of [false,true]) test(`real process ${mode}/${point}/one-shot=${once}: WAL reopen is atomic`,t=>{
  const f=reserved(t,once?{schedule:{kind:'at',atMs:now+60000}}:{});f.db.pragma('journal_mode=WAL');const before=state(f.db);
  const child=spawnSync(process.execPath,['--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),
    fileURLToPath(new URL('./terminal-crash-child.mjs',import.meta.url)),f.path,JSON.stringify(request(f)),String(f.clock.value),point,mode],
    {env:process.env,encoding:'utf8',timeout:10000});
  if(mode==='exit') assert.equal(child.status,83,child.stderr);else assert.equal(child.signal,'SIGKILL',child.stderr);
  assert.equal(child.error,undefined);f.db.close();const reopened=f.connect();const after=state(reopened);
  if(point==='afterCommit') {
    assert.equal(after.runs[0].status,'ok');assert.equal(after.jobs[0].last_slot_watermark,f.slot);
    assert.equal(after.jobs[0].deleted_at,once?f.clock.value:null);
    const store=new CronStore(reopened,f.clock);const r=request(f);r.ownership.assertHeld=()=>assert.equal(reopened.inTransaction,true);
    assert.equal(store.finalize(scope,f.job.id,r).kind,'existing');assert.deepEqual(state(reopened),after);
  } else {
    assert.deepEqual(after,before);const r=request(f);r.ownership.assertHeld=()=>assert.equal(reopened.inTransaction,true);
    assert.equal(new CronStore(reopened,f.clock).finalize(scope,f.job.id,r).kind,'finalized');
  }
});

test('CAS returning zero never authorizes projection or fault hooks',t=>{
  const f=reserved(t);let hooks=0;
  const proxy={get inTransaction(){return f.db.inTransaction;},exec:s=>f.db.exec(s),prepare(sql){
    if(sql.startsWith('UPDATE cron_runs SET status=')) return {run:()=>({changes:0})};
    return f.db.prepare(sql);
  }};
  const store=new CronStore(proxy,f.clock,{afterTerminalCas(){hooks++;},afterJobProjection(){hooks++;}});
  unchanged(f,()=>assert.equal(finalize(f,success,store).kind,'miss'));assert.equal(hooks,0);
});
test('success and all deferrals perform no session/history/network activity; unsupported requests issue no DML',t=>{
  const f=reserved(t);f.db.exec('CREATE TABLE context_notes(id TEXT); CREATE TABLE sessions(id TEXT); CREATE TABLE messages(id TEXT)');
  const statements=[];let calls=0;const saved=globalThis.fetch;
  globalThis.fetch=()=>{calls++;throw Error('unexpected network');};t.after(()=>{globalThis.fetch=saved;});
  const proxy={get inTransaction(){return f.db.inTransaction;},exec:s=>f.db.exec(s),prepare(sql){statements.push(sql);return f.db.prepare(sql);}};
  const store=new CronStore(proxy,f.clock);
  for(const outcome of [{kind:'error'},{kind:'target-failure'},{kind:'retry-superseded'},{kind:'success',deliveryState:'delivered'}]){
    statements.length=0;const changes=f.db.prepare('SELECT total_changes() n').get().n;
    unchanged(f,()=>assert.equal(finalize(f,outcome,store).kind,'deferred'));
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
    assert.equal(statements.some(s=>/^(UPDATE|INSERT|DELETE)/.test(s)),false);
  }
  statements.length=0;assert.equal(finalize(f,success,store).kind,'finalized');
  assert.equal(statements.filter(s=>s.startsWith('UPDATE cron_runs')).length,1);
  assert.equal(statements.filter(s=>s.startsWith('UPDATE cron_jobs')).length,1);
  assert.equal(statements.some(s=>/\b(context_notes|sessions|messages)\b/.test(s)),false);
  for(const table of ['context_notes','sessions','messages']) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(calls,0);
});
test('retained valid attempt0/retry chain remains wholly untouched by deferred retry success',t=>{
  const f=reserved(t);finalize(f);const base=f.db.prepare('SELECT * FROM cron_runs').get();
  const retry={...base,run_id:'retry',attempt:1,trigger:'retry',status:'running',phase:'executing',completion:null,ended_at:null,
    delivery_state:'not-started',history_state:null,ready_at:f.clock.value+30000};
  f.db.prepare(`INSERT INTO cron_runs (${Object.keys(retry).join(',')}) VALUES (${Object.keys(retry).map(()=>'?').join(',')})`).run(...Object.values(retry));
  f.run=retry;unchanged(f,()=>assert.deepEqual(finalize(f),{kind:'deferred',reason:'retry-chain'}));
});
test('finite recurring schedule exhaustion is a typed no-DML deferral',t=>{
  const f=reserved(t,{schedule:{kind:'cron',expr:'0 0 13 29 10 * 2026',tz:'UTC',exact:true}});
  f.clock.value=f.slot+86400000;
  unchanged(f,()=>assert.deepEqual(finalize(f),{kind:'deferred',reason:'schedule-exhausted'}));
});
for(const mode of ['if-enabled','force']) test(`overdue manual one-shot ${mode} shares base consumption rule`,t=>{
  const f=reserved(t,{schedule:{kind:'at',atMs:now+60000},deleteAfterRun:false},'running','manual');
  const snap={...JSON.parse(f.run.definition_snapshot_json),manualMode:mode};
  f.db.prepare('UPDATE cron_runs SET manual_mode=?,definition_snapshot_json=?').run(mode,JSON.stringify(snap));
  f.run=f.db.prepare('SELECT * FROM cron_runs').get();finalize(f);const j=f.store.get(scope,f.job.id);
  assert.equal(j.last_slot_watermark,f.slot);assert.equal(j.enabled,0);assert.equal(j.deleted_at,null);
});
for(const change of [
  s=>({...s,policy:{tools:'unsupported'}}),
  s=>({...s,admittedEnabled:false}),
  s=>({...s,scheduleOwnership:'borrow'}),
  s=>({...s,schedule:{...s.schedule,anchorMs:1}}),
]) test(`invalid admitted snapshot variant ${String(change)} fails closed`,t=>{
  const f=reserved(t);f.db.prepare('UPDATE cron_runs SET definition_snapshot_json=?').run(JSON.stringify(change(JSON.parse(f.run.definition_snapshot_json))));
  unchanged(f,()=>finalize(f),StoreIntegrityError);
});
test('current tombstone, same generation, accepts only receipt/newer information effects',t=>{
  const f=reserved(t,{schedule:{kind:'at',atMs:now+60000}});f.db.prepare('UPDATE cron_jobs SET deleted_at=?,enabled=0').run(now);
  const before=f.store.get(scope,f.job.id);finalize(f);const after=f.store.get(scope,f.job.id);
  for(const k of ['deleted_at','enabled','generation','last_slot_watermark','next_run_at','consecutive_errors','consecutive_skipped']) assert.equal(after[k],before[k]);
});
test('missing receipt expected immutable keys and extra outcome work are rejected before mutation',t=>{
  const f=reserved(t),r=request(f),expected={...r.expected};delete expected.authored_slot;
  unchanged(f,()=>f.store.finalize(scope,f.job.id,{...r,expected}),TypeError);
  unchanged(f,()=>finalize(f,{...success,publish:true}),TypeError);
});
for(const [column,value] of [['completion','failed'],['error','classified failure'],['reason','network'],['phase','admission']])
test(`pending ${column} cannot be silently overwritten by success`,t=>{
  const f=reserved(t);f.db.prepare(`UPDATE cron_runs SET ${column}=?`).run(value);f.run=f.db.prepare('SELECT * FROM cron_runs').get();
  unchanged(f,()=>assert.deepEqual(finalize(f),{kind:'deferred',reason:'outcome-policy'}));
});
for(const [column,value] of [['started_at',null],['ended_at',now+60000],['phase',null],['queued_at',now]])
test(`invalid stored lifecycle ${column} is an integrity error without writes`,t=>{
  const f=reserved(t);f.db.prepare(`UPDATE cron_runs SET ${column}=?`).run(value);f.run=f.db.prepare('SELECT * FROM cron_runs').get();
  unchanged(f,()=>finalize(f),StoreIntegrityError);
});
