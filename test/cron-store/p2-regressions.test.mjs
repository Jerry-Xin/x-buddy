// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRON_DDL, initializeCronSchema, StoreIntegrityError } from '../../src/cron/store/index.ts';
import { fixture, input, scope, state } from './helpers.mjs';

for (const literal of ['no ne', 'no\tne', 'no\nne']) {
  test(`P2 schema literal ${JSON.stringify(literal)} must not compare equal to none`, t => {
    const { db } = fixture(t, false);
    db.exec(CRON_DDL.replace("IN ('announce','none')", `IN ('announce','${literal}')`));
    const before = db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
    assert.throws(() => initializeCronSchema(db), StoreIntegrityError);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(), before);
    assert.equal(db.inTransaction, false);
  });
}
test('P2 correct R8 schema accepts initialization and valid none delivery', t => {
  const { db, store } = fixture(t);
  initializeCronSchema(db);
  assert.equal(store.create(input({ deliveryMode: 'none' })).delivery_mode, 'none');
});

const malformed = [
  ['missing resolved width', { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, 300000],
  ['input-only exact overrides stored width', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 1000, exact: true }, 0],
  ['extra exact even when width agrees', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 1000, exact: false }, 1000],
  ['disagreeing width column', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 1000 }, 0],
  ['unknown stored field', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 0, unexpected: 1 }, 0],
  ['missing stored zone', { kind: 'cron', expr: '0 * * * *', staggerMs: 0 }, 0],
  ['disagreeing stored zone', { kind: 'cron', expr: '0 * * * *', tz: 'Asia/Shanghai', staggerMs: 0 }, 0],
  ['fractional resolved width', { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 0.5 }, 0],
];
for (const [label, wire, column] of malformed) test(`P2 persisted cron rejects ${label} without writes`, t => {
  const { db, store } = fixture(t);
  const row = store.create(input({ schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } }));
  db.prepare('UPDATE cron_jobs SET schedule_json=?,stagger_ms=? WHERE id=?').run(JSON.stringify(wire), column, row.id);
  const before = state(db), changes = db.prepare('SELECT total_changes() n').get().n;
  assert.throws(() => store.definition(scope, row.id), StoreIntegrityError);
  assert.deepEqual(state(db), before);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes);
  assert.throws(() => store.edit(scope, row.id, 1, { name: 'must not repair malformed wire' }), StoreIntegrityError);
  assert.deepEqual(state(db), before);
});
test('P2 authored cron defaults and exact still normalize into complete persisted wire', t => {
  const { store } = fixture(t);
  let row = store.create(input({ schedule: { kind: 'cron', expr: ' 0 * * * * ', tz: 'UTC' } }));
  assert.deepEqual(store.definition(scope, row.id).schedule, { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 300000 });
  row = store.edit(scope, row.id, 1, { schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 1000, exact: true } });
  assert.deepEqual(JSON.parse(row.schedule_json), { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 0 });
  assert.deepEqual(store.definition(scope, row.id).schedule, JSON.parse(row.schedule_json));
});
