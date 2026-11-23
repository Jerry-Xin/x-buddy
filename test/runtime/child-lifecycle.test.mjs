// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { BotChildLifecycle } from '../../dist/runtime/child-lifecycle.js';
import { AppServerClient } from '../../dist/app-server/client.js';
import { DARWIN_CHILD_OBSERVER } from '../../dist/runtime/darwin-child.js';

const BOT = 'owned-test-bot';
import { trace, gone, clean, owned } from './lifecycle-fixture.mjs';
async function refused(lock, bot, reason) {
  let db = 0, home = 0;
  const before = readFileSync(lock.path, 'utf8');
  await assert.rejects(async () => {
    await lock.reconcilePreviousChild(bot);
    db++; home++;
  }, error => reason ? error.reason === reason : Boolean(error.reason));
  assert.equal(db, 0); assert.equal(home, 0);
  assert.equal(readFileSync(lock.path, 'utf8'), before);
  trace({ phase: 'refusal', reason, dbAccess: db, homeAccess: home, retainedLock: before });
}

test('actual owned parent SIGKILL → immediate replacement → native child exit → lock boundary only', async t => {
  const o = await owned(t, 1100); const oldInode = statSync(join(o.dir, 'gateway.lock')).ino;
  await o.killParent(); const lock = new BotOwnershipLock(o.dir);
  let db = 0, home = 0; const start = performance.now();
  const pending = lock.reconcilePreviousChild(BOT);
  void pending.catch(() => {});
  await delay(100); assert.equal(db, 0); assert.equal(home, 0);
  assert.equal(readFileSync(lock.path, 'utf8'), `${o.record.host.pid} ${o.record.incarnation}\n`);
  const receipt = await pending; lock.assertHeld();
  assert.ok(Object.isFrozen(receipt.previous.child.start));
  assert.equal(receipt.kind, 'reconciled'); assert.equal(receipt.exit.source, 'kqueue-note-exit');
  assert.equal(receipt.exit.code, 7); assert.equal(receipt.exit.signal, null);
  assert.deepEqual(receipt.previous.child, o.record.child); assert.ok(performance.now() - start >= 500);
  assert.equal(statSync(lock.path).ino, oldInode); // Retained inode, no stale-lock unlink.
  assert.equal(db, 0); assert.equal(home, 0);
  trace({ phase: 'admitted-lock-boundary', receipt, elapsed: performance.now() - start, dbAccess: db, homeAccess: home });
  await refused(new BotOwnershipLock(o.dir), BOT, 'record-mismatch');
  lock.release();
});

test('child already gone without a recorded exit remains unknown; no PID absence shortcut', async t => {
  const o = await owned(t, 10); await o.killParent(); await delay(400);
  assert.equal(gone(o.record.child.pid), true);
  await refused(new BotOwnershipLock(o.dir), BOT, 'exit-observation-unavailable');
});

test('unrelated owned sentinel survives valid reconciliation; no recorded-PID signal operation', async t => {
  const sentinel = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'],
    { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'ignore', 'ignore'] });
  const sentinelExit = once(sentinel, 'exit'); await once(sentinel, 'spawn');
  try {
    const o = await owned(t, 500); await o.killParent();
    const lock = new BotOwnershipLock(o.dir); await lock.reconcilePreviousChild(BOT); lock.assertHeld(); lock.release();
    assert.equal(gone(sentinel.pid), false);
    trace({ phase: 'unrelated-sentinel', pid: sentinel.pid, alive: true, signalsSent: 0 });
  } finally {
    sentinel.stdin.end(); assert.deepEqual(await sentinelExit, [0, null]); assert.equal(gone(sentinel.pid), true);
    trace({ phase: 'unrelated-sentinel-collected', pid: sentinel.pid, absent: gone(sentinel.pid) });
  }
});

test('live owner refuses before protected effects and keeps its child alive', async t => {
  const o = await owned(t); await refused(new BotOwnershipLock(o.dir), BOT, 'owner-live');
  assert.equal(gone(o.record.child.pid), false);
});

test('normal owned exit persists actual status; later replacement consumes that observation', async t => {
  const o = await owned(t, 10); const closed = once(o.parent, 'message'); o.parent.send('close');
  assert.equal((await closed)[0].closed, true);
  const record = JSON.parse(readFileSync(o.recordPath));
  assert.deepEqual(record.exit, { code: 7, signal: null, source: 'owned-child-exit' });
  await o.killParent(); const lock = new BotOwnershipLock(o.dir);
  const receipt = await lock.reconcilePreviousChild(BOT); lock.assertHeld();
  assert.equal(receipt.exit.code, 7); assert.equal(receipt.exit.source, 'owned-child-exit');
  trace({ phase: 'normal-exit', receipt }); lock.release();
});

for (const [name, change, reason] of [
  ['wrong bot', r => { r.bot = 'wrong'; }, 'record-mismatch'],
  ['wrong incarnation', r => { r.incarnation = '00000000-0000-4000-8000-000000000001'; }, 'record-mismatch'],
  ['host start mismatch', r => { r.host.start[1]++; }, 'host-identity-mismatch'],
  ['PID reuse fixture', r => { r.child.start[1] = (r.child.start[1] + 1) % 1000000; }, 'child-identity-mismatch'],
  ['wrong lock inode', r => { r.lease[1]++; }, 'record-mismatch'],
  ['unknown observation', r => { r.state = 'unknown'; }, 'malformed-record'],
]) test(`${name} refuses without touching an unrelated PID`, async t => {
  const o = await owned(t);
  const record = structuredClone(o.record); change(record); writeFileSync(o.recordPath, JSON.stringify(record));
  if (name !== 'host start mismatch') await o.killParent();
  await refused(new BotOwnershipLock(o.dir), BOT, reason);
});

for (const bad of ['missing', 'truncated']) test(`${bad} diagnostic never grants startup`, async t => {
  const o = await owned(t); await o.killParent();
  if (bad === 'missing') unlinkSync(o.recordPath); else writeFileSync(o.recordPath, '{"version":1');
  await refused(new BotOwnershipLock(o.dir), BOT, bad === 'missing' ? 'identity-or-record-unavailable' : 'malformed-record');
});

test('concurrent replacement has a single retained-inode observer', async t => {
  const o = await owned(t, 1300); await o.killParent();
  const a = new BotOwnershipLock(o.dir), b = new BotOwnershipLock(o.dir);
  const first = a.reconcilePreviousChild(BOT); await delay(200);
  await refused(b, BOT, 'reconciliation-busy');
  const receipt = await first; a.assertHeld(); trace({ phase: 'concurrent', receipt }); a.release();
});

test('ownership loss during observation preserves the replacement lock byte for byte', async t => {
  const o = await owned(t, 1000); await o.killParent(); const a = new BotOwnershipLock(o.dir);
  const pending = a.reconcilePreviousChild(BOT); void pending.catch(() => {}); await delay(200);
  renameSync(a.path, join(o.dir, 'old.lock')); const replacement = 'private replacement lock\n';
  writeFileSync(a.path, replacement, { mode: 0o600 });
  await assert.rejects(pending, e => e.reason === 'ownership-lost');
  a.release(); assert.equal(readFileSync(a.path, 'utf8'), replacement);
  trace({ phase: 'ownership-loss', dbAccess: 0, homeAccess: 0, replacement });
});

test('loss of private directory permissions during observation refuses before grant', async t => {
  const o = await owned(t, 1000); await o.killParent(); const lock = new BotOwnershipLock(o.dir);
  const before = readFileSync(lock.path, 'utf8');
  const pending = lock.reconcilePreviousChild(BOT); void pending.catch(() => {}); await delay(200);
  chmodSync(o.dir, 0o755);
  try {
    await assert.rejects(pending, e => e.reason === 'unsafe-owned-path');
    assert.equal(readFileSync(lock.path, 'utf8'), before);
    trace({ phase: 'directory-permission-loss', dbAccess: 0, homeAccess: 0, retainedLock: before });
  } finally { chmodSync(o.dir, 0o700); }
});

test('concrete AppServer integration retains the lifecycle settlement and blocks a second spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xin2739-direct-'));
  const lock = new BotOwnershipLock(dir).acquire(); const lifecycle = new BotChildLifecycle(lock, BOT);
  assert.throws(() => new BotChildLifecycle(lock, BOT), /lifecycle-already-bound/);
  const client = new AppServerClient({ bin: process.execPath, args: [new URL('./inert-lifecycle-child.mjs', import.meta.url).pathname, '10'],
    env: { PATH: '/usr/bin:/bin' }, clientInfo: { name: 'inert', version: '0' }, lifecycle });
  try {
    await client.start();
    trace({ phase: 'direct-spawn', pid: client.pid, recordBytes: readFileSync(join(dir, 'app-server-child.json'), 'utf8') });
    assert.throws(() => lifecycle.spawn(process.execPath, [], {}), /previous-child-unsettled/);
    await client.close({ graceMs: 1000 }); await lifecycle.settled;
    assert.equal(JSON.parse(readFileSync(join(dir, 'app-server-child.json'))).state, 'exited');
    assert.equal(gone(client.pid), true);
    trace({ phase: 'direct-exit', pid: client.pid, exit: client.exitInfo, recordBytes: readFileSync(join(dir, 'app-server-child.json'), 'utf8'), absent: gone(client.pid) });
  } finally { await client.close({ graceMs: 0 }); lock.release(); clean(dir); }
});

test('controlled native fixtures: unsupported, permission, unknown, and identity races refuse', () => {
  // These are explicitly modeled ABI/error seams, not real platform proofs.
  const cases = `
import types
namespace = {'__name__':'fixture'}
exec(SOURCE, namespace)
R = namespace['Refusal']
def refusal(fn, reason):
    try: fn()
    except R as e: assert str(e) == reason, str(e)
    else: raise AssertionError('grant')
namespace['sys'] = types.SimpleNamespace(platform='linux')
refusal(namespace['main'], 'unsupported-platform')
namespace['lib'] = types.SimpleNamespace(proc_pidinfo=lambda *args: 0)
namespace['ctypes'].set_errno(0)
refusal(lambda: namespace['identity'](123), 'identity-unavailable')
def permission(*args):
    namespace['ctypes'].set_errno(1)
    return 0
namespace['lib'] = types.SimpleNamespace(proc_pidinfo=permission)
refusal(lambda: namespace['identity'](123), 'identity-permission-denied')
refusal(lambda: namespace['identity'](False), 'invalid-identity')
namespace['identity'] = lambda *args, **kw: {'pid':123,'start':[2,3]}
namespace['old_pid'] = 123
refusal(lambda: namespace['observe']({'host':{'pid':123,'start':[2,4]}}), 'host-identity-mismatch')
print('5 modeled refusal fixtures pass')
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', 'SOURCE = ' + JSON.stringify(DARWIN_CHILD_OBSERVER) + '\n' + cases],
    { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); trace({ phase: 'modeled-native-fixtures', stdout: result.stdout });
});
