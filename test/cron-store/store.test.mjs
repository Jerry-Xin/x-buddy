// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CronStore, initializeCronSchema, StoreConflict, JobNotFound, DeferredOperation, StoreIntegrityError,
  CRON_DDL, CRON_DDL_SHA256, R8_CONTENT_SHA256 } from '../../src/cron/store/index.ts';
import { now, input, scope, globalScope, fixture, state, receipt } from './helpers.mjs';

test('exact R8 schema bytes, complete columns and indexes are created without host tables', t => {
  const { db } = fixture(t);
  assert.equal(CRON_DDL_SHA256, '7e9c38c1a53b5e0eef02531593dd9eab4afaf52e31db952d5d088bb22e229322');
  assert.equal(createHash('sha256').update(CRON_DDL).digest('hex'), CRON_DDL_SHA256);
  assert.equal(readFileSync(new URL('../../src/cron/store/schema.sql', import.meta.url), 'utf8'), CRON_DDL);
  assert.equal(R8_CONTENT_SHA256, 'c40ff6b67f2f32c28b7a57bba8605c2204212497ae0001cfc064c2e875b753a0');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name), ['cron_jobs', 'cron_runs']);
  assert.equal(db.prepare('PRAGMA table_info(cron_jobs)').all().length, 38);
  assert.equal(db.prepare('PRAGMA table_info(cron_runs)').all().length, 35);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.name),
    ['idx_cron_jobs_due','idx_cron_runs_job_time','idx_cron_runs_occurrence_attempt','idx_cron_runs_ready','idx_cron_runs_single_flight','idx_cron_runs_slot_attempt']);
});
test('initialization is explicit, transactional, idempotent and preserves unrelated schema', t => {
  const { db, store } = fixture(t, false);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master").get().n, 0);
  assert.ok(store instanceof CronStore);
  db.exec('PRAGMA user_version=17; CREATE TABLE unrelated (id INTEGER PRIMARY KEY); INSERT INTO unrelated VALUES (42)');
  initializeCronSchema(db); initializeCronSchema(db);
  assert.equal(db.pragma('user_version', { simple: true }), 17);
  assert.deepEqual(db.prepare('SELECT * FROM unrelated').all(), [{ id: 42 }]);
});
test('incompatible pre-existing schema is refused without creating other objects', t => {
  const { db } = fixture(t, false);
  db.exec('CREATE TABLE cron_runs (legacy TEXT)');
  const before = db.prepare('SELECT * FROM sqlite_master').all();
  assert.throws(() => initializeCronSchema(db), StoreIntegrityError);
  assert.deepEqual(db.prepare('SELECT * FROM sqlite_master').all(), before);
  assert.equal(db.inTransaction, false);
});
test('create persists tagged normalized definitions and roundtrips through reopen', t => {
  const { db, store, connect, clock } = fixture(t);
  const created = store.create(input());
  assert.equal(created.generation, 1); assert.equal(created.deleted_at, null); assert.equal(created.last_slot_watermark, null);
  assert.equal(created.schedule_activated_at, now); assert.equal(created.created_at, now); assert.equal(created.updated_at, now);
  assert.equal(created.next_run_at, now + 60_000); assert.equal(created.stagger_ms, 0);
  assert.equal(created.delete_after_run, 0); assert.equal(created.delivery_mode, 'announce');
  assert.deepEqual(JSON.parse(created.schedule_json), { kind: 'every', everyMs: 60_000, anchorMs: 0 });
  const definition = store.definition(scope, created.id);
  assert.equal(definition.schemaVersion, 1); assert.deepEqual(definition.payload, input().payload);
  assert.ok(Object.isFrozen(created)); assert.ok(Object.isFrozen(definition)); assert.ok(Object.isFrozen(definition.target));
  assert.throws(() => { definition.payload.message = 'overwrite'; }, TypeError);
  db.close();
  const reopened = new CronStore(connect(), clock);
  assert.deepEqual(reopened.get(scope, created.id), created);
  assert.deepEqual(reopened.definition(scope, created.id), definition);
});
test('default cron stagger and --exact use accepted effective-slot arithmetic', t => {
  const { store } = fixture(t);
  const a = store.create(input({ schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } }));
  assert.equal(a.stagger_ms, 300_000); assert.equal(a.next_run_at, now + 253353);
  assert.deepEqual(JSON.parse(a.schedule_json), { kind: 'cron', expr: '0 * * * *', tz: 'UTC', staggerMs: 300_000 });
  const b = store.create(input({ id: 'jabcdef', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC', exact: true } }));
  assert.equal(b.stagger_ms, 0); assert.equal(b.next_run_at, now + 3600_000);
});
test('at/reminder defaults, explicit keep and paused definitions preserve future eligibility', t => {
  const { store } = fixture(t);
  const a = store.create(input({ schedule: { kind: 'at', atMs: now + 60_000 }, payload: { kind: 'reminder', text: 'Remember' } }));
  assert.equal(a.delete_after_run, 1); assert.equal(a.next_run_at, now + 60_000); assert.equal(a.last_slot_watermark, null);
  const b = store.create(input({ id: 'jabcdef', enabled: false, deleteAfterRun: false, deliveryMode: 'none', schedule: { kind: 'at', atMs: now + 60_000 } }));
  assert.equal(b.delete_after_run, 0); assert.equal(b.next_run_at, null); assert.equal(b.enabled, 0);
});

const invalidCreates = [
  ['bad ID', { id: 'jo0000l' }], ['empty name', { name: ' ' }], ['unknown field', { generation: 99 }],
  ['null enabled', { enabled: null }], ['coerced boolean', { enabled: 1 }], ['null delete flag', { deleteAfterRun: null }],
  ['unknown zone', { tz: 'Nowhere/Unknown' }], ['unsupported schedule', { schedule: { kind: 'stream' } }],
  ['zero interval', { schedule: { kind: 'every', everyMs: 0, anchorMs: 0 } }],
  ['fractional interval', { schedule: { kind: 'every', everyMs: 0.5, anchorMs: 0 } }],
  ['infinite interval', { schedule: { kind: 'every', everyMs: Infinity, anchorMs: 0 } }],
  ['missing anchor', { schedule: { kind: 'every', everyMs: 60000 } }],
  ['invalid cron', { schedule: { kind: 'cron', expr: 'invalid', tz: 'UTC' } }],
  ['mismatched cron zone', { schedule: { kind: 'cron', expr: '* * * * *', tz: 'Asia/Shanghai' } }],
  ['excess stagger', { schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC', staggerMs: 300001 } }],
  ['bad exact', { schedule: { kind: 'cron', expr: '* * * * *', tz: 'UTC', exact: 'true' } }],
  ['unexpected at stagger', { schedule: { kind: 'at', atMs: now + 1000, staggerMs: 3 } }],
  ['too-old at', { schedule: { kind: 'at', atMs: now - 60001 } }],
  ['too-far at', { schedule: { kind: 'at', atMs: now + 10 * 365.25 * 86400_000 + 1 } }],
  ['empty creator', { creatorUid: '' }], ['wrong channel type', { target: { sessionKey: 's', channelId: 'c', channelType: 3 } }],
  ['unknown target authority field', { target: { sessionKey: 's', channelId: 'c', channelType: 2, token: 'fixture-only' } }],
  ['bad mode', { execMode: 'other' }], ['bad delivery', { deliveryMode: 'other' }], ['null delivery', { deliveryMode: null }],
  ['bad payload', { payload: { kind: 'other', text: 'x' } }], ['empty prompt', { payload: { kind: 'agentTurn', message: '' } }],
  ['too-long text', { payload: { kind: 'reminder', text: 'a'.repeat(4001) } }],
  ['secret-shaped extra field', { payload: { kind: 'reminder', text: 'x', token: 'fixture-only' } }],
  ['session model override', { execMode: 'session' }],
  ['bad effort', { payload: { kind: 'agentTurn', message: 'x', effort: 'invalid' } }],
  ['short timeout', { payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 9 } }],
  ['long timeout', { payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 7201 } }],
];
for (const [name, overrides] of invalidCreates) test(`invalid create: ${name} leaves no writes`, t => {
  const { db, store } = fixture(t); const before = state(db);
  assert.throws(() => store.create(input(overrides))); assert.deepEqual(state(db), before); assert.equal(db.inTransaction, false);
});
for (const timeout of [10, 7200]) test(`valid timeout boundary ${timeout} and 4000 Unicode characters`, t => {
  const { store } = fixture(t);
  store.create(input({ payload: { kind: 'agentTurn', message: '😀'.repeat(4000), timeoutSeconds: timeout }, execMode: 'session' }));
});

test('all mutable definition fields advance one generation and reset activation/watermark', t => {
  const { db, store, clock } = fixture(t); let row = store.create(input());
  db.prepare("UPDATE cron_jobs SET last_slot_watermark=?,last_run_at=?,last_status='ok',consecutive_errors=2 WHERE id=?").run(now, now - 1, row.id);
  for (const patch of [{ name: 'new' }, { schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' } }, { tz: 'Asia/Shanghai' },
    { payload: { kind: 'agentTurn', message: 'new', model: 'another', effort: 'low', timeoutSeconds: 20 } },
    { deliveryMode: 'none' }, { payload: { kind: 'agentTurn', message: 'session' }, execMode: 'session' }, { enabled: false }]) {
    clock.value += 1; const before = row;
    row = store.edit(scope, row.id, row.generation, patch);
    assert.equal(row.generation, before.generation + 1); assert.equal(row.last_slot_watermark, null);
    assert.equal(row.schedule_activated_at, clock.value); assert.equal(row.updated_at, clock.value);
    for (const field of ['id','created_at','creator_uid','target_session','target_channel_id','target_channel_type','delete_after_run']) assert.equal(row[field], before[field]);
    assert.equal(row.last_status, 'ok'); assert.equal(row.last_run_at, now - 1); assert.equal(row.consecutive_errors, 2);
  }
});
test('enable resets failure counters; repeated enable/disable still fence generations', t => {
  const { db, store, clock } = fixture(t); let row = store.create(input());
  db.prepare("UPDATE cron_jobs SET enabled=0,last_slot_watermark=?,consecutive_errors=10,consecutive_skipped=3,consecutive_target_failures=3,schedule_error_count=3,auto_disabled_reason='fixture',auto_disabled_at=? WHERE id=?").run(now, now, row.id);
  clock.value += 125000;
  row = store.enable(scope, row.id, 1);
  for (const field of ['consecutive_errors','consecutive_skipped','consecutive_target_failures','schedule_error_count']) assert.equal(row[field], 0);
  assert.equal(row.auto_disabled_reason, null); assert.equal(row.auto_disabled_at, null);
  assert.equal(row.last_slot_watermark, null); assert.equal(row.schedule_activated_at, clock.value);
  assert.equal(row.next_run_at, now + 180000);
  row = store.enable(scope, row.id, 2); assert.equal(row.generation, 3);
  row = store.disable(scope, row.id, 3); assert.equal(row.next_run_at, null);
  row = store.disable(scope, row.id, 4); assert.equal(row.generation, 5);
});
for (const method of ['edit','enable','disable','tombstone']) test(`stale CAS on ${method} produces no effects`, t => {
  const { db, store } = fixture(t); const row = store.create(input()); store.edit(scope, row.id, 1, { name: 'changed' });
  const before = state(db), changes = db.prepare('SELECT total_changes() n').get().n;
  assert.throws(() => store[method](scope, row.id, 1, { name: 'stale' }), StoreConflict);
  assert.deepEqual(state(db), before); assert.equal(db.prepare('SELECT total_changes() n').get().n, changes);
});
for (const patch of [{ id: 'jabcdef' }, { target: input().target }, { creatorUid: 'other' }, { deleteAfterRun: true }, { created_at: 0 },
  { last_slot_watermark: 0 }, { payload: { kind: 'reminder', text: 'changed type' } }, {}, { name: undefined }, { enabled: null }]) {
  test(`immutable/invalid edit ${JSON.stringify(patch)} is rejected atomically`, t => {
    const { db, store } = fixture(t); store.create(input()); const before = state(db);
    assert.throws(() => store.edit(scope, input().id, 1, patch)); assert.deepEqual(state(db), before);
  });
}
test('scoped reads and foreign mutations conceal existence without writes', t => {
  const { db, store } = fixture(t); const row = store.create(input()); const foreign = { targetSession: 'other' };
  const before = state(db);
  assert.equal(store.get(foreign, row.id), undefined); assert.deepEqual(store.list(foreign), []);
  assert.deepEqual(store.dueCandidates(foreign, now + 60000), []);
  assert.throws(() => store.edit(foreign, row.id, 1, { name: 'x' }), JobNotFound);
  assert.throws(() => store.tombstone(foreign, row.id, 1), JobNotFound);
  assert.deepEqual(state(db), before);
});
test('due query excludes disabled, tombstoned and NULL dates with stable ordering/paging', t => {
  const { store, clock } = fixture(t);
  store.create(input()); store.create(input({ id: 'jabcdef', enabled: false }));
  store.create(input({ id: 'jbcdefg' })); store.tombstone(scope, 'jbcdefg', 1);
  assert.deepEqual(store.dueCandidates(scope, now + 59999), []);
  assert.deepEqual(store.dueCandidates(scope, now + 60000).map(r => r.id), [input().id]);
  assert.equal(store.list(scope).length, 1);
  assert.equal(store.list(globalScope, { includeDisabled: true }).length, 2);
  assert.equal(store.list(globalScope, { includeDisabled: true, includeDeleted: true }).length, 3);
  assert.deepEqual(store.list(scope, { limit: 1, offset: 1 }), []);
  clock.value += 70000; assert.equal(store.dueCandidates(scope, clock.value).length, 1);
});
test('tombstone increments generation, excludes due, preserves history and reserves the ID', t => {
  const { db, store, clock } = fixture(t); const row = store.create(input());
  const run = receipt(db, row, { status: 'ok', phase: null, ended_at: now });
  clock.value += 1; const removed = store.tombstone(scope, row.id, 1);
  assert.equal(removed.deleted_at, clock.value); assert.equal(removed.generation, 2); assert.equal(removed.enabled, 0);
  assert.equal(removed.last_slot_watermark, null); assert.equal(removed.next_run_at, null);
  assert.deepEqual(db.prepare('SELECT * FROM cron_runs').get(), run);
  assert.throws(() => store.create(input()), StoreConflict);
  assert.throws(() => store.enable(scope, row.id, 2), JobNotFound);
});
test('retained receipts reserve a legacy hard-deleted job ID', t => {
  const { db, store } = fixture(t); const row = store.create(input()); receipt(db, row, { status: 'ok' });
  db.prepare('DELETE FROM cron_jobs WHERE id=?').run(row.id);
  assert.throws(() => store.create(input()), StoreConflict);
});
for (const status of ['queued','running']) test(`active ${status} removal is explicitly deferred with zero effects`, t => {
  const { db, store } = fixture(t); const row = store.create(input()); receipt(db, row, { status }); const before = state(db);
  assert.throws(() => store.tombstone(scope, row.id, 1), DeferredOperation); assert.deepEqual(state(db), before);
});
for (const method of ['edit','enable','disable']) test(`${method} with queued work is deferred without fake finalization`, t => {
  const { db, store } = fixture(t); const row = store.create(input()); receipt(db, row, { status: 'queued' }); const before = state(db);
  assert.throws(() => store[method](scope, row.id, 1, { name: 'x' }), DeferredOperation); assert.deepEqual(state(db), before);
});
test('running borrowed future one-shot and its immutable full snapshot survive definition edit unchanged', t => {
  const { db, store, clock } = fixture(t); const row = store.create(input({ schedule: { kind: 'at', atMs: now + 60000 } }));
  const run = receipt(db, row); clock.value += 1;
  const edited = store.edit(scope, row.id, 1, { name: 'new generation' });
  assert.deepEqual(db.prepare('SELECT * FROM cron_runs').get(), run);
  const snapshot = JSON.parse(run.definition_snapshot_json);
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.jobGeneration, 1); assert.equal(snapshot.scheduleOwnership, 'borrow');
  assert.equal(snapshot.authoredSlot, now + 60000); assert.equal(edited.generation, 2); assert.equal(edited.last_slot_watermark, null);
  assert.equal(edited.next_run_at, row.next_run_at);
});
test('SQLite abort during edit rolls back the definition and generation together', t => {
  const { db, store } = fixture(t); store.create(input());
  db.exec("CREATE TRIGGER refuse_edit AFTER UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT,'injected'); END");
  const before = state(db); assert.throws(() => store.edit(scope, input().id, 1, { name: 'x' }), /injected/);
  assert.deepEqual(state(db), before); assert.equal(db.inTransaction, false);
});
test('two real independent connections contend, then re-read CAS after commit', t => {
  const { db, store, connect, clock } = fixture(t); const row = store.create(input()); const second = connect(); const other = new CronStore(second, clock);
  second.exec('BEGIN IMMEDIATE'); second.prepare('UPDATE cron_jobs SET generation=2,name=? WHERE id=?').run('winner', row.id);
  assert.throws(() => store.edit(scope, row.id, 1, { name: 'loser' }), e => e.code === 'SQLITE_BUSY');
  second.exec('COMMIT'); const before = state(db);
  assert.throws(() => store.edit(scope, row.id, 1, { name: 'loser' }), StoreConflict); assert.deepEqual(state(db), before);
  assert.equal(other.edit(scope, row.id, 2, { name: 'next' }).generation, 3);
});
test('caller transaction is preserved and never committed or rolled back by the store', t => {
  const { db, store } = fixture(t); db.exec('BEGIN');
  assert.throws(() => store.create(input()), StoreConflict); assert.equal(db.inTransaction, true);
  assert.throws(() => initializeCronSchema(db), StoreConflict); assert.equal(db.inTransaction, true); db.exec('ROLLBACK');
});
test('unknown stored wire fields, mismatched columns and invalid tagged data fail closed', t => {
  const { db, store } = fixture(t); store.create(input());
  const before = state(db);
  for (const json of ['{"schemaVersion":2,"kind":"every","everyMs":60000,"anchorMs":0}', '{"everyMs":60000}', 'not-json']) {
    db.prepare('UPDATE cron_jobs SET schedule_json=?').run(json);
    assert.throws(() => store.definition(scope, input().id), StoreIntegrityError);
  }
  db.prepare('UPDATE cron_jobs SET schedule_json=?,stagger_ms=123').run(before.jobs[0].schedule_json);
  assert.throws(() => store.definition(scope, input().id), StoreIntegrityError);
});
test('generation exhaustion, invalid clock and malformed scope/page inputs cannot write', t => {
  const { db, store, clock } = fixture(t); const row = store.create(input());
  db.prepare('UPDATE cron_jobs SET generation=?').run(Number.MAX_SAFE_INTEGER); const before = state(db);
  assert.throws(() => store.disable(scope, row.id, Number.MAX_SAFE_INTEGER), StoreConflict); assert.deepEqual(state(db), before);
  clock.value = NaN; assert.throws(() => store.create(input({ id: 'jabcdef' }))); assert.deepEqual(state(db), before);
  for (const bad of [{}, { allConversations: false }, { targetSession: '' }, { targetSession: scope.targetSession, allConversations: true }]) assert.throws(() => store.list(bad));
  assert.throws(() => store.list(scope, { limit: 0 })); assert.throws(() => store.list(scope, { offset: -1 }));
});
test('single-flight partial index rejects a second queued/running row while allowing terminal history', t => {
  const { db, store } = fixture(t); const row = store.create(input()); receipt(db, row);
  const before = state(db);
  assert.throws(() => receipt(db, row, { run_id: 'second', occurrence_id: 'manual:second', status: 'queued' }), e => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
  assert.deepEqual(state(db), before);
  receipt(db, row, { run_id: 'terminal', occurrence_id: 'manual:terminal', status: 'ok' });
  assert.equal(state(db).runs.length, 2);
});
test('slot-attempt index keeps generation domains distinct and rejects unrelated duplicate slots', t => {
  const { db, store } = fixture(t); const row = store.create(input());
  receipt(db, row, { trigger: 'scheduled', status: 'ok', scheduled_for: row.next_run_at });
  const before = state(db);
  assert.throws(() => receipt(db, row, { run_id: 'conflict', occurrence_id: 'different', trigger: 'retry', status: 'error', scheduled_for: row.next_run_at }), e => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
  assert.deepEqual(state(db), before);
  receipt(db, row, { run_id: 'new-generation', occurrence_id: 'generation-2', admitted_generation: 2, trigger: 'scheduled', status: 'ok', scheduled_for: row.next_run_at });
  assert.equal(state(db).runs.length, 2);
});
test('occurrence-attempt uniqueness is independent of display job and status', t => {
  const { db, store } = fixture(t); const row = store.create(input()); receipt(db, row, { status: 'ok' });
  const before = state(db);
  assert.throws(() => receipt(db, row, { run_id: 'same-occurrence', job_id: 'other', status: 'error' }), e => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
  assert.deepEqual(state(db), before);
});
test('SQLite enforces exact R8 enums without weakening constraints for test fixtures', t => {
  const { db, store } = fixture(t); const row = store.create(input()); receipt(db, row);
  const before = state(db);
  for (const [table, column] of [['cron_jobs','schedule_kind'],['cron_jobs','payload_kind'],['cron_jobs','exec_mode'],['cron_jobs','delivery_mode'],
    ['cron_runs','trigger'],['cron_runs','manual_mode'],['cron_runs','schedule_ownership'],['cron_runs','status'],['cron_runs','phase'],['cron_runs','completion'],['cron_runs','delivery_state']]) {
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${column}=?`).run('invalid'), e => e.code === 'SQLITE_CONSTRAINT_CHECK');
    assert.deepEqual(state(db), before);
  }
});
test('accepted legacy session library reopens a scratch schema extension with semantic conservation', async t => {
  const { SessionStore } = await import('../../src/host/session-store.ts');
  const { db, store, connect } = fixture(t, false);
  db.pragma('foreign_keys = ON');
  const legacy = new SessionStore(db); legacy.init();
  legacy.getOrCreate('legacy:A', 'channel:A', 2);
  legacy.getOrCreate('legacy:B', 'channel:B', 1);
  legacy.appendUser('legacy:A', 'before extension', 12, 'Member');
  legacy.appendAssistant('legacy:B', 'preserved response', 13, 'Fixture');
  legacy.setResetBarrier('legacy:A', 11);
  legacy.setSdkSessionId('legacy:A', 'thread:A');
  legacy.setConversationDocumentSignature('legacy:A', 'thread:A', 'signature:A');
  const tables = ['sessions','messages','reset_barriers','sdk_sessions','conversation_document_state'];
  const inventory = () => Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()]));
  const before = inventory();
  initializeCronSchema(db); const job = store.create(input());
  assert.deepEqual(inventory(), before);
  db.close();
  const reopenedDb = connect(); reopenedDb.pragma('foreign_keys = ON');
  const reopened = new SessionStore(reopenedDb); reopened.init();
  for (const name of tables) assert.deepEqual(reopenedDb.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(), before[name]);
  assert.equal(reopened.getSdkSessionId('legacy:A'), 'thread:A');
  assert.equal(reopened.getResetBarrier('legacy:A'), 11);
  reopened.appendUser('legacy:B', 'after extension', 14, 'Member');
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) n FROM messages').get().n, 3);
  assert.deepEqual(reopenedDb.prepare('SELECT * FROM cron_jobs WHERE id=?').get(job.id), job);
});
