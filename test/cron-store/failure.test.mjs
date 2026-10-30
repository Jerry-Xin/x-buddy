// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { fixture, input, scope, state, now } from './helpers.mjs';

const transient = ['rate_limited','overloaded','network','runtime_unavailable','quarantined','timeout'];
const permanent = ['model_error','auth','invalid-definition'];
const owner = { ownerIncarnation: 'owner', resetGeneration: 2, assertHeld() {} };
function setup(t, overrides = {}, phase = 'executing') {
  const f = fixture(t); f.job = f.store.create(input({ schedule: { kind: 'every', everyMs: 3600000, anchorMs: 0 }, deliveryMode: 'none', ...overrides }));
  f.slot = f.job.next_run_at; f.clock.value = f.slot;
  f.store.admitBase(scope, f.job.id, { trigger: 'scheduled', generation: 1, slot: f.slot, runId: 'base', ownership: owner,
    authority: { jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: 'owner', resetGeneration: 2, policy: { tools: 'none' } } });
  f.db.prepare("UPDATE cron_runs SET status='running',phase=?,started_at=? WHERE run_id='base'").run(phase, f.slot);
  f.clock.value += 1000; f.runId = 'base'; return f;
}
const row = f => f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.runId);
function request(f, outcome, options = {}) {
  return { expected: terminalExpectation(row(f)), ownership: owner, outcome, ...options };
}
function finish(f, reason = 'network', options = {}, store = f.store) {
  return store.finalize(scope, f.job.id, request(f, { kind: 'failure', reason, redactedError: 'redacted fixture' }, options));
}
function startRetry(f, phase = 'admission') {
  const queued = f.db.prepare("SELECT * FROM cron_runs WHERE status='queued'").get(); assert.ok(queued);
  f.runId = queued.run_id; f.clock.value = queued.ready_at;
  // Seed executor admission precondition. admitRetry deliberately does not grant execution.
  f.db.prepare("UPDATE cron_runs SET status='running',phase=?,started_at=? WHERE run_id=?").run(phase, f.clock.value, f.runId);
  f.clock.value += 1000;
}
function noWrites(f, work, expected) {
  const before = state(f.db), dml = [];
  const proxy = { get inTransaction() { return f.db.inTransaction; }, exec(sql) { assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i); f.db.exec(sql); }, prepare(sql) {
    const s = f.db.prepare(sql); return { get: (...a) => s.get(...a), all: (...a) => s.all(...a), run(...a) { if (/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) dml.push(sql); return s.run(...a); } };
  } };
  const store = new CronStore(proxy, f.clock);
  if (expected instanceof Function) assert.throws(() => work(store), expected);
  else assert.deepEqual(work(store), expected);
  assert.deepEqual(dml, []); assert.deepEqual(state(f.db), before);
}
for (const reason of transient) for (const manual of [false, true]) test(`classified ${reason}/manual=${manual}: atomic first-error W/counter/successor`, t => {
  const f = setup(t);
  if (manual) {
    const r = row(f), snap = { ...JSON.parse(r.definition_snapshot_json), manualMode: 'due' };
    f.db.prepare("UPDATE cron_runs SET trigger='manual',manual_mode='due',definition_snapshot_json=?").run(JSON.stringify(snap));
  }
  const original = row(f), before = f.store.get(scope, f.job.id);
  const r = finish(f, reason, { retryRunId: 'retry1' }); assert.equal(r.kind, 'finalized');
  assert.equal(r.run.status, 'error'); assert.equal(r.run.reason, reason); assert.equal(r.run.completion, 'failed');
  const j = f.store.get(scope, f.job.id), retry = f.db.prepare("SELECT * FROM cron_runs WHERE run_id='retry1'").get();
  assert.equal(j.last_slot_watermark, f.slot); assert.equal(j.consecutive_errors, 1); assert.equal(j.next_run_at, before.next_run_at);
  assert.equal(retry.attempt, 1); assert.equal(retry.ready_at, f.clock.value + 30000); assert.equal(retry.queued_at, f.clock.value);
  for (const k of ['occurrence_id','authored_slot','authored_occurrence_id','definition_snapshot_json','admitted_generation','manual_mode']) assert.equal(retry[k], original[k], k);
  assert.equal(retry.status, 'queued'); assert.equal(retry.started_at, null); assert.equal(retry.error, null);
  noWrites(f, s => s.finalize(scope, f.job.id, { expected: terminalExpectation(original), ownership: owner,
    outcome: { kind: 'failure', reason: 'auth' }, retryRunId: 'unwanted' }), { kind: 'existing', run: r.run });
});

for (const attempt of [0,1,2,3]) for (const reason of transient) test(`${reason} quick ladder at attempt ${attempt} after skipped admissions`, t => {
  const f = setup(t, {}, attempt ? 'admission' : 'executing');
  for (let k = 0; k < attempt; k++) { assert.equal(finish(f, 'session-busy', { retryRunId: `retry${k+1}` }).kind, 'finalized'); startRetry(f, k === attempt-1 ? 'executing' : 'admission'); }
  const r = finish(f, reason, { retryRunId: 'execution-retry' }); assert.equal(r.kind, 'finalized');
  const j = f.store.get(scope, f.job.id); assert.equal(j.consecutive_errors, 1); assert.equal(j.last_slot_watermark, f.slot);
  const q = f.db.prepare("SELECT * FROM cron_runs WHERE status='queued'").get();
  if (attempt < 3) { assert.equal(q.attempt, attempt+1); assert.equal(q.ready_at-f.clock.value, [30000,60000,300000][attempt]); }
  else { assert.equal(q, undefined); assert.ok(j.next_run_at >= f.clock.value+30000); }
});
test('session-busy 30s x3 budget never increments execution/target/schedule errors', t => {
  const f = setup(t, {}, 'admission');
  f.db.prepare('UPDATE cron_jobs SET consecutive_errors=9,consecutive_target_failures=2,schedule_error_count=2').run();
  for (let k=0;k<4;k++) {
    assert.equal(finish(f, 'session-busy', { retryRunId: `retry${k+1}` }).kind, 'finalized');
    const j=f.store.get(scope,f.job.id); assert.equal(j.consecutive_errors,9); assert.equal(j.consecutive_target_failures,2); assert.equal(j.schedule_error_count,2);
    if(k<3) {const q=f.db.prepare("SELECT * FROM cron_runs WHERE status='queued'").get();assert.equal(q.ready_at-f.clock.value,30000);startRetry(f);}
    else assert.equal(f.db.prepare("SELECT * FROM cron_runs WHERE status='queued'").get(),undefined);
  }
});
for (const reason of permanent) test(`${reason}: permanent first recurring error uses 30s backoff, no quick retry`, t => {
  const f=setup(t,{schedule:{kind:'every',everyMs:10000,anchorMs:0}});
  assert.equal(finish(f,reason,{retryRunId:'unused'}).kind,'finalized');
  const j=f.store.get(scope,f.job.id);assert.equal(j.next_run_at,f.clock.value+30000);assert.equal(j.consecutive_errors,1);
  assert.equal(state(f.db).runs.length,1);
});
for (const gap of [29999,30000,30001]) test(`retry must be strictly earlier than natural slot: delta ${gap}`,t=>{
  const f=setup(t,{schedule:{kind:'every',everyMs:60000,anchorMs:0}});
  f.clock.value=f.slot+60000-gap;
  assert.equal(finish(f,'network',{retryRunId:'retry1'}).kind,'finalized');
  const q=f.db.prepare("SELECT * FROM cron_runs WHERE status='queued'").get();assert.equal(!!q,gap>30000);
  if(!q)assert.equal(f.store.get(scope,f.job.id).next_run_at,Math.max(f.slot+60000,f.clock.value+30000));
});
for (const count of [1,2,3,4,8,9,10]) for (const reason of ['network','auth']) test(`error boundary prior=${count}/${reason}: mandatory effect defers BEFORE CAS`,t=>{
  const f=setup(t);f.db.prepare('UPDATE cron_jobs SET consecutive_errors=?,last_alert_at=?,alert_incident_key=?,alert_occurrence=1').run(count,f.clock.value,'fixture');
  noWrites(f,s=>finish(f,reason,{retryRunId:'unused'},s),{kind:'deferred',reason:count>=9?'disable-notice-required':'alert-intent-required'});
});
for (const count of [0,1,2,3]) test(`delivery-only target boundary prior=${count}`,t=>{
  const f=setup(t,{deliveryMode:'announce'},'delivering');f.db.prepare('UPDATE cron_jobs SET consecutive_errors=8,consecutive_target_failures=?,schedule_error_count=2').run(count);
  if(count)noWrites(f,s=>finish(f,'target-unavailable',{},s),{kind:'deferred',reason:count>=2?'disable-notice-required':'alert-intent-required'});
  else {assert.equal(finish(f,'target-unavailable').kind,'finalized');const j=f.store.get(scope,f.job.id);assert.equal(j.consecutive_errors,8);assert.equal(j.consecutive_target_failures,1);assert.equal(j.schedule_error_count,2);assert.equal(row(f).status,'ok');assert.equal(row(f).completion,'failed');assert.equal(row(f).delivery_state,'not-delivered');assert.equal(state(f.db).runs.length,1);}
});
for (const reason of permanent) test(`one-shot ${reason}: mandatory terminal disable notice defers`,t=>{
  const f=setup(t,{schedule:{kind:'at',atMs:now+60000}});
  noWrites(f,s=>finish(f,reason,{},s),{kind:'deferred',reason:'disable-notice-required'});
});
for (const del of [false,true]) test(`one-shot failed base then validated retry success keep/delete=${del}`,t=>{
  const f=setup(t,{schedule:{kind:'at',atMs:now+60000},deleteAfterRun:del});
  assert.equal(finish(f,'network',{retryRunId:'retry1'}).kind,'finalized');
  const j=f.store.get(scope,f.job.id);assert.equal(j.enabled,1);assert.equal(j.last_slot_watermark,f.slot);assert.equal(j.next_run_at,f.clock.value+30000);
  noWrites(f,s=>s.admitRetry(scope,f.job.id,'retry1',owner),{kind:'deferred',reason:'retry-admission'});
  startRetry(f,'executing');const expected=terminalExpectation(row(f));
  const r=f.store.finalize(scope,f.job.id,{expected,ownership:owner,outcome:{kind:'success',deliveryState:'not-requested'},retryChain:true});
  assert.equal(r.kind,'finalized');const final=f.store.get(scope,f.job.id);assert.equal(final.last_slot_watermark,f.slot);assert.equal(final.enabled,0);assert.equal(final.consecutive_errors,0);assert.equal(final.deleted_at,del?f.clock.value:null);
});
for (const mutation of ['missing-base','snapshot','ready','owner-snapshot','not-retryable','missing-W','completion','publication','past-natural']) test(`chain corruption ${mutation} rejects without writes`,t=>{
  const f=setup(t);finish(f,'network',{retryRunId:'retry1'});startRetry(f,'executing');
  if(mutation==='missing-base')f.db.prepare("DELETE FROM cron_runs WHERE attempt=0").run();
  if(mutation==='snapshot')f.db.prepare("UPDATE cron_runs SET definition_snapshot_json=json_set(definition_snapshot_json,'$.policy.tools','doc-task') WHERE attempt=0").run();
  if(mutation==='ready')f.db.prepare('UPDATE cron_runs SET ready_at=ready_at+1 WHERE attempt=1').run();
  if(mutation==='owner-snapshot')f.db.prepare('UPDATE cron_runs SET reset_generation=4 WHERE attempt=0').run();
  if(mutation==='not-retryable')f.db.prepare("UPDATE cron_runs SET reason='auth' WHERE attempt=0").run();
  if(mutation==='missing-W')f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=NULL').run();
  if(mutation==='completion')f.db.prepare("UPDATE cron_runs SET completion='succeeded' WHERE attempt=0").run();
  if(mutation==='publication')f.db.prepare("UPDATE cron_runs SET delivery_state='delivered',segments_sent=1,history_state='published' WHERE attempt=0").run();
  if(mutation==='past-natural'){
    const ended=f.slot+3600000-15000,ready=ended+30000;
    f.db.prepare('UPDATE cron_runs SET ended_at=? WHERE attempt=0').run(ended);
    f.db.prepare('UPDATE cron_runs SET queued_at=?,ready_at=?,started_at=? WHERE attempt=1').run(ended,ready,ready);f.clock.value=ready+1000;
  }
  noWrites(f,s=>s.finalize(scope,f.job.id,request(f,{kind:'success',deliveryState:'not-requested'},{retryChain:true})),StoreIntegrityError);
});
for(const phase of ['afterTerminalCas','afterJobProjection','beforeRetryInsert','afterRetryInsert'])test(`fault ${phase} rolls receipt/W/counter/successor back together`,t=>{
  const f=setup(t),before=state(f.db);const store=new CronStore(f.db,f.clock,{[phase](){throw new Error('injected');}});
  assert.throws(()=>finish(f,'network',{retryRunId:'retry1'},store),/injected/);assert.deepEqual(state(f.db),before);
});
test('ownership loss at precommit rolls back every failure effect',t=>{
  const f=setup(t),before=state(f.db);let checks=0;
  assert.throws(()=>f.store.finalize(scope,f.job.id,request(f,{kind:'failure',reason:'network'},{retryRunId:'retry1',ownership:{...owner,assertHeld(){if(++checks===2)throw new Error('lost owner');}}})),/lost owner/);
  assert.deepEqual(state(f.db),before);
});
for(const collision of ['run-id','attempt'])test(`${collision} collision is integrity rollback, never existing consumption`,t=>{
  const f=setup(t);if(collision==='run-id'){
    const r=row(f);f.db.prepare("INSERT INTO cron_runs SELECT 'collision',job_id,trigger,manual_mode,schedule_ownership,authored_occurrence_id,authored_slot,admitted_enabled,admitted_next_run_at,scheduled_for,3,occurrence_id||'-unrelated',ready_at,'error',NULL,'failed','not-requested',0,NULL,'auth',NULL,admitted_generation,definition_snapshot_json,reset_generation,owner_incarnation,exec_mode,NULL,NULL,NULL,NULL,NULL,NULL,queued_at,started_at,? FROM cron_runs WHERE run_id=?").run(f.clock.value,r.run_id);
  }else{const r=row(f);const c={...r,run_id:'collision',trigger:'retry',attempt:1,status:'error',phase:null,ended_at:f.clock.value};const keys=Object.keys(c);f.db.prepare(`INSERT INTO cron_runs(${keys}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>c[k]));}
  const before=state(f.db);assert.throws(()=>finish(f,'network',{retryRunId:collision==='run-id'?'collision':'retry1'}),collision==='run-id'?/UNIQUE/:/chain/);assert.deepEqual(state(f.db),before);
});
test('two real SQLite connections serialize failure CAS and duplicate callback',t=>{
  const f=setup(t),other=f.connect(),expected=terminalExpectation(row(f)),before=state(f.db);other.exec('BEGIN IMMEDIATE');
  assert.throws(()=>finish(f,'network',{retryRunId:'retry1'}),/locked/);assert.deepEqual(state(f.db),before);other.exec('ROLLBACK');
  const r=finish(f,'network',{retryRunId:'retry1'});assert.equal(r.kind,'finalized');const second=new CronStore(other,f.clock);
  assert.deepEqual(second.finalize(scope,f.job.id,{expected,ownership:owner,outcome:{kind:'failure',reason:'network'},retryRunId:'retry2'}),{kind:'existing',run:r.run});assert.equal(state(f.db).runs.length,2);
});
for(const reason of [...transient,...permanent,'session-busy','target-unavailable'])test(`stale generation ${reason} has informational effects only`,t=>{
  const f=setup(t,{deliveryMode:reason==='target-unavailable'?'announce':'none'},reason==='session-busy'?'admission':reason==='target-unavailable'?'delivering':'executing');
  f.store.edit(scope,f.job.id,1,{payload:{kind:'agentTurn',message:'replacement'}});const before=f.store.get(scope,f.job.id);
  assert.equal(finish(f,reason,{retryRunId:'forbidden'}).kind,'finalized');const after=f.store.get(scope,f.job.id);
  for(const k of ['generation','schedule_activated_at','last_slot_watermark','enabled','next_run_at','consecutive_errors','consecutive_target_failures','schedule_error_count','deleted_at'])assert.equal(after[k],before[k],k);assert.equal(state(f.db).runs.length,1);
});
for(const paused of [false,true])for(const reason of ['network','auth','target-unavailable'])test(`borrowed future at crossing due paused=${paused}/${reason} preserves authored definition`,t=>{
  const f=setup(t,{schedule:{kind:'at',atMs:now+60000},deliveryMode:reason==='target-unavailable'?'announce':'none'},reason==='target-unavailable'?'delivering':'executing'),r=row(f),id='manual:00000000-0000-4000-8000-000000000001';
  if(paused)f.db.prepare('UPDATE cron_jobs SET enabled=0').run();
  const snap={...JSON.parse(r.definition_snapshot_json),occurrenceId:id,manualMode:'force',scheduleOwnership:'borrow',admittedEnabled:!paused};
  f.db.prepare("UPDATE cron_runs SET trigger='manual',manual_mode='force',schedule_ownership='borrow',scheduled_for=NULL,occurrence_id=?,admitted_enabled=?,definition_snapshot_json=?,queued_at=?,started_at=?").run(id,+!paused,JSON.stringify(snap),now,now);
  const before=f.store.get(scope,f.job.id);assert.equal(finish(f,reason,{retryRunId:'forbidden'}).kind,'finalized');const after=f.store.get(scope,f.job.id);
  for(const k of ['enabled','next_run_at','last_slot_watermark','generation','consecutive_errors','consecutive_target_failures','deleted_at'])assert.equal(after[k],before[k],k);assert.equal(state(f.db).runs.length,1);
});
for(const boundary of ['afterTerminalCas','beforeRetryInsert','afterRetryInsert','committed'])for(const method of ['exit','kill'])test(`real ${method}/${boundary} WAL reopen atomic failure effects`,t=>{
  const f=setup(t);f.db.pragma('journal_mode=WAL');const before=state(f.db);f.db.close();
  const child=spawnSync(process.execPath,['--import',new URL('./register.mjs',import.meta.url).pathname,fileURLToPath(new URL('./failure-crash-child.mjs',import.meta.url)),f.path,boundary,method,String(f.clock.value)],{env:process.env,encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined,child.stderr);assert.equal(child.signal,method==='kill'?'SIGKILL':null,child.stderr);if(method==='exit')assert.equal(child.status,0,child.stderr);
  const db=f.connect(),after=state(db);
  if(boundary!=='committed')assert.deepEqual(after,before);else{assert.equal(after.runs.length,2);assert.equal(after.jobs[0].last_slot_watermark,f.slot);assert.equal(after.jobs[0].consecutive_errors,1);assert.equal(after.runs.find(r=>r.run_id==='base').status,'error');assert.equal(after.runs.find(r=>r.run_id==='retry1').status,'queued');}
});

for(const field of ['owner_incarnation','status','ready_at','definition_snapshot_json'])test(`failure CAS expectation mismatch ${field} has no DML`,t=>{
  const f=setup(t);const req=request(f,{kind:'failure',reason:'network'},{retryRunId:'retry1'});
  req.expected={...req.expected,[field]:field==='status'?'queued':field==='ready_at'?req.expected.ready_at+1:field==='definition_snapshot_json'?req.expected.definition_snapshot_json+' ':'wrong-owner'};
  noWrites(f,s=>s.finalize(scope,f.job.id,req),{kind:'miss',run:row(f)});
});
for(const phase of ['admission','delivering'])test(`execution failure in unsupported ${phase} phase is no-write deferred`,t=>{
  const f=setup(t,{},phase);noWrites(f,s=>finish(f,'network',{retryRunId:'retry1'},s),{kind:'deferred',reason:'outcome-policy'});
});
test('missing successor identity defers before CAS and consumption',t=>{
  const f=setup(t);noWrites(f,s=>finish(f,'network',{},s),{kind:'deferred',reason:'retry-successor-required'});
});
for(const field of ['segments_sent','delivery_state','history_state'])test(`failure publication precondition ${field} remains no-write deferred`,t=>{
  const f=setup(t);const value=field==='segments_sent'?1:field==='delivery_state'?'unknown':'published';
  f.db.prepare(`UPDATE cron_runs SET ${field}=?`).run(value);
  noWrites(f,s=>finish(f,'network',{retryRunId:'retry1'},s),{kind:'deferred',reason:'publication-or-delivery'});
});
test('retry success after later overlap watermark never reconsumes or regresses cadence',t=>{
  const f=setup(t);finish(f,'network',{retryRunId:'retry1'});startRetry(f,'executing');
  const higher=f.slot+3600000;f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?,next_run_at=?,consecutive_skipped=5').run(higher,higher+3600000);
  assert.equal(f.store.finalize(scope,f.job.id,request(f,{kind:'success',deliveryState:'not-requested'},{retryChain:true})).kind,'finalized');
  const j=f.store.get(scope,f.job.id);assert.equal(j.last_slot_watermark,higher);assert.equal(j.next_run_at,higher+3600000);assert.equal(j.consecutive_errors,0);assert.equal(j.consecutive_skipped,0);
});
for(const reason of ['stopped','reset','reload','shutdown'])test(`validated retry neutral ${reason} preserves counters and creates no successor`,t=>{
  const f=setup(t);finish(f,'network',{retryRunId:'retry1'});startRetry(f,'executing');
  const before=f.store.get(scope,f.job.id);assert.equal(f.store.finalize(scope,f.job.id,request(f,{kind:'neutral',reason},{retryChain:true})).kind,'finalized');
  const j=f.store.get(scope,f.job.id);assert.equal(j.last_slot_watermark,before.last_slot_watermark);assert.equal(j.consecutive_errors,1);assert.equal(state(f.db).runs.length,2);assert.equal(f.db.prepare("SELECT * FROM cron_runs WHERE status IN ('queued','running')").get(),undefined);
});
test('old generation retry continuation cannot mutate replacement at or enqueue successor',t=>{
  const f=setup(t);finish(f,'network',{retryRunId:'retry1'});startRetry(f,'executing');
  f.store.edit(scope,f.job.id,1,{schedule:{kind:'at',atMs:f.clock.value+60000}});const before=f.store.get(scope,f.job.id);
  assert.equal(f.store.finalize(scope,f.job.id,request(f,{kind:'success',deliveryState:'not-requested'},{retryChain:true})).kind,'finalized');
  const after=f.store.get(scope,f.job.id);for(const k of ['generation','last_slot_watermark','next_run_at','enabled','deleted_at','consecutive_errors'])assert.equal(after[k],before[k],k);
});
test('retry chain from consuming manual due retains canonical base and succeeds',t=>{
  const f=setup(t,{schedule:{kind:'at',atMs:now+60000},deleteAfterRun:false});const snap={...JSON.parse(row(f).definition_snapshot_json),manualMode:'due'};
  f.db.prepare("UPDATE cron_runs SET trigger='manual',manual_mode='due',definition_snapshot_json=?").run(JSON.stringify(snap));
  finish(f,'network',{retryRunId:'retry1'});startRetry(f,'executing');
  assert.equal(f.store.finalize(scope,f.job.id,request(f,{kind:'success',deliveryState:'not-requested'},{retryChain:true})).kind,'finalized');
  assert.equal(f.store.get(scope,f.job.id).last_slot_watermark,f.slot);assert.equal(f.store.get(scope,f.job.id).enabled,0);
});
test('delivery-only failure cannot mutate target counters when admitted delivery mode is none',t=>{
  const f=setup(t,{},'delivering');noWrites(f,s=>finish(f,'target-unavailable',{},s),{kind:'deferred',reason:'outcome-policy'});
});
