// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CronStore, StoreConflict, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { queued } from './supersession-fixture.mjs';
import { setup } from './execution-fixture.mjs';
import { manualFixture, success, scope, state, now, invocation, borrowedUnchanged } from './manual-fixture.mjs';
import { noWrites, observed } from './supersession-fixture.mjs';

for (const [name, overrides, mode, advance, outcome] of [
  ['MAN-01 early success', {}, 'if-enabled', 0, success],
  ['MAN-02 early transient', {}, 'if-enabled', 0, { kind: 'failure', reason: 'network' }],
  ['MAN-03 early permanent', {}, 'if-enabled', 0, { kind: 'failure', reason: 'auth' }],
  ['MAN-04 disabled future force', { enabled: false }, 'force', 0, success],
  ['MAN-05 disabled overdue force', { enabled: false }, 'force', 120000, { kind: 'failure', reason: 'network' }],
  ['MAN-10 recurring immediate failure', { schedule: { kind: 'every', everyMs: 60000, anchorMs: 0 } }, 'if-enabled', 60000, { kind: 'failure', reason: 'network' }],
]) test(`REAL public manual ${name}`, t => {
  const f = manualFixture(t, overrides), before = f.store.get(scope, f.job.id); f.clock.value += advance;
  const r = f.reserve({ manualMode: mode }); assert.equal(r.kind, 'reserved');
  assert.equal(r.run.trigger, 'manual'); assert.equal(r.run.manual_mode, mode);
  assert.equal(r.run.schedule_ownership, 'borrow'); assert.equal(r.run.scheduled_for, null);
  assert.equal(r.run.occurrence_id, invocation); assert.equal(r.run.admitted_enabled, before.enabled);
  assert.equal(r.run.admitted_next_run_at, before.next_run_at); assert.deepEqual(f.store.get(scope, f.job.id), before);
  assert.equal(f.start().kind, 'admitted'); f.clock.value++;
  assert.equal(f.finish(outcome, { retryRunId: 'forbidden-retry' }).kind, 'finalized');
  borrowedUnchanged(before, f.store.get(scope, f.job.id));
  assert.equal(state(f.db).runs.length, 1); assert.equal(f.issuer.requestCallbacks, 0);
});
for (const mode of ['due', 'if-enabled', 'force']) test(`REAL MAN-07/08 consuming ${mode} shares canonical slot and keeps terminal at disabled`, t => {
  const f = manualFixture(t, { deleteAfterRun: false }); f.clock.value = now + 60000;
  const r = f.reserve({ manualMode: mode }); assert.equal(r.kind, 'reserved');
  assert.equal(r.run.schedule_ownership, 'consume'); assert.equal(r.run.occurrence_id, JSON.stringify([f.job.id, 1, f.clock.value]));
  assert.equal(f.start().kind, 'admitted'); const expected = terminalExpectation(f.row()); f.clock.value++;
  assert.equal(f.finish(success).kind, 'finalized');
  const job = f.store.get(scope, f.job.id); assert.equal(job.last_slot_watermark, now + 60000);
  assert.equal(job.enabled, 0); assert.equal(job.next_run_at, null);
  noWrites(f, s => s.finalize(scope, f.job.id, { expected, ownership: f.owner, outcome: success }),
    { kind: 'existing', run: f.row() }, 'manual-terminal-replay');
});
for (const mode of ['due', 'if-enabled', 'force']) test(`REAL enabled future manual table ${mode}`, t => {
  const f = manualFixture(t);
  if (mode === 'due') noWrites(f, s => f.reserve({ manualMode: mode }, s), { kind: 'not-due' }, 'future-due');
  else assert.equal(f.reserve({ manualMode: mode }).run.schedule_ownership, 'borrow');
});
for (const mode of ['due', 'if-enabled', 'force']) test(`REAL disabled manual table ${mode}`, t => {
  const f = manualFixture(t, { enabled: false });
  if (mode === 'force') assert.equal(f.reserve({ manualMode: mode }).run.admitted_enabled, 0);
  else noWrites(f, s => f.reserve({ manualMode: mode }, s), { kind: 'disabled' }, 'disabled');
});
test('REAL manual duplicate invocation returns its immutable receipt without DML after crossing at', t => {
  const f = manualFixture(t), r = f.reserve(); f.clock.value += 120000;
  noWrites(f, s => f.reserve({}, s), { kind: 'existing', run: r.run }, 'manual-duplicate-crossing');
  assert.equal(f.start().kind, 'admitted'); assert.equal(f.finish(success).kind, 'finalized');
  borrowedUnchanged(f.job, f.store.get(scope, f.job.id));
  const a = f.store.admitBase(scope, f.job.id, { trigger: 'catchup', generation: 1, slot: now + 60000,
    runId: 'authored', authority: f.request().authority, ownership: f.owner });
  assert.equal(a.kind, 'reserved'); assert.equal(a.run.schedule_ownership, 'consume');
});
test('REAL manual active invocation cannot produce a second receipt', t => {
  const f = manualFixture(t); const r = f.reserve();
  noWrites(f, s => f.reserve({ runId: 'second', invocationId: 'manual:00000000-0000-4000-8000-000000000002' }, s),
    { kind: 'already-running', activeRunId: r.run.run_id }, 'manual-active');
});
test('REAL manual entry preserves legacy startBase wrong-entry rejection and missing issuer no-writes', t => {
  const f = manualFixture(t); f.reserve(); const req = f.issuer.issue(f);
  noWrites(f, s => s.startBase(scope, f.job.id, req), StoreConflict, 'wrong-base-entry');
  const before = state(f.db), unbound = new CronStore(f.db, f.clock);
  assert.deepEqual(f.start(unbound, req), { kind: 'deferred', reason: 'execution-admission', prerequisite: 'issuer-unavailable' });
  assert.deepEqual(state(f.db), before);
});
for (const point of ['afterReceiptInsert', 'beforeManualCommit']) test(`manual reservation rollback ${point}`, t => {
  let calls = 0;
  const f = manualFixture(t), r = observed(f, s => f.reserve({}, s), point, { [point]() { calls++; f.held = false; } });
  assert.equal(calls, 1); assert.ok(r.error); assert.deepEqual(r.after, r.before);
});

for (const [kind, schedule] of [['at', { kind: 'at', atMs: now + 60000 }],
  ['every', { kind: 'every', everyMs: 60000, anchorMs: 0 }]])
for (const enabled of [false, true]) for (const delta of [-1, 0, 1]) for (const mode of ['due', 'if-enabled', 'force'])
test(`REAL mode table ${kind}/enabled=${enabled}/due${delta}/${mode}`, t => {
  const f = manualFixture(t, { schedule, enabled }); f.clock.value = now + 60000 + delta;
  const before = state(f.db), r = f.reserve({ manualMode: mode });
  if (!enabled && mode !== 'force') assert.deepEqual(r, { kind: 'disabled' });
  else if (mode === 'due' && delta < 0) assert.deepEqual(r, { kind: 'not-due' });
  else {
    assert.equal(r.kind, 'reserved');
    assert.equal(r.run.schedule_ownership, enabled && delta >= 0 && (mode === 'due' || kind === 'at') ? 'consume' : 'borrow');
    if (r.run.schedule_ownership === 'borrow' && kind === 'every' && enabled) {
      assert.equal(r.run.authored_slot, before.jobs[0].next_run_at);
      assert.equal(r.run.authored_occurrence_id, JSON.stringify([f.job.id, 1, before.jobs[0].next_run_at]));
    }
  }
  assert.deepEqual(state(f.db).jobs, before.jobs);
  if (r.kind !== 'reserved') assert.deepEqual(state(f.db), before);
});

for (const mode of ['due', 'if-enabled', 'force']) test(`REAL pending retry rejects manual ${mode} without supersession`, t => {
  const f = queued(t), req = { trigger: 'manual', manualMode: mode, generation: 1, runId: 'new-manual', invocationId: invocation,
    authority: f.request().authority, ownership: f.owner };
  noWrites(f, s => s.admitManual(scope, f.job.id, req), { kind: 'already-running', activeRunId: f.retry.run_id }, 'pending-retry');
});

test('REAL MAN-06 borrowed at persists across close/reopen and crossing; one-shot scheduler defers then reserves once', t => {
  const f = manualFixture(t); const r = f.reserve(); assert.equal(f.start().kind, 'admitted');
  const live = f.row(), before = f.store.get(scope, f.job.id);
  f.db.close(); const reopened = f.connect();
  f.db = reopened; f.store = new CronStore(reopened, f.clock, {}, f.issuer.port(reopened)); f.clock.value += 120000;
  assert.deepEqual(f.row(), live); assert.equal(f.row().schedule_ownership, 'borrow');
  const timed = { trigger: 'catchup', generation: 1, slot: now + 60000, runId: 'authored', ownership: f.owner, authority: f.request().authority };
  noWrites(f, s => s.admitBase(scope, f.job.id, timed), { kind: 'deferred', reason: 'one-shot-busy', activeRunId: r.run.run_id, recheckAfterMs: 30000 }, 'at-busy-during-borrow');
  assert.equal(f.finish({ kind: 'neutral', reason: 'shutdown' }).kind, 'finalized');
  borrowedUnchanged(before, f.store.get(scope, f.job.id));
  const a = f.store.admitBase(scope, f.job.id, timed); assert.equal(a.kind, 'reserved');
  noWrites(f, s => s.admitBase(scope, f.job.id, timed), { kind: 'existing', run: a.run }, 'at-once-after-borrow');
});

for (const mode of ['if-enabled', 'force']) for (const reason of ['stopped', 'reset', 'reload', 'shutdown'])
test(`REAL borrowed neutral ${mode}/${reason} preserves all authored fields`, t => {
  const f = manualFixture(t, { enabled: mode !== 'force' });
  // Aggregate-only threshold control, not a fabricated active receipt or permission.
  f.db.exec('UPDATE cron_jobs SET consecutive_errors=9,consecutive_skipped=8,consecutive_target_failures=2,alert_occurrence=4');
  const before = f.store.get(scope, f.job.id); f.reserve({ manualMode: mode });
  if (reason !== 'stopped') assert.equal(f.start().kind, 'admitted');
  assert.equal(f.finish({ kind: 'neutral', reason }).kind, 'finalized');
  borrowedUnchanged(before, f.store.get(scope, f.job.id)); assert.equal(state(f.db).runs.length, 1);
});

test('REAL recurring --due consume once dedupes a later timed tick and manual repeat', t => {
  const f = manualFixture(t, { schedule: { kind: 'every', everyMs: 60000, anchorMs: 0 } }); f.clock.value += 60000;
  const r = f.reserve({ manualMode: 'due' }); assert.equal(f.start().kind, 'admitted'); f.clock.value++;
  assert.equal(f.finish(success).kind, 'finalized');
  const job = f.store.get(scope, f.job.id); assert.equal(job.last_slot_watermark, r.run.authored_slot);
  assert.equal(job.next_run_at, now + 120000);
  noWrites(f, s => s.admitBase(scope, f.job.id, { trigger: 'scheduled', generation: 1, slot: r.run.authored_slot,
    runId: 'later-tick', authority: f.request().authority, ownership: f.owner }), { kind: 'existing', run: f.row() }, 'timed-after-manual');
  noWrites(f, s => f.reserve({ manualMode: 'due' }, s), { kind: 'existing', run: f.row() }, 'consume-exact-repeat');
});

test('REAL consuming at success deletes only with policy; retained disabled force is fresh borrow', t => {
  const f = manualFixture(t); f.clock.value += 60000; f.reserve(); f.start(); f.clock.value++;
  assert.equal(f.finish(success).kind, 'finalized');
  const j = f.store.get(scope, f.job.id); assert.equal(j.deleted_at, f.clock.value); assert.equal(j.last_slot_watermark, now + 60000);
});
test('REAL consuming manual failure retains canonical retry chain without a second watermark', t => {
  const f = manualFixture(t, { deleteAfterRun: false }); f.clock.value += 60000; f.reserve(); f.start(); f.clock.value++;
  assert.equal(f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: 'retry1' }).kind, 'finalized');
  const base = f.row(), job = f.store.get(scope, f.job.id); assert.equal(job.last_slot_watermark, now + 60000);
  f.id = 'retry1'; f.clock.value = f.row().ready_at;
  assert.equal(f.store.admitRetry(scope, f.job.id, f.issuer.issue(f)).kind, 'admitted'); f.clock.value++;
  assert.equal(f.finish(success, { retryChain: true }).kind, 'finalized');
  const kept = f.store.get(scope, f.job.id); assert.equal(kept.enabled, 0); assert.equal(kept.last_slot_watermark, job.last_slot_watermark);
  assert.deepEqual(f.db.prepare("SELECT * FROM cron_runs WHERE run_id='manual-run'").get(), base);
  f.id = 'explicit-repeat';
  assert.equal(f.reserve({ manualMode: 'force', invocationId: 'manual:00000000-0000-4000-8000-000000000002' }).run.schedule_ownership, 'borrow');
  f.start(); f.clock.value++; assert.equal(f.finish(success).kind, 'finalized');
  borrowedUnchanged(kept, f.store.get(scope, f.job.id));
});

test('REAL MAN-09 old borrowed completion preserves replacement generation', t => {
  const f = manualFixture(t); f.reserve(); f.start();
  f.clock.value++; f.store.edit(scope, f.job.id, 1, { schedule: { kind: 'at', atMs: now + 180000 } });
  const replacement = f.store.get(scope, f.job.id); f.clock.value += 200000;
  assert.equal(f.finish(success).kind, 'finalized'); borrowedUnchanged(replacement, f.store.get(scope, f.job.id));
});
for (const ownership of ['borrow', 'consume']) test(`REAL manual unknown delivery defers before CAS ${ownership}`, t => {
  const f = manualFixture(t); if (ownership === 'consume') f.clock.value += 60000;
  f.reserve(); f.start();
  noWrites(f, s => f.finish({ kind: 'success', deliveryState: 'unknown' }, {}, s), { kind: 'deferred', reason: 'publication-or-delivery' }, 'unknown-is-not-success');
});
test('REAL manual mandatory one-shot disable notice remains no-write deferred', t => {
  const f = manualFixture(t); f.clock.value += 60000; f.reserve(); f.start();
  noWrites(f, s => f.finish({ kind: 'failure', reason: 'auth' }, {}, s), { kind: 'deferred', reason: 'disable-notice-required' }, 'manual-disable-notice');
});

for (const field of ['definition', 'creatorAuthorized', 'targetAuthorized', 'ownerIncarnation', 'resetGeneration'])
test(`manual reservation authority ${field} corruption has zero DML`, t => {
  const f = manualFixture(t), req = f.request();
  req.authority = { ...req.authority, [field]: field === 'definition' ? {} : field === 'ownerIncarnation' ? 'foreign' : field === 'resetGeneration' ? 9 : false };
  noWrites(f, s => s.admitManual(scope, f.job.id, req), TypeError, `manual-authority-${field}`);
});
for (const field of ['generation', 'manualMode', 'invocationId', 'trigger']) test(`manual reservation request ${field} corruption has zero DML`, t => {
  const f = manualFixture(t), req = f.request({ [field]: field === 'generation' ? 2 : 'invalid' });
  noWrites(f, s => s.admitManual(scope, f.job.id, req), field === 'generation' ? StoreConflict : TypeError, `manual-request-${field}`);
});
for (const fault of ['job', 'receipt', 'clock', 'authority', 'policy', 'owner', 'reset', 'request'])
test(`manual reservation precommit ${fault} rolls back complete snapshots`, t => {
  const f = manualFixture(t), req = f.request();
  const r = observed(f, s => s.admitManual(scope, f.job.id, req), `manual-precommit-${fault}`, { beforeManualCommit() {
    if (fault === 'job') f.db.exec('UPDATE cron_jobs SET consecutive_errors=1');
    if (fault === 'receipt') f.db.exec('UPDATE cron_runs SET ready_at=ready_at+1');
    if (fault === 'clock') f.clock.value--;
    if (fault === 'authority') req.authority.targetAuthorized = false;
    if (fault === 'policy') req.authority.policy.tools = 'doc-task';
    if (fault === 'owner') f.held = false;
    if (fault === 'reset') { req.ownership.resetGeneration++; req.authority.resetGeneration++; }
    if (fault === 'request') req.invocationId = 'manual:00000000-0000-4000-8000-000000000002';
  } });
  assert.ok(r.error); assert.deepEqual(r.after, r.before);
});
for (const status of ['authority', 'reset', 'permit', 'runtime', 'lane', 'abort']) test(`manual execution issuer ${status} revocation is no-write`, t => {
  const f = manualFixture(t, { enabled: false }); f.reserve({ manualMode: 'force' }); const req = f.issuer.issue(f); f.issuer.status = status;
  noWrites(f, s => f.start(s, req), StoreConflict, `manual-issuer-${status}`);
});
for (const fault of ['job', 'receipt', 'clock', 'owner', 'reset']) for (const point of ['afterTerminalCas', 'afterJobProjection'])
test(`manual terminal precommit ${point}/${fault} rolls back all effects`, t => {
  const f = manualFixture(t, { deleteAfterRun: false }); f.clock.value += 60000; f.reserve(); f.start(); f.clock.value++;
  const r = observed(f, s => f.finish(success, {}, s), `manual-terminal-${point}-${fault}`, { [point]() {
    if (fault === 'job') f.db.exec('UPDATE cron_jobs SET consecutive_errors=5');
    if (fault === 'receipt') f.db.exec('UPDATE cron_runs SET ended_at=ended_at+1');
    if (fault === 'clock') f.clock.value--;
    if (fault === 'owner') f.held = false;
    if (fault === 'reset') f.owner.resetGeneration++;
  } });
  assert.ok(r.error); assert.deepEqual(r.after, r.before);
});
test('manual two-connection serialization and single-flight', t => {
  const f = manualFixture(t), db = f.connect(), second = new CronStore(db, f.clock);
  const store = new CronStore(f.db, f.clock, { afterReceiptInsert() {
    assert.throws(() => f.reserve({}, second), { code: 'SQLITE_BUSY' });
  } });
  const r = f.reserve({}, store);
  noWrites(f, s => f.reserve({}, s), { kind: 'existing', run: r.run }, 'manual-winner-dedupe');
  assert.deepEqual(f.reserve({}, second), { kind: 'existing', run: r.run });
  assert.deepEqual(state(db), state(f.db));
});

for (const [name, schedule, createdAt, slot] of [
  ['stagger', { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, '2026-10-29T12:00:00Z', '2026-10-29T12:04:13.353Z'],
  ['fall first', { kind: 'cron', expr: '30 1 * * *', tz: 'America/New_York', exact: true }, '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z'],
  ['spring skips gap', { kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York', exact: true }, '2027-03-14T06:00:00Z', '2027-03-15T06:30:00Z'],
]) for (const delta of [-1, 0, 1]) test(`REAL manual effective ${name}/${delta}`, t => {
  const f = manualFixture(t, { schedule, tz: schedule.tz, enabled: false });
  // Create/enable at the selected fixed instant through public CRUD; no receipt seeding.
  f.clock.value = Date.parse(createdAt); f.job = f.store.enable(scope, f.job.id, 1);
  assert.equal(f.job.next_run_at, Date.parse(slot)); f.clock.value = Date.parse(slot) + delta;
  const r = f.reserve({ manualMode: 'due' });
  if (delta < 0) assert.deepEqual(r, { kind: 'not-due' });
  else { assert.equal(r.run.authored_slot, Date.parse(slot)); assert.equal(r.run.schedule_ownership, 'consume'); f.start(); f.finish(success); }
});

for (const field of ['activation', 'backoff', 'watermark']) for (const mode of ['due', 'if-enabled', 'force'])
test(`SEEDED effective ${field} manual fence/${mode} is no-write`, t => {
  const f = manualFixture(t); f.clock.value += 60000;
  if (field === 'activation') f.db.prepare('UPDATE cron_jobs SET schedule_activated_at=?').run(f.clock.value + 1);
  if (field === 'backoff') f.db.prepare('UPDATE cron_jobs SET next_run_at=?').run(f.clock.value + 30000);
  if (field === 'watermark') f.db.prepare('UPDATE cron_jobs SET last_slot_watermark=?').run(f.clock.value);
  noWrites(f, s => f.reserve({ manualMode: mode }, s), { kind: 'not-due' }, `manual-fence-${field}-${mode}`);
});

for (const field of ['authored_slot', 'authored_occurrence_id', 'definition_snapshot_json', 'admitted_next_run_at', 'schedule_ownership', 'manual_mode'])
test(`SEEDED duplicate immutable manual ${field} corruption is quarantined without DML`, t => {
  const f = manualFixture(t); f.reserve();
  const values = { authored_slot: now + 60001, authored_occurrence_id: 'foreign', definition_snapshot_json: '{}', admitted_next_run_at: 1,
    schedule_ownership: 'consume', manual_mode: 'due' };
  f.db.prepare(`UPDATE cron_runs SET ${field}=?`).run(values[field]);
  noWrites(f, s => f.reserve({}, s), StoreIntegrityError, `manual-duplicate-corrupt-${field}`);
});
for (const field of ['owner_incarnation', 'reset_generation']) test(`SEEDED duplicate ${field} preserves foreign receipt`, t => {
  const f = manualFixture(t); f.reserve(); f.db.prepare(`UPDATE cron_runs SET ${field}=?`).run(field === 'reset_generation' ? 99 : 'foreign');
  noWrites(f, s => f.reserve({}, s), StoreConflict, `manual-duplicate-${field}`);
});
test('REAL borrowed new explicit repeat has new identity and cannot auto-retry', t => {
  const f = manualFixture(t); f.reserve(); f.start(); f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: 'automatic' });
  const first = f.row(); f.id = 'explicit-repeat'; f.clock.value++;
  const repeat = f.reserve({ invocationId: 'manual:00000000-0000-4000-8000-000000000002' }); assert.equal(repeat.kind, 'reserved');
  assert.notEqual(repeat.run.occurrence_id, first.occurrence_id); assert.equal(repeat.run.attempt, 0);
  assert.deepEqual(state(f.db).runs.find(r => r.run_id === first.run_id), first); assert.equal(state(f.db).runs.length, 2);
});
for (const proof of ['missing', 'unbound']) test(`REAL manual execution ${proof} proof is NO-WRITES`, t => {
  const f = manualFixture(t); f.reserve(); const req = f.issuer.issue(f);
  if (proof === 'missing') req.executionProof = undefined;
  else req.executionProof = { ...req.executionProof, assertCurrent() { throw new Error('Must never call request verifier'); } };
  noWrites(f, s => f.start(s, req), { kind: 'deferred', reason: 'execution-admission', prerequisite: proof === 'missing' ? 'proof-missing' : 'issuer-unavailable' }, `manual-proof-${proof}`);
  assert.equal(f.issuer.requestCallbacks, 0);
});
test('REAL manual entry rejects a scheduled receipt and retry entry rejects a manual receipt', t => {
  const f = setup(t), req = f.issuer.issue(f);
  noWrites(f, s => s.startManual(scope, f.job.id, req), StoreConflict, 'timed-wrong-manual-entry');
  const m = manualFixture(t); m.reserve(); const mr = m.issuer.issue(m);
  noWrites(m, s => s.admitRetry(scope, m.job.id, mr), StoreConflict, 'manual-wrong-retry-entry');
});
for (const status of ['queued', 'running']) for (const mode of ['due', 'if-enabled', 'force']) test(`REAL timed ${status} rejects manual ${mode}`, t => {
  const f = setup(t); if (status === 'running') f.admit();
  noWrites(f, s => s.admitManual(scope, f.job.id, { trigger: 'manual', manualMode: mode, generation: 1, runId: 'new-manual',
    invocationId: invocation, ownership: f.owner, authority: f.reservation.authority }), { kind: 'already-running', activeRunId: 'base' }, `timed-${status}-${mode}`);
});
for (const phase of ['reservation', 'start']) test(`REAL manual ${phase} foreign scope is no-write`, t => {
  const f = manualFixture(t); if (phase === 'start') f.reserve(); const before = state(f.db);
  assert.throws(() => phase === 'reservation' ? f.store.admitManual({ targetSession: 'other' }, f.job.id, f.request())
    : f.store.startManual({ targetSession: 'other' }, f.job.id, f.issuer.issue(f)));
  assert.deepEqual(state(f.db), before);
});
for (const ownership of ['borrow', 'consume']) test(`REAL manual stale ${ownership} completion protects new generation W and cadence`, t => {
  const f = manualFixture(t, { deleteAfterRun: true }); if (ownership === 'consume') f.clock.value += 60000;
  f.reserve(); f.start(); f.clock.value++;
  f.store.edit(scope, f.job.id, 1, { schedule: { kind: 'at', atMs: now + 180000 } }); const before = f.store.get(scope, f.job.id);
  f.finish(success); borrowedUnchanged(before, f.store.get(scope, f.job.id)); assert.equal(f.store.get(scope, f.job.id).deleted_at, null);
});
for (const ownership of ['borrow', 'consume']) for (const delivery of ['not-requested', 'suppressed']) test(`REAL manual success ${ownership}/${delivery}`, t => {
  const f = manualFixture(t, { deleteAfterRun: false, deliveryMode: delivery === 'suppressed' ? 'announce' : 'none' });
  if (ownership === 'consume') f.clock.value += 60000; const before = f.store.get(scope, f.job.id);
  f.reserve(); f.start(); f.clock.value++; assert.equal(f.finish({ kind: 'success', deliveryState: delivery }).kind, 'finalized');
  assert.equal(f.row().completion, 'succeeded'); assert.equal(f.row().delivery_state, delivery);
  if (ownership === 'borrow') borrowedUnchanged(before, f.store.get(scope, f.job.id));
  else assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, now + 60000);
});
test('REAL completed invocation identity cannot be reused in a replacement generation', t => {
  const f = manualFixture(t); f.reserve(); f.start(); f.finish(success); f.clock.value++;
  f.job = f.store.edit(scope, f.job.id, 1, { name: 'replacement' });
  noWrites(f, s => f.reserve({}, s), StoreConflict, 'manual-old-invocation-new-generation');
});
for (const delta of [-1, 0, 1]) test(`SEEDED strictly newer borrowed information ${delta} preserves alert timestamp`, t => {
  const f = manualFixture(t);
  f.db.prepare("UPDATE cron_jobs SET last_run_at=?,last_status='error',last_error_reason='network',last_alert_at=?,alert_incident_key='retained',consecutive_errors=9,consecutive_target_failures=2")
    .run(f.clock.value + 1 + delta, now - 100);
  const before = f.store.get(scope, f.job.id); f.reserve(); f.start(); f.clock.value++;
  assert.equal(f.finish({ kind: 'failure', reason: 'auth' }).kind, 'finalized');
  const after = f.store.get(scope, f.job.id); borrowedUnchanged(before, after);
  assert.equal(after.last_status, delta < 0 ? 'error' : before.last_status);
  if (delta >= 0) for (const k of ['last_run_at','last_status','last_error_reason','last_completion','last_duration_ms']) assert.equal(after[k], before[k]);
  else assert.equal(after.last_error_reason, 'auth');
  assert.equal(state(f.db).runs.length, 1);
});
for (const variant of ['borrow', 'consume', 'disabled-force']) test(`REAL SQL complete snapshots manual ${variant} chain`, t => {
  const f = manualFixture(t, { enabled: variant !== 'disabled-force', deleteAfterRun: false });
  if (variant === 'consume') f.clock.value += 60000;
  const req = f.request({ manualMode: variant === 'disabled-force' ? 'force' : variant === 'consume' ? 'due' : 'if-enabled' });
  const reserved = observed(f, s => s.admitManual(scope, f.job.id, req), `manual-sql-reserve-${variant}`);
  if (reserved.error) throw reserved.error;
  assert.equal(reserved.result.kind, 'reserved'); assert.deepEqual(reserved.before.jobs, reserved.after.jobs);
  assert.equal(reserved.sql.filter(x => x === 'BEGIN IMMEDIATE').length, 1); assert.equal(reserved.sql.filter(x => x === 'COMMIT').length, 1);
  assert.equal(reserved.dml.length, 1); assert.match(reserved.dml[0].sql, /INSERT INTO cron_runs/);
  const execution = observed(f, s => f.start(s), `manual-sql-start-${variant}`);
  if (execution.error) throw execution.error;
  assert.equal(execution.result.kind, 'admitted'); assert.deepEqual(execution.before.jobs, execution.after.jobs);
  assert.equal(execution.dml.length, 1); assert.match(execution.dml[0].sql, /UPDATE cron_runs/);
  f.clock.value++;
  const terminal = observed(f, s => f.finish(success, {}, s), `manual-sql-terminal-${variant}`);
  if (terminal.error) throw terminal.error;
  assert.equal(terminal.result.kind, 'finalized'); assert.equal(terminal.dml.length, 2);
  assert.match(terminal.dml[0].sql, /UPDATE cron_runs/); assert.match(terminal.dml[1].sql, /UPDATE cron_jobs/);
  if (variant === 'consume') assert.match(terminal.dml[1].sql, /last_slot_watermark=CASE WHEN last_slot_watermark IS NULL/);
  else { borrowedUnchanged(reserved.before.jobs[0], terminal.after.jobs[0]);
    assert.doesNotMatch(terminal.dml[1].sql, /last_slot_watermark|next_run_at|enabled=|consecutive_|alert_/); }
});
test('REAL manual lower-slot completion cannot lower a later overlap watermark or cadence', t => {
  const f = manualFixture(t, { schedule: { kind: 'every', everyMs: 60000, anchorMs: 0 } });
  f.clock.value += 60000; f.reserve({ manualMode: 'due' }); f.start(); const live = f.row();
  f.clock.value += 60000;
  const overlap = f.store.admitBase(scope, f.job.id, { trigger: 'catchup', generation: 1, slot: f.clock.value,
    runId: 'later-overlap', authority: f.request().authority, ownership: f.owner });
  assert.equal(overlap.kind, 'overlap'); assert.deepEqual(f.row(), live);
  const later = f.store.get(scope, f.job.id); assert.equal(later.last_slot_watermark, now + 120000);
  f.clock.value++; assert.equal(f.finish(success).kind, 'finalized');
  assert.equal(f.store.get(scope, f.job.id).last_slot_watermark, later.last_slot_watermark);
  assert.equal(f.store.get(scope, f.job.id).next_run_at, later.next_run_at);
});

for (const [phase, points] of [['reservation', ['before', 'mutated', 'precommit', 'committed']],
  ['start', ['before', 'mutated', 'committed']], ['terminal', ['before', 'mutated', 'projection', 'committed']]])
for (const ownership of ['borrow', 'consume']) for (const point of points) for (const mode of ['exit', 'kill'])
test(`REAL ${mode}/WAL manual ${phase}/${ownership}/${point}`, t => {
  const f = manualFixture(t, { deleteAfterRun: false }); f.db.pragma('journal_mode=WAL');
  if (ownership === 'consume') f.clock.value += 60000;
  if (phase !== 'reservation') f.reserve({ manualMode: ownership === 'consume' ? 'due' : 'if-enabled' });
  if (phase === 'terminal') { f.start(); f.clock.value++; }
  if (ownership === 'borrow' && phase !== 'reservation') f.clock.value += 120000;
  const before = state(f.db);
  const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./register.mjs', import.meta.url)),
    fileURLToPath(new URL('./manual-crash-child.mjs', import.meta.url)), f.path, String(f.clock.value), phase, point, mode, ownership],
    { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.stderr, ''); assert.ok(child.pid > 0);
  assert.equal(child.status, mode === 'exit' ? 79 : null); assert.equal(child.signal, mode === 'kill' ? 'SIGKILL' : null);
  const reopened = f.connect(), after = state(reopened);
  if (point !== 'committed') assert.deepEqual(after, before);
  else {
    assert.equal(after.runs.length, 1); const row = after.runs[0];
    assert.equal(row.schedule_ownership, ownership); assert.equal(row.admitted_enabled, 1);
    assert.equal(row.authored_slot, now + 60000); assert.equal(row.scheduled_for, ownership === 'consume' ? now + 60000 : null);
    assert.equal(row.occurrence_id, ownership === 'consume' ? JSON.stringify([f.job.id, 1, now + 60000]) : invocation);
    assert.equal(row.owner_incarnation, f.owner.ownerIncarnation); assert.equal(row.reset_generation, 2);
    if (phase === 'reservation') { assert.equal(row.status, 'queued'); assert.equal(row.started_at, null); assert.deepEqual(after.jobs, before.jobs); }
    if (phase === 'start') {
      assert.deepEqual(row, { ...before.runs[0], status: 'running', phase: 'executing', started_at: f.clock.value });
      assert.deepEqual(after.jobs, before.jobs);
    }
    if (phase === 'terminal') {
      assert.deepEqual(row, { ...before.runs[0], status: 'ok', phase: null, completion: 'succeeded', delivery_state: 'not-requested',
        history_state: 'skipped_not_requested', ended_at: f.clock.value });
      assert.deepEqual(after.jobs, [{ ...before.jobs[0], ...(ownership === 'consume' ? { enabled: 0, next_run_at: null, last_slot_watermark: now + 60000 } : {}),
        last_run_at: f.clock.value, last_status: 'ok', last_completion: 'succeeded', last_duration_ms: f.clock.value - row.started_at }]);
    }
  }
  observed(f, () => ({ phase, ownership, point, mode, pid: child.pid, status: child.status, signal: child.signal, before, reopened: after }),
    `manual-crash-${phase}-${ownership}-${point}-${mode}`);
});
