// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { state, config, reset, assertClean } from './host-fixture.mjs';
import { clean, trace } from './lifecycle-fixture.mjs';
const { startBot, waitForBotShutdown } = await import('../../src/host/index.ts');
const { BotManager, BotStartupCleanupError } = await import('../../src/host/bot-manager.ts');

function setup() {
  reset(); const dirs = new Map(), stacks = new Map();
  const manager = new BotManager(async id => {
    const dir = mkdtempSync(join(tmpdir(), 'manager-owned-')); dirs.set(id, dir);
    const bot = await startBot(config(dir, id), true); stacks.set(id, bot); return bot;
  });
  return { manager, dirs, stacks, async finish() {
    state.fail = ''; state.hook = null; state.handlerGate = null;
    await manager.shutdownAll(); assertClean(assert);
    for (const dir of dirs.values()) { assert.equal(existsSync(join(dir, 'gateway.lock')), false); clean(dir); }
    trace({ phase: 'manager-cleanup', directories: [...dirs.values()], absent: [...dirs.values()].every(d => !existsSync(d)), dbs: state.dbs.size, timers: state.timers.size });
  } };
}
function snapshot(f) {
  return { running: f.manager.runningKeys(), pending: f.manager.pendingCleanupKeys(), dbs: state.dbs.size,
    locks: [...f.dirs].map(([id,d]) => [id, existsSync(join(d,'gateway.lock'))]) };
}
function retained(f, id) {
  assert.ok(f.manager.pendingCleanupKeys().includes(id));
  assert.equal(f.manager.has(id), false);
  assert.equal(existsSync(join(f.dirs.get(id), 'gateway.lock')), true);
}
async function noReplacement(f, id) {
  const before = state.events.length, dirs = f.dirs.size;
  await assert.rejects(f.manager.addBot(id), /cleanup pending/);
  const result = await f.manager.addBotsBatch([id]); assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error.message, /cleanup pending/);
  assert.equal(state.events.length, before); assert.equal(f.dirs.size, dirs);
}

for (const retry of ['remove', 'shutdownAll']) test(`actual manager reports failed removal and retries through ${retry}`, async () => {
  const f = setup();
  try {
    await f.manager.addBotsBatch(['a']); const lease = state.gateways[0].testOwnership;
    const lock = readFileSync(join(f.dirs.get('a'), 'gateway.lock'), 'utf8');
    state.fail = 'db-close'; await assert.rejects(f.manager.removeBot('a'));
    retained(f, 'a'); await noReplacement(f, 'a'); assert.equal(state.dbs.size, 1);
    await assert.rejects(f.manager.removeBot('a')); retained(f, 'a');
    assert.equal(readFileSync(join(f.dirs.get('a'), 'gateway.lock'), 'utf8'), lock);
    trace({ phase: 'manager-remove-retained', retry, snapshot: snapshot(f), events: state.events });
    state.fail = ''; state.hook = n => { if (n === 'db-close') { assert.equal(state.gateways[0].testOwnership, lease); lease.assertFor(f.dirs.get('a'),'a'); } };
    if (retry === 'remove') await f.manager.removeBot('a'); else await f.manager.shutdownAll();
    assertClean(assert); assert.deepEqual(f.manager.pendingCleanupKeys(), []);
    assert.equal(existsSync(join(f.dirs.get('a'), 'gateway.lock')), false);
    const Database = createRequire(import.meta.url)(process.env.HOST_SQLITE);
    const reopened = new Database(join(f.dirs.get('a'), 'cc-octo.db'));
    try {
      const tables = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      assert.ok(tables.length > 0);
      trace({ phase: 'manager-private-sqlite-reopened', retry, tables, integrity: reopened.pragma('integrity_check') });
    } finally { reopened.close(); }
  } finally { await f.finish(); }
});

test('actual repeated shutdownAll exposes all failures and retains only uncollected bots', async () => {
  const f = setup();
  try {
    await f.manager.addBotsBatch(['a','b']);
    const a = join(f.dirs.get('a'),'cc-octo.db');
    state.hook = (n,e) => { if (n === 'db-close' && e.path === a) throw Error('owned close fault'); };
    await assert.rejects(f.manager.shutdownAll(), e => e instanceof AggregateError && e.errors.length === 1);
    retained(f,'a'); assert.equal(state.dbs.size,1); assert.equal(existsSync(join(f.dirs.get('b'),'gateway.lock')),false);
    await assert.rejects(f.manager.shutdownAll()); retained(f,'a');
    state.hook=null; await f.manager.shutdownAll(); assertClean(assert); assert.deepEqual(f.manager.pendingCleanupKeys(),[]);
  } finally { await f.finish(); }
});

for (const mode of ['single','batch']) test(`actual ${mode} partial startup transfers its cleanup owner to the manager`, async () => {
  const f=setup();
  try {
    state.fail='handler'; state.hook=n=>{if(n==='db-close')throw Error('owned transient close fault')};
    if(mode==='single') await assert.rejects(f.manager.addBot('a'),e=>e instanceof BotStartupCleanupError);
    else { const r=await f.manager.addBotsBatch(['a']); assert.equal(r.failed.length,1); assert.ok(r.failed[0].error instanceof BotStartupCleanupError); }
    retained(f,'a'); assert.equal(state.dbs.size,1); await noReplacement(f,'a');
    state.fail=''; await assert.rejects(f.manager.shutdownAll()); retained(f,'a');
    trace({phase:'manager-partial-retained',mode,snapshot:snapshot(f),events:state.events});
    state.hook=null; await f.manager.shutdownAll(); assertClean(assert); assert.deepEqual(f.manager.pendingCleanupKeys(),[]);
    assert.equal(existsSync(join(f.dirs.get('a'),'gateway.lock')),false);
  } finally {await f.finish()}
});

for (const mode of ['single','batch']) test(`actual ${mode} connect rollback retains resources and sibling guards until collection`,async()=>{
  const f=setup();
  try {
    await f.manager.addBot('sibling'); const sibling=f.stacks.get('sibling');
    state.fail='connect'; state.hook=n=>{if(n==='db-close')throw Error('owned transient close fault')};
    if(mode==='single')await assert.rejects(f.manager.addBot('a'),e=>e instanceof AggregateError&&e.errors.length===2);
    else {const r=await f.manager.addBotsBatch(['a']);assert.equal(r.failed.length,1);assert.ok(r.failed[0].error instanceof AggregateError)}
    retained(f,'a'); assert.ok(sibling.router.knownBots.has('a')); assert.equal(state.dbs.size,2);
    state.fail=''; await noReplacement(f,'a');
    await f.manager.addBot('later'); assert.ok(f.stacks.get('later').router.knownBots.has('a'));
    state.hook=null; await f.manager.removeBot('a');
    assert.equal(sibling.router.knownBots.has('a'),false);assert.equal(f.stacks.get('later').router.knownBots.has('a'),false);
    assert.equal(existsSync(join(f.dirs.get('a'),'gateway.lock')),false);assert.equal(state.dbs.size,2);
    trace({phase:'manager-connect-retry',mode,snapshot:snapshot(f),events:state.events});
  }finally{await f.finish()}
});

test('unsettled actual gateway handlers retain manager ownership and sibling registration',async()=>{
  const f=setup();let settle;
  try {
    await f.manager.addBotsBatch(['a','b']);state.handlerGate=new Promise(resolve=>{settle=resolve});
    await assert.rejects(f.manager.removeBot('a'),e=>e.reason==='handlers-unsettled');retained(f,'a');
    assert.ok(f.stacks.get('b').router.knownBots.has('a'));assert.equal(state.dbs.size,2);
    assert.equal(state.events.some(e=>e.name==='db-close'),false);await noReplacement(f,'a');
    settle();await state.handlerGate;state.handlerGate=null;await f.manager.removeBot('a');
    assert.equal(f.stacks.get('b').router.knownBots.has('a'),false);assert.equal(state.dbs.size,1);
    trace({phase:'manager-handlers-retry',snapshot:snapshot(f),events:state.events});
  }finally{settle?.();await f.finish()}
});

for (const partial of [false,true]) test(`product shutdown signal caller retains its retry owner, partial=${partial}`,async()=>{
  const f=setup();let complete=false,waiting,stops=0;
  const before=process.listenerCount('SIGINT');
  try {
    if(partial){state.fail='handler';state.hook=n=>{if(n==='db-close')throw Error('owned close fault')};assert.equal((await f.manager.addBotsBatch(['a'])).failed.length,1);state.fail=''}
    else {await f.manager.addBot('a');state.fail='db-close'}
    waiting=waitForBotShutdown(f.manager,()=>{stops++}).then(()=>{complete=true});
    process.emit('SIGINT');await new Promise(resolve=>setImmediate(resolve));
    retained(f,'a');assert.equal(complete,false);assert.equal(stops,1);
    assert.equal(process.listenerCount('SIGINT'),before+1);assert.equal(state.timers.size,1);
    state.fail='';state.hook=null;process.emit('SIGINT');await waiting;
    assert.equal(stops,2);assert.equal(process.listenerCount('SIGINT'),before);
    assertClean(assert);assert.equal(existsSync(join(f.dirs.get('a'),'gateway.lock')),false);
    trace({phase:'manager-signal-caller-retry',partial,stops,signalEventsAreOwnedTestDispatch:true,events:state.events});
  }finally{state.fail='';state.hook=null;if(!complete&&waiting){process.emit('SIGINT');await waiting}await f.finish()}
});
