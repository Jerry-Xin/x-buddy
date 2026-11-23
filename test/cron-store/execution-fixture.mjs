// SPDX-License-Identifier: Apache-2.0
// MODELED CALLER BOUNDARY ONLY. Never imported by production code.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { appendFileSync } from 'node:fs';
import { CronStore, StoreConflict, terminalExpectation } from '../../src/cron/store/index.ts';
import { fixture, input, scope, state, now } from './helpers.mjs';
export { scope, state, now };
const binding = r => ({ expected: r.expected, authority: r.authority,
  ownership: { ownerIncarnation: r.ownership.ownerIncarnation, resetGeneration: r.ownership.resetGeneration },
  proof: { permitGrantedAtMs: r.executionProof.permitGrantedAtMs, admissionDeadlineMs: r.executionProof.admissionDeadlineMs,
    runtimeGeneration: r.executionProof.runtimeGeneration } });

/** Stateful, non-production issuer: registers exact envelopes, rejects forged handles,
 * and independently models current authority/permit/reset/runtime/lane/abort state.
 */
export class ModeledIssuer {
  grants = new WeakMap();
  status = 'valid';
  checks = 0;
  prepareCalls = 0;
  requestCallbacks = 0;
  returnValue;
  port(db) {
    return { prepare: request => {
      assert.equal(db.inTransaction, false, 'issuer preparation must precede BEGIN');
      assert.ok(Object.isFrozen(request) && Object.isFrozen(request.expected) && Object.isFrozen(request.authority.definition));
      this.prepareCalls++;
      const record = this.grants.get(request.executionProof.assertCurrent);
      if (!record || !isDeepStrictEqual(binding(request), record.binding)) return undefined;
      return { assertCurrent: () => {
        this.checks++;
        if (this.status !== 'valid') throw new StoreConflict(`MODELED issuer ${this.status}`);
        return this.returnValue;
      } };
    } };
  }
  issue(f, row = f.row(), overrides = {}) {
    const handle = () => { this.requestCallbacks++; throw new Error('Request callbacks are not a verifier'); };
    const request = { expected: terminalExpectation(row), ownership: f.owner,
      authority: { jobId: row.job_id, definition: f.store.definition(scope, row.job_id), creatorAuthorized: true,
        targetAuthorized: true, ownerIncarnation: row.owner_incarnation, resetGeneration: row.reset_generation,
        policy: JSON.parse(row.definition_snapshot_json).policy },
      executionProof: { permitGrantedAtMs: f.clock.value, admissionDeadlineMs: f.clock.value + 300000,
        runtimeGeneration: 7, assertCurrent: handle }, ...overrides };
    this.grants.set(request.executionProof.assertCurrent, { binding: structuredClone(binding(request)) });
    return request;
  }
}
export function setup(t, overrides = {}, seams = {}) {
  const f = fixture(t); f.held = true;
  f.owner = { ownerIncarnation: 'modeled-owner', resetGeneration: 2, assertHeld() {
    if (!f.held) throw new StoreConflict('MODELED ownership lost');
  } };
  f.issuer = new ModeledIssuer();
  f.store = new CronStore(f.db, f.clock, seams, f.issuer.port(f.db));
  f.job = f.store.create(input({ schedule: { kind: 'every', everyMs: 3600000, anchorMs: 0 }, deliveryMode: 'none', ...overrides }));
  f.clock.value = f.job.next_run_at;
  f.reservation = { trigger: 'scheduled', generation: f.job.generation, slot: f.clock.value, runId: 'base', ownership: f.owner,
    authority: { jobId: f.job.id, definition: f.store.definition(scope, f.job.id), creatorAuthorized: true,
      targetAuthorized: true, ownerIncarnation: f.owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } } };
  f.store.admitBase(scope, f.job.id, f.reservation);
  f.id = 'base';
  f.row = () => f.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(f.id);
  f.admit = (request = f.issuer.issue(f), store = f.store) => f.id === 'base'
    ? store.startBase(scope, f.job.id, request) : store.admitRetry(scope, f.job.id, request);
  f.finish = (outcome, extra = {}) => f.store.finalize(scope, f.job.id,
    { expected: terminalExpectation(f.row()), ownership: f.owner, outcome, retryChain: true, ...extra });
  f.queueRetry = () => {
    const base = f.admit(); assert.equal(base.kind, 'admitted');
    f.clock.value++;
    assert.equal(f.finish({ kind: 'failure', reason: 'network' }, { retryRunId: 'retry1' }).kind, 'finalized');
    f.id = 'retry1'; f.clock.value = f.row().ready_at;
    return f.row();
  };
  return f;
}
export function noWrites(f, request, expected, storeOptions = {}) {
  const before = state(f.db), dml = [];
  const proxy = { get inTransaction() { return f.db.inTransaction; }, exec(sql) {
    assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i); f.db.exec(sql);
  }, prepare(sql) {
    const s = f.db.prepare(sql);
    const call = method => (...a) => { if (/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) dml.push(sql); return s[method](...a); };
    return { run: call('run'), get: call('get'), all: call('all') };
  } };
  const verifier = Object.hasOwn(storeOptions, 'verifier') ? storeOptions.verifier : f.issuer.port(f.db);
  const store = new CronStore(proxy, f.clock, storeOptions.seams ?? {}, verifier);
  let result, error;
  try { result = storeOptions.call ? storeOptions.call(store) : f.admit(request, store); } catch (e) { error = e; }
  if (process.env.EXECUTION_TRACE) appendFileSync(process.env.EXECUTION_TRACE,
    JSON.stringify({ runId:f.id, expected: typeof expected === 'function' ? expected.name : expected,
      result, error:error && {name:error.constructor.name,message:error.message}, dml, before, after:state(f.db) })+'\n');
  if (typeof expected === 'function') assert.ok(error instanceof expected, error?.stack ?? JSON.stringify(result));
  else { if(error)throw error; assert.deepEqual(result, expected); }
  assert.deepEqual(dml, []); assert.deepEqual(state(f.db), before);
  assert.equal(f.db.inTransaction, false);
}
