// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, chmodSync, writeFileSync, unlinkSync, statSync, mkdirSync, renameSync, openSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, config, reset, assertClean } from './host-fixture.mjs';
import { clean, owned, trace } from './lifecycle-fixture.mjs';
const { startBot } = await import('../../src/host/index.ts');
const { BotOwnershipLock } = await import('../../src/transport/ownership-lock.ts');
const { BotStartupOwnership } = await import('../../src/runtime/bootstrap.ts');
const { BotManager } = await import('../../src/host/bot-manager.ts');
const { OctoGateway } = await import('../../src/host/gateway.ts');
const { AppServerClient } = await import('../../dist/app-server/client.js');
const { setTimeout: delay } = await import('node:timers/promises');

test('actual startBot refuses a live owner before any HOME use, timer or DB open', async () => {
  reset(); const dir = mkdtempSync(join(tmpdir(), 'host-owned-')); const lock = new BotOwnershipLock(dir).acquire();
  try {
    await assert.rejects(startBot(config(dir), true));
    assert.equal(state.events.some(e => ['home-use','timer','db-open'].includes(e.name)), false);
    lock.assertHeld(); assertClean(assert);
  } finally { lock.release(); clean(dir); }
});
test('genuine live native owner and child refuse startup without protected effects',async t=>{
  reset();const o=await owned(t,650);
  await assert.rejects(startBot(config(o.dir),true),e=>e.reason==='owner-live');
  assert.deepEqual(state.events,[]);assertClean(assert);
  trace({phase:'host-live-owner-refusal',record:o.record,dbOpens:0,homeUse:0});
});
test('missing configured bot key refuses without protected effects',async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));const c=config(dir);delete c.botId;
  try {await assert.rejects(startBot(c,true),e=>e.reason==='invalid-scope');assert.deepEqual(state.events,[]);assertClean(assert)}finally{clean(dir)}
});
test('modeled unsupported platform refuses before ownership or protected effects',async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  try {
    Object.defineProperty(process,'platform',{...descriptor,value:'linux'});
    await assert.rejects(startBot(config(dir),true),e=>e.reason==='unsupported-platform');
    assert.deepEqual(state.events,[]);assert.equal(existsSync(join(dir,'gateway.lock')),false);
  } finally {Object.defineProperty(process,'platform',descriptor);clean(dir)}
});

for (const stage of ['home-use','timer','db-open','store-constructor','store-init','store-clean','context-load','gateway','register','router','handler']) {
  test(`actual startBot collects initialized resources after ${stage} failure`, async () => {
    reset(); const dir = mkdtempSync(join(tmpdir(), 'host-owned-')); state.fail = stage;
    state.hook = name => { if (name === 'db-close') assert.equal(existsSync(join(dir,'gateway.lock')), true); };
    try {
      await assert.rejects(startBot(config(dir), true));
      assertClean(assert); assert.equal(existsSync(join(dir,'gateway.lock')), false);
    } finally { state.fail = ''; state.hook = null; clean(dir); }
  });
}
for (const mode of ['invalid-directory','missing-record','truncated-record']) {
  test(`actual startBot ${mode} refuses before any protected startup effect`, async t => {
    reset(); let o, dir;
    if (mode === 'invalid-directory') { dir = mkdtempSync(join(tmpdir(), 'host-owned-')); chmodSync(dir,0o755); }
    else {
      o = await owned(t, 650); dir = o.dir; await o.killParent();
      if (mode === 'missing-record') unlinkSync(o.recordPath); else writeFileSync(o.recordPath, '{');
    }
    try {
      await assert.rejects(startBot(config(dir),true));
      assert.deepEqual(state.events,[]); assertClean(assert);
    } finally { if (!o) { chmodSync(dir,0o700); clean(dir); } }
  });
}
test('actual startBot admits genuine previous native exit with the retained inode', async t => {
  reset(); const o = await owned(t,1000); const inode = statSync(join(o.dir,'gateway.lock')).ino;
  await o.killParent(); let stack;
  try {
    stack = await startBot(config(o.dir),true);
    assert.equal(statSync(join(o.dir,'gateway.lock')).ino,inode);
    const lease = state.gateways[0].testOwnership;
    lease.assertFor(o.dir,'owned-test-bot');
    trace({phase:'host-native-start',recordBytes:readFileSync(o.recordPath,'utf8'),inode,events:state.events});
    await stack.shutdown(); stack=null; assertClean(assert);
  } finally { await stack?.shutdown(); }
});
test('actual startBot rechecks directory ownership between cleanup and DB open', async () => {
  reset(); const dir=mkdtempSync(join(tmpdir(),'host-owned-'));
  state.hook=name=>{if(name==='home-use')chmodSync(dir,0o755)};
  try {
    await assert.rejects(startBot(config(dir),true));
    assert.equal(state.events.some(e=>e.name==='db-open'),false);assertClean(assert);
    assert.equal(existsSync(join(dir,'gateway.lock')),true); // Unsafe path never unlinked by cleanup.
  } finally { state.hook=null;chmodSync(dir,0o700);clean(dir); }
});
test('lease loss during registration closes the already-owned DB and refuses handler/connect',async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));
  state.hook=name=>{if(name==='register')chmodSync(dir,0o755)};
  try {
    await assert.rejects(startBot(config(dir),true));assertClean(assert);
    assert.equal(state.events.filter(e=>e.name==='db-open').length,1);
    assert.equal(state.events.filter(e=>e.name==='db-close').length,1);
    assert.equal(state.events.some(e=>['handler','connect'].includes(e.name)),false);
    assert.equal(existsSync(join(dir,'gateway.lock')),true);
  } finally {state.hook=null;chmodSync(dir,0o700);clean(dir)}
});
test('actual gateway refuses wrong-bot, wrong-directory and forged lease before registration', async () => {
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));const lease=await BotStartupOwnership.acquire(dir,'owned-test-bot');
  try {
    for (const [c,l] of [[config(dir,'wrong'),lease],[config(dir+'-wrong'),lease],[config(dir),{assertFor(){}}],[config(dir),undefined]]) {
      await assert.rejects(new OctoGateway(c,{handleSignals:false,ownership:l}).register());
    }
    assert.equal(state.events.some(e=>e.name==='register'),false);
  } finally { lease.release();clean(dir); }
});
for(const field of ['incarnationId','path','dataDir']) {
  test(`fresh startup scope retains ${field} and refuses restoration after observed loss`,async()=>{
    reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));const lease=await BotStartupOwnership.acquire(dir,'owned-test-bot');
    const lock=lease.lifecycle.lock,original=lock[field];
    try {
      lock[field]+='-wrong';assert.throws(()=>lease.assertFor(dir,'owned-test-bot'));lock[field]=original;
      await assert.rejects(new OctoGateway(config(dir),{handleSignals:false,ownership:lease}).register());
      assert.equal(state.events.some(e=>e.name==='register'),false);
    } finally {lock[field]=original;lease.release();clean(dir)}
  });
}
test('fresh startup scope pins the original inode even under modeled descriptor substitution',async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));const lease=await BotStartupOwnership.acquire(dir,'owned-test-bot');
  const lock=lease.lifecycle.lock,fd=lock.fd,retired=join(dir,'retired.lock'),bytes=readFileSync(lock.path);let replacement;
  try {
    renameSync(lock.path,retired);writeFileSync(lock.path,bytes,{mode:0o600});replacement=openSync(lock.path,constants.O_WRONLY|constants.O_NOFOLLOW);lock.fd=replacement;
    // Only owned fixture descriptor/public fields are corrupted. No external account authority is claimed.
    assert.throws(()=>lease.assertFor(dir,'owned-test-bot'));
    lock.fd=fd;closeSync(replacement);replacement=undefined;unlinkSync(lock.path);renameSync(retired,lock.path);
    assert.throws(()=>lease.assertFor(dir,'owned-test-bot'));assert.equal(state.events.some(e=>e.name==='register'),false);
  } finally {
    lock.fd=fd;if(replacement!==undefined)closeSync(replacement);
    if(existsSync(retired)){unlinkSync(lock.path);renameSync(retired,lock.path)}lease.release();clean(dir);
  }
});
test('gateway handler timeout retains the host DB and lease until collection', async () => {
  reset(); const dir=mkdtempSync(join(tmpdir(),'host-owned-'));let stack;let done;
  const pending=new Promise(resolve=>{done=resolve});const handlers=new Set([pending]);
  try {
    stack=await startBot(config(dir),true);const gateway=state.gateways[0];
    await assert.rejects(gateway.stop(handlers,1),e=>e.reason==='handlers-unsettled');
    assert.equal(gateway.draining,true);assert.equal(state.dbs.size,1);assert.equal(existsSync(join(dir,'gateway.lock')),true);
    done();await pending;handlers.clear();await stack.shutdown();stack=null;assertClean(assert);
  } finally {done();handlers.clear();await stack?.shutdown();clean(dir)}
});
test('failed DB close retains the same lease and allows cleanup retry', async () => {
  reset(); const dir=mkdtempSync(join(tmpdir(),'host-owned-'));let stack;
  try {
    stack=await startBot(config(dir),true);state.fail='db-close';await assert.rejects(stack.shutdown());
    assert.equal(state.dbs.size,1);assert.equal(existsSync(join(dir,'gateway.lock')),true);
    state.fail='';await stack.shutdown();stack=null;assertClean(assert);
  } finally {state.fail='';await stack?.shutdown();clean(dir)}
});
test('real BotManager preserves start-all, cross-register-all, connect-all with injected leases', async () => {
  reset();const a=mkdtempSync(join(tmpdir(),'host-a-')),b=mkdtempSync(join(tmpdir(),'host-b-'));
  const m=new BotManager(id=>startBot(config(id==='a'?a:b,id),true));
  try {
    assert.deepEqual((await m.addBotsBatch(['a','b'])).failed,[]);
    const events=state.events.map(e=>e.name),first=events.indexOf('connect');
    assert.equal(events.slice(0,first).filter(e=>e==='handler').length,2);
    assert.equal(events.slice(first).includes('sibling'),false);
    assert.equal(events.filter(e=>e==='sibling').length,4); // Existing idempotent pairwise registration.
    assert.equal(new Set(state.events.filter(e=>e.name==='sibling').map(e=>e.from+'->'+e.to)).size,2);
    await m.shutdownAll();assertClean(assert);
    assert.equal(existsSync(join(a,'gateway.lock')),false);assert.equal(existsSync(join(b,'gateway.lock')),false);
  } finally {await m.shutdownAll();clean(a);clean(b)}
});
test('real BotManager connect failure rolls back the initialized gateway, DB and lease',async()=>{
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-'));const m=new BotManager(id=>startBot(config(dir,id),true));
  state.fail='connect';
  try {
    assert.equal((await m.addBotsBatch(['owned-test-bot'])).failed.length,1);
    assert.equal(m.size(),0);assertClean(assert);assert.equal(existsSync(join(dir,'gateway.lock')),false);
  } finally {state.fail='';await m.shutdownAll();clean(dir)}
});
test('host shutdown collects its genuine owned child before DB close and lease release', async () => {
  reset();const dir=mkdtempSync(join(tmpdir(),'host-owned-')),home=join(dir,'child-home');mkdirSync(home,{mode:0o700});let stack,client;
  try {
    stack=await startBot(config(dir),true);const lease=state.gateways[0].testOwnership;
    client=new AppServerClient({bin:process.execPath,args:[new URL('./inert-lifecycle-child.mjs',import.meta.url).pathname,'100'],
      env:{PATH:'/usr/bin:/bin',HOME:home},clientInfo:{name:'owned-host',version:'0'},lifecycle:lease.lifecycle});
    await client.start();const before=readFileSync(join(dir,'app-server-child.json'),'utf8');
    state.hook=name=>{if(name==='db-close'){
      const r=JSON.parse(readFileSync(join(dir,'app-server-child.json'),'utf8'));assert.equal(r.state,'exited');assert.equal(r.exit.code,7);
      assert.equal(existsSync(join(dir,'gateway.lock')),true);
    }};
    await stack.shutdown();stack=null;await client.close({graceMs:1000});assertClean(assert);
    trace({phase:'host-child-collected',before,after:readFileSync(join(dir,'app-server-child.json'),'utf8'),pid:client.pid,exit:client.exitInfo,events:state.events});
  } finally {state.hook=null;await client?.close({graceMs:1000});await stack?.shutdown();clean(dir)}
});
test('real host 30-second previous-child timeout permits zero DB/HOME effects', {timeout:45000}, async t => {
  reset();const o=await owned(t,31500);await o.killParent();const before=readFileSync(join(o.dir,'gateway.lock'),'utf8');const start=performance.now();
  await assert.rejects(startBot(config(o.dir),true),e=>e.reason==='exit-timeout');
  assert.deepEqual(state.events,[]);assert.equal(readFileSync(join(o.dir,'gateway.lock'),'utf8'),before);assertClean(assert);
  trace({phase:'host-native-timeout',elapsed:performance.now()-start,dbOpens:0,homeUse:0,record:o.record,lockBytes:before});
});
test('actual startBot holds canonical ownership before cleanup and SQLite, closes DB before release', async () => {
  reset(); const dir = mkdtempSync(join(tmpdir(), 'host-owned-')); let stack;
  state.hook = name => {
    if (['home-use','timer','db-open','db-close'].includes(name)) assert.equal(existsSync(join(dir, 'gateway.lock')), true, name);
  };
  try {
    stack = await startBot(config(dir), true);
    assert.ok(state.gateways[0].testOwnership, 'same canonical ownership injected');
    state.hook = name => { if(name === 'db-close') {
      assert.equal(existsSync(join(dir,'gateway.lock')),true);
      assert.throws(()=>state.gateways[0].testOwnership.lifecycle.spawn('forbidden',[],{}),e=>e.reason==='lifecycle-draining');
    }};
    await stack.shutdown(); stack = null;
    assert.equal(existsSync(join(dir, 'gateway.lock')), false); assertClean(assert);
    trace({ phase: 'host-order', events: state.events, dbClosedBeforeRelease: true });
  } finally { state.hook = null; await stack?.shutdown(); clean(dir); }
});
