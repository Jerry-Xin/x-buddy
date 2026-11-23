// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, readFileSync, renameSync, symlinkSync, unlinkSync, statSync } from 'node:fs';
import { CronStore, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { borrowedUnchanged } from './manual-fixture.mjs';
import { repairFixture, observe, now, scope, state } from './restart-fixture.mjs';

function zero(f, call, expected) {
  const r = observe(f, call);
  assert.deepEqual(r.after, r.before); assert.equal(r.afterChanges, r.beforeChanges);
  assert.equal(r.sql.filter(sql => /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)).length, 0);
  assert.equal(f.db.inTransaction, false);
  if (typeof expected === 'function') assert.ok(r.error instanceof expected, r.error?.stack);
  else { assert.ifError(r.error); if (expected) assert.equal(r.result.kind, expected); }
  return r;
}

for (const [label, options, kind, status] of [
  ['running consume', {}, 'repaired', 'interrupted'],
  ['lost queued consuming manual', { manual: 'due', running: false }, 'repaired', 'skipped'],
  ['future borrowed run after date crossing', { manual: 'if-enabled', schedule: { kind: 'at', atMs: now + 60000 } }, 'repaired', 'interrupted'],
  ['queued timed reservation', { running: false }, 'resumed', 'queued'],
]) test(`actual restart repair: ${label}`, async t => {
  const f = await repairFixture(t, options); f.clock.value += 3600000;
  const first = observe(f, () => f.repair());
  assert.ifError(first.error); assert.equal(first.result.kind, kind); assert.equal(f.row().status, status);
  if (status !== 'queued') assert.equal(f.row().reason, 'restart');
  const duplicate = observe(f, () => f.repair());
  assert.ifError(duplicate.error); assert.equal(duplicate.result.kind, 'existing');
  assert.deepEqual(duplicate.after, duplicate.before); assert.equal(duplicate.afterChanges, duplicate.beforeChanges);
  const job = f.store.get(scope, f.job.id);
  if (f.row().schedule_ownership === 'borrow') borrowedUnchanged(first.before.jobs[0], job);
  else if (status !== 'queued') assert.equal(job.last_slot_watermark, f.row().authored_slot);
  if (label === 'running consume') {
    assert.equal(job.consecutive_errors, 1); assert.ok(job.next_run_at > f.clock.value);
    assert.equal(job.enabled, 1); assert.equal(job.deleted_at, null);
  }
  if (label === 'queued timed reservation') {
    assert.equal(f.row().owner_incarnation, f.lock.incarnationId);
    assert.deepEqual(first.before.jobs, first.after.jobs);
    assert.equal(f.row().attempt, 0); assert.equal(f.row().ready_at, f.expected.ready_at);
    const noIssuer = new CronStore(f.db, f.clock, {}, undefined, f.binding);
    assert.equal(f.start(noIssuer).prerequisite, 'issuer-unavailable');
    assert.equal(f.start().kind, 'admitted');
  }
});

test('actual restart repair: controlled delivering receipt becomes unknown without resend/history', async t => {
  const f = await repairFixture(t);
  // Controlled state fixture after public start, no provider/send or confirmed history.
  f.db.exec("UPDATE cron_runs SET phase='delivering',delivery_state='started',segments_sent=1");
  const result = f.repair(); assert.equal(result.kind, 'repaired');
  assert.equal(result.run.status, 'interrupted'); assert.equal(result.run.completion, 'unknown');
  assert.equal(result.run.delivery_state, 'unknown'); assert.equal(result.run.segments_sent, 1);
  assert.equal(result.run.history_state, 'skipped_not_delivered');
  zero(f, () => f.repair(), 'existing');
});
for (const enabled of [false, true]) for (const running of [false, true]) test(`actual restart repair: ${enabled ? 'enabled future' : 'disabled force'} borrow, ${running ? 'running' : 'queued'}`, async t => {
  const f = await repairFixture(t, { manual: enabled ? 'if-enabled' : 'force', running, enabled,
    schedule: { kind: 'at', atMs: now + 60000 } });
  f.clock.value += 120000;
  const before = state(f.db); assert.equal(f.repair().kind, 'repaired');
  borrowedUnchanged(before.jobs[0], f.store.get(scope, f.job.id));
  assert.equal(f.row().schedule_ownership, 'borrow'); assert.equal(f.row().owner_incarnation, f.expected.owner_incarnation);
  zero(f, () => f.repair(), 'existing');
  if (enabled) {
    const job = f.store.get(scope, f.job.id);
    const request = { trigger: 'scheduled', generation: job.generation, slot: job.next_run_at, runId: 'authored-after-borrow', ownership: f.owner,
      authority: { jobId: job.id, definition: f.store.definition(scope, job.id), creatorAuthorized: true, targetAuthorized: true,
        ownerIncarnation: f.owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } } };
    assert.equal(f.store.admitBase(scope, job.id, request).kind, 'reserved');
    assert.equal(f.store.admitBase(scope, job.id, request).kind, 'existing');
  }
});
test('actual restart repair: disabled overdue force remains borrowed', async t => {
  const f = await repairFixture(t, { manual: 'force', enabled: false, schedule: { kind: 'at', atMs: now - 60000 } });
  const before = state(f.db); assert.equal(f.repair().kind, 'repaired'); borrowedUnchanged(before.jobs[0], f.store.get(scope, f.job.id));
});
test('actual restart repair: manual consume queued one-shot retires its base through common projection', async t => {
  const f = await repairFixture(t, { manual: 'due', running: false, schedule: { kind: 'at', atMs: now + 60000 } });
  assert.equal(f.repair().kind, 'repaired'); const job = f.store.get(scope, f.job.id);
  assert.equal(job.last_slot_watermark, f.row().authored_slot); assert.equal(job.enabled, 0); assert.equal(job.next_run_at, null);
  assert.equal(job.deleted_at, null); assert.equal(job.consecutive_errors, 0);
});
for (const errors of [0, 1, 9]) test(`actual restart repair: mandatory notice/alert defers before CAS, counter=${errors}`, async t => {
  const f = await repairFixture(t, errors === 0 ? { manual: 'due', schedule: { kind: 'at', atMs: now + 60000 } } : {});
  if (errors) f.db.prepare('UPDATE cron_jobs SET consecutive_errors=?').run(errors); // Controlled threshold fixture.
  const r = zero(f, () => f.repair(), 'deferred');
  assert.equal(r.result.reason, errors === 1 ? 'alert-intent-required' : 'disable-notice-required');
});
test('actual restart repair: public later overlap preserves max watermark and cadence', async t => {
  const f = await repairFixture(t); f.clock.value += 3600000;
  const job = f.store.get(scope, f.job.id);
  assert.equal(f.store.admitBase(scope, job.id, { trigger: 'scheduled', generation: job.generation, slot: job.next_run_at,
    runId: 'overlap', ownership: f.owner, authority: { jobId: job.id, definition: f.store.definition(scope, job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: f.owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } } }).kind, 'overlap');
  const before = f.store.get(scope, job.id); assert.ok(before.last_slot_watermark > f.row().authored_slot);
  assert.equal(f.repair().kind, 'repaired'); const after = f.store.get(scope, job.id);
  assert.equal(after.last_slot_watermark, before.last_slot_watermark); assert.ok(after.next_run_at >= before.next_run_at);
  zero(f, () => f.repair(), 'existing');
});
for (const running of [false, true]) test(`actual restart repair: retained retry ${running ? 'running terminal repair' : 'queued transfer and fenced start'}`, async t => {
  const f = await repairFixture(t, { retry: true, running });
  if (running) { // A second authored error requires an unsupported alert, before CAS.
    const r = zero(f, () => f.repair(), 'deferred'); assert.equal(r.result.reason, 'alert-intent-required');
  } else {
    const watermark = f.store.get(scope, f.job.id).last_slot_watermark;
    assert.equal(f.repair().kind, 'resumed'); assert.equal(f.row().attempt, 1);
    const request = f.issuer.issue(f); assert.equal(f.start(f.store, request).kind, 'admitted');
    assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, watermark);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cron_runs').get().n, 2);
  }
});
test('actual restart repair: replacement generation keeps authored effects and newer information', async t => {
  const f = await repairFixture(t); f.store.edit(scope, f.job.id, f.job.generation, { name: 'replacement' });
  // Controlled newer completion; replacement itself used the public edit API.
  f.db.prepare("UPDATE cron_jobs SET last_run_at=?,last_status='newer'").run(f.clock.value + 1);
  const before = f.store.get(scope, f.job.id); assert.equal(f.repair().kind, 'repaired');
  assert.deepEqual(f.store.get(scope, f.job.id), before); assert.equal(f.row().reason, 'restart');
});
test('actual restart repair: current incarnation cannot be stolen', async t => {
  const f = await repairFixture(t, { running: false }); assert.equal(f.repair().kind, 'resumed');
  assert.equal(f.start().kind, 'admitted');
  zero(f, () => f.repair(f.store, { expected: terminalExpectation(f.row()), ownership: f.owner }), 'miss');
});
for (const fault of ['none-manual', 'readiness', 'snapshot', 'reset', 'owner', 'status']) test(`actual restart repair: controlled integrity/fence refusal ${fault}`, async t => {
  const f = await repairFixture(t, { manual: 'due' });
  // Corruption only after valid public reservation/start; never a public-chain proof.
  if (fault === 'none-manual') f.db.exec("UPDATE cron_runs SET schedule_ownership='none'");
  if (fault === 'readiness') f.db.exec('UPDATE cron_runs SET started_at=ready_at-1');
  if (fault === 'snapshot') f.db.exec("UPDATE cron_runs SET definition_snapshot_json='{}'");
  if (fault === 'reset') f.owner.resetGeneration++;
  if (fault === 'owner') f.db.exec("UPDATE cron_runs SET owner_incarnation='another-owner'");
  if (fault === 'status') f.expected = { ...f.expected, status: 'queued' };
  zero(f, () => f.repair(), ['none-manual', 'readiness', 'snapshot'].includes(fault) ? StoreIntegrityError : 'miss');
});
for (const fault of ['missing', 'serialized', 'other-instance', 'copied-prototype', 'wrong-scope', 'released']) test(`actual restart repair: canonical prerequisite refusal ${fault}`, async t => {
  const f = await repairFixture(t); let binding = f.binding;
  if (fault === 'missing') {
    const store = new CronStore(f.proxy(f.db), f.clock); zero(f, () => f.repair(store), 'deferred'); return;
  }
  if (fault === 'serialized') binding = { ...binding, lock: JSON.parse(JSON.stringify(f.lock)) };
  if (fault === 'other-instance') binding = { ...binding, lock: new BotOwnershipLock(f.o.dir) };
  if (fault === 'copied-prototype') binding = { ...binding, lock: Object.assign(Object.create(Object.getPrototypeOf(f.lock)), f.lock) };
  if (fault === 'wrong-scope') { binding = { ...binding, expected: structuredClone(binding.expected) }; binding.expected.previousChild.start[1]++; }
  if (fault === 'released') f.lock.release();
  zero(f, () => f.repair(f.makeStore({}, binding)), Error);
  if (fault === 'wrong-scope') assert.equal(f.repair().kind, 'repaired'); // Wrong expectation did not revoke healthy native origin.
});
for (const point of ['entry', 'beforeRestartCas', 'beforeRestartCommit']) for (const fault of ['mode', 'symlink', 'directory-inode'])
test(`actual restart repair: ${fault} lost at ${point}, restoration never restores native fact`, async t => {
  const f = await repairFixture(t), dir = f.o.dir, moved = dir + '-moved';
  const inode = statSync(f.lock.path).ino, bytes = readFileSync(f.lock.path);
  const invalidate = () => {
    if (fault === 'mode') chmodSync(dir, 0o755);
    else {
      renameSync(dir, moved);
      if (fault === 'symlink') symlinkSync(moved, dir);
      else { // Same lock inode and bytes in a different private directory.
        renameSync(moved + '/home', moved + '/home-saved');
        // Directory substitution uses a second private directory while retaining the file inode.
        // The minimal path operations are undone before owned cleanup below.
        renameSync(moved + '/home-saved', dir);
        renameSync(moved + '/gateway.lock', dir + '/gateway.lock');
      }
    }
  };
  const restore = () => {
    if (fault === 'mode') chmodSync(dir, 0o700);
    else if (fault === 'symlink') { unlinkSync(dir); renameSync(moved, dir); }
    else { renameSync(dir + '/gateway.lock', moved + '/gateway.lock'); renameSync(dir, moved + '/home'); renameSync(moved, dir); }
  };
  const before = state(f.db);
  try {
    const store = f.makeStore(point === 'entry' ? {} : { [point]: invalidate });
    if (point === 'entry') invalidate();
    const r = observe(f, () => f.repair(store)); assert.ok(r.error);
    assert.deepEqual(state(f.db), before); assert.equal(f.db.inTransaction, false);
    if (point !== 'beforeRestartCommit') { assert.equal(r.afterChanges, r.beforeChanges); assert.equal(r.sql.filter(s => /^UPDATE/.test(s)).length, 0); }
    else assert.ok(r.afterChanges > r.beforeChanges, 'SQLite counts rolled-back attempts; never call these zero attempted DML');
  } finally { restore(); }
  assert.equal(statSync(f.lock.path).ino, inode); assert.deepEqual(readFileSync(f.lock.path), bytes);
  zero(f, () => f.repair(), Error);
});
for (const point of ['beforeRestartCas', 'afterRestartCas', 'afterJobProjection', 'beforeRestartCommit']) test(`actual restart repair: fault at ${point} rolls back the full snapshot`, async t => {
  const f = await repairFixture(t); const before = state(f.db);
  const r = observe(f, () => f.repair(f.makeStore({ [point]() { throw new Error('owned injected repair failure'); } })));
  assert.match(r.error?.message, /owned injected/); assert.deepEqual(state(f.db), before); assert.equal(f.db.inTransaction, false);
  assert.equal(f.repair().kind, 'repaired');
});
test('actual restart repair: reset loss at precommit rolls back', async t => {
  const f = await repairFixture(t), before = state(f.db);
  const r = observe(f, () => f.repair(f.makeStore({ beforeRestartCommit() { f.owner.resetGeneration++; } })));
  assert.ok(r.error); assert.deepEqual(state(f.db), before);
});
test('actual restart repair: two writers contend, reread and commit once', async t => {
  const f = await repairFixture(t), other = f.connect(); f.db.pragma('journal_mode=WAL');
  other.exec('BEGIN IMMEDIATE');
  try { zero(f, () => f.repair(), Error); } finally { other.exec('ROLLBACK'); }
  assert.equal(f.repair().kind, 'repaired');
  zero(f, () => f.repair(f.makeStore({}, f.binding, other)), 'existing');
  assert.equal(f.store.get(scope, f.job.id).consecutive_errors, 1);
});
test('actual restart repair: SQLite COMMIT failure rolls back receipt and projection', async t => {
  const f = await repairFixture(t), before = state(f.db);
  const db = { get inTransaction() { return f.db.inTransaction; }, prepare(sql) { return f.db.prepare(sql); },
    exec(sql) { if (sql === 'COMMIT') throw new Error('owned injected commit failure'); return f.db.exec(sql); } };
  const r = observe(f, () => f.repair(f.makeStore({}, f.binding, db)));
  assert.match(r.error?.message, /owned injected commit/); assert.deepEqual(state(f.db), before);
  assert.equal(f.db.inTransaction, false); assert.equal(f.repair().kind, 'repaired');
});
test('actual restart repair: constructor captures expected scope independently of later caller edits', async t => {
  const f = await repairFixture(t), expected = structuredClone(f.binding.expected);
  const store = f.makeStore({}, { lock: f.lock, expected }); expected.botId = 'later-caller-edit'; expected.lease[1]++;
  assert.equal(f.repair(store).kind, 'repaired');
});
test('actual restart repair: stale queued timed reservation never transfers into a new generation', async t => {
  const f = await repairFixture(t, { running: false });
  // Controlled generation corruption; the public edit API correctly refuses active queued work.
  f.db.exec('UPDATE cron_jobs SET generation=generation+1');
  const r = zero(f, () => f.repair(), 'deferred'); assert.equal(r.result.reason, 'outcome-policy');
});
test('actual restart repair: resumed base keeps fixed issuer/authority/deadline fences', async t => {
  const f = await repairFixture(t, { running: false }); assert.equal(f.repair().kind, 'resumed');
  const request = f.issuer.issue(f); f.clock.value = request.executionProof.admissionDeadlineMs;
  zero(f, () => f.start(f.store, request), 'deferred');
  f.clock.value = request.executionProof.permitGrantedAtMs;
  for (const status of ['authority-revoked', 'reset', 'permit', 'lane', 'aborted']) {
    f.issuer.status = status; zero(f, () => f.start(f.store, request), Error);
  }
  f.issuer.status = 'valid'; assert.equal(f.start(f.store, request).kind, 'admitted');
  assert.equal(f.issuer.requestCallbacks, 0);
});
