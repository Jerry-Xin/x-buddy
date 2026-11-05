// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { state, config, reset, assertClean } from './host-fixture.mjs';
import { clean, trace, gone } from './lifecycle-fixture.mjs';
import { AppServerClient } from '../../dist/app-server/client.js';
const { startBot } = await import('../../src/host/index.ts');
function clientOptions(dir, args) {
  const home=join(dir,'child-home');mkdirSync(home,{mode:0o700});
  return {bin:process.execPath,args,env:{HOME:home,PATH:'/usr/bin:/bin'},clientInfo:{name:'owned-host',version:'0'},lifecycle:state.gateways[0].testOwnership.lifecycle};
}
test('partial start failure drains the actual owned child before closing its SQLite',async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-partial-'));let client;
  state.beforeRegister=async()=>{
    client=new AppServerClient(clientOptions(dir,[new URL('./inert-lifecycle-child.mjs',import.meta.url).pathname,'100']));
    await client.start();
  };
  state.fail='handler';
  state.hook=name=>{if(name==='db-close'){
    const r=JSON.parse(readFileSync(join(dir,'app-server-child.json'),'utf8'));assert.equal(r.state,'exited');assert.equal(r.exit.code,7);
    assert.equal(existsSync(join(dir,'gateway.lock')),true);
  }};
  try {
    await assert.rejects(startBot(config(dir),true));await client.close({graceMs:1000});assertClean(assert);
    assert.equal(existsSync(join(dir,'gateway.lock')),false);
    trace({phase:'host-partial-child-cleanup',pid:client.pid,exit:client.exitInfo,recordBytes:readFileSync(join(dir,'app-server-child.json'),'utf8'),events:state.events});
  } finally {state.fail='';state.hook=null;state.beforeRegister=null;await client?.close({graceMs:1000});clean(dir)}
});
for (const phase of ['active', 'already-exited']) test(`host cleanup collects ${phase} owned readers with persistent inherited pipes`, {timeout:12000},async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-pipes-')),stop=join(dir,'stop'),eof=join(dir,'eof');let stack,client,helper;
  try {
    stack=await startBot(config(dir),true);
    client=new AppServerClient(clientOptions(dir,[new URL('./inert-held-pipes-peer.mjs',import.meta.url).pathname,'persistent',stop,eof]));
    client.subscribe(()=>true,n=>{if(n.method==='owned-descendant')helper=n.params.pid});
    await client.start();trace({phase:'host-helper-created',child:client.pid,helper});assert.ok(helper);const start=performance.now();
    if(phase==='already-exited'){void client.close({graceMs:1000});await state.gateways[0].testOwnership.lifecycle.settled;assert.equal(client.state,'closing')}
    state.hook=name=>{if(name==='db-close')assert.equal(client.state,'closed','owned stream reader must close before DB close')};
    await stack.shutdown();stack=null;await client.close({graceMs:1000});
    assert.ok(performance.now()-start<4000);assert.equal(gone(client.pid),true);assert.equal(gone(helper),false);
    assert.equal(client.exitInfo.code,7);assert.equal(client.exitInfo.signal,null);assertClean(assert);
    trace({phase:'host-held-pipes',entryState:phase,elapsed:performance.now()-start,child:client.pid,helper,exit:client.exitInfo,recordBytes:readFileSync(join(dir,'app-server-child.json'),'utf8'),events:state.events});
  } finally {
    state.hook=null;writeFileSync(stop,'owned fixture cleanup');await client?.close({graceMs:1000});await stack?.shutdown();
    for(let i=0;helper&&!gone(helper)&&i<200;i++)await delay(25);
    assert.ok(!helper||gone(helper));clean(dir);
    trace({phase:'host-held-pipes-cleanup',helper,helperAbsent:!helper||gone(helper),directoryAbsent:!existsSync(dir)});
  }
});
