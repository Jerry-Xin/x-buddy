// SPDX-License-Identifier: Apache-2.0
// Missing-prerequisite controls only. All owner/issuer guards here are modeled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CronStore, StoreConflict, terminalExpectation } from '../../src/cron/store/index.ts';
import { setup, scope, state, now } from './execution-fixture.mjs';
import { manualFixture, success } from './manual-fixture.mjs';

const deferred = { kind: 'deferred', reason: 'restart-reconciliation',
  prerequisite: 'previous-child-termination-unavailable' };
const changes = db => db.prepare('SELECT total_changes() n').get().n;
const cases = [
  ['timed queued', 'timed', false], ['timed running', 'timed', true],
  ['manual consume queued', 'consume', false], ['manual consume running', 'consume', true],
  ['future borrow queued across date', 'future', false], ['future borrow running across date', 'future', true],
  ['disabled future force', 'disabled-future', true], ['disabled overdue force', 'disabled-overdue', true],
  ['recurring borrow', 'recurring', true], ['retry queued', 'retry', false], ['retry running', 'retry', true],
];
function prepare(t, kind, running) {
  let f;
  if (kind === 'timed' || kind === 'retry') {
    f = setup(t);
    if (kind === 'retry') f.queueRetry();
    if (running) assert.equal(f.admit().kind, 'admitted');
  } else {
    const schedule = kind === 'recurring' ? { kind: 'every', everyMs: 3600000, anchorMs: 0 }
      : { kind: 'at', atMs: now + 60000 };
    f = manualFixture(t, { schedule, enabled: !kind.startsWith('disabled'), deleteAfterRun: false });
    if (kind === 'consume' || kind === 'disabled-overdue') f.clock.value = schedule.atMs;
    assert.equal(f.reserve(kind.startsWith('disabled') ? { manualMode: 'force' }
      : kind === 'consume' ? { manualMode: 'due' } : {}).kind, 'reserved');
    if (running) assert.equal(f.start().kind, 'admitted');
    // Time crossing never changes the immutable reservation's ownership.
    f.clock.value = Math.max(f.clock.value, f.job.next_run_at ?? schedule.atMs) + 3600000;
  }
  return f;
}
function reopen(f) {
  f.db.close(); f.db = f.connect(); f.store = new CronStore(f.db, f.clock);
}
function observe(f, request, expected = deferred, db = f.db) {
  const before = state(db), beforeChanges = changes(db), sql = [];
  const proxy = { get inTransaction() { return db.inTransaction; },
    exec(s) { sql.push(s); return db.exec(s); }, prepare(s) { sql.push(s); return db.prepare(s); } };
  let verifierCalls = 0;
  const store = new CronStore(proxy, f.clock, {}, { prepare() { verifierCalls++; throw new Error('Execution issuer is not restart authority'); } });
  assert.equal(typeof store.reconcileRestart, 'function', 'Typed restart prerequisite entry is missing');
  let result, error;
  try { result = store.reconcileRestart(scope, f.job.id, request); } catch (e) { error = e; }
  const after = state(db), afterChanges = changes(db);
  if (process.env.RESTART_TRACE) appendFileSync(process.env.RESTART_TRACE, JSON.stringify({
    test: f.label, result, error: error && { name: error.constructor.name, message: error.message },
    before, after, beforeChanges, afterChanges, sql, verifierCalls, inTransaction: db.inTransaction,
  }) + '\n');
  assert.deepEqual(after, before); assert.equal(afterChanges, beforeChanges);
  assert.deepEqual(sql, [], 'Unavailable canonical termination proof must stop before DB access');
  assert.equal(verifierCalls, 0);
  if (typeof expected === 'function') assert.ok(error instanceof expected, error?.stack ?? JSON.stringify(result));
  else { if (error) throw error; assert.deepEqual(result, expected); assert.ok(Object.isFrozen(result)); }
  return result;
}
function request(f, same = false) {
  return { expected: terminalExpectation(f.row()), ownership: { ...f.owner,
    ownerIncarnation: same ? f.owner.ownerIncarnation : 'modeled-replacement-owner' } };
}

for (const [name, kind, running] of cases) for (const same of [false, true]) {
  test(`restart prerequisite: ${name}; ${same ? 'same' : 'old'} incarnation; reopen and repeat`, t => {
    const f = prepare(t, kind, running); f.label = t.name;
    const r = request(f, same), before = state(f.db);
    reopen(f); assert.deepEqual(state(f.db), before);
    observe(f, r); observe(f, r);
    assert.equal(f.row().status, running ? 'running' : 'queued');
  });
}
for (const running of [false, true]) test(`restart prerequisite: replacement generation, ${running ? 'running old receipt' : 'queued receipt publicly stopped before edit'}`, t => {
  const f = prepare(t, 'future', running); f.label = t.name;
  const r = request(f);
  if (!running) assert.equal(f.finish({ kind: 'neutral', reason: 'stopped' }).kind, 'finalized');
  f.store.edit(scope, f.job.id, f.job.generation, { name: 'replacement' });
  reopen(f); observe(f, r);
});
test('restart prerequisite: stored terminal outcome is not accepted as repair evidence', t => {
  const f = prepare(t, 'future', true); f.label = t.name;
  const r = request(f);
  assert.equal(f.finish(success).kind, 'finalized');
  reopen(f); observe(f, r); observe(f, r);
});
for (const key of ['previousChildTerminated', 'terminationProof', 'verifier', 'executionProof', 'authority']) {
  test(`restart prerequisite: request-selected ${key} cannot authorize repair`, t => {
    const f = prepare(t, 'future', true); f.label = t.name;
    let calls = 0;
    const fake = key === 'previousChildTerminated' ? true : { assertCurrent() { calls++; }, prepare() { calls++; } };
    observe(f, { ...request(f), [key]: fake }, TypeError); assert.equal(calls, 0);
  });
}
for (const fence of [1, 2]) test(`restart prerequisite: ownership loss at guard ${fence}`, t => {
  const f = prepare(t, 'consume', true); f.label = t.name;
  let calls = 0;
  const r = request(f);
  r.ownership.assertHeld = () => { if (++calls === fence) throw new StoreConflict('MODELED ownership lost'); };
  observe(f, r, StoreConflict); assert.equal(calls, fence);
});
test('restart prerequisite: a concurrent SQLite writer cannot turn deferral into a grant', t => {
  const f = prepare(t, 'retry', false); f.label = t.name;
  f.db.pragma('journal_mode=WAL');
  const other = f.connect(), r = request(f);
  other.exec('BEGIN IMMEDIATE');
  try { observe(f, r); assert.equal(other.inTransaction, true); }
  finally { other.exec('ROLLBACK'); }
  observe(f, r, deferred, other);
});
for (const point of ['before', 'after']) for (const signal of ['exit', 'SIGKILL']) {
  test(`restart prerequisite: actual ${signal} ${point} deferral, WAL reopen unchanged`, t => {
    const f = prepare(t, 'consume', true); f.label = t.name;
    f.db.pragma('journal_mode=WAL');
    const before = state(f.db), expected = terminalExpectation(f.row()), file = join(f.dir, 'request.json');
    writeFileSync(file, JSON.stringify({ expected, clock: f.clock.value }));
    f.db.close();
    const env = Object.fromEntries(['PATH', 'HOME', 'TZ', 'CRON_STORE_SQLITE_PACKAGE'].map(k => [k, process.env[k]]));
    const cmd = ['--import', new URL('./register.mjs', import.meta.url).pathname,
      new URL('./restart-prerequisite-child.mjs', import.meta.url).pathname, f.path, file, point, signal];
    const child = spawnSync(process.execPath, cmd, { env, encoding: 'utf8', timeout: 10000 });
    f.db = f.connect();
    const after = state(f.db);
    if (process.env.RESTART_CRASH_TRACE) appendFileSync(process.env.RESTART_CRASH_TRACE, JSON.stringify({
      test: t.name, pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message,
      stdout: child.stdout, stderr: child.stderr, command: cmd, environment: env, before, after,
    }) + '\n');
    assert.ifError(child.error);
    assert.equal(child.status, signal === 'exit' ? 73 : null);
    assert.equal(child.signal, signal === 'exit' ? null : 'SIGKILL');
    assert.deepEqual(after, before); assert.equal(f.db.inTransaction, false);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
    if (point === 'after') assert.deepEqual(JSON.parse(child.stdout), deferred);
  });
}
