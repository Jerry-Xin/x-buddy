// SPDX-License-Identifier: Apache-2.0
// Observe the actual handler/router/store; replace only external sends and RPC.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { state, config, reset, assertClean } from './host-fixture.mjs';
import { Peer, deferred, tick, FakeClock } from './helpers.mjs';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { clean, trace } from './lifecycle-fixture.mjs';
const root=resolve(import.meta.dirname,'../..');
registerHooks({resolve(spec,context,next){
  if(spec==='./session-router.js'&&context.parentURL?.startsWith(pathToFileURL(join(root,'src/host/index.ts')).href))
    return next(pathToFileURL(join(root,'src/host/session-router.ts')).href+'?completion-real',context);
  return next(spec,context);
}});
const {SessionStore}=await import('../../src/host/session-store.ts?host-real');
for(const name of ['buildSegmentedHistoryPrefix','appendAssistant','appendUser','setSdkSessionId','clearSdkSessionId','deleteSession']){
  const original=SessionStore.prototype[name];
  SessionStore.prototype[name]=function(...args){state.event('store-'+name,{sessionKey:args[0],value:args[1]});return original.apply(this,args)};
}
export async function completionStack(kind,extra={}){
  const {startBot,handleMessage}=await import('../../src/host/index.ts');
  const {StreamRelay}=await import('../../src/host/stream-relay.ts');
  const dir=mkdtempSync(join(tmpdir(),'completion-owned-'));const cfg={...config(dir,extra.botId??'completion-bot'),dispatchTimeoutMs:5,rateLimit:{maxPerMinute:1000},context:{maxContextChars:1000,historyLimit:40},...extra.config};
  const generations=new Map(),controllers=new Map(),starts=[],peers=[];
  const controller=session=>{if(!controllers.has(session))controllers.set(session,new AbortController());return controllers.get(session)};
  const now=extra.clock?()=>extra.clock.now():()=>Date.now();
  const setup={env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CODEX_OCTO_EXECUTOR:kind},bin:process.execPath,clientInfo:{name:'inert-completion',title:null,version:'0'},now,
    issuer:{prepare(input,scope){const generation=generations.get(input.sessionKey)??0;return {ready:Object.fromEntries(['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects'].map(k=>[k,true])),assertCurrent(){assert.equal(generations.get(input.sessionKey)??0,generation)},request:{sessionKey:input.sessionKey,laneKey:'new:'+input.sessionKey,laneDeadlineMs:now()+(extra.admissionMs??10000),signal:controller(input.sessionKey).signal,ctx:{incarnationId:scope.incarnationId,origin:'chat',principal:{uid:input.principalUid,role:'member'},session:{sessionKey:input.sessionKey,resetGeneration:generation,channelId:input.channelId,channelType:input.channelType},policy:{tools:'none'},delivery:{logicalOrigin:input.messageId}}}}}},
    runtime:{getResetGeneration:key=>generations.get(key)??0,...(extra.clock?{clock:extra.clock.asClock()}: {})},
    sdkFactory(){const thread=(id='sdk-session')=>({runStreamed:async prompt=>{starts.push(prompt);state.event('executor-start',{kind,prompt});return {events:(async function*(){yield {type:'thread.started',thread_id:id};yield {type:'item.completed',item:{id:'message',type:'agent_message',text:extra.text??'ok'}};yield {type:'turn.completed',usage:{}}})()}}});return {startThread:()=>thread(),resumeThread:id=>thread(id)}},
    appServerFactory(options){assert.equal(options.lifecycle.lock.dataDir,dir);const peer=new Peer(extra.scenario??(extra.text?{defaultTurn:[{notify:'item/completed',params:{threadId:'$threadId',turnId:'$turnId',item:{id:'$itemId',type:'agentMessage',text:extra.text}}}]}:{}));peers.push(peer);const actual=peer.request.bind(peer);peer.request=(method,params,opts)=>{if(method==='turn/start'){starts.push(params.input[0].text);state.event('executor-start',{kind,prompt:params.input[0].text})}return actual(method,params,opts)};return peer},
    ...extra.setup,
  };
  const stack=await startBot(cfg,true,setup),store=state.stores.at(-1),relay=new StreamRelay();
  const message=(seq,session='member',content='hello')=>({from_uid:session,from_name:session,channel_id:'channel-'+session,channel_type:1,message_id:'message-'+session+'-'+seq,message_seq:seq,timestamp:seq,payload:{type:1,content},streamOn:false});
  return {stack,store,cfg,dir,starts,peers,generations,controllers,setup,message,handle:msg=>handleMessage(msg,cfg,store,stack.router,{},relay,stack.robotUid,stack.execution),gateway:state.gateways.at(-1),
    async close(checkAll=true){await stack.shutdown();if(checkAll)assertClean(assert);assert.equal(existsSync(join(dir,'gateway.lock')),false);clean(dir);trace({phase:'completion-cleanup',kind,directoryAbsent:!existsSync(dir),clientsClosed:peers.every(p=>p.state==='closed')})}};
}

const abortableHold=(signal,release)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  release.promise.then(()=>{signal.removeEventListener('abort',abort);resolve({})});
  if(signal.aborted)abort();
});
export async function resetPending(kind){
  reset();const entered=deferred(),release=deferred();let held=false;
  state.send=async(name,opts)=>{if(name==='sendMessage'){state.event('captured-send',{channel:opts.channelId,content:opts.content});if(opts.channelId==='channel-member'&&!held){held=true;entered.resolve();return abortableHold(opts.signal,release)}}return {}};
  const f=await completionStack(kind,{text:'x'.repeat(7100)});let a,b,other;
  try{
    a=f.handle(f.message(1));a.catch(()=>{});await entered.promise;
    b=f.handle(f.message(2));b.catch(()=>{});await delay(10);
    // This map is the existing injected trusted-generation test hook. It is
    // not a production CAS implementation, and observeReset performs no write.
    f.generations.set('member',1);state.event('trusted-generation-observed');
    await f.stack.execution.observeReset('member');
    await Promise.allSettled([a,b]);
    const fence=state.events.findIndex(e=>e.name==='trusted-generation-observed');
    assert.equal(state.events.slice(fence+1).filter(e=>e.name.startsWith('store-')&&['store-appendAssistant','store-setSdkSessionId','store-clearSdkSessionId'].includes(e.name)).length,0);
    assert.equal(state.events.filter(e=>e.name==='captured-send'&&e.channel==='channel-member'&&!e.content.startsWith('⚠️')).length,1,'no second pending segment after reset');
    assert.equal(f.starts.length,1,'queued old-generation work removed before model start');
    other=f.handle(f.message(3,'other'));await other;assert.equal(f.starts.length,2,'another session remains independent');
    await assert.rejects(f.handle(f.message(4,'member','/reset')),e=>e.status==='NO-WRITES'&&e.prerequisite==='reset-cas-unavailable');
    await assert.rejects(f.handle(f.message(5,'member','/new')),e=>e.status==='NO-WRITES'&&e.prerequisite==='reset-cas-unavailable');
    assert.equal(state.events.filter(e=>e.name==='store-deleteSession').length,0,'no fabricated reset producer');
    trace({phase:'reset-pending',kind,starts:f.starts.length,events:state.events});
  }finally{release.resolve();await Promise.allSettled([a,b,other].filter(Boolean));await f.close()}
}
export async function deliveryFailure(kind){
  reset();let sends=0;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&!opts.content.startsWith('⚠️')){sends++;state.event('unknown-send',{content:opts.content});throw Error('inert written request response lost')}return {}};
  const f=await completionStack(kind,{text:'x'.repeat(7100)});
  try{await f.handle(f.message(1));assert.equal(sends,1);assert.equal(f.starts.length,1);assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,0);trace({phase:'unknown-no-resend',kind,sends,events:state.events})}
  finally{await f.close()}
}
export async function shutdownPending(kind,hotreload=false){
  reset();const entered=deferred(),release=deferred();let held=false;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&opts.content==='ok'&&!held){held=true;state.event('shutdown-send-pending');entered.resolve();try{return await abortableHold(opts.signal,release)}finally{state.event('shutdown-send-collected')}}return {}};
  const f=await completionStack(kind);
  try{
    f.gateway.testHandler(f.message(1));await entered.promise;f.gateway.testHandler(f.message(2));await delay(10);
    state.hook=name=>{if(name==='db-close'){assert.ok(state.events.some(e=>e.name==='shutdown-send-collected'));assert.equal(f.starts.length,1);state.event('completion-before-db-close')}};
    if(hotreload){const {BotManager}=await import('../../src/host/bot-manager.ts');const manager=new BotManager(async()=>f.stack);await manager.addBot('owned');await manager.removeBot('owned')}
    else await f.stack.shutdown();
    const closed=state.events.findIndex(e=>e.name==='db-close');await tick();assert.equal(state.events.slice(closed+1).filter(e=>e.name==='store-appendAssistant'||e.name==='store-setSdkSessionId').length,0);
    trace({phase:hotreload?'hotreload-pending':'shutdown-pending',kind,events:state.events});
  }finally{state.hook=null;release.resolve();await f.close()}
}
export async function deliveryBudget(kind){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let calls=0;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&!opts.content.startsWith('⚠️')){calls++;if(calls===1){clock.advance(59000);return {}}entered.resolve();return abortableHold(opts.signal,release)}return {}};
  const f=await completionStack(kind,{text:'x'.repeat(7100),clock});let work;
  try{
    work=f.handle(f.message(1));await entered.promise;clock.advance(999);await tick();assert.equal(calls,2);clock.advance(1);await work;
    assert.equal(calls,2,'one absolute 60s budget, not a new budget per segment');assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,0);
    trace({phase:'delivery-absolute-budget',kind,calls,monotonic:clock.monotonicNow(),events:state.events});
  }finally{release.resolve();await Promise.allSettled([work].filter(Boolean));await f.close();assert.equal(clock.pendingCount(),0)}
}
export async function queueBounds(kind){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let held=false;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&opts.content==='ok'&&!held){held=true;entered.resolve();return abortableHold(opts.signal,release)}return {}};
  const f=await completionStack(kind,{clock,admissionMs:100});const jobs=[];
  try{
    jobs.push(f.handle(f.message(1)));await entered.promise;
    for(let i=2;i<=4;i++){const p=f.handle(f.message(i));p.catch(()=>{});jobs.push(p)}
    await assert.rejects(f.handle(f.message(5)),e=>e.name==='LaneOverflowError');
    clock.advance(100);await tick();const queued=await Promise.allSettled(jobs.slice(1));assert.ok(queued.every(x=>x.status==='rejected'&&x.reason.prerequisite==='deadline'));assert.equal(f.starts.length,1);
    release.resolve();await jobs[0];trace({phase:'bounded-queue',kind,queued:queued.length,starts:f.starts.length});
  }finally{release.resolve();await Promise.allSettled(jobs);await f.close();assert.equal(clock.pendingCount(),0)}
}
export async function independentBots(kind){
  reset();const entered=deferred(),release=deferred();let held=false;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&opts.botToken==='completion-a'&&opts.content==='ok'&&!held){held=true;entered.resolve();return abortableHold(opts.signal,release)}return {}};
  const a=await completionStack(kind,{botId:'completion-a'}),b=await completionStack(kind,{botId:'completion-b'});let pending;
  try{pending=a.handle(a.message(1));await entered.promise;await b.handle(b.message(1));assert.equal(a.starts.length,1);assert.equal(b.starts.length,1);trace({phase:'independent-bots',kind,a:a.starts.length,b:b.starts.length});release.resolve();await pending}
  finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));const closed=await Promise.allSettled([a.close(false),b.close(false)]);assertClean(assert);assert.ok(closed.every(x=>x.status==='fulfilled'))}
}
export async function uncooperativeDelivery(kind){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let held=false;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&opts.content==='ok'&&!held){held=true;entered.resolve();await release.promise;state.event('uncooperative-send-collected')}return {}};
  const f=await completionStack(kind,{clock});let work,closing;
  try{
    work=f.handle(f.message(1));work.catch(()=>{});await entered.promise;
    closing=f.stack.shutdown();closing.catch(()=>{});await tick();clock.advance(10000);
    await assert.rejects(closing,e=>e.name==='HostCompletionDrainError');
    assert.equal(existsSync(join(f.dir,'gateway.lock')),true);assert.equal(state.dbs.size,1,'uncollected send retains the DB and same owner');
    assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,0);
    release.resolve();await tick();await Promise.allSettled([work]);await f.stack.shutdown();
    const send=state.events.findIndex(e=>e.name==='uncooperative-send-collected'),db=state.events.findIndex(e=>e.name==='db-close');assert.ok(send>=0&&send<db);
    trace({phase:'uncooperative-send-retention-retry',kind,send,db,events:state.events});
  }finally{release.resolve();await Promise.allSettled([work,closing].filter(Boolean));await tick();await f.close();assert.equal(clock.pendingCount(),0)}
}
export async function relayFormatting(kind){
  reset();const replies=[];
  state.send=async(name,opts)=>{if(name==='sendMessage'&&!opts.content.startsWith('⚠️')){const captured={...opts};delete captured.signal;replies.push(captured)}return {}};
  const text='start @[u:Name] @all '+('paragraph 😀\n'.repeat(650));
  const f=await completionStack(kind,{text});
  try{
    const {StreamRelay}=await import('../../src/host/stream-relay.ts');
    await new StreamRelay().deliver('channel-member',1,(async function*(){yield text})(),f.cfg.apiUrl,f.cfg.botToken);
    const expected=replies.splice(0);await f.handle(f.message(1));
    assert.deepEqual(replies,expected,'same existing mention/protected-range/split wire parameters');
    assert.ok(replies.length>1);assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,1);
    trace({phase:'existing-relay-format-contract',kind,segments:replies.length});
  }finally{await f.close()}
}
export async function activeCeiling(){
  reset();const clock=new FakeClock();let messages=0;
  state.send=async(name)=>{if(name==='sendMessage')messages++;return {}};
  const f=await completionStack('app-server',{clock,scenario:{defaultTurn:[{waitInterrupt:true}]}});let work;
  try{
    work=f.handle(f.message(1));
    for(let i=0;i<200&&!f.peers[0]?.server.requests('turn/start').length;i++)await tick();
    assert.equal(f.peers[0].server.requests('turn/start').length,1);
    clock.advance(1800000);await tick();await work;
    assert.equal(f.starts.length,1);assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,0);
    assert.ok(f.peers[0].server.requests('turn/interrupt').length>0);
    trace({phase:'actual-host-runtime-ceiling',messages,events:state.events});
  }finally{await Promise.allSettled([work].filter(Boolean));await f.close();assert.equal(clock.pendingCount(),0)}
}
export async function nativeCompletion(){
  reset();const entered=deferred(),release=deferred(),clients=[];let held=false;
  const {AppServerClient}=await import('../../dist/app-server/client.js');
  const peerBin=fileURLToPath(new URL('../foundation/bin/fake-app-server.mjs',import.meta.url));
  state.send=async(name,opts)=>{if(name==='sendMessage'&&held&&!opts.content.startsWith('⚠️')){entered.resolve();try{return await abortableHold(opts.signal,release)}finally{state.event('native-send-collected')}}return {}};
  const f=await completionStack('app-server',{setup:{appServerFactory(options){
    assert.equal(options.lifecycle,state.gateways.at(-1).testOwnership.lifecycle);
    const client=new AppServerClient({...options,args:[peerBin]});clients.push(client);return client;
  }}});let pending;
  try{
    await f.handle(f.message(1));await clients[0].close({graceMs:0});
    held=true;pending=f.handle(f.message(2,'other'));pending.catch(()=>{});await entered.promise;
    assert.equal(clients.length,2);const lease=readFileSync(join(f.dir,'gateway.lock'));
    state.hook=name=>{if(name==='db-close'){
      assert.ok(state.events.some(e=>e.name==='native-send-collected'));
      assert.ok(clients.every(c=>c.state==='closed'&&c.exitInfo));
      assert.equal(JSON.parse(readFileSync(join(f.dir,'app-server-child.json'))).state,'exited');
      state.event('native-generations-before-db');
    }};
    state.fail='db-close';await assert.rejects(f.stack.shutdown(),/db-close/);
    assert.deepEqual(readFileSync(join(f.dir,'gateway.lock')),lease);assert.equal(state.dbs.size,1);
    state.fail='';await f.stack.shutdown();await Promise.allSettled([pending]);
    trace({phase:'native-completion-generation-retry',clients:clients.map(c=>({pid:c.pid,state:c.state,exit:c.exitInfo})),events:state.events});
  }finally{state.fail='';state.hook=null;release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close()}
}
export async function abandonedReply(kind){
  reset();let sends=0;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&!opts.content.startsWith('⚠️'))sends++;return {}};
  const f=await completionStack(kind,{text:'first response',config:{maxResponseChars:1}});
  try{
    await f.handle(f.message(1));await f.handle(f.message(2));
    assert.equal(f.starts.length,2);assert.equal(sends,2,'truncating consumer settles once without resend or deadlock');
    assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,2);
    trace({phase:'host-truncated-consumer-collected',kind,sends,events:state.events});
  }finally{await f.close()}
}
export async function routerPublicationGap(kind){
  reset();const entered=deferred(),release=deferred(),delivered=deferred();let work;
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.content.startsWith('⚠️')){
      state.event('router-apology-pending',{hasSignal:!!opts.signal});entered.resolve();
      try {
        if(opts.signal) await abortableHold(opts.signal,release); else await release.promise;
        state.event('router-apology-published');
      } finally { delivered.resolve(); }
    }
    if(name==='sendMessage'&&opts.content==='ok')return abortableHold(opts.signal,release);
    return {};
  };
  const f=await completionStack(kind);
  try{
    work=f.handle(f.message(1));work.catch(()=>{});await entered.promise;
    f.generations.set('member',1);state.event('trusted-reset-before-router-reply');
    await f.stack.execution.observeReset('member');release.resolve();await delivered.promise;
    await Promise.allSettled([work]);
    const fence=state.events.findIndex(e=>e.name==='trusted-reset-before-router-reply');
    trace({phase:'blocked-router-publication',kind,events:state.events});
    assert.equal(state.events.slice(fence+1).filter(e=>e.name==='router-apology-published').length,0,
      'router-owned reply must be fenced by the same completion generation');
  }finally{release.resolve();await Promise.allSettled([work].filter(Boolean));await f.close()}
}
export async function delayedCompletion(kind){
  reset();const entered=deferred(),release=deferred();let held=false;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&opts.content==='ok'&&!held){held=true;state.event('reply-pending');entered.resolve();await release.promise;state.event('reply-settled')}return {}};
  const f=await completionStack(kind);let a,b;
  try{
    a=f.handle(f.message(1));await entered.promise;
    b=f.handle(f.message(2));await delay(25);
    trace({phase:'delayed-before-release',kind,starts:f.starts.length,events:state.events});
    assert.equal(f.starts.length,1,'same-session next turn must wait for delivery/history settlement');
    assert.equal(state.events.filter(e=>e.name==='store-buildSegmentedHistoryPrefix').length,1,'no next prompt/history read while reply pending');
    release.resolve();await Promise.all([a,b]);await tick();
    const settled=state.events.findIndex(e=>e.name==='reply-settled'),history=state.events.findIndex(e=>e.name==='store-appendAssistant'),reads=state.events.flatMap((e,i)=>e.name==='store-buildSegmentedHistoryPrefix'?[i]:[]);
    assert.ok(settled<history&&history<reads[1]);assert.equal(f.starts.length,2);
    trace({phase:'delayed-order',kind,settled,history,nextHistoryRead:reads[1]});
  }finally{release.resolve();await Promise.allSettled([a,b].filter(Boolean));await tick();await f.close()}
}

const routerText = mode => mode==='rate'?'请稍后再试':mode==='oversize'?'消息过长，请缩短后重试':'⚠️ 处理超时，请稍后重试。';
export async function routerPublicationRace(kind,mode,race){
  reset();const entered=deferred(),release=deferred();let attempts=0,writes=0,work,queued;
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.content===routerText(mode)){
      attempts++;assert.ok(opts.signal instanceof AbortSignal);state.event('router-before-write',{mode,channel:opts.channelId});entered.resolve();
      await abortableHold(opts.signal,release);writes++;state.event('router-write',{mode,channel:opts.channelId});
    }
    return {};
  };
  const f=await completionStack(kind,{config:mode==='rate'?{rateLimit:{maxPerMinute:1}}:{}});
  try{
    if(mode==='rate')await f.handle(f.message(1));
    const before=state.events.filter(e=>e.name==='store-appendAssistant').length;
    work=f.handle(f.message(2,'member',mode==='oversize'?'x'.repeat(32769):'next'));work.catch(()=>{});await entered.promise;
    queued=f.handle(f.message(3));queued.catch(()=>{});await tick();
    if(race==='reset'){f.generations.set('member',1);await f.stack.execution.observeReset('member')}
    else await f.stack.shutdown();
    release.resolve();await Promise.allSettled([work,queued]);
    assert.equal(attempts,1);assert.equal(writes,0);assert.equal(f.starts.length,mode==='rate'?1:0);
    assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,before);
    trace({phase:'router-publication-race',kind,mode,race,attempts,writes,events:state.events});
  }finally{release.resolve();await Promise.allSettled([work,queued].filter(Boolean));await f.close()}
}
export async function routerInvocationIsolation(kind){
  reset();const aEntered=deferred(),bEntered=deferred(),aRelease=deferred(),bRelease=deferred();let aWork,bWork;
  const writes=[];
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.content===routerText('oversize')){
      if(opts.botToken==='router-a'){
        const member=opts.channelId==='channel-member';(member?aEntered:bEntered).resolve();
        await abortableHold(opts.signal,member?aRelease:bRelease);
      }
      writes.push({bot:opts.botToken,channel:opts.channelId});
    }return {};
  };
  const a=await completionStack(kind,{botId:'router-a'}),b=await completionStack(kind,{botId:'router-b'});
  try{
    aWork=a.handle(a.message(1,'member','x'.repeat(32769)));aWork.catch(()=>{});await aEntered.promise;
    bWork=a.handle(a.message(1,'other','x'.repeat(32769)));bWork.catch(()=>{});await bEntered.promise;
    a.generations.set('member',1);await a.stack.execution.observeReset('member');
    await b.handle(b.message(1,'member','x'.repeat(32769)));
    aRelease.resolve();bRelease.resolve();await Promise.allSettled([aWork,bWork]);
    assert.deepEqual(writes,[{bot:'router-b',channel:'channel-member'},{bot:'router-a',channel:'channel-other'}]);
    trace({phase:'router-per-invocation-isolation',kind,writes});
  }finally{aRelease.resolve();bRelease.resolve();await Promise.allSettled([aWork,bWork].filter(Boolean));const closed=await Promise.allSettled([a.close(false),b.close(false)]);assertClean(assert);assert.ok(closed.every(x=>x.status==='fulfilled'))}
}
export async function routerReplyFailure(kind,timeout){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let attempts=0,writes=0,work;
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.content===routerText('oversize')){
      attempts++;assert.ok(opts.signal);entered.resolve();
      if(timeout){await abortableHold(opts.signal,release);writes++}else throw Error('inert router response unknown');
    }return {};
  };
  const f=await completionStack(kind,{clock});
  try{
    work=f.handle(f.message(1,'member','x'.repeat(32769)));await entered.promise;
    if(timeout){clock.advance(29999);await tick();assert.equal(writes,0);clock.advance(1)}
    await work;assert.equal(attempts,1);assert.equal(writes,0);assert.equal(f.starts.length,0);
    assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,0);
    await f.handle(f.message(2));assert.equal(f.starts.length,1);
    trace({phase:'router-reply-failure',kind,timeout,attempts,writes,monotonic:clock.monotonicNow()});
  }finally{release.resolve();await Promise.allSettled([work].filter(Boolean));await f.close();assert.equal(clock.pendingCount(),0)}
}
export async function routerOrdinaryTimeout(kind){
  reset();const apology=deferred(),release=deferred();let attempts=0,accepted=0,completed=false,work;
  state.send=async(name,opts)=>{if(name==='sendMessage'&&opts.content===routerText('timeout')){attempts++;assert.ok(opts.signal);apology.resolve()}return {}};
  const scenario={defaultTurn:[{delayMs:100,notify:'item/completed',params:{threadId:'$threadId',turnId:'$turnId',item:{id:'$itemId',type:'agentMessage',text:'ok'}}}]};
  const setup=kind==='sdk'?{sdkFactory(){return {startThread(){return {runStreamed:async()=>({events:(async function*(){
    accepted++;yield {type:'thread.started',thread_id:'inert-active'};await release.promise;
    yield {type:'item.completed',item:{id:'m',type:'agent_message',text:'ok'}};yield {type:'turn.completed',usage:{}};
  })()})}}}}}:{};
  const f=await completionStack(kind,{scenario,setup});
  try{
    work=f.handle(f.message(1)).then(()=>{completed=true});await apology.promise;
    assert.equal(completed,false,'accepted turn is still active after timeout apology');assert.equal(attempts,1);
    if(kind==='app-server'){assert.equal(f.starts.length,1);assert.equal(f.peers[0].server.requests('turn/interrupt').length,0)}else assert.equal(accepted,1);
    release.resolve();await work;assert.equal(attempts,1);assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,1);
    trace({phase:'router-timeout-keeps-accepted-turn',kind,attempts,events:state.events});
  }finally{release.resolve();await Promise.allSettled([work].filter(Boolean));await f.close()}
}
export async function routerUnboundDefaults(){
  reset();const f=await completionStack('sdk');const sent=[];
  state.send=async(name,opts)=>{if(name==='sendMessage'){assert.equal(opts.signal,undefined);sent.push(opts.content)}return {}};
  const {SessionRouter}=await import('../../src/host/session-router.ts?completion-real');
  try{
    const router=new SessionRouter({...f.cfg,rateLimit:{maxPerMinute:1}},'unbound');
    const gate=deferred();let handled=0;
    await router.routeAndHandle(f.message(1),async()=>{handled++;await gate.promise});
    assert.equal(handled,1);assert.deepEqual(sent,[routerText('timeout')]);gate.resolve();await tick();
    const rejected=await router.routeAndHandle(f.message(2),async()=>assert.fail('rate-limited handler'));
    assert.equal(rejected.rejectionReason,'rate_limited');
    const oversized=new SessionRouter(f.cfg,'unbound');
    const result=await oversized.routeAndHandle(f.message(3,'other','x'.repeat(32769)),async()=>assert.fail('oversize handler'));
    assert.equal(result.rejectionReason,'oversized');assert.deepEqual(sent,[routerText('timeout'),routerText('rate'),routerText('oversize')]);
    trace({phase:'router-unbound-original-defaults',handled,sent});
  }finally{await f.close()}
}
export async function routerAcceptedUnknown(kind){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let attempts=0,accepted=0,work,closing;
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.content===routerText('timeout')){
      attempts++;accepted++;state.event('remote-effect-already-accepted');entered.resolve();
      await release.promise;state.event('late-unknown-response-collected');
    }
    if(name==='sendMessage'&&opts.content==='ok')return abortableHold(opts.signal,release);
    return {};
  };
  const f=await completionStack(kind,{clock});
  try{
    work=f.handle(f.message(1));work.catch(()=>{});await entered.promise;
    f.generations.set('member',1);state.event('reset-after-remote-acceptance');await f.stack.execution.observeReset('member');
    await Promise.allSettled([work]);closing=f.stack.shutdown();closing.catch(()=>{});await tick();clock.advance(10000);
    await assert.rejects(closing,e=>e.name==='HostCompletionDrainError');assert.equal(existsSync(join(f.dir,'gateway.lock')),true);assert.equal(state.dbs.size,1);
    assert.equal(attempts,1);assert.equal(accepted,1,'cancellation cannot retract a remote effect already accepted');
    assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,0);
    release.resolve();await tick();await f.stack.shutdown();
    const collected=state.events.findIndex(e=>e.name==='late-unknown-response-collected'),db=state.events.findIndex(e=>e.name==='db-close');assert.ok(collected>=0&&collected<db);
    trace({phase:'router-unknown-acceptance-not-retracted',kind,attempts,accepted,events:state.events});
  }finally{release.resolve();await Promise.allSettled([work,closing].filter(Boolean));await tick();await f.close();assert.equal(clock.pendingCount(),0)}
}

export async function pendingDeadlineAdmission(kind){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let held=false,collected=false,outward=false,first,expired;
  const jobs=[];
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.content==='ok'&&!held){held=true;entered.resolve();await release.promise;collected=true;state.event('pending-final-collected')}
    return {};
  };
  const f=await completionStack(kind,{clock,admissionMs:120000});
  try{
    first=f.handle(f.message(1));first.then(()=>{outward=true},()=>{outward=true});await entered.promise;await delay(12);
    expired=f.handle(f.message(2));expired.catch(()=>{});
    clock.advance(60000);await tick();assert.equal(outward,true,'unknown outward result stays finite');assert.equal(collected,false);assert.equal(f.starts.length,1);
    clock.advance(60000);await assert.rejects(expired,e=>e.status==='NO-WRITES'&&e.prerequisite==='deadline');
    assert.equal(f.starts.length,1);assert.equal(state.events.filter(e=>e.name==='store-buildSegmentedHistoryPrefix').length,1,'expired caller never entered history assembly');
    for(let seq=3;seq<=5;seq++){const job=f.handle(f.message(seq));job.catch(()=>{});jobs.push(job)}
    await assert.rejects(f.handle(f.message(6)),e=>e.name==='LaneOverflowError');await tick();assert.equal(f.starts.length,1,'finished outward wrapper still owns the session capacity');
    release.resolve();await Promise.all(jobs);await tick();
    assert.equal(collected,true);assert.equal(f.starts.length,4,'three admitted callers enter exactly once after actual collection');
    assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,3,'unknown first send creates no successful history');
    trace({phase:'pending-owner-deadline-capacity',kind,outward,collected,events:state.events});
  }finally{release.resolve();await Promise.allSettled([first,expired,...jobs].filter(Boolean));await f.close();assert.equal(clock.pendingCount(),0)}
}
export async function pendingGenerationIsolation(kind){
  reset();const clock=new FakeClock(),entered=deferred(),release=deferred();let held=false,collected=false,first,oldQueued,current;
  state.send=async(name,opts)=>{
    if(name==='sendMessage'&&opts.botToken==='pending-main'&&opts.channelId==='channel-member'&&opts.content==='ok'&&!held){held=true;entered.resolve();await release.promise;collected=true;state.event('old-generation-effect-collected')}
    return {};
  };
  const a=await completionStack(kind,{botId:'pending-main',clock,admissionMs:120000}),b=await completionStack(kind,{botId:'pending-sibling',clock,admissionMs:120000});
  try{
    first=a.handle(a.message(1));first.catch(()=>{});await entered.promise;await delay(12);
    oldQueued=a.handle(a.message(2));oldQueued.catch(()=>{});a.generations.set('member',1);await a.stack.execution.observeReset('member');
    const settled=await Promise.allSettled([first,oldQueued]);assert.equal(settled[1].status,'rejected');assert.equal(settled[1].reason.prerequisite,'permit-not-current');
    current=a.handle(a.message(3));current.catch(()=>{});await tick();assert.equal(collected,false);assert.equal(a.starts.length,1);
    assert.equal(state.events.filter(e=>e.name==='store-buildSegmentedHistoryPrefix').length,1,'new generation still waits behind the old accepted effect');
    await a.handle(a.message(4,'other'));await b.handle(b.message(1));assert.equal(a.starts.length,2);assert.equal(b.starts.length,1);
    release.resolve();await current;await tick();assert.equal(collected,true);assert.equal(a.starts.length,3,'late collection admits only the current queued caller');
    trace({phase:'pending-owner-generation-isolation',kind,collected,aStarts:a.starts.length,bStarts:b.starts.length,events:state.events});
  }finally{release.resolve();await Promise.allSettled([first,oldQueued,current].filter(Boolean));const closed=await Promise.allSettled([a.close(false),b.close(false)]);assertClean(assert);assert.ok(closed.every(x=>x.status==='fulfilled'));assert.equal(clock.pendingCount(),0)}
}
export async function pendingAllEffects(kind){
  reset();const clock=new FakeClock(),finalEntered=deferred(),noticeEntered=deferred(),finalRelease=deferred(),noticeRelease=deferred();
  let heldFinal=false,heldNotice=false,finalCollected=false,noticeCollected=false,outward=false,first,next;
  state.send=async(name,opts)=>{
    if(name==='sendTyping'&&!heldNotice){heldNotice=true;noticeEntered.resolve();await noticeRelease.promise;noticeCollected=true;state.event('last-notice-collected')}
    if(name==='sendMessage'&&opts.content==='ok'&&!heldFinal){heldFinal=true;finalEntered.resolve();await finalRelease.promise;finalCollected=true;state.event('first-final-collected')}
    return {};
  };
  const f=await completionStack(kind,{clock,admissionMs:120000});
  try{
    first=f.handle(f.message(1));first.then(()=>{outward=true},()=>{outward=true});await Promise.all([finalEntered.promise,noticeEntered.promise]);await delay(12);
    next=f.handle(f.message(2));next.catch(()=>{});clock.advance(60000);await tick();assert.equal(outward,true);assert.equal(f.starts.length,1);
    finalRelease.resolve();await tick();assert.equal(finalCollected,true);assert.equal(noticeCollected,false);assert.equal(f.starts.length,1,'collecting one effect cannot release an entry with another pending notice');
    noticeRelease.resolve();await next;await tick();assert.equal(noticeCollected,true);assert.equal(f.starts.length,2);
    const last=state.events.findIndex(e=>e.name==='last-notice-collected'),reads=state.events.flatMap((e,i)=>e.name==='store-buildSegmentedHistoryPrefix'?[i]:[]);
    assert.ok(last<reads[1]);assert.equal(state.events.filter(e=>e.name==='store-appendAssistant').length,1);
    trace({phase:'pending-owner-all-effects',kind,outward,finalCollected,noticeCollected,events:state.events});
  }finally{finalRelease.resolve();noticeRelease.resolve();await Promise.allSettled([first,next].filter(Boolean));await f.close();assert.equal(clock.pendingCount(),0)}
}
