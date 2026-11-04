// SPDX-License-Identifier: Apache-2.0
// Real owned native lifecycle; admission authority/issuer remain explicitly modeled.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { CronStore, terminalExpectation } from '../../src/cron/store/index.ts';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { owned } from '../runtime/lifecycle-fixture.mjs';
import { fixture, input, scope, state, now } from './helpers.mjs';
import { ModeledIssuer } from './execution-fixture.mjs';
export { scope, state, now };
export const record = x => { if (process.env.REPAIR_TRACE) appendFileSync(process.env.REPAIR_TRACE, JSON.stringify(x) + '\n'); };
export async function repairFixture(t, { manual = false, running = true, retry = false, ...overrides } = {}) {
  const cleanup = [];
  const o = await owned({ after(fn) { cleanup.push(fn); } }, 650);
  let lock;
  const f = fixture({ after(fn) { cleanup.push(fn); } });
  t.after(async () => {
    if (f.db.open) record({ phase: 'repair-final-snapshot', snapshot: state(f.db), sql: f.sql ?? [] });
    // Close every fixture connection before releasing the same canonical lease.
    cleanup[1](); lock?.release(); await cleanup[0]();
    record({ phase: 'repair-cleanup', dbAbsent: !f.db.open, ownedPath: f.dir });
  });
  f.owner = { ownerIncarnation: o.record.incarnation, resetGeneration: 2, assertHeld() {} };
  f.issuer = new ModeledIssuer();
  f.store = new CronStore(f.db, f.clock, {}, f.issuer.port(f.db));
  f.job = f.store.create(input({ schedule: { kind: 'every', everyMs: 3600000, anchorMs: 0 }, deliveryMode: 'none', ...overrides }));
  f.id = 'base'; f.row = () => f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.id);
  if (!manual || manual === 'due') f.clock.value = f.job.next_run_at;
  const authority = () => ({ jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true,
    targetAuthorized: true, ownerIncarnation: f.owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } });
  const reservation = manual ? { trigger: 'manual', manualMode: manual, generation: f.job.generation,
    runId: f.id, invocationId: 'manual:00000000-0000-4000-8000-000000000007', authority: authority(), ownership: f.owner }
    : { trigger: 'scheduled', generation: f.job.generation, slot: f.clock.value, runId: f.id, authority: authority(), ownership: f.owner };
  assert.equal(f.store[manual ? 'admitManual' : 'admitBase'](scope, f.job.id, reservation).kind, 'reserved');
  f.start = (store = f.store, request = f.issuer.issue(f)) => store[f.id !== 'base' ? 'admitRetry' : manual ? 'startManual' : 'startBase'](scope, f.job.id, request);
  if (retry) {
    assert.equal(f.start().kind, 'admitted'); f.clock.value++;
    assert.equal(f.store.finalize(scope, f.job.id, { expected: terminalExpectation(f.row()), ownership: f.owner,
      outcome: { kind: 'failure', reason: 'network' }, retryRunId: 'retry1' }).kind, 'finalized');
    f.id = 'retry1'; f.clock.value = f.row().ready_at;
  }
  if (running) assert.equal(f.start().kind, 'admitted');
  f.original = state(f.db); f.expected = terminalExpectation(f.row());
  f.db.close(); // Persistent reopen occurs only after real native reconciliation.
  await o.killParent(); lock = new BotOwnershipLock(o.dir);
  const receipt = await lock.reconcilePreviousChild('owned-test-bot');
  assert.equal(receipt.exit.code, 7); assert.equal(receipt.exit.signal, null);
  const expected = { botId: 'owned-test-bot', currentIncarnationId: lock.incarnationId,
    previousIncarnationId: receipt.previous.incarnation, previousHost: receipt.previous.host,
    previousChild: receipt.previous.child, lease: receipt.lease };
  f.binding = { lock, expected }; f.lock = lock; f.o = o;
  f.owner = { ownerIncarnation: lock.incarnationId, resetGeneration: 2, assertHeld() { lock.assertHeld(); } };
  f.db = f.connect(); assert.deepEqual(state(f.db), f.original);
  f.sql = [];
  f.proxy = db => ({ get inTransaction() { return db.inTransaction; },
    exec(sql) { f.sql.push(sql); return db.exec(sql); },
    prepare(sql) { const statement = db.prepare(sql); return Object.fromEntries(['run', 'get', 'all'].map(method =>
      [method, (...args) => { f.sql.push(sql); return statement[method](...args); }])); } });
  f.makeStore = (seams = {}, binding = f.binding, db = f.db) => new CronStore(f.proxy(db), f.clock, seams, f.issuer.port(db), binding);
  f.store = f.makeStore();
  f.request = () => ({ expected: f.expected, ownership: f.owner });
  f.repair = (store = f.store, request = f.request()) => store.reconcileRestart(scope, f.job.id, request);
  record({ phase: 'native-reopen', receipt, scope: expected, before: f.original, reopened: state(f.db) });
  return f;
}
export function observe(f, call) {
  const before = state(f.db), beforeChanges = f.db.prepare('SELECT total_changes() n').get().n;
  const sqlStart = f.sql.length;
  let result, error;
  try { result = call(); } catch (e) { error = e; }
  const after = state(f.db), afterChanges = f.db.prepare('SELECT total_changes() n').get().n;
  const sql = f.sql.slice(sqlStart);
  record({ phase: 'repair-observation', before, after, beforeChanges, afterChanges, result, sql,
    error: error && { name: error.constructor.name, message: error.message } });
  return { before, after, beforeChanges, afterChanges, result, error, sql };
}
