// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, StoreConflict, StoreIntegrityError, JobNotFound, terminalExpectation } from '../../src/cron/store/index.ts';
import { setup, noWrites, scope, state, now } from './execution-fixture.mjs';

for (const schedule of ['recurring', 'at-keep', 'at-delete']) for (const outcome of ['success', 'stopped', 'reset', 'reload', 'shutdown']) {
  test(`MODELED issuer / REAL API unseeded ${schedule}/${outcome}`, t => {
    const f = setup(t, schedule === 'recurring' ? {} : { schedule: { kind: 'at', atMs: now + 60000 }, deleteAfterRun: schedule === 'at-delete' });
    const queued = f.queueRetry(), before = f.store.get(scope, f.job.id), req = f.issuer.issue(f);
    const admitted = f.admit(req); assert.equal(admitted.kind, 'admitted');
    assert.equal(admitted.run.status, 'running'); assert.equal(admitted.run.phase, 'executing');
    assert.equal(admitted.run.started_at, queued.ready_at); assert.ok(Object.isFrozen(admitted.run));
    assert.deepEqual(f.store.get(scope, f.job.id), before);
    noWrites(f, req, { kind: 'existing', run: admitted.run });
    f.clock.value++;
    const expected = terminalExpectation(f.row());
    const terminalOutcome = outcome === 'success' ? { kind: 'success', deliveryState: 'not-requested' } : { kind: 'neutral', reason: outcome };
    const result = f.finish(terminalOutcome); assert.equal(result.kind, 'finalized');
    const job = f.store.get(scope, f.job.id);
    assert.equal(job.last_slot_watermark, queued.authored_slot);
    assert.equal(job.consecutive_errors, outcome === 'success' ? 0 : 1);
    assert.equal(state(f.db).runs.length, 2);
    assert.equal(result.run.occurrence_id, queued.occurrence_id);
    assert.equal(result.run.admitted_generation, queued.admitted_generation);
    const snapshot = state(f.db);
    assert.equal(f.store.finalize(scope, f.job.id, { expected, ownership: f.owner, outcome: terminalOutcome, retryChain: true }).kind, 'existing');
    noWrites(f, req, { kind: 'existing', run: result.run });
    assert.deepEqual(state(f.db), snapshot);
    if (schedule !== 'recurring') {
      assert.equal(job.enabled, 0);
      assert.equal(job.deleted_at !== null, schedule === 'at-delete' && outcome === 'success');
    }
    assert.equal(f.issuer.requestCallbacks, 0);
  });
}
for (const retry of [false, true]) {
  for (const forgery of ['no-issuer', 'no-op-handle', 'copied-wrong-receipt', 'changed-runtime', 'renewed-deadline', 'boolean-only']) {
    test(`MODELED boundary / default and request forgery ${retry}/${forgery}`, t => {
      const f = setup(t); if (retry) f.queueRetry();
      const req = f.issuer.issue(f);
      if (forgery === 'no-op-handle') req.executionProof.assertCurrent = () => {};
      if (forgery === 'copied-wrong-receipt') req.expected = { ...req.expected, ready_at: req.expected.ready_at + 1 };
      if (forgery === 'changed-runtime') req.executionProof.runtimeGeneration++;
      if (forgery === 'renewed-deadline') req.executionProof.admissionDeadlineMs++;
      if (forgery === 'boolean-only') req.executionProof = { ...req.executionProof, assertCurrent: () => true };
      noWrites(f, req, { kind: 'deferred', reason: retry ? 'retry-admission' : 'execution-admission', prerequisite: 'issuer-unavailable' },
        forgery === 'no-issuer' ? { verifier: undefined } : {});
      assert.equal(f.issuer.requestCallbacks, 0);
    });
  }
  for (const status of ['revoked', 'foreign', 'reset-session', 'aborted', 'quarantined', 'lane-lost', 'permit-lost', 'runtime-old']) {
    test(`MODELED live issuer entry rejection ${retry}/${status}`, t => {
      const f = setup(t); if (retry) f.queueRetry(); const req = f.issuer.issue(f); f.issuer.status = status;
      noWrites(f, req, StoreConflict);
    });
  }
  for (const edge of ['ready-1', 'ready', 'grant-1', 'deadline-1', 'deadline', 'deadline+1']) {
    test(`fixed grant/readiness/deadline boundary ${retry}/${edge}`, t => {
      const f = setup(t); if (retry) f.queueRetry(); const row = f.row();
      const proof = { permitGrantedAtMs: row.ready_at, admissionDeadlineMs: row.ready_at + 1000, runtimeGeneration: 1, assertCurrent() {} };
      const req = f.issuer.issue(f, row, { executionProof: proof });
      f.clock.value = edge === 'ready-1' ? row.ready_at - 1 : edge === 'grant-1' ? row.ready_at - 1
        : edge === 'ready' ? row.ready_at : row.ready_at + 1000 + ({ 'deadline-1': -1, deadline: 0, 'deadline+1': 1 }[edge]);
      if (edge === 'ready' || edge === 'deadline-1') assert.equal(f.admit(req).kind, 'admitted');
      else noWrites(f, req, { kind: 'deferred', reason: retry ? 'retry-admission' : 'execution-admission',
        prerequisite: edge.endsWith('-1') && edge !== 'deadline-1' ? 'not-ready' : 'permit-not-current' });
    });
  }
  for (const fault of ['owner', 'issuer', 'deadline', 'clock-back', 'job', 'receipt', 'throw']) {
    test(`post-CAS ${retry}/${fault} leaves zero committed changes`, t => {
      const f = setup(t); if (retry) f.queueRetry(); const req = f.issuer.issue(f), before = state(f.db);
      const seams = { afterExecutionCas() {
        if (fault === 'owner') f.held = false;
        if (fault === 'issuer') f.issuer.status = 'revoked';
        if (fault === 'deadline') f.clock.value = req.executionProof.admissionDeadlineMs;
        if (fault === 'clock-back') f.clock.value--;
        if (fault === 'job') f.db.prepare('UPDATE cron_jobs SET enabled=0').run();
        if (fault === 'receipt') f.db.prepare('UPDATE cron_runs SET started_at=started_at+1 WHERE run_id=?').run(f.id);
        if (fault === 'throw') throw new Error('injected');
      } };
      const store = new CronStore(f.db, f.clock, seams, f.issuer.port(f.db));
      assert.throws(() => f.admit(req, store)); assert.deepEqual(state(f.db), before); assert.equal(f.db.inTransaction, false);
    });
  }
  for (const field of ['phase','started_at','ended_at','completion','history_state','reason','error','thread_id','turn_id','model','usage_json','summary','lane_wait_ms','segments_sent','delivery_state']) {
    test(`SEEDED INVALID queued lifecycle ${retry}/${field}: zero DML`, t => {
      const f = setup(t); if (retry) f.queueRetry();
      const value = field === 'phase' ? 'admission' : field === 'segments_sent' ? 1 : field === 'delivery_state' ? 'started'
        : ['started_at','ended_at','lane_wait_ms'].includes(field) ? f.clock.value : field === 'completion' ? 'unknown' : 'corrupt';
      f.db.prepare(`UPDATE cron_runs SET ${field}=? WHERE run_id=?`).run(value, f.id);
      noWrites(f, f.issuer.issue(f), StoreIntegrityError);
    });
  }
  for (const field of ['jobId','creatorAuthorized','targetAuthorized','ownerIncarnation','resetGeneration','definition','policy']) {
    test(`SEEDED issuer envelope binding mismatch ${retry}/${field}`, t => {
      const f = setup(t); if (retry) f.queueRetry(); const r = f.issuer.issue(f);
      const a = { ...r.authority, [field]: field === 'definition' ? { ...r.authority.definition, creatorUid: 'foreign' }
        : field === 'policy' ? { tools: 'doc-task' } : field.endsWith('Authorized') ? false : field === 'resetGeneration' ? 3 : 'foreign' };
      noWrites(f, f.issuer.issue(f, f.row(), { authority: a }), StoreConflict);
    });
  }
}
for (const mutation of ['missing-base','base-start','base-end','base-ready','base-phase','base-completion','base-publication','missing-W','invalid-W','snapshot','ready','reset','owner','activation']) {
  test(`SEEDED INVALID retained retry evidence ${mutation}`, t => {
    const f = setup(t); f.queueRetry();
    const sql = {
      'missing-base': "DELETE FROM cron_runs WHERE attempt=0", 'base-start': 'UPDATE cron_runs SET started_at=NULL WHERE attempt=0',
      'base-end': 'UPDATE cron_runs SET ended_at=NULL WHERE attempt=0', 'base-ready': 'UPDATE cron_runs SET started_at=ready_at-1 WHERE attempt=0',
      'base-phase': "UPDATE cron_runs SET phase='executing' WHERE attempt=0", 'base-completion': "UPDATE cron_runs SET completion='succeeded' WHERE attempt=0",
      'base-publication': "UPDATE cron_runs SET history_state='published' WHERE attempt=0", 'missing-W': 'UPDATE cron_jobs SET last_slot_watermark=NULL',
      'invalid-W': "UPDATE cron_jobs SET last_slot_watermark='invalid'", snapshot: "UPDATE cron_runs SET definition_snapshot_json=json_set(definition_snapshot_json,'$.policy.tools','doc-task') WHERE attempt=0",
      ready: 'UPDATE cron_runs SET ready_at=ready_at+1 WHERE attempt=1', reset: 'UPDATE cron_runs SET reset_generation=3 WHERE attempt=0',
      owner: "UPDATE cron_runs SET owner_incarnation='old-owner' WHERE attempt=0", activation: 'UPDATE cron_jobs SET schedule_activated_at=schedule_activated_at+7200000',
    }[mutation];
    f.db.prepare(sql).run(); noWrites(f, f.issuer.issue(f), StoreIntegrityError);
  });
}
for (const offset of [-1,0,1]) test(`OD39 natural boundary offset=${offset}`, t => {
  const f = setup(t); f.queueRetry(); f.clock.value = f.reservation.slot + 3600000 + offset;
  const req = f.issuer.issue(f);
  if (offset < 0) assert.equal(f.admit(req).kind, 'admitted');
  else noWrites(f, req, { kind: 'deferred', reason: 'queued-retry-supersession', activeRunId: f.id, recheckAfterMs: 30000 });
});
test('retained lower base reservation survives later overlap watermark/cadence', t => {
  const f = setup(t); const expected = f.row(); f.clock.value += 3600000;
  const current = f.store.get(scope, f.job.id);
  const overlap = f.store.admitBase(scope, f.job.id, { ...f.reservation, slot: f.clock.value, runId: 'overlap' });
  assert.equal(overlap.kind, 'overlap'); const before = f.store.get(scope, f.job.id);
  assert.equal(f.admit(f.issuer.issue(f, expected)).kind, 'admitted'); assert.deepEqual(f.store.get(scope, f.job.id), before);
  assert.ok(before.last_slot_watermark > expected.authored_slot); assert.ok(current.next_run_at <= before.next_run_at);
});
for (const mutation of ['disabled','deleted','generation']) test(`SEEDED job mutation ${mutation} refuses execution`, t => {
  const f = setup(t); const req = f.issuer.issue(f);
  f.db.prepare(mutation === 'disabled' ? 'UPDATE cron_jobs SET enabled=0' : mutation === 'deleted'
    ? 'UPDATE cron_jobs SET deleted_at=1' : 'UPDATE cron_jobs SET generation=generation+1').run();
  noWrites(f, req, mutation === 'deleted' ? JobNotFound : StoreConflict);
});
for (const retry of [false,true]) for (const method of ['promise-prepare','promise-guard','no-guard','missing-proof','missing-authority']) {
  test(`reject unsupported asynchronous/missing proof ${retry}/${method}`, t => {
    const f = setup(t); if (retry) f.queueRetry(); const req = f.issuer.issue(f);
    if (method === 'missing-proof') delete req.executionProof;
    if (method === 'missing-authority') delete req.authority;
    const verifier = method === 'promise-prepare' ? { prepare: () => Promise.resolve({ assertCurrent() {} }) }
      : method === 'promise-guard' ? { prepare: () => ({ assertCurrent: () => Promise.resolve() }) }
      : method === 'no-guard' ? { prepare: () => ({}) } : f.issuer.port(f.db);
    noWrites(f, req, method.startsWith('missing') ? { kind:'deferred',reason:retry?'retry-admission':'execution-admission',prerequisite:'proof-missing' } : TypeError, { verifier });
  });
}
for (const retry of [false,true]) test(`two connections: one CAS; busy loser re-reads existing ${retry}`, t => {
  const f = setup(t); if (retry) f.queueRetry(); const db2 = f.connect(), req = f.issuer.issue(f);
  const store2 = new CronStore(db2, f.clock, {}, f.issuer.port(db2));
  const store1 = new CronStore(f.db, f.clock, { afterExecutionCas() { assert.throws(() => f.admit(req, store2), { code:'SQLITE_BUSY' }); } }, f.issuer.port(f.db));
  const j = f.store.get(scope,f.job.id), win = f.admit(req,store1); assert.equal(win.kind,'admitted');
  assert.deepEqual(f.admit(req,store2),{kind:'existing',run:win.run}); assert.deepEqual(f.store.get(scope,f.job.id),j);
});
for (const count of [1,8,9,10]) test(`real retry execution retains mandatory error notice gate prior=${count}`, t => {
  const f=setup(t); f.queueRetry(); assert.equal(f.admit().kind,'admitted');
  // Controlled aggregate boundary fixture; execution states above came only from public APIs.
  f.db.prepare('UPDATE cron_jobs SET consecutive_errors=?').run(count);
  const before=state(f.db); assert.deepEqual(f.finish({kind:'failure',reason:'network'},{retryRunId:'retry2'}),
    {kind:'deferred',reason:count>=9?'disable-notice-required':'alert-intent-required'}); assert.deepEqual(state(f.db),before);
});
for (const retry of [false,true]) for (const point of ['before','after-cas','committed']) for (const mode of ['exit','kill']) {
  test(`actual ${mode}/WAL admission ${retry}/${point}`, t => {
    const f=setup(t); if(retry)f.queueRetry(); f.db.pragma('journal_mode=WAL'); const before=state(f.db);
    const child=fileURLToPath(new URL('./execution-crash-child.mjs',import.meta.url));
    const r=spawnSync(process.execPath,['--import',fileURLToPath(new URL('./register.mjs',import.meta.url)),child,
      f.path, f.id, String(f.clock.value), point, mode],{env:process.env,encoding:'utf8',timeout:10000});
    assert.equal(r.error,undefined); if(mode==='kill')assert.equal(r.signal,'SIGKILL');else assert.equal(r.status,79,r.stderr);
    const reopened=f.connect(), after=state(reopened); assert.deepEqual(after.jobs,before.jobs);
    if(point==='committed'){
      const current=after.runs.find(x=>x.run_id===f.id); const original=before.runs.find(x=>x.run_id===f.id);
      assert.deepEqual(current,{...original,status:'running',phase:'executing',started_at:f.clock.value});
      assert.equal(f.admit(f.issuer.issue(f,original)).kind,'existing');
    }else assert.deepEqual(after,before);
  });
}

for (const retry of [false,true]) {
  for (const field of ['permitGrantedAtMs','admissionDeadlineMs','runtimeGeneration','assertCurrent']) {
    test(`missing execution proof field defers ${retry}/${field}`, t => {
      const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f);delete req.executionProof[field];
      noWrites(f,req,{kind:'deferred',reason:retry?'retry-admission':'execution-admission',prerequisite:'proof-missing'});
    });
  }
  for (const field of ['jobId','definition','creatorAuthorized','targetAuthorized','ownerIncarnation','resetGeneration','policy']) {
    test(`missing authority binding defers ${retry}/${field}`, t => {
      const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f);delete req.authority[field];
      noWrites(f,req,{kind:'deferred',reason:retry?'retry-admission':'execution-admission',prerequisite:'proof-missing'});
    });
  }
  for (const field of ['permitGrantedAtMs','admissionDeadlineMs','runtimeGeneration']) for (const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    test(`malformed proof number ${retry}/${field}/${value}`, t => {
      const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f);req.executionProof[field]=value;
      noWrites(f,req,field==='runtimeGeneration'?TypeError:RangeError);
    });
  }
  for (const budget of [999,1000,1800000,1800001,0]) test(`fixed admission budget bound ${retry}/${budget}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const row=f.row(),req=f.issuer.issue(f,row,{executionProof:{permitGrantedAtMs:f.clock.value,
      admissionDeadlineMs:f.clock.value+budget,runtimeGeneration:1,assertCurrent(){}}});
    if(budget===1000||budget===1800000)assert.equal(f.admit(req).kind,'admitted');else noWrites(f,req,RangeError);
  });
  for (const field of ['run_id','owner_incarnation','reset_generation','occurrence_id','ready_at','queued_at','definition_snapshot_json','admitted_generation']) {
    test(`foreign exact expected receipt ${retry}/${field} is not a grant`, t => {
      const f=setup(t);if(retry)f.queueRetry();const row=f.row(),e=terminalExpectation(row),altered={...e,[field]:typeof e[field]==='number'?e[field]+1:'foreign'};
      const req=f.issuer.issue(f,row,{expected:altered});
      noWrites(f,req,field==='run_id'?{kind:'miss'}:{kind:'miss',run:row});
    });
  }
  for (const field of ['ownerIncarnation','resetGeneration']) test(`foreign ownership field ${retry}/${field}`, t => {
    const f=setup(t);if(retry)f.queueRetry();f.issuer.issue(f);const ownership={...f.owner,[field]:field==='ownerIncarnation'?'foreign':3};
    noWrites(f,f.issuer.issue(f,f.row(),{ownership}),{kind:'miss',run:f.row()});
  });
  test(`missing scope does not disclose receipt ${retry}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f);
    noWrites(f,req,JobNotFound,{call:s=>retry?s.admitRetry({targetSession:'foreign'},f.job.id,req):s.startBase({targetSession:'foreign'},f.job.id,req)});
  });
  test(`entry owner loss is zero DML ${retry}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f);f.held=false;noWrites(f,req,StoreConflict);
  });
  test(`nested caller transaction rejects before issuer resolution ${retry}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f),count=f.issuer.prepareCalls;f.db.exec('BEGIN');
    assert.throws(()=>f.admit(req),StoreConflict);assert.equal(f.issuer.prepareCalls,count);assert.equal(f.db.inTransaction,true);f.db.exec('ROLLBACK');
  });
  test(`grant from the future is not current ${retry}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const row=f.row();const req=f.issuer.issue(f,row,{executionProof:{
      permitGrantedAtMs:f.clock.value+1,admissionDeadlineMs:f.clock.value+1001,runtimeGeneration:1,assertCurrent(){}}});
    noWrites(f,req,{kind:'deferred',reason:retry?'retry-admission':'execution-admission',prerequisite:'permit-not-current'});
  });
  test(`frozen envelope survives caller mutation during CAS ${retry}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const before=f.row(),req=f.issuer.issue(f,before,{expected:{...terminalExpectation(before)}});
    const store=new CronStore(f.db,f.clock,{beforeExecutionCas(){req.expected.run_id='foreign';req.executionProof.admissionDeadlineMs++;req.authority.policy.tools='doc-task';}},f.issuer.port(f.db));
    const r=f.admit(req,store);assert.equal(r.kind,'admitted');assert.equal(r.run.run_id,before.run_id);
    assert.equal(r.run.definition_snapshot_json,before.definition_snapshot_json);
  });
  test(`Promise fault seam rolls back ${retry}`, t => {
    const f=setup(t);if(retry)f.queueRetry();const before=state(f.db),store=new CronStore(f.db,f.clock,{afterExecutionCas:()=>Promise.resolve()},f.issuer.port(f.db));
    assert.throws(()=>f.admit(f.issuer.issue(f),store),TypeError);assert.deepEqual(state(f.db),before);
  });
}
test('internal verifier with no grant has no permissive fallback',t=>{
  const f=setup(t);noWrites(f,f.issuer.issue(f),{kind:'deferred',reason:'execution-admission',prerequisite:'issuer-unavailable'},{verifier:{prepare(){}}});
});
test('accessor proof cannot change grant fields after validation',t=>{
  const f=setup(t),req=f.issuer.issue(f);Object.defineProperty(req.executionProof,'admissionDeadlineMs',{get:()=>f.clock.value+1000,enumerable:true});
  noWrites(f,req,TypeError);
});
for(const ownership of ['borrow','none'])test(`SEEDED valid manual ${ownership} cannot use base execution entry`,t=>{
  const f=setup(t),r=f.row(),occurrence='manual:12345678-1234-4234-8234-123456789abc',snap={...JSON.parse(r.definition_snapshot_json),
    occurrenceId:occurrence,manualMode:'force',scheduleOwnership:ownership,authoredOccurrenceId:null,authoredSlot:null};
  f.db.prepare("UPDATE cron_runs SET trigger='manual',manual_mode='force',schedule_ownership=?,occurrence_id=?,authored_occurrence_id=NULL,authored_slot=NULL,scheduled_for=NULL,definition_snapshot_json=?")
    .run(ownership,occurrence,JSON.stringify(snap));
  noWrites(f,f.issuer.issue(f),StoreConflict);
});
test('retry accepts higher retained W without another consumption/counter/cadence write',t=>{
  const f=setup(t);f.queueRetry();f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=last_slot_watermark+3600000').run();
  const before=f.store.get(scope,f.job.id);assert.equal(f.admit().kind,'admitted');assert.deepEqual(f.store.get(scope,f.job.id),before);
});
test('post-CAS predecessor corruption is rolled back with the new running receipt',t=>{
  const f=setup(t);f.queueRetry();const before=state(f.db),store=new CronStore(f.db,f.clock,{afterExecutionCas(){
    f.db.prepare('UPDATE cron_runs SET started_at=NULL WHERE attempt=0').run();}},f.issuer.port(f.db));
  assert.throws(()=>f.admit(f.issuer.issue(f),store),StoreIntegrityError);assert.deepEqual(state(f.db),before);
});
function seededAdmissionChain(t) {
  const f=setup(t,{schedule:{kind:'at',atMs:now+60000}});f.queueRetry();
  for(let k=1;k<3;k++){
    assert.equal(f.admit().kind,'admitted');
    // SEEDED admission-wait phase: the ready-only API does not implement waiting.
    f.db.prepare("UPDATE cron_runs SET phase='admission' WHERE run_id=?").run(f.id);f.clock.value++;
    assert.equal(f.finish({kind:'failure',reason:'session-busy'},{retryRunId:`retry${k+1}`}).kind,'finalized');
    f.db.prepare('UPDATE cron_runs SET started_at=NULL WHERE run_id=?').run(f.id);
    f.id=`retry${k+1}`;f.clock.value=f.row().ready_at;
  }
  return f;
}
for(const position of [0,1,2])for(const corruption of ['start','end','phase','ready','completion','reason'])test(`SEEDED base/intermediate lifecycle ${position}/${corruption}`,t=>{
  const f=seededAdmissionChain(t),r=f.db.prepare('SELECT * FROM cron_runs WHERE attempt=?').get(position);
  const patch=corruption==='start'?(position===0?{started_at:null}:{status:'error',reason:'network',completion:'failed',started_at:null})
    :corruption==='end'?{ended_at:null}:corruption==='phase'?{phase:'executing'}:corruption==='ready'?{ready_at:r.ready_at+1}
    :corruption==='completion'?{completion:'unknown'}:{reason:'auth'};
  const keys=Object.keys(patch);f.db.prepare(`UPDATE cron_runs SET ${keys.map(k=>k+'=?').join(',')} WHERE attempt=?`).run(...keys.map(k=>patch[k]),position);
  noWrites(f,f.issuer.issue(f),StoreIntegrityError);
});
test('SEEDED valid nullable-start session-busy predecessors permit retry3 without weakening P2',t=>{
  const f=seededAdmissionChain(t);assert.equal(f.admit().kind,'admitted');
  const before=f.store.get(scope,f.job.id);assert.equal(before.consecutive_errors,1);
  assert.equal(f.finish({kind:'success',deliveryState:'not-requested'}).kind,'finalized');
  assert.equal(f.store.get(scope,f.job.id).consecutive_errors,0);
});
for(const at of [false,true])test(`unseeded permanent failure keeps mandatory finalization gate at=${at}`,t=>{
  const f=setup(t,at?{schedule:{kind:'at',atMs:now+60000}}:{});assert.equal(f.admit().kind,'admitted');const before=state(f.db);
  const r=f.finish({kind:'failure',reason:'auth'});assert.equal(r.kind,at?'deferred':'finalized');
  if(at){assert.equal(r.reason,'disable-notice-required');assert.deepEqual(state(f.db),before);}
});
for(const terminal of [false,true])test(`repeated admission validates retained P2 lifecycle terminal=${terminal}`,t=>{
  const f=setup(t);f.queueRetry();const req=f.issuer.issue(f);assert.equal(f.admit(req).kind,'admitted');
  if(terminal)assert.equal(f.finish({kind:'success',deliveryState:'not-requested'}).kind,'finalized');
  f.db.prepare('UPDATE cron_runs SET started_at=NULL WHERE attempt=0').run();noWrites(f,req,StoreIntegrityError);
});
test('base replay after its terminal failure validates the complete successor chain',t=>{
  const f=setup(t),req=f.issuer.issue(f);f.queueRetry();f.id='base';
  noWrites(f,req,{kind:'existing',run:f.row()});
});
for(const retry of [false,true])test(`admission writes exactly one receipt CAS and no job effects ${retry}`,t=>{
  const f=setup(t);if(retry)f.queueRetry();const req=f.issuer.issue(f),writes=[];
  const proxy={get inTransaction(){return f.db.inTransaction;},exec:sql=>f.db.exec(sql),prepare(sql){const s=f.db.prepare(sql);
    return {get:(...a)=>s.get(...a),all:(...a)=>s.all(...a),run(...a){if(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))writes.push(sql);return s.run(...a);}};}};
  const store=new CronStore(proxy,f.clock,{},f.issuer.port(f.db));const j=f.store.get(scope,f.job.id);
  assert.equal(f.admit(req,store).kind,'admitted');assert.equal(writes.length,1);assert.match(writes[0],/^UPDATE cron_runs SET status='running',phase='executing',started_at=/);
  assert.deepEqual(f.store.get(scope,f.job.id),j);
});
test('unseeded base failure callback does not repeat counters/W/successor',t=>{
  const f=setup(t),run=f.admit().run,expected=terminalExpectation(run);
  const request={expected,ownership:f.owner,outcome:{kind:'failure',reason:'network'},retryRunId:'retry1'};
  assert.equal(f.store.finalize(scope,f.job.id,request).kind,'finalized');const before=state(f.db);
  assert.equal(f.store.finalize(scope,f.job.id,{...request,retryRunId:'unwanted'}).kind,'existing');
  assert.deepEqual(state(f.db),before);assert.equal(before.jobs[0].consecutive_errors,1);assert.equal(before.runs.length,2);
});
test('SEEDED competing definition writer: busy admission then stale-generation rejection',t=>{
  const f=setup(t),req=f.issuer.issue(f),db2=f.connect();
  db2.exec('BEGIN IMMEDIATE');db2.prepare('UPDATE cron_jobs SET generation=generation+1').run();
  assert.throws(()=>f.admit(req),{code:'SQLITE_BUSY'});db2.exec('COMMIT');
  noWrites(f,req,StoreConflict);
});
