import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,renameSync,writeFileSync,unlinkSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {completionStack} from './completion-fixture.mjs';
import {state,reset,assertClean} from './host-fixture.mjs';
import {clean,trace} from './lifecycle-fixture.mjs';
const Native=createRequire(import.meta.url)(process.env.HOST_SQLITE);
const open=f=>new Native(join(f.dir,'cc-octo.db'),{nativeBinding:join(process.env.HOST_SQLITE,'build/Release/better_sqlite3.node')});
const sql=(f,q,...p)=>{const db=open(f);try{return db.prepare(q).all(...p)}finally{db.close()}};
const input=(f,seq=1)=>({sessionKey:'member',principalUid:'member',channelId:'channel-member',channelType:1,messageId:'review-'+seq,messageSeq:seq});
async function fixture(kind,extra={}){
 reset();state.send=async()=>({});const permit={allowed:true};
 const issuer={prepare(i,s){const g=state.stores.at(-1).getResetGeneration(i.sessionKey);return {ready:Object.fromEntries(['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects'].map(k=>[k,true])),assertCurrent(){if(!permit.allowed)throw Error('review revoked')},request:{sessionKey:i.sessionKey,laneKey:'new:'+i.sessionKey,laneDeadlineMs:Date.now()+20000,ctx:{incarnationId:s.incarnationId,origin:'chat',principal:{uid:i.principalUid,role:'member'},session:{sessionKey:i.sessionKey,resetGeneration:g,channelId:i.channelId,channelType:i.channelType},policy:{tools:'none'},delivery:{logicalOrigin:i.messageId}}}}}};
 const f=await completionStack(kind,{setup:{...extra,issuer}});return {...f,permit};
}
const capture=f=>f.stack.execution.withCompletion(input(f),async s=>s.state);
for(const kind of ['sdk','app-server'])test(`independent ${kind} reentrant compound history and mapping rollback latches old turn`,async()=>{
 const f=await fixture(kind);
 try{
  const turn=await capture(f);turn.create('channel-member',1);turn.mapping('old',()=>f.store.setConversationDocumentSignature('member','old','before'));
  const start=state.events.length;
  assert.throws(()=>turn.write(()=>{turn.user('rolled user');turn.assistant('rolled assistant');turn.mapping('new',()=>f.store.setConversationDocumentSignature('member','new','rolled signature'));f.permit.allowed=false}),e=>e.name==='HostExecutionRefusal');
  assert.equal(sql(f,'SELECT count(*) n FROM messages')[0].n,0);
  assert.equal(sql(f,'SELECT sdk_session_id FROM sdk_sessions')[0].sdk_session_id,'old');
  assert.equal(sql(f,'SELECT signature FROM conversation_document_state')[0].signature,'before');
  assert.ok(state.events.slice(start).some(e=>e.name==='sql-result'&&e.sql.startsWith('INSERT INTO messages')));
  assert.ok(state.events.slice(start).some(e=>e.name==='transaction-rolled-back'));
  f.permit.allowed=true;assert.throws(()=>turn.user('latch must refuse'));
  const next=await capture(f);next.user('committed next');assert.equal(sql(f,'SELECT content FROM messages')[0].content,'committed next');
  trace({phase:'review-compound-SQL-rollback',kind,events:state.events.slice(start)});
 }finally{await f.close()}
});
for(const kind of ['sdk','app-server'])test(`independent ${kind} lease replaced inside mapping callback rolls back attempted SQL and stays invalid`,async()=>{
 const f=await fixture(kind);let moved=false;
 try{
  const turn=await capture(f);turn.create('channel-member',1);turn.mapping('old');
  const lock=join(f.dir,'gateway.lock'),saved=readFileSync(lock),start=state.events.length;
  assert.throws(()=>turn.mapping('rejected',()=>{f.store.setConversationDocumentSignature('member','rejected','reject');renameSync(lock,lock+'.review-held');writeFileSync(lock,saved);moved=true}),/Bot ownership lock was replaced or invalidated/);
  assert.equal(sql(f,'SELECT sdk_session_id FROM sdk_sessions')[0].sdk_session_id,'old');
  assert.equal(sql(f,'SELECT signature FROM conversation_document_state')[0].signature,null);
  assert.ok(state.events.slice(start).some(e=>e.name==='sql-result'&&e.sql.startsWith('INSERT INTO sdk_sessions')));
  assert.ok(state.events.slice(start).some(e=>e.name==='transaction-rolled-back'));
  unlinkSync(lock);renameSync(lock+'.review-held',lock);assert.throws(()=>turn.assistant('must refuse restored bytes'));
  await assert.rejects(f.stack.shutdown(),e=>e.reason==='ownership-lost');assert.equal(state.dbs.size,1);
  trace({phase:'review-reentrant-lease-rollback',kind,events:state.events.slice(start),noNativeChild:f.peers.length===0});
 }finally{
  if(moved){await f.stack.shutdown().catch(()=>{});for(const db of state.dbs)db.close();state.dbs.clear();for(const t of state.timers)clearInterval(t);state.timers.clear();clean(f.dir);assertClean(assert)}else await f.close();
 }
});
test('independent actual SDK rejected resume clearing preserves mapping and refuses fresh retry',async()=>{
 let resumed=0,fresh=0,freshRuns=0,freshDrivers=0,sends=0;
 const f=await fixture('sdk',{sdkFactory:()=>({resumeThread:()=>({runStreamed:async()=>{resumed++;throw Error('thread not found: stale')}}),startThread:()=>{fresh++;return {runStreamed:async()=>{freshRuns++;return {events:(async function*(){freshDrivers++;yield {type:'thread.started',thread_id:'forbidden-fresh'};yield {type:'item.completed',item:{id:'late',type:'agent_message',text:'must not publish'}}})()}}}}})});
 try{
  f.store.setSdkSessionId('member','old-thread');const db=open(f);db.exec("CREATE TRIGGER review_clear BEFORE DELETE ON sdk_sessions BEGIN SELECT RAISE(ABORT,'review clear rejected'); END");db.close();
  state.send=async(name)=>{if(name==='sendMessage')sends++;return {}};
  await assert.rejects(f.handle(f.message(1)),/review clear rejected/);
  trace({phase:'review-clear-rejected-fresh-driver-observation',resumed,fresh,freshRuns,freshDrivers,sends,rows:sql(f,'SELECT * FROM sdk_sessions'),messages:sql(f,'SELECT role,content FROM messages'),events:state.events});
  assert.equal(resumed,1);assert.equal(freshDrivers,0,'rejected durable resume clearing must refuse before another SDK event driver enters');assert.equal(freshRuns,0,'rejected durable resume clearing must refuse before another SDK runStreamed');assert.equal(fresh,0);
  assert.equal(sql(f,'SELECT sdk_session_id FROM sdk_sessions')[0].sdk_session_id,'old-thread');assert.equal(sql(f,"SELECT count(*) n FROM messages WHERE role='assistant'")[0].n,0);
  trace({phase:'review-clear-refused-no-replay',resumed,fresh,events:state.events});
 }finally{await f.close()}
});
for(const kind of ['sdk','app-server'])test(`independent ${kind} assistant SQL rejection after accepted reply does not advance history cursor`,async()=>{
 const f=await fixture(kind);let accepted=0;
 try{
  const db=open(f);db.exec("CREATE TRIGGER review_assistant BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'review assistant rejected'); END");db.close();
  state.send=async(name,o)=>{if(name==='sendMessage'&&o.content==='ok')accepted++;return {}};
  await assert.rejects(f.handle(f.message(1)),/review assistant rejected/);assert.equal(accepted,1);assert.equal(f.starts.length,1);
  assert.equal(sql(f,"SELECT count(*) n FROM messages WHERE role='assistant'")[0].n,0);assert.equal(f.store.getLastBotReplySeq('member'),undefined);
  assert.equal(sql(f,'SELECT count(*) n FROM sdk_sessions')[0].n,1);
  trace({phase:'review-accepted-reply-history-refusal',kind,accepted,events:state.events});
 }finally{await f.close()}
});
test('independent current persistence native two generations close before DB fault and same-owner retry',async()=>{
 const {AppServerClient}=await import('../../dist/app-server/client.js');const clients=[];
 const f=await fixture('app-server',{appServerFactory(o){const c=new AppServerClient({...o,bin:process.execPath,args:[new URL('../foundation/bin/fake-app-server.mjs',import.meta.url).pathname]});clients.push(c);return c}});
 try{
  const lease=readFileSync(join(f.dir,'gateway.lock'),'utf8'),inode=statSync(join(f.dir,'cc-octo.db')).ino;
  for(const seq of [1,2]){
   await f.handle(f.message(seq));const c=clients.at(-1),childRecord=JSON.parse(readFileSync(join(f.dir,'app-server-child.json'),'utf8'));
   trace({phase:'review-native-running',node:process.version,abi:process.versions.modules,pid:c.pid,lease,inode,childRecord});
   if(seq===1){await c.close({graceMs:0});trace({phase:'review-native-first-collected',pid:c.pid,state:c.state,exit:c.exitInfo})}
  }
  assert.equal(clients.length,2);
  state.hook=name=>{if(name==='db-close'){assert.ok(clients.every(c=>c.state==='closed'&&c.exitInfo));const record=JSON.parse(readFileSync(join(f.dir,'app-server-child.json'),'utf8'));assert.equal(record.state,'exited');trace({phase:'review-native-at-db-close',record,lease:readFileSync(join(f.dir,'gateway.lock'),'utf8'),clients:clients.map(c=>({pid:c.pid,state:c.state,exit:c.exitInfo})),incarnations:sql(f,'SELECT * FROM bot_incarnations')})}};
  state.fail='db-close';await assert.rejects(f.stack.shutdown(),/db-close/);assert.equal(state.dbs.size,1);assert.equal(readFileSync(join(f.dir,'gateway.lock'),'utf8'),lease);assert.equal(statSync(join(f.dir,'cc-octo.db')).ino,inode);
  trace({phase:'review-native-db-fault-retained',sameLease:true,dbOpen:state.dbs.size,inode});state.fail='';await f.stack.shutdown();
  const db=open(f);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');db.close();assert.equal(existsSync(join(f.dir,'gateway.lock')),false);assert.equal(existsSync(join(f.dir,'cc-octo.db-wal')),false);assert.equal(existsSync(join(f.dir,'cc-octo.db-shm')),false);
  trace({phase:'review-native-retry-collected',inode:statSync(join(f.dir,'cc-octo.db')).ino,integrity:'ok',sameInode:statSync(join(f.dir,'cc-octo.db')).ino===inode});
 }finally{state.fail='';state.hook=null;await f.close()}
});
test('independent actual SDK accepted work cannot fresh replay after a stale-worded persistence refusal',async()=>{
 let acceptedRuns=0,inertEffects=0,resumed=0,fresh=0,sends=0;
 const driver=(id,isFresh)=>({runStreamed:async()=>({events:(async function*(){acceptedRuns++;if(isFresh)inertEffects++;yield {type:'thread.started',thread_id:id};inertEffects++;yield {type:'item.completed',item:{id:'owned-command',type:'command_execution',command:'inert owned operation',status:'completed',exit_code:0,aggregated_output:''}};})()})});
 const f=await fixture('sdk',{sdkFactory:()=>({resumeThread:()=>{resumed++;return driver('old-thread',false)},startThread:()=>{fresh++;return driver('fresh-thread',true)}})});
 try{
  f.store.setSdkSessionId('member','old-thread');const db=open(f);db.exec("CREATE TRIGGER review_mapping_stale BEFORE INSERT ON sdk_sessions BEGIN SELECT RAISE(ABORT,'thread not found: owned persistence refusal'); END");db.close();
  state.send=async(name)=>{if(name==='sendMessage')sends++;return {}};
  await assert.rejects(f.handle(f.message(1)),/owned persistence refusal/);
  trace({phase:'review-accepted-SDK-store-refusal-replay',acceptedRuns,inertEffects,resumed,fresh,sends,rows:sql(f,'SELECT * FROM sdk_sessions'),messages:sql(f,'SELECT role,content FROM messages'),events:state.events});
  assert.equal(acceptedRuns,1,'already accepted SDK work must not be fresh replayed after the store latched refusal');assert.equal(fresh,0);assert.equal(inertEffects,1);
 }finally{await f.close()}
});
