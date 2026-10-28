// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { BotOwnershipLock, withBotOwnership } from '../dist/transport/ownership-lock.js';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-dev02-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('DEV02 lock: exclusive per bot, private modes and idempotent release', t => {
  const dir = directory(t);
  const lock = new BotOwnershipLock(join(dir, 'bot')).acquire();
  lock.assertHeld();
  assert.match(readFileSync(lock.path, 'utf8'), new RegExp(`^${process.pid} [a-f0-9-]{36}\\n$`));
  assert.equal(statSync(lock.path).mode & 0o777, 0o600);
  assert.equal(statSync(lock.dataDir).mode & 0o777, 0o700);
  assert.throws(() => new BotOwnershipLock(lock.dataDir).acquire(), /Another instance is running/);
  const other = new BotOwnershipLock(join(dir, 'other')).acquire(); other.release();
  lock.release(); lock.release();
  assert.equal(existsSync(lock.path), false);
  assert.throws(() => lock.assertHeld(), /not held/);
});

test('DEV02 lock: second process never enters DB callback or mutates DB/WAL', t => {
  const dir = directory(t), lock = new BotOwnershipLock(dir).acquire();
  t.after(() => lock.release());
  const db = join(dir, 'cc-octo.db'), wal = db + '-wal';
  writeFileSync(db, 'populated SDK session fixture'); writeFileSync(wal, 'owner paused in delivering');
  const digest = path => [createHash('sha256').update(readFileSync(path)).digest('hex'), statSync(path).mtimeMs];
  const before = [digest(db), digest(wal)];
  const moduleUrl = new URL('../dist/transport/ownership-lock.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import {withBotOwnership} from ${JSON.stringify(moduleUrl)};
    import {writeFileSync} from 'node:fs';
    try { await withBotOwnership(process.argv[1], async () => { writeFileSync(process.argv[1]+'/opened','bad'); }); }
    catch(e) { console.error(e.message); process.exitCode=23; }
  `, dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 23, child.stderr);
  assert.match(child.stderr, new RegExp(`Another instance is running \\(PID ${process.pid}\\)`));
  assert.equal(existsSync(join(dir, 'opened')), false);
  assert.deepEqual([digest(db), digest(wal)], before);
});

test('DEV02 lock: failure cleanup runs while lock remains held, then releases last', async t => {
  const dir = directory(t);
  let cleanup = false;
  await assert.rejects(withBotOwnership(dir, async lock => {
    try { lock.assertHeld(); throw new Error('fixture failed start'); }
    finally { lock.assertHeld(); cleanup = true; }
  }), /failed start/);
  assert.equal(cleanup, true);
  assert.equal(existsSync(join(dir, 'gateway.lock')), false);
});

test('DEV02 lock: replacement nonce/inode is never removed', t => {
  const dir = directory(t), lock = new BotOwnershipLock(dir).acquire();
  renameSync(lock.path, lock.path + '.old');
  writeFileSync(lock.path, 'replacement-owner', { mode: 0o600 });
  assert.throws(() => lock.assertHeld(), /replaced/);
  lock.release();
  assert.equal(readFileSync(lock.path, 'utf8'), 'replacement-owner');
});

test('DEV02 lock: stale, corrupt and symlink locks fail closed', t => {
  for (const value of ['', 'corrupt', '99999999 previous-incarnation']) {
    const dir = directory(t), path = join(dir, 'gateway.lock');
    writeFileSync(path, value, { mode: 0o600 });
    assert.throws(() => new BotOwnershipLock(dir).acquire(), /ownership reconciliation required/);
    assert.equal(readFileSync(path, 'utf8'), value);
  }
  const dir = directory(t), target = join(dir, 'target');
  writeFileSync(target, 'untouched'); symlinkSync(target, join(dir, 'gateway.lock'));
  assert.throws(() => new BotOwnershipLock(dir).acquire(), /ownership reconciliation required/);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});
