// SPDX-License-Identifier: Apache-2.0
// Local API fixtures; issuer/owner are modeled, never production operator authority.
import assert from 'node:assert/strict';
import { CronStore, StoreConflict, terminalExpectation } from '../../src/cron/store/index.ts';
import { fixture, input, scope, state, now } from './helpers.mjs';
import { ModeledIssuer } from './execution-fixture.mjs';
export { scope, state, now };
export const invocation = 'manual:00000000-0000-4000-8000-000000000001';
export function manualFixture(t, overrides = {}, seams = {}) {
  const f = fixture(t); f.held = true;
  f.owner = { ownerIncarnation: 'modeled-owner', resetGeneration: 2, assertHeld() {
    if (!f.held) throw new StoreConflict('MODELED ownership lost');
  } };
  f.issuer = new ModeledIssuer();
  f.store = new CronStore(f.db, f.clock, seams, f.issuer.port(f.db));
  f.job = f.store.create(input({ schedule: { kind: 'at', atMs: now + 60000 }, deliveryMode: 'none', ...overrides }));
  f.id = 'manual-run'; f.row = () => f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.id);
  f.request = (extra = {}) => ({ trigger: 'manual', manualMode: 'if-enabled', generation: f.job.generation,
    runId: f.id, invocationId: invocation, ownership: f.owner,
    authority: { jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: f.owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } }, ...extra });
  f.reserve = (extra = {}, store = f.store) => store.admitManual(scope, f.job.id, f.request(extra));
  f.start = (store = f.store, request = f.issuer.issue(f)) => store.startManual(scope, f.job.id, request);
  f.finish = (outcome, extra = {}, store = f.store) => store.finalize(scope, f.job.id,
    { expected: terminalExpectation(f.row()), ownership: f.owner, outcome, ...extra });
  return f;
}
export const success = { kind: 'success', deliveryState: 'not-requested' };
export function authored(job) {
  const informational = ['last_run_at', 'last_status', 'last_completion', 'last_error', 'last_error_reason', 'last_duration_ms'];
  return Object.fromEntries(Object.entries(job).filter(([k]) => !informational.includes(k)));
}
export function borrowedUnchanged(before, after) {
  assert.deepEqual(authored(after), authored(before));
}
