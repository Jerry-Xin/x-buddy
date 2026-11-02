// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { CronStore, StoreIntegrityError, terminalExpectation } from '../../src/cron/store/index.ts';
import { setup, scope, state } from './execution-fixture.mjs';

// Finite terminal representation oracle from R8 §§3.2.4, 3.4, 3.5.3–4 and M2-10.
// This table is independent of the implementation's predicates. None of the
// seeded delivery/publication/restart representations proves a real producer.
const dispositions = [
  ['ok', 'succeeded', 'suppressed', 'skipped_suppressed', [0]],
  ['ok', 'succeeded', 'delivered', 'published', [1, 3]],
  ['ok', 'succeeded', 'delivered', 'skipped_reset', [1, 3]],
  ['ok', 'succeeded', 'delivered', 'skipped_session_mode', [1, 3]],
  ['ok', 'failed', 'not-delivered', 'skipped_not_delivered', [0]],
  ['ok', 'unknown', 'unknown', 'skipped_not_delivered', [0, 1, 3]],
  ['error', 'failed', 'not-requested', 'skipped_not_requested', [0]],
  ['error', 'failed', 'suppressed', 'skipped_suppressed', [0]],
  ['skipped', null, 'not-requested', 'skipped_not_requested', [0]],
  ['skipped', null, 'suppressed', 'skipped_suppressed', [0]],
  ['interrupted', null, 'not-requested', 'skipped_not_requested', [0]],
  ['interrupted', null, 'suppressed', 'skipped_suppressed', [0]],
  ['interrupted', 'unknown', 'unknown', 'skipped_not_delivered', [0, 1, 3]],
];
const histories = [null, 'not-published', 'published', 'skipped_reset',
  'skipped_session_mode', 'skipped_suppressed', 'skipped_not_requested', 'skipped_not_delivered'];
const deliveries = ['not-started', 'started', 'delivered', 'not-delivered', 'unknown', 'suppressed', 'not-requested'];

for (const retry of [false, true]) for (const entry of ['execution', 'terminal']) {
  for (const status of ['ok', 'error', 'skipped', 'interrupted']) {
    for (const completion of [null, 'succeeded', 'failed', 'unknown']) for (const delivery of deliveries) {
      test(`SEEDED terminal matrix ${retry}/${entry}/${status}/${completion}/${delivery}`, t => {
        const f = setup(t, { deliveryMode: 'announce' });
        if (retry) f.queueRetry(); // Real public network failure → queued retry.
        const executionRequest = f.issuer.issue(f);
        assert.equal(f.admit(executionRequest).kind, 'admitted');
        const terminalRequest = { expected: terminalExpectation(f.row()), ownership: f.owner,
          retryChain: true, outcome: { kind: 'success', deliveryState: 'suppressed' } };
        assert.equal(f.store.finalize(scope, f.job.id, terminalRequest).kind, 'finalized');
        // Only the terminal representation varies. The admitted identity, chain,
        // start/end, job projection and original queued/running requests are kept.
        // This is a classification fixture, not a finalizer for these outcomes.
        const reason = { ok: null, error: 'network', skipped: 'stopped', interrupted: 'restart' }[status];
        for (const history of histories) for (const segments of [0, 1, 3]) {
          f.db.prepare(`UPDATE cron_runs SET status=?,completion=?,delivery_state=?,history_state=?,segments_sent=?,reason=? WHERE run_id=?`)
            .run(status, completion, delivery, history, segments, reason, f.id);
          const valid = dispositions.some(([s, c, d, h, n]) =>
            s === status && c === completion && d === delivery && h === history && n.includes(segments));
          const before = state(f.db), dml = [];
          const proxy = { get inTransaction() { return f.db.inTransaction; }, exec(sql) {
            if (/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) dml.push(sql); f.db.exec(sql);
          }, prepare(sql) {
            const statement = f.db.prepare(sql), call = method => (...args) => {
              if (/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) dml.push(sql);
              return statement[method](...args);
            };
            return { run: call('run'), get: call('get'), all: call('all') };
          } };
          const store = new CronStore(proxy, f.clock, {}, f.issuer.port(f.db));
          let result, error;
          try { result = entry === 'execution' ? f.admit(executionRequest, store)
            : store.finalize(scope, f.job.id, terminalRequest); } catch (e) { error = e; }
          const after = state(f.db), cell = { retry, entry, status, completion, delivery, history, segments, valid };
          if (process.env.REVIEW_TRACE) appendFileSync(process.env.REVIEW_TRACE,
            JSON.stringify({ case: t.name, cell, before, after, dml, result,
              error: error && { type: error.constructor.name, message: error.message } }) + '\n');
          assert.deepEqual(dml, [], JSON.stringify(cell));
          assert.deepEqual(after, before, JSON.stringify(cell));
          assert.equal(f.db.inTransaction, false);
          if (valid) {
            assert.ifError(error); assert.equal(result.kind, 'existing', JSON.stringify(cell));
            assert.deepEqual(result.run, f.row()); assert.ok(Object.isFrozen(result.run));
          } else {
            assert.ok(error instanceof StoreIntegrityError, JSON.stringify({ cell, result, error: error?.message }));
            assert.match(error.message, /quarantine/);
          }
        }
      });
    }
  }
}
