// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from '../../dist/app-server/client.js';
import { BotCodexRuntime } from '../../dist/runtime/runtime.js';
import { BotChildLifecycle } from '../../dist/runtime/child-lifecycle.js';
import { DARWIN_CHILD_OBSERVER } from '../../dist/runtime/darwin-child.js';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { trace, gone, clean } from './lifecycle-fixture.mjs';

const handles = new Set(), processes = [], signals = [];
const originalSpawn = cp.spawn, originalKill = cp.ChildProcess.prototype.kill;
cp.spawn = function (...args) {
  const child = originalSpawn.apply(this, args); handles.add(child);
  const row = { pid: child.pid, bin: args[0] }; processes.push(row);
  child.once('exit', (code, signal) => Object.assign(row, { code, signal, exitAt: performance.now() }));
  child.once('close', () => { row.collected = true; }); return child;
};
cp.ChildProcess.prototype.kill = function (signal) {
  assert.ok(handles.has(this)); signals.push({ pid: this.pid, signal: signal ?? 'SIGTERM', ownedHandle: true });
  return originalKill.call(this, signal);
};
syncBuiltinESMExports();

// Test-only collection of the freshly announced descendant, never a grant.
async function watch(pid) {
  const program = `import ctypes,json,select,sys\nd=json.load(sys.stdin);n={'__name__':'fixture'};exec(d['source'],n)\nn['lib']=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)\nn['lib'].proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int];n['lib'].proc_pidinfo.restype=ctypes.c_int\nq=select.kqueue();q.control([select.kevent(d['pid'],filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT|0x04000000)],0,0)\nprint(json.dumps({'identity':n['identity'](d['pid'])}),flush=True)\ne=q.control(None,1,15);assert e and e[0].fflags&select.KQ_NOTE_EXIT and e[0].fflags&0x04000000\nprint(json.dumps({'pid':e[0].ident,'waitStatus':e[0].data}),flush=True);q.close()`;
  const child = cp.spawn('/usr/bin/python3', ['-I', '-c', program], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stdout.on('data', b => { output += b; if (output.includes('\n')) readyResolve(JSON.parse(output.split('\n')[0])); });
  child.stderr.on('data', b => { errors += b; });
  const closed = once(child, 'close'); child.stdin.end(JSON.stringify({ pid, source: DARWIN_CHILD_OBSERVER }));
  const first = await Promise.race([ready, closed.then(() => { throw new Error(errors || 'observer ended before ready'); })]);
  return { identity: first.identity, async collected() {
    const [code, signal] = await closed; assert.equal(code, 0, errors); assert.equal(signal, null);
    const end = JSON.parse(output.trim().split('\n').at(-1)); assert.equal(end.pid, pid); assert.equal(end.waitStatus, 23 << 8);
    for (let i = 0; i < 100 && !gone(pid); i++) await delay(10);
    assert.equal(gone(pid), true); return { ...first, ...end, observer: child.pid, observerCode: code, observerSignal: signal };
  } };
}

for (const kind of ['client', 'runtime']) for (const mode of ['finite', 'persistent']) {
  test(`owned exit bounds ${kind} closure with ${mode} inherited pipes`, { timeout: 12_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'xin2739-pipes-')), home = join(dir, 'home'); mkdirSync(home, { mode: 0o700 });
    const stop = join(dir, 'stop'), eof = join(dir, 'eof');
    const lock = new BotOwnershipLock(dir).acquire(), lifecycle = new BotChildLifecycle(lock, 'pipe-test');
    const startIndex = processes.length, signalIndex = signals.length;
    let client, helper, collection, close;
    const late = [];
    const opts = { bin: process.execPath, args: [new URL('./inert-held-pipes-peer.mjs', import.meta.url).pathname, mode, stop, eof],
      env: { HOME: home, PATH: '/usr/bin:/bin' }, clientInfo: { name: 'inert-pipe-test', version: '0' }, lifecycle };
    const factory = () => {
      client = new AppServerClient(opts);
      client.subscribe(() => true, n => {
        if (n.method === 'owned-descendant') helper = n.params.pid;
        if (n.method === 'owned-late-drain') late.push({ at: performance.now(), params: n.params });
      }); return client;
    };
    const runtime = kind === 'runtime' ? new BotCodexRuntime({ client: opts, clientFactory: factory }) : undefined;
    t.after(async () => {
      if (mode === 'persistent') writeFileSync(stop, 'owned cleanup');
      const helperExit = collection ? await collection.collected() : undefined;
      if (close) await close;
      await client?.close({ graceMs: 0 }); await lifecycle.settled;
      const recordBytes = readFileSync(join(dir, 'app-server-child.json'), 'utf8');
      assert.ok(processes.slice(startIndex).every(p => p.collected));
      assert.deepEqual(readdirSync(home), []); lock.release(); clean(dir);
      trace({ phase: 'held-pipes-cleanup', kind, mode, helperExit, recordBytes, processes: processes.slice(startIndex),
        signals: signals.slice(signalIndex), childAbsent: gone(client.pid), helperAbsent: gone(helper),
        ownedHomeAbsent: !existsSync(home), directoryAbsent: !existsSync(dir) });
    });
    if (runtime) await runtime.ensureReady(); else { factory(); await client.start(); }
    collection = await watch(helper);
    const before = readFileSync(join(dir, 'app-server-child.json'), 'utf8');
    let settled = false, error;
    const start = performance.now();
    const closing = runtime ? runtime.shutdown({ interruptGraceMs: 0, exitGraceMs: 1000 }) : client.close({ graceMs: 1000 });
    close = closing.catch(e => { error = { name: e.name, message: e.message }; }).finally(() => { settled = true; });
    await delay(2600);
    const after = readFileSync(join(dir, 'app-server-child.json'), 'utf8');
    const snapshot = { phase: 'held-pipes-decision', kind, mode, elapsed: performance.now() - start, settled, error,
      child: client.pid, helper: collection.identity, childAbsent: gone(client.pid), helperAlive: !gone(helper),
      before, after, clientState: client.state, exit: client.exitInfo, runtime: runtime?.stats(), late,
      dbAccess: 0, homeAccess: 0, signals: signals.slice(signalIndex) };
    trace(snapshot);
    assert.equal(snapshot.childAbsent, true); assert.equal(snapshot.helperAlive, true);
    assert.equal(settled, true); assert.equal(error, undefined);
    assert.equal(JSON.parse(after).state, 'exited'); assert.equal(JSON.parse(after).exit.code, 7);
    assert.equal(client.exitInfo.code, 7); assert.equal(client.exitInfo.signal, null);
    assert.equal(client.state, 'closed'); if (runtime) assert.equal(runtime.stats().state, 'closed');
    const peer = processes.slice(startIndex).find(p => p.pid === client.pid);
    assert.equal(late.length, 1); assert.ok(late[0].at > peer.exitAt, 'bounded drain retains post-exit inherited bytes');
    assert.deepEqual(signals.slice(signalIndex), []);
  });
}

test('lifecycle spawn failure settles without fabricating a process exit', { timeout: 2000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xin2739-spawn-fail-')), lock = new BotOwnershipLock(dir).acquire();
  const lifecycle = new BotChildLifecycle(lock, 'spawn-failure');
  const client = new AppServerClient({ bin: '/nonexistent-owned-inert-peer', args: [], lifecycle, clientInfo: { name: 'inert', version: '0' } });
  try {
    await assert.rejects(client.start()); await client.close({ graceMs: 0 });
    assert.throws(() => lifecycle.spawn(process.execPath, [], {}));
    assert.equal(readdirSync(dir).includes('app-server-child.json'), false);
  } finally { lock.release(); clean(dir); }
});

test('failed exit persistence preserves refusal and never fabricates a durable exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xin2739-persist-fail-')), lock = new BotOwnershipLock(dir).acquire();
  const lifecycle = new BotChildLifecycle(lock, 'persistence-failure');
  const client = new AppServerClient({ bin: process.execPath,
    args: [new URL('./inert-lifecycle-child.mjs', import.meta.url).pathname, '10'],
    env: { PATH: '/usr/bin:/bin' }, lifecycle, clientInfo: { name: 'inert', version: '0' } });
  try {
    await client.start(); const runningBytes = readFileSync(join(dir, 'app-server-child.json'), 'utf8');
    unlinkSync(join(dir, 'app-server-child.json'));
    await client.close({ graceMs: 1000 });
    assert.equal(client.exitInfo.code, 7); assert.equal(gone(client.pid), true);
    assert.throws(() => lifecycle.spawn(process.execPath, [], {}), e => e.reason === 'identity-or-record-unavailable');
    const before = readFileSync(lock.path, 'utf8');
    await assert.rejects(new BotOwnershipLock(dir).reconcilePreviousChild('persistence-failure'), e => e.reason === 'identity-or-record-unavailable');
    assert.equal(readFileSync(lock.path, 'utf8'), before);
    assert.equal(readdirSync(dir).includes('app-server-child.json'), false);
    trace({ phase: 'persistence-failure-refusal', runningBytes, child: client.pid, exit: client.exitInfo,
      childAbsent: gone(client.pid), recordAbsent: true, dbAccess: 0, homeAccess: 0, retainedLock: before });
  } finally { await client.close({ graceMs: 0 }); lock.release(); clean(dir); }
});
