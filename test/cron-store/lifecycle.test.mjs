// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { CronStore, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { fixture, input, scope, state, now } from './helpers.mjs';

const owner = { ownerIncarnation: 'lifecycle-owner', resetGeneration: 2, assertHeld() {} };
const transient = ['rate_limited','overloaded','network','runtime_unavailable','quarantined','timeout'];
const get = (f, id = f.active) => f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(id);
function setup(t, at = true) {
  const f = fixture(t); f.job = f.store.create(input({ schedule: at ? { kind:'at',atMs:now+60000 } : { kind:'every',everyMs:3600000,anchorMs:0 }, deliveryMode:'none' }));
  f.slot=f.job.next_run_at;f.clock.value=f.slot;f.active='base';
  f.store.admitBase(scope,f.job.id,{trigger:'scheduled',generation:1,slot:f.slot,runId:'base',ownership:owner,
    authority:{jobId:f.job.id,definition:f.store.definition(scope,f.job.id),creatorAuthorized:true,targetAuthorized:true,ownerIncarnation:owner.ownerIncarnation,resetGeneration:2,policy:{tools:'none'}}});
  return f;
}
function update(f, id, changes) {
  f.db.prepare(`UPDATE cron_runs SET ${Object.keys(changes).map(k=>k+'=?')} WHERE run_id=?`).run(...Object.values(changes),id);
}
function start(f, phase) {
  const r=get(f);f.clock.value=r.ready_at;
  update(f,f.active,{status:'running',phase,started_at:f.clock.value});f.clock.value+=1000;
}
function fail(f, reason, id) {
  return f.store.finalize(scope,f.job.id,{expected:terminalExpectation(get(f)),ownership:owner,outcome:{kind:'failure',reason},retryRunId:id});
}
function chain(t, location, reason='network') {
  const f=setup(t);
  start(f,location==='intermediate'||reason==='session-busy'?'admission':'executing');
  assert.equal(fail(f,location==='intermediate'?'session-busy':reason,'retry1').kind,'finalized');
  f.active='retry1';
  if(location==='intermediate') {
    start(f,reason==='session-busy'?'admission':'executing');
    assert.equal(fail(f,reason,'retry2').kind,'finalized');f.active='retry2';
  }
  start(f,'executing');f.predecessor=location==='intermediate'?'retry1':'base';return f;
}
function observe(f, work) {
  const before=state(f.db),writes=[];
  const db={get inTransaction(){return f.db.inTransaction;},exec(sql){if(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))writes.push(sql);return f.db.exec(sql);},prepare(sql){
    const s=f.db.prepare(sql);return {get:(...a)=>s.get(...a),all:(...a)=>s.all(...a),run(...a){if(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))writes.push(sql);return s.run(...a);}};
  }};
  let result,error;try{result=work(new CronStore(db,f.clock));}catch(e){error=e;}
  const after=state(f.db);
  if(process.env.LIFECYCLE_TRACE)appendFileSync(process.env.LIFECYCLE_TRACE,JSON.stringify({case:f.label,before,result,error:error&&{name:error.constructor.name,message:error.message},writes,after})+'\n');
  return {result,error,writes,before,after};
}
function success(f, store=f.store) {
  return store.finalize(scope,f.job.id,{expected:terminalExpectation(get(f)),ownership:owner,outcome:{kind:'success',deliveryState:'not-requested'},retryChain:true});
}
function rejected(f) {
  const o=observe(f,s=>success(f,s));assert.ok(o.error instanceof StoreIntegrityError,o.error?.message??JSON.stringify(o.result));
  assert.deepEqual(o.writes,[]);assert.deepEqual(o.after,o.before);
}
const corruptions={
  'missing-start':r=>({started_at:null}),
  'start-before-queue':r=>({started_at:r.queued_at-1}),
  'start-before-ready':r=>({started_at:r.ready_at-1}),
  'start-after-end':r=>({started_at:r.ended_at+1}),
  'fractional-start':r=>({started_at:r.started_at+0.5}),
  'text-start':r=>({started_at:'invalid-time'}),
  'missing-end':r=>({ended_at:null}),
  'end-before-queue':r=>({ended_at:r.queued_at-1}),
  'terminal-live-phase':r=>({phase:'executing'}),
  'wrong-ok-status':r=>({status:'ok'}),
  'wrong-skipped-status':r=>({status:'skipped'}),
  'permanent-reason':r=>({reason:'auth'}),
  'busy-reason-with-error-status':r=>({reason:'session-busy'}),
  'missing-completion':r=>({completion:null}),
};
for(const location of ['base','intermediate'])for(const reason of transient)for(const [mutation,change] of Object.entries(corruptions))test(`executed predecessor ${location}/${reason}/${mutation} rejects before DML`,t=>{
  const f=chain(t,location,reason);f.label=t.name;update(f,f.predecessor,change(get(f,f.predecessor)));rejected(f);
});
for(const location of ['base','intermediate'])for(const reason of transient)for(const boundary of ['at-ready','at-end'])test(`executed predecessor ${location}/${reason}/${boundary} remains valid`,t=>{
  const f=chain(t,location,reason),prior=get(f,f.predecessor);f.label=t.name;
  update(f,f.predecessor,{started_at:boundary==='at-ready'?Math.max(prior.queued_at,prior.ready_at):prior.ended_at});
  const o=observe(f,s=>success(f,s));assert.ifError(o.error);assert.equal(o.result.kind,'finalized');
  const j=f.store.get(scope,f.job.id);assert.equal(j.last_slot_watermark,f.slot);assert.equal(j.consecutive_errors,0);assert.equal(j.enabled,0);assert.equal(j.deleted_at,f.clock.value);
});
function retimeSuccessor(f, predecessorEnd) {
  // Busy predecessors use30s at every attempt. Keep the successor's timing
  // consistent so the control probes the predecessor's own eligibility.
  update(f,f.predecessor,{ended_at:predecessorEnd});
  update(f,f.active,{queued_at:predecessorEnd,ready_at:predecessorEnd+30000,started_at:predecessorEnd+30000});f.clock.value=predecessorEnd+31000;
}
for(const location of ['base','intermediate'])for(const startEvidence of ['not-started','at-ready','at-end'])test(`skipped admission ${location}/${startEvidence} remains a valid chain`,t=>{
  const f=chain(t,location,'session-busy'),prior=get(f,f.predecessor);f.label=t.name;
  update(f,f.predecessor,{started_at:startEvidence==='not-started'?null:startEvidence==='at-ready'?Math.max(prior.queued_at,prior.ready_at):prior.ended_at});
  const o=observe(f,s=>success(f,s));assert.ifError(o.error);assert.equal(o.result.kind,'finalized');assert.equal(o.after.jobs[0].consecutive_errors,0);assert.equal(o.after.jobs[0].last_slot_watermark,f.slot);
});
for(const location of ['base','intermediate'])test(`skipped admission ${location} may terminalize at eligibility with no start`,t=>{
  const f=chain(t,location,'session-busy'),prior=get(f,f.predecessor);f.label=t.name;
  update(f,f.predecessor,{started_at:null});retimeSuccessor(f,prior.ready_at);
  const o=observe(f,s=>success(f,s));assert.ifError(o.error);assert.equal(o.result.kind,'finalized');assert.equal(o.after.jobs[0].consecutive_errors,0);
});
for(const location of ['base','intermediate'])for(const mutation of ['start-before-ready','start-after-end','end-before-ready','terminal-live-phase','wrong-reason','wrong-status'])test(`skipped predecessor ${location}/${mutation} rejects before DML`,t=>{
  const f=chain(t,location,'session-busy'),prior=get(f,f.predecessor);f.label=t.name;
  if(mutation==='start-before-ready')update(f,f.predecessor,{started_at:prior.ready_at-1});
  if(mutation==='start-after-end')update(f,f.predecessor,{started_at:prior.ended_at+1});
  if(mutation==='end-before-ready'){update(f,f.predecessor,{started_at:null});retimeSuccessor(f,prior.ready_at-1);}
  if(mutation==='terminal-live-phase')update(f,f.predecessor,{phase:'admission'});
  if(mutation==='wrong-reason')update(f,f.predecessor,{reason:'network',started_at:null});
  if(mutation==='wrong-status')update(f,f.predecessor,{status:'error',completion:'failed',started_at:null});
  rejected(f);
});
for(const reason of ['stopped','reset','reload','shutdown'])test(`queued neutral ${reason} replay retains valid absent start evidence`,t=>{
  const f=setup(t,false),expected=terminalExpectation(get(f));f.label=t.name;f.clock.value++;
  const req={expected,ownership:owner,outcome:{kind:'neutral',reason}},r=f.store.finalize(scope,f.job.id,req);assert.equal(r.run.started_at,null);
  const o=observe(f,s=>s.finalize(scope,f.job.id,req));assert.ifError(o.error);assert.deepEqual(o.result,{kind:'existing',run:r.run});assert.deepEqual(o.writes,[]);assert.deepEqual(o.after,o.before);
});
for(const status of ['ok','error','interrupted'])for(const mutation of ['missing-start','terminal-live-phase'])test(`terminal replay ${status}/${mutation} validates lifecycle before returning stored outcome`,t=>{
  const f=setup(t,false);start(f,'executing');const expected=terminalExpectation(get(f));f.label=t.name;
  const outcome=status==='ok'?{kind:'success',deliveryState:'not-requested'}:status==='interrupted'?{kind:'neutral',reason:'stopped'}:{kind:'failure',reason:'network'};
  f.store.finalize(scope,f.job.id,{expected,ownership:owner,outcome,retryRunId:'retry1'});
  update(f,'base',mutation==='missing-start'?{started_at:null}:{phase:'executing'});
  const o=observe(f,s=>s.finalize(scope,f.job.id,{expected,ownership:owner,outcome}));assert.ok(o.error instanceof StoreIntegrityError);assert.deepEqual(o.writes,[]);assert.deepEqual(o.after,o.before);
});
