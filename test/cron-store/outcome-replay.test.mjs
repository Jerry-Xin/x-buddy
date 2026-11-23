// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { CronStore, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { setup, state, scope } from './execution-fixture.mjs';

function started(t,retry,mode='none') {
  const f=setup(t,{deliveryMode:mode});if(retry)f.queueRetry();
  f.executionRequest=f.issuer.issue(f);const running=f.admit(f.executionRequest);assert.equal(running.kind,'admitted');
  f.terminalRequest={expected:terminalExpectation(running.run),ownership:f.owner,retryChain:true,
    outcome:{kind:'success',deliveryState:mode==='none'?'not-requested':'suppressed'}};
  return f;
}
function success(t,retry,mode='none') {
  const f=started(t,retry,mode);assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');return f;
}
function update(f,patch) {
  const keys=Object.keys(patch);f.db.prepare(`UPDATE cron_runs SET ${keys.map(k=>`${k}=?`).join(',')} WHERE run_id=?`).run(...keys.map(k=>patch[k]),f.id);
}
function observe(f,entry,corrupt) {
  const before=state(f.db),dml=[];
  const proxy={get inTransaction(){return f.db.inTransaction;},exec(sql){if(/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql))dml.push(sql);f.db.exec(sql);},prepare(sql){
    const s=f.db.prepare(sql),call=method=>(...a)=>{if(/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql))dml.push(sql);return s[method](...a);};
    return {get:call('get'),all:call('all'),run:call('run')};}};
  const store=new CronStore(proxy,f.clock,{},f.issuer.port(f.db));let result,error;
  try{result=entry==='execution'?f.admit(f.executionRequest,store):store.finalize(scope,f.job.id,f.terminalRequest);}catch(e){error=e;}
  const after=state(f.db);
  if(process.env.REVIEW_TRACE)appendFileSync(process.env.REVIEW_TRACE,JSON.stringify({case:f.label,entry,corrupt,before,after,dml,result,
    error:error&&{type:error.constructor.name,message:error.message}})+'\n');
  assert.deepEqual(dml,[]);assert.deepEqual(after,before);assert.equal(f.db.inTransaction,false);
  if(corrupt){assert.ok(error instanceof StoreIntegrityError,error?.stack??JSON.stringify(result));assert.match(error.message,/quarantine/);}
  else{assert.ifError(error);assert.equal(result.kind,'existing');assert.deepEqual(result.run,f.row());assert.ok(Object.isFrozen(result.run));}
}

for(const retry of [false,true]) {
  for(const completion of ['succeeded','failed','unknown'])test(`CURRENT corruption running completion ${retry}/${completion}`,t=>{
    const f=started(t,retry);f.label=t.name;update(f,{completion});observe(f,'execution',true);
  });
  for(const history of ['published','skipped_reset','skipped_session_mode','skipped_suppressed','skipped_not_requested','skipped_not_delivered']) {
    test(`CURRENT corruption active publication ${retry}/${history}`,t=>{const f=started(t,retry);f.label=t.name;update(f,{history_state:history});observe(f,'execution',true);});
  }
  for(const field of ['reason','error'])test(`CURRENT corruption active terminal ${retry}/${field}`,t=>{
    const f=started(t,retry);f.label=t.name;update(f,{[field]:'network'});observe(f,'execution',true);
  });
  for(const delivery of ['started','delivered','not-delivered','unknown'])test(`CURRENT corruption executing publication phase ${retry}/${delivery}`,t=>{
    const f=started(t,retry,'announce');f.label=t.name;update(f,{delivery_state:delivery,segments_sent:1});observe(f,'execution',true);
  });
  for(const delivery of ['started','delivered','not-delivered','unknown'])test(`SEEDED valid active delivering representation ${retry}/${delivery}`,t=>{
    const f=started(t,retry,'announce');f.label=t.name;update(f,{phase:'delivering',delivery_state:delivery,segments_sent:1});observe(f,'execution',false);
  });
  test(`valid running duplicate preserves original start and complete job state ${retry}`,t=>{const f=started(t,retry);f.label=t.name;observe(f,'execution',false);});

  const corruptions={
    'missing-completion':{completion:null},'failed-completion':{completion:'failed'},'unknown-completion':{completion:'unknown'},
    'not-started-delivery':{delivery_state:'not-started'},'started-delivery':{delivery_state:'started'},
    'failed-delivery':{delivery_state:'not-delivered'},'unknown-delivery':{delivery_state:'unknown'},
    'missing-history':{history_state:null},'unpublished-history':{history_state:'not-published'},
    'false-publication':{history_state:'published'},'wrong-suppression-history':{history_state:'skipped_suppressed'},
    'sent-without-delivery':{segments_sent:1},'failure-reason':{reason:'network'},'failure-error':{error:'redacted'},
  };
  for(const entry of ['execution','terminal'])for(const [label,patch]of Object.entries(corruptions)) {
    test(`CURRENT terminal success corruption ${entry}/${retry}/${label}`,t=>{const f=success(t,retry);f.label=t.name;update(f,patch);observe(f,entry,true);});
  }
  for(const mode of ['none','announce'])for(const entry of ['execution','terminal'])test(`valid success none/suppressed ${entry}/${retry}/${mode}`,t=>{
    const f=success(t,retry,mode);f.label=t.name;observe(f,entry,false);
  });
  for(const reason of ['stopped','reset','reload','shutdown'])for(const entry of ['execution','terminal'])test(`valid neutral terminal ${entry}/${retry}/${reason}`,t=>{
    const f=started(t,retry);f.label=t.name;f.terminalRequest.outcome={kind:'neutral',reason};
    assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');observe(f,entry,false);
  });
  for(const entry of ['execution','terminal'])for(const completion of [null,'unknown','succeeded'])test(`CURRENT executed error completion ${entry}/${retry}/${completion}`,t=>{
    const f=started(t,retry);f.label=t.name;
    // Counter boundary fixture permits this first executed error on a retry.
    if(retry)f.db.prepare('UPDATE cron_jobs SET consecutive_errors=0').run();
    f.terminalRequest.outcome={kind:'failure',reason:'network'};f.terminalRequest.retryRunId='next';
    assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');update(f,{completion});observe(f,entry,true);
  });
  for(const entry of ['execution','terminal'])test(`valid executed error plus queued successor ${entry}/${retry}`,t=>{
    const f=started(t,retry);f.label=t.name;if(retry)f.db.prepare('UPDATE cron_jobs SET consecutive_errors=0').run();
    f.terminalRequest.outcome={kind:'failure',reason:'network'};f.terminalRequest.retryRunId='next';
    assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');observe(f,entry,false);
  });
  for(const nullable of [false,true])for(const entry of ['execution','terminal'])test(`SEEDED valid skipped admission ${entry}/${retry}/NULLstart=${nullable}`,t=>{
    const f=started(t,retry);f.label=t.name;
    // Waiting-admission production is pending. This fixture only models its stored phase.
    update(f,{phase:'admission'});f.terminalRequest.outcome={kind:'failure',reason:'session-busy'};f.terminalRequest.retryRunId='busy-next';
    assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');
    if(nullable)update(f,{started_at:null});observe(f,entry,false);
  });
  for(const entry of ['execution','terminal'])for(const history of ['published','skipped_reset','skipped_session_mode'])test(`SEEDED R8 confirmed delivery disposition ${entry}/${retry}/${history}`,t=>{
    const f=success(t,retry,'announce');f.label=t.name;
    // Representation-only control; no delivered-history/publication writer is implemented.
    update(f,{delivery_state:'delivered',history_state:history,segments_sent:1});observe(f,entry,false);
  });
  for(const entry of ['execution','terminal'])test(`SEEDED R8 ambiguous delivery restart ${entry}/${retry}`,t=>{
    const f=success(t,retry,'announce');f.label=t.name;update(f,{status:'interrupted',reason:'restart',completion:'unknown',delivery_state:'unknown',history_state:'skipped_not_delivered',segments_sent:1});
    observe(f,entry,false);
  });
  for(const entry of ['execution','terminal'])for(const patch of [
    {delivery_state:'delivered',history_state:'skipped_not_requested',segments_sent:1},
    {delivery_state:'delivered',history_state:'published',segments_sent:0},
    {completion:'unknown',delivery_state:'unknown',history_state:'published',segments_sent:1},
  ])test(`CURRENT false confirmed/unknown history ${entry}/${retry}/${JSON.stringify(patch)}`,t=>{
    const f=success(t,retry,'announce');f.label=t.name;update(f,patch);observe(f,entry,true);
  });
  test(`active unsupported completion retains original finalizer deferral ${retry}`,t=>{
    const f=started(t,retry);update(f,{completion:'failed'});const before=state(f.db);
    assert.deepEqual(f.store.finalize(scope,f.job.id,f.terminalRequest),{kind:'deferred',reason:'outcome-policy'});assert.deepEqual(state(f.db),before);
  });
}
for(const reason of ['stopped','reset','reload','shutdown'])for(const entry of ['execution','terminal'])test(`valid queued neutral skip ${entry}/${reason}`,t=>{
  const f=setup(t);f.label=t.name;f.executionRequest=f.issuer.issue(f);
  f.terminalRequest={expected:terminalExpectation(f.row()),ownership:f.owner,outcome:{kind:'neutral',reason}};
  assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');
  assert.equal(f.row().status,'skipped');assert.equal(f.row().started_at,null);observe(f,entry,false);
});
for(const retry of [false,true])for(const entry of ['execution','terminal'])test(`valid target-only failure ${entry}/${retry}`,t=>{
  const f=started(t,retry,'announce');f.label=t.name;
  // Delivery producer remains pending; this controls its admitted phase only.
  update(f,{phase:'delivering'});f.terminalRequest.outcome={kind:'failure',reason:'target-unavailable'};
  assert.equal(f.store.finalize(scope,f.job.id,f.terminalRequest).kind,'finalized');
  assert.equal(f.row().status,'ok');assert.equal(f.row().completion,'failed');observe(f,entry,false);
});
