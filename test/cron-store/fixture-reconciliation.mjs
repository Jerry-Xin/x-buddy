// SPDX-License-Identifier: Apache-2.0
// Additive equivalents only. Immutable original cases remain in the inherited selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { manualFixture, borrowedUnchanged, scope, state, now, success } from './manual-fixture.mjs';
import { observed } from './supersession-fixture.mjs';

const reasons = ['rate_limited', 'overloaded', 'network', 'runtime_unavailable', 'quarantined', 'timeout',
  'model_error', 'auth', 'invalid-definition', 'session-busy', 'target-unavailable'];
const phaseFor = reason => reason === 'session-busy' ? 'admission' : reason === 'target-unavailable' ? 'delivering' : 'executing';

function reserve(t, { paused = false, recurring = false, reason, mode = 'force', queued = false,
  counters = false, origin } = {}) {
  const f = manualFixture(t, {
    schedule: recurring ? origin === 'terminal' ? { kind: 'every', everyMs: 60000, anchorMs: 0 }
      : { kind: 'every', everyMs: 90000, anchorMs: now - 45000 } : { kind: 'at', atMs: now + 60000 },
    deliveryMode: reason === 'target-unavailable' ? 'announce' : 'none', deleteAfterRun: !recurring,
  });
  // Preserve the original paused fixture's retained next_run_at. This is an
  // explicit stored-definition precondition, not proof of a disable workflow.
  if (paused) f.db.exec('UPDATE cron_jobs SET enabled=0');
  if (counters) f.db.prepare(`UPDATE cron_jobs SET consecutive_errors=9,consecutive_skipped=8,
    consecutive_target_failures=2,schedule_error_count=2,alert_incident_key='preserve',
    alert_occurrence=3,last_alert_at=?`).run(now);
  if (origin === 'terminal') f.clock.value = f.job.next_run_at;
  if (origin === 'QA-04') f.clock.value = f.job.next_run_at - 5000;
  const admittedAt = f.clock.value;
  assert.equal(f.reserve({ manualMode: mode }).kind, 'reserved');
  assert.equal(f.row().schedule_ownership, 'borrow');
  assert.equal(f.row().ready_at, admittedAt);
  assert.equal(f.row().queued_at, admittedAt);
  assert.equal(f.row().admitted_enabled, +!paused);
  if (!queued) {
    if (origin === 'QA-04') f.clock.value += 1000;
    assert.equal(f.start().kind, 'admitted');
    assert.equal(f.row().started_at, f.clock.value);
    // No public executor phase-transition writer exists in this slice.
    // Start is real/bound-issuer; only its downstream phase is modeled.
    if (reason && phaseFor(reason) !== 'executing') {
      f.db.prepare('UPDATE cron_runs SET phase=? WHERE run_id=?').run(phaseFor(reason), f.id);
    }
  }
  if (origin === 'reviewer32') f.db.exec('UPDATE cron_jobs SET consecutive_skipped=4,alert_incident_key=NULL,alert_occurrence=0,last_alert_at=NULL');
  if (origin === 'QA-04') f.db.prepare("UPDATE cron_jobs SET consecutive_skipped=6,alert_incident_key='qa-incident',alert_occurrence=4").run();
  f.finishAt = origin === 'terminal' ? f.job.next_run_at + 1500 : origin === 'QA-04' ? f.job.next_run_at + 2300 : undefined;
  return f;
}

function finish(f, outcome, t, { crossDue = true } = {}) {
  const before = f.store.get(scope, f.job.id), original = f.row();
  f.clock.value = f.finishAt ?? (crossDue ? (original.authored_slot ?? now) + 1000 : now + 1);
  const expected = terminalExpectation(original);
  const result = observed(f, s => s.finalize(scope, f.job.id,
    { expected, ownership: f.owner, outcome, retryRunId: 'forbidden' }), t.name);
  assert.ifError(result.error);
  assert.equal(result.result.kind, 'finalized');
  const run = result.result.run, after = f.store.get(scope, f.job.id);
  const targetFailure = outcome.kind === 'failure' && outcome.reason === 'target-unavailable';
  borrowedUnchanged(before, after); // Includes W, cadence, enablement, deletion, all counters/alerts.
  assert.equal(state(f.db).runs.length, 1);
  assert.deepEqual(run, { ...original, status: outcome.kind === 'success' ? 'ok' : outcome.kind === 'failure'
    ? outcome.reason === 'session-busy' ? 'skipped' : targetFailure ? 'ok' : 'error' : original.status === 'queued' ? 'skipped' : 'interrupted',
    phase: null, completion: outcome.kind === 'success' ? 'succeeded' : outcome.kind === 'failure' && outcome.reason !== 'session-busy' ? 'failed' : null,
    delivery_state: targetFailure ? 'not-delivered' : 'not-requested',
    history_state: targetFailure ? 'skipped_not_delivered' : 'skipped_not_requested', reason: outcome.reason ?? null,
    error: outcome.redactedError ?? null, ended_at: f.clock.value });
  assert.equal(after.last_status, run.status);
  assert.equal(after.last_completion, run.completion);
  assert.equal(after.last_run_at, run.ended_at);
  assert.equal(after.last_error_reason, run.reason);
  assert.equal(after.last_error, run.error);
  assert.equal(after.last_duration_ms, run.ended_at - (original.started_at ?? original.queued_at));
  const duplicate = observed(f, s => s.finalize(scope, f.job.id,
    { expected, ownership: f.owner, outcome: { kind: 'neutral', reason: 'reset' } }), t.name + ' / replay');
  assert.ifError(duplicate.error);
  assert.deepEqual(duplicate.result, { kind: 'existing', run });
  assert.deepEqual(duplicate.dml, []);
  assert.deepEqual(duplicate.before, duplicate.after);
  return run;
}

function none(f, readinessDefect = false) {
  const snapshot = { ...JSON.parse(f.row().definition_snapshot_json), scheduleOwnership: 'none' };
  // Original none-owned recurring fixtures had no authored reference. Preserve
  // that input so the manual gate, rather than generic provenance, rejects it.
  if (f.job.schedule_kind !== 'at') snapshot.authoredSlot = snapshot.authoredOccurrenceId = null;
  f.db.prepare(`UPDATE cron_runs SET schedule_ownership='none',definition_snapshot_json=?,ready_at=?,
    authored_slot=?,authored_occurrence_id=? WHERE run_id=?`)
    .run(JSON.stringify(snapshot), readinessDefect ? now + 60000 : f.row().ready_at,
      snapshot.authoredSlot, snapshot.authoredOccurrenceId, f.id);
}

function rejects(f, outcome, t, message = /Invalid manual entry/) {
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  const r = observed(f, s => f.finish(outcome, {}, s), t.name);
  assert.ok(r.error instanceof StoreIntegrityError, r.error?.stack ?? JSON.stringify(r.result));
  assert.match(r.error.message, message);
  assert.deepEqual(r.before, r.after);
  assert.deepEqual(r.dml, []);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
}

// Exact 24-case mapping is recorded in docs/cron-store/fixture-reconciliation.md.
for (const paused of [false, true]) for (const reason of ['network', 'auth', 'target-unavailable']) {
  test(`RECON failure paused=${paused}/${reason} / valid`, t => {
    const f = reserve(t, { paused, reason });
    assert.equal(f.row().phase, phaseFor(reason));
    finish(f, { kind: 'failure', reason, redactedError: 'redacted fixture' }, t);
  });
}
for (const reason of reasons) {
  test(`RECON reviewer32 ${reason} / valid`, t => {
    const f = reserve(t, { paused: true, reason, counters: true, origin: 'reviewer32' });
    assert.equal(f.row().phase, phaseFor(reason));
    finish(f, { kind: 'failure', reason }, t);
  });
}
for (const outcome of [success, { kind: 'neutral', reason: 'shutdown' }]) {
  test(`RECON terminal ${outcome.kind} / valid`, t => {
    finish(reserve(t, { recurring: true, mode: 'if-enabled', counters: true, origin: 'terminal' }), outcome, t, { crossDue: false });
  });
  test(`RECON terminal ${outcome.kind} / none integrity`, t => {
    const f = reserve(t, { recurring: true, mode: 'if-enabled', counters: true, origin: 'terminal' }); none(f); rejects(f, outcome, t);
  });
}
test('RECON QA-04 success / valid', t => {
  finish(reserve(t, { recurring: true, mode: 'if-enabled', counters: true, origin: 'QA-04' }), success, t, { crossDue: false });
});
test('RECON QA-04 success / none integrity', t => {
  const f = reserve(t, { recurring: true, mode: 'if-enabled', counters: true, origin: 'QA-04' }); none(f); rejects(f, success, t);
});
for (const reason of ['stopped', 'reset', 'reload', 'shutdown']) {
  test(`RECON reviewer47 ${reason} / valid`, t => {
    const f = reserve(t, { queued: true });
    const run = finish(f, { kind: 'neutral', reason }, t, { crossDue: false });
    assert.equal(run.started_at, null);
    assert.equal(run.ended_at, now + 1);
  });
  test(`RECON reviewer47 ${reason} / none integrity`, t => {
    const f = reserve(t, { queued: true }); none(f); rejects(f, { kind: 'neutral', reason }, t);
  });
}
test('RECON reviewer32 auth / none and readiness integrity', t => {
  const f = reserve(t, { paused: true, reason: 'auth', counters: true, origin: 'reviewer32' });
  none(f, true); f.clock.value = now + 61000; rejects(f, { kind: 'failure', reason: 'auth' }, t);
});
test('RECON reviewer32 auth / readiness integrity after ownership correction', t => {
  const f = reserve(t, { paused: true, reason: 'auth', counters: true, origin: 'reviewer32' });
  f.db.prepare('UPDATE cron_runs SET ready_at=? WHERE run_id=?').run(now + 60000, f.id);
  f.clock.value = now + 61000; rejects(f, { kind: 'failure', reason: 'auth' }, t, /Invalid borrowed admission/);
});

for (const outcome of [success, { kind: 'neutral', reason: 'shutdown' }]) for (const delta of [-1, 0, 1]) {
  test(`RECON informational ${outcome.kind} / prior-minus-ended=${delta}`, t => {
    const f = reserve(t, { recurring: true, mode: 'if-enabled', origin: 'terminal', counters: true });
    f.clock.value = f.finishAt;
    f.db.prepare(`UPDATE cron_jobs SET last_run_at=?,last_status='error',last_completion='failed',
      last_error='retained',last_error_reason='network',last_duration_ms=123`).run(f.clock.value + delta);
    const before = f.store.get(scope, f.job.id);
    const r = observed(f, s => f.finish(outcome, {}, s), t.name);
    assert.ifError(r.error); assert.equal(r.result.kind, 'finalized');
    const after = f.store.get(scope, f.job.id); borrowedUnchanged(before, after);
    assert.equal(state(f.db).runs.length, 1);
    if (delta < 0) { assert.equal(after.last_run_at, f.clock.value); assert.equal(after.last_status, r.result.run.status); }
    else for (const k of ['last_run_at', 'last_status', 'last_completion', 'last_error', 'last_error_reason', 'last_duration_ms']) {
      assert.equal(after[k], before[k], k);
    }
  });
}
