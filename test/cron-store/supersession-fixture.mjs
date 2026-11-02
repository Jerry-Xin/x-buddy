// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { CronStore, StoreConflict, terminalExpectation } from '../../src/cron/store/index.ts';
import { setup, ModeledIssuer, scope, state } from './execution-fixture.mjs';
import { fixture, input } from './helpers.mjs';
export { scope, state };

function atClock(t, overrides, createdAt) {
  const f = fixture(t); f.clock.value = createdAt; f.held = true;
  f.owner = { ownerIncarnation: 'modeled-owner', resetGeneration: 2, assertHeld() { if (!f.held) throw new StoreConflict('ownership lost'); } };
  f.issuer = new ModeledIssuer(); f.store = new CronStore(f.db, f.clock, {}, f.issuer.port(f.db));
  f.job = f.store.create(input({ deliveryMode: 'none', ...overrides })); f.clock.value = f.job.next_run_at;
  f.reservation = { trigger: 'scheduled', generation: f.job.generation, slot: f.clock.value, runId: 'base', ownership: f.owner,
    authority: { jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true, targetAuthorized: true,
      ownerIncarnation: f.owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } } };
  assert.equal(f.store.admitBase(scope, f.job.id, f.reservation).kind, 'reserved');
  f.id = 'base'; f.row = () => f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.id);
  f.admit = (r = f.issuer.issue(f), s = f.store) => f.id === 'base' ? s.startBase(scope, f.job.id, r) : s.admitRetry(scope, f.job.id, r);
  f.finish = (outcome, extra = {}) => f.store.finalize(scope, f.job.id, { expected: terminalExpectation(f.row()), ownership: f.owner, outcome, retryChain: true, ...extra });
  f.queueRetry = () => {
    assert.equal(f.admit().kind, 'admitted'); f.clock.value++;
    assert.equal(f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: 'retry1' }).kind, 'finalized');
    f.id = 'retry1'; f.clock.value = f.row().ready_at; return f.row();
  };
  return f;
}
export function queued(t, attempt = 1, overrides = {}, createdAt) {
  const f = createdAt === undefined ? setup(t, overrides) : atClock(t, overrides, createdAt);
  f.queueRetry();
  for (let k = 2; k <= attempt; k++) {
    assert.equal(f.admit().kind, 'admitted');
    f.clock.value++;
    // Higher-attempt representation control: the mandatory alert gate remains
    // real and is observed first. Only the aggregate counter is then seeded;
    // no running receipt, permission, predecessor or watermark is fabricated.
    assert.equal(f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: `retry${k}` }).reason, 'alert-intent-required');
    f.db.exec('UPDATE cron_jobs SET consecutive_errors=0');
    assert.equal(f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: `retry${k}` }).kind, 'finalized');
    f.id = `retry${k}`;
    f.clock.value = f.row().ready_at;
  }
  f.retry = f.row();
  f.slot = f.store.get(scope, f.job.id).next_run_at;
  f.clock.value = f.slot;
  f.request = (changes = {}) => ({ ...f.reservation, slot: f.slot, runId: 'next-base', ...changes });
  f.reserve = (store = f.store, changes = {}) => store.admitBase(scope, f.job.id, f.request(changes));
  return f;
}

export function observed(f, work, label, seams = {}) {
  const before = state(f.db), sql = [], dml = [];
  const proxy = {
    get inTransaction() { return f.db.inTransaction; },
    exec(text) { sql.push(text); return f.db.exec(text); },
    prepare(text) {
      const s = f.db.prepare(text);
      const call = method => (...args) => {
        sql.push(text);
        if (/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(text)) dml.push({ sql: text, args });
        return s[method](...args);
      };
      return { run: call('run'), get: call('get'), all: call('all') };
    },
  };
  const store = new CronStore(proxy, f.clock, seams, f.issuer.port(f.db));
  let result, error;
  try { result = work(store); } catch (e) { error = e; }
  const record = { label, before, after: state(f.db), sql, dml, result,
    error: error && { name: error.constructor.name, message: error.message } };
  if (process.env.SUPERSESSION_TRACE) appendFileSync(process.env.SUPERSESSION_TRACE, JSON.stringify(record) + '\n');
  assert.equal(f.db.inTransaction, false);
  return { ...record, error };
}

export function noWrites(f, work, expected, label) {
  const r = observed(f, work, label);
  if (typeof expected === 'function') assert.ok(r.error instanceof expected, r.error?.stack ?? JSON.stringify(r.result));
  else { if (r.error) throw r.error; assert.deepEqual(r.result, expected); }
  assert.deepEqual(r.dml, []);
  assert.deepEqual(r.after, r.before);
  return r;
}
