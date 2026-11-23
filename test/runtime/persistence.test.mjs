// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { completionStack } from './completion-fixture.mjs';
import { state, config, reset, assertClean } from './host-fixture.mjs';
import { clean, trace } from './lifecycle-fixture.mjs';
import { deferred, tick, Peer } from './helpers.mjs';
import { guardState } from './query-agent-harness.mjs';
const require = createRequire(import.meta.url);
const Native = require(process.env.HOST_SQLITE);
const nativeBinding = join(process.env.HOST_SQLITE, 'build/Release/better_sqlite3.node');
const open = (path, options = {}) => new Native(path, { ...options, nativeBinding });
const { startBot, handleMessage } = await import('../../src/host/index.ts');
const { createAdapter } = await import('../../src/host/db-adapter.ts');
await import('../../src/host/session-store.ts?host-real');
const { StreamRelay } = await import('../../src/host/stream-relay.ts');
const refusal = error => error.name === 'HostExecutionRefusal' || error.reason === 'ownership-lost';
const sql = (f, query, ...values) => { const db = open(join(f.dir, 'cc-octo.db')); try { return db.prepare(query).all(...values); } finally { db.close(); } };
const envelope = (f, message = f.message(1)) => ({ sessionKey: f.stack.router.sessionKey(message), principalUid: message.from_uid,
  channelId: message.channel_id, channelType: message.channel_type, messageId: message.message_id, messageSeq: message.message_seq });
async function stack(kind, extra = {}) {
  reset(); state.send = async () => ({});
  const control = { allowed: true, missing: undefined };
  const issuer = { prepare(input, scope) {
    const store = state.stores.at(-1);
    const generation = store.getResetGeneration?.(input.sessionKey) ?? 0;
    control.onPrepare?.();
    return { ready: Object.fromEntries(['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects'].map(k => [k, k !== control.missing])),
      assertCurrent() { if (!control.allowed) throw Error('revoked local fixture permit'); },
      request: { sessionKey: input.sessionKey, laneKey: 'new:' + input.sessionKey, laneDeadlineMs: Date.now() + 20_000,
        ctx: { incarnationId: scope.incarnationId, origin: 'chat', principal: { uid: input.principalUid, role: 'member' },
          session: { sessionKey: input.sessionKey, resetGeneration: generation, channelId: input.channelId, channelType: input.channelType },
          policy: { tools: 'none' }, delivery: { logicalOrigin: input.messageId } } } };
  } };
  const f = await completionStack(kind, { ...extra, setup: { ...extra.setup, issuer } });
  return { ...f, control };
}
const capture = (f, message = f.message(1)) => f.stack.execution.withCompletion(envelope(f, message), async scope => scope.state);

for (const kind of ['sdk','app-server']) {
  test(`v154 ${kind} actual mapping refusal cannot start AppServer turn or publish later SDK effects`, async () => {
    const f = await stack(kind); const sends = [];
    try {
      const db = open(join(f.dir, 'cc-octo.db'));
      db.exec("CREATE TRIGGER reject_mapping BEFORE INSERT ON sdk_sessions BEGIN SELECT RAISE(ABORT,'owned mapping rejection'); END"); db.close();
      state.send = async (name, options) => { sends.push({ name, content: options.content }); return {}; };
      await assert.rejects(f.handle(f.message(1)), /owned mapping rejection/);
      assert.equal(f.starts.length, kind === 'sdk' ? 1 : 0, 'AppServer hook must commit before turn/start; SDK accepted work is not replayed');
      assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions')[0].n, 0);
      assert.equal(sql(f, "SELECT count(*) n FROM messages WHERE role='assistant'")[0].n, 0);
      assert.equal(sends.some(x => x.content === 'ok'), false);
      trace({ phase: 'v154-pre-turn-refusal', kind, events: state.events, sends });
    } finally { await f.close(); }
  });

  test(`v154 ${kind} actual group backfill and signature/cursor compound publication`, async () => {
    const f = await stack(kind);
    try {
      state.api = name => {
        if (name === 'getGroupMembers') return [{ uid: 'member', name: 'Member' }];
        if (name === 'getGroupMd') return { content: 'inert group instructions', version: 1 };
        if (name === 'getChannelMessages') return [
          { type: 1, from_uid: 'older', from_name: 'Older', content: 'backfilled user', message_seq: 1 },
          { type: 1, from_uid: f.stack.robotUid, content: 'backfilled assistant', message_seq: 2 },
        ];
        throw Error('unlisted inert API ' + name);
      };
      const message = { ...f.message(5), channel_id: 'inert-group', channel_type: 2,
        payload: { type: 1, content: 'group hello', mention: { uids: [f.stack.robotUid] } } };
      await handleMessage(message, f.cfg, f.store, f.stack.router, state.groups.at(-1), new StreamRelay(), f.stack.robotUid, f.stack.execution);
      assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 4);
      assert.ok(sql(f, 'SELECT signature FROM conversation_document_state')[0].signature.startsWith('1:'));
      assert.ok(sql(f, 'SELECT last_id FROM group_context_cursors')[0].last_id > 0);
      // A later signature failure must roll its pending cursor and mapping transaction back.
      const group = state.groups.at(-1), oldCursor = group.getContextCursor('inert-group');
      state.hook = (name, event) => {
        if (name === 'sql-result' && event.sql?.startsWith('INSERT INTO conversation_document_state') && event.sql.includes('SELECT session_id')) throw Error('owned signature fault');
      };
      f.store.clearSdkSessionId('inert-group');
      await assert.rejects(handleMessage({ ...message, message_id: 'group-message-6', message_seq: 6 }, f.cfg, f.store, f.stack.router, group, new StreamRelay(), f.stack.robotUid, f.stack.execution), /owned signature fault/);
      state.hook = null;
      assert.equal(group.getContextCursor('inert-group'), oldCursor);
      assert.equal(sql(f, "SELECT count(*) n FROM messages WHERE role='assistant' AND content='ok'")[0].n, 1);
      trace({ phase: 'v154-group-publication', kind, oldCursor, rows: sql(f, 'SELECT * FROM group_context_cursors'), events: state.events });
    } finally { state.hook = null; await f.close(); }
  });
}

test('v154 delayed SDK first-thread callback cannot resurrect mapping after durable reset', async () => {
  const entered = deferred(), release = deferred(); let starts = 0;
  const f = await stack('sdk', { setup: { sdkFactory: () => ({ startThread: () => ({ runStreamed: async () => {
    starts++; return { events: (async function* () { entered.resolve(); await release.promise;
      yield { type: 'thread.started', thread_id: 'late-sdk-thread' };
      yield { type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'late forbidden' } };
    })() };
  } }) }) } }); let work;
  try {
    work = f.handle(f.message(1)); work.catch(() => {}); await entered.promise;
    assert.equal((await f.stack.execution.resetSession(envelope(f, f.message(9)))).generation, 1);
    release.resolve(); await Promise.allSettled([work]);
    assert.equal(starts, 1); assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions')[0].n, 0);
    assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 0);
  } finally { release.resolve(); await Promise.allSettled([work].filter(Boolean)); await f.close(); }
});

test('v154 delayed AppServer thread response is fenced before turn/start after reset', async () => {
  const entered = deferred(), release = deferred(); let turns = 0;
  const f = await stack('app-server', { setup: { appServerFactory() {
    const peer = new Peer(), original = peer.request.bind(peer);
    peer.request = async (method, params, options) => {
      if (method === 'thread/start') { entered.resolve(); await release.promise; }
      if (method === 'turn/start') turns++;
      return original(method, params, options);
    }; return peer;
  } } }); let work, resetting;
  try {
    work = f.handle(f.message(1)); work.catch(() => {}); await entered.promise;
    resetting = f.stack.execution.resetSession(envelope(f, f.message(9)));
    assert.equal(f.store.getResetGeneration(envelope(f).sessionKey), 1, 'commit precedes awaited cancellation');
    release.resolve(); await resetting; await Promise.allSettled([work]);
    assert.equal(turns, 0); assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions')[0].n, 0);
    assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 0);
  } finally { release.resolve(); await Promise.allSettled([work, resetting].filter(Boolean)); await f.close(); }
});

for (const kind of ['sdk','app-server']) {
  test(`v154 actual ${kind} host persists first thread and generation across reopen`, async () => {
    const f = await stack(kind); let reopened;
    try {
      assert.equal(sql(f, "SELECT count(*) n FROM sqlite_master WHERE name='session_generations'")[0].n, 1, 'durable generation table must exist at actual startBot');
      await f.handle(f.message(1));
      const key = envelope(f).sessionKey;
      assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions WHERE session_id=?', key)[0].n, 1);
      assert.equal(sql(f, "SELECT count(*) n FROM messages WHERE session_id=? AND role='assistant'", key)[0].n, 1);
      assert.deepEqual(await f.stack.execution.resetSession(envelope(f, f.message(9))), { generation: 1 });
      assert.equal(sql(f, 'SELECT count(*) n FROM messages WHERE session_id=?', key)[0].n, 0);
      assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions WHERE session_id=?', key)[0].n, 0);
      assert.equal(sql(f, 'SELECT reset_seq FROM reset_barriers WHERE session_id=?', key)[0].reset_seq, 9);
      await f.stack.shutdown();
      reopened = await startBot(f.cfg, true, f.setup);
      assert.equal(state.stores.at(-1).getResetGeneration(key), 1);
      assert.equal(sql(f, 'SELECT count(*) n FROM bot_incarnations WHERE ended_at IS NULL')[0].n, 1);
      assert.equal(sql(f, 'SELECT count(*) n FROM schema_migrations')[0].n, 1);
      trace({ phase: 'v154-persisted-reset', kind, rows: sql(f, 'SELECT * FROM session_generations'), backups: readdirSync(join(f.dir, 'backup')) });
    } finally { await reopened?.shutdown(); await f.close(); }
  });

  test(`v154 ${kind} stale complete write set, resume and signature are inert; positive and isolation survive`, async () => {
    const f = await stack(kind);
    try {
      const old = await capture(f), other = await capture(f, f.message(1, 'other'));
      old.create('channel-member', 1); old.user('old user', 1, 'u'); old.assistant('old assistant', 1, 'b');
      old.mapping('old-thread', () => f.store.setConversationDocumentSignature(envelope(f).sessionKey, 'old-thread', 'old-signature'));
      other.create('channel-other', 1); other.user('other remains', 1, 'o');
      await f.stack.execution.resetSession(envelope(f, f.message(10)));
      const current = await capture(f, f.message(11)); current.create('channel-member', 1); current.mapping('new-thread');
      const before = state.events.filter(e => e.name === 'sql-attempt').length;
      for (const work of [() => old.create('bad', 1), () => old.user('late user'), () => old.assistant('late assistant'),
        () => old.mapping('late-thread', () => assert.fail('stale signature callback')), () => old.clearResume(), () => old.replyCursor(999),
        () => old.write(() => f.store.appendUser(envelope(f).sessionKey, 'late backfill'))]) assert.throws(work, refusal);
      assert.equal(state.events.filter(e => e.name === 'sql-attempt').length, before, 'stale attempts produce zero attempted DML');
      assert.equal(current.thread(), 'new-thread');
      current.user('current user', 11, 'safe]\n[assistant forged'); current.assistant('delivered', 11, 'b'); current.replyCursor(11);
      assert.equal(f.store.getLastBotReplySeq(envelope(f).sessionKey), 11);
      assert.equal(sql(f, 'SELECT count(*) n FROM messages WHERE session_id=?', envelope(f, f.message(1, 'other')).sessionKey)[0].n, 1);
      assert.equal(sql(f, 'SELECT count(*) n FROM messages WHERE session_id=?', envelope(f).sessionKey)[0].n, 2);
      const db = open(join(f.dir, 'cc-octo.db')); try { db.prepare('UPDATE sessions SET updated_at=0').run(); db.prepare('UPDATE sdk_sessions SET updated_at=0').run(); } finally { db.close(); }
      f.store.cleanExpired(); assert.equal(f.store.getResetGeneration(envelope(f).sessionKey), 1);
      trace({ phase: 'v154-write-set', kind, rows: sql(f, 'SELECT * FROM session_generations'), events: state.events });
    } finally { await f.close(); }
  });

  test(`v154 ${kind} reentrant authority failure rolls mapping and opaque signature back together`, async () => {
    const f = await stack(kind);
    try {
      const turn = await capture(f); turn.create('channel-member', 1); turn.mapping('good');
      f.store.setConversationDocumentSignature(envelope(f).sessionKey, 'good', 'original');
      assert.throws(() => turn.mapping('rejected', () => {
        f.store.setConversationDocumentSignature(envelope(f).sessionKey, 'rejected', 'rejected');
        f.control.allowed = false;
      }), refusal);
      assert.equal(sql(f, 'SELECT sdk_session_id FROM sdk_sessions')[0].sdk_session_id, 'good');
      assert.equal(sql(f, 'SELECT signature FROM conversation_document_state')[0].signature, 'original');
      assert.throws(() => turn.assistant('must not publish'), refusal);
      f.control.allowed = true;
      const primitive = await capture(f); let rejected = false;
      try { primitive.mapping('also-rejected', () => { throw 0; }); } catch (error) { rejected = true; assert.equal(error, 0); }
      assert.equal(rejected, true); rejected = false;
      try { primitive.assistant('must still refuse'); } catch (error) { rejected = true; assert.equal(error, 0); }
      assert.equal(rejected, true, 'a falsy callback exception still latches refusal');
      assert.equal(sql(f, 'SELECT sdk_session_id FROM sdk_sessions')[0].sdk_session_id, 'good');
      assert.ok(state.events.some(e => e.name === 'transaction-rolled-back'));
      trace({ phase: 'v154-compound-rollback', kind, events: state.events });
    } finally { await f.close(); }
  });

  test(`v154 ${kind} reset rollback and successful commit preserve honest state`, async () => {
    const f = await stack(kind);
    try {
      await f.handle(f.message(1)); const key = envelope(f).sessionKey;
      state.hook = (name, event) => { if (name === 'sql-result' && event.sql?.startsWith('INSERT INTO session_generations')) throw Error('owned crash inside reset'); };
      await assert.rejects(f.stack.execution.resetSession(envelope(f, f.message(9))), /owned crash inside reset/);
      state.hook = null;
      assert.equal(f.store.getResetGeneration(key), 0); assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 2);
      const result = await f.stack.execution.resetSession(envelope(f, f.message(9)));
      assert.equal(result.generation, 1); assert.equal(f.store.getResetGeneration(key), 1);
      assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 0);
      assert.equal(sql(f, 'SELECT reset_seq FROM reset_barriers')[0].reset_seq, 9);
      trace({ phase: 'v154-reset-rollback-commit', kind, events: state.events });
    } finally { state.hook = null; await f.close(); }
  });

  test(`v154 ${kind} missing authority refuses reset before DML; raw reset and new stay held`, async () => {
    const f = await stack(kind);
    try {
      for (const requirement of ['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects']) {
        f.control.missing = requirement; const before = state.events.filter(e => e.name === 'sql-attempt').length;
        await assert.rejects(f.stack.execution.resetSession(envelope(f)), error => error.prerequisite === requirement);
        assert.equal(state.events.filter(e => e.name === 'sql-attempt').length, before);
      }
      f.control.missing = undefined;
      for (const command of ['/reset','/new']) await assert.rejects(f.handle(f.message(2, 'member', command)), error => error.prerequisite === 'reset-cas-unavailable');
      assert.equal(sql(f, 'SELECT count(*) n FROM session_generations')[0].n, 0);
    } finally { await f.close(); }
  });

  test(`v154 ${kind} reset fences delayed actual SDK events and held delivery before shutdown close`, async () => {
    const entered = deferred(), release = deferred(); const f = await stack(kind); let work, closing;
    try {
      state.send = async (name, options) => { if (name === 'sendMessage' && options.content === 'ok') { entered.resolve(); await release.promise; } return {}; };
      work = f.handle(f.message(1)); work.catch(() => {}); await entered.promise;
      const result = await f.stack.execution.resetSession(envelope(f, f.message(9))); assert.equal(result.generation, 1);
      closing = f.stack.shutdown(); closing.catch(() => {}); await tick();
      assert.equal(state.events.filter(e => e.name === 'db-close').length, 0, 'uncollected old send still owns DB');
      assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 0);
      release.resolve(); await Promise.allSettled([work]); await closing;
      assert.equal(existsSync(join(f.dir, 'gateway.lock')), false);
      const db = open(join(f.dir, 'cc-octo.db')); try { assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 0); } finally { db.close(); }
    } finally { release.resolve(); await Promise.allSettled([work, closing].filter(Boolean)); await f.close(); }
  });
}

test('v154 missing/wrong constructor binding and lost ownership produce zero writes', async () => {
  const f = await stack('sdk');
  let invalidated = false;
  try {
    const { createHostCaller } = await import('../../src/runtime/host-caller.ts');
    const { createQueryAgent } = await import('../../src/host/agent-bridge.ts');
    const ownership = f.gateway.testOwnership;
    for (const fake of [undefined, { generation: () => 0, capture: () => assert.fail('fake state') }]) {
      const caller = createHostCaller(ownership, f.dir, f.cfg.botId, f.setup, createQueryAgent, fake);
      assert.throws(() => caller.forTurn(envelope(f)), error => error.prerequisite === 'session-state-binding-mismatch');
    }
    await assert.rejects(handleMessage(f.message(1), f.cfg, {}, f.stack.router, {}, new StreamRelay(), f.stack.robotUid, f.stack.execution), error => error.prerequisite === 'host-store-binding-mismatch');
    const turn = await capture(f); const lock = join(f.dir, 'gateway.lock'), saved = readFileSync(lock); let moved;
    const before = state.events.filter(e => e.name === 'sql-attempt').length;
    renameSync(lock, lock + '.held'); writeFileSync(lock, saved); moved = true; invalidated = true;
    assert.throws(() => turn.user('forbidden'), /Bot ownership lock was replaced or invalidated/);
    assert.equal(state.events.filter(e => e.name === 'sql-attempt').length, before);
    // The invalidated owner cannot be made valid again by restoring path bytes.
    if (moved) { unlinkSync(lock); renameSync(lock + '.held', lock); }
  } finally {
    if (invalidated) {
      // A revoked lease must not permit an end-of-incarnation write, but
      // shutdown still closes its own already-drained local handles.
      const before = sql(f, 'SELECT ended_at FROM bot_incarnations');
      await f.stack.shutdown();
      assert.deepEqual(sql(f, 'SELECT ended_at FROM bot_incarnations'), before);
      assertClean(assert);
      clean(f.dir);
    } else await f.close();
  }
});

test('v154 reset uses its immutable admitted envelope after a reentrant issuer call', async () => {
  const f = await stack('sdk');
  try {
    const input = envelope(f, f.message(9)), expectedKey = input.sessionKey;
    f.control.onPrepare = () => { input.sessionKey = 'different-session'; input.messageSeq = 999; };
    assert.equal((await f.stack.execution.resetSession(input)).generation, 1);
    assert.deepEqual(sql(f, 'SELECT session_id, generation FROM session_generations'), [{ session_id: expectedKey, generation: 1 }]);
    assert.deepEqual(sql(f, 'SELECT session_id, reset_seq FROM reset_barriers'), [{ session_id: expectedKey, reset_seq: 9 }]);
  } finally { await f.close(); }
});

test('v154 populated WAL backup, actual-schema legacy downgrade-open, restore and retention', async () => {
  reset(); const dir = mkdtempSync(join(tmpdir(), 'persistence-migrate-')); const cfg = config(dir); let bot;
  const db = open(join(dir, 'cc-octo.db')); db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
  try {
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,channel_type INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,timestamp INTEGER NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE)');
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('legacy', 'old-channel', 1, Date.now(), Date.now());
    db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES (?,?,?,?)').run('legacy', 'user', 'committed in WAL', Date.now());
    assert.equal(existsSync(join(dir, 'cc-octo.db-wal')), true);
    bot = await startBot(cfg, true); const backups = readdirSync(join(dir, 'backup')).filter(x => x.endsWith('.db'));
    assert.equal(backups.length, 1);
    const backup = open(join(dir, 'backup', backups[0]), { readonly: true });
    try { assert.equal(backup.prepare('SELECT content FROM messages').get().content, 'committed in WAL'); assert.equal(backup.prepare("SELECT count(*) n FROM sqlite_master WHERE name='session_generations'").get().n, 0); } finally { backup.close(); }
    await bot.shutdown(); bot = undefined; db.close();
    // Execute the actual immutable old store against the populated migrated schema.
    const bytes = execFileSync('git', ['cat-file','blob','6e8f7903a3787fe32f0718916d3b7e9fee198af2:src/host/session-store.ts']);
    const ts = require(process.env.HOST_TYPESCRIPT);
    const source = bytes.toString().replace("'./prompt-safety.js'", JSON.stringify(new URL('../../src/host/prompt-safety.ts', import.meta.url).href));
    const legacy = await import('data:text/javascript,' + encodeURIComponent(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText));
    const adapter = createAdapter(join(dir, 'cc-octo.db')), old = new legacy.SessionStore(adapter); old.init();
    assert.match(old.buildHistoryPrefix('legacy', 10), /committed in WAL/); old.appendAssistant('legacy', 'old package write'); old.close();
    for (let i = 0; i < 4; i++) { bot = await startBot(cfg, true); await bot.shutdown(); bot = undefined; }
    assert.equal(readdirSync(join(dir, 'backup')).filter(x => x.endsWith('.db')).length, 3);
    // Preserve the stopped current bundle and install a consistent backup with no old WAL/SHM.
    const recovery = join(dir, 'recovery'); mkdirSync(recovery);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(dir, 'cc-octo.db' + suffix))) renameSync(join(dir, 'cc-octo.db' + suffix), join(recovery, 'cc-octo.db' + suffix));
    const latest = readdirSync(join(dir, 'backup')).filter(x => x.endsWith('.db')).sort().at(-1);
    const snapshot = open(join(dir, 'backup', latest), { readonly: true }); await snapshot.backup(join(dir, 'cc-octo.db')); snapshot.close();
    assert.equal(existsSync(join(dir, 'cc-octo.db-wal')), false); assert.equal(existsSync(join(dir, 'cc-octo.db-shm')), false);
    const restored = open(join(dir, 'cc-octo.db')); try { assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(restored.prepare('SELECT count(*) n FROM messages').get().n, 2); } finally { restored.close(); }
    trace({ phase: 'v154-legacy-WAL-restore', backups: readdirSync(join(dir, 'backup')), events: state.events });
  } finally { await bot?.shutdown(); if (db.open) db.close(); assertClean(assert); clean(dir); }
});

for (const fault of ['backup-start', 'backup-collected', 'store-init', 'incarnation']) test(`v154 ${fault} failure stops startup with accurate backup and rollback state`, async () => {
  reset(); const dir = mkdtempSync(join(tmpdir(), 'persistence-failure-'));
  try {
    state.hook = (name, event) => { if (name === fault || (fault === 'incarnation' && name === 'sql-attempt' && event.sql?.startsWith('INSERT INTO bot_incarnations'))) throw Error('owned ' + fault + ' fault'); };
    await assert.rejects(startBot(config(dir), true), /backup at/); state.hook = null;
    assert.equal(existsSync(join(dir, 'gateway.lock')), false); assertClean(assert);
    const db = open(join(dir, 'cc-octo.db')); try {
      const present = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='schema_migrations'").get().n;
      assert.equal(present, fault === 'incarnation' ? 1 : 0);
      if (present) assert.equal(db.prepare('SELECT count(*) n FROM bot_incarnations').get().n, 0);
    } finally { db.close(); }
  } finally { state.hook = null; clean(dir); }
});

for (const kind of ['sdk','app-server']) test(`v154 ${kind} new generation waits for the old actual effect after committed reset`, async () => {
  const f = await stack(kind), entered = deferred(), release = deferred(); let first, next, held = false;
  try {
    state.send = async (name, options) => { if (!held && name === 'sendMessage' && options.content === 'ok') { held = true; entered.resolve(); await release.promise; } return {}; };
    first = f.handle(f.message(1)); first.catch(() => {}); await entered.promise;
    assert.equal((await f.stack.execution.resetSession(envelope(f, f.message(9)))).generation, 1);
    next = f.handle(f.message(10)); next.catch(() => {}); await tick(); assert.equal(f.starts.length, 1);
    release.resolve(); await Promise.allSettled([first]); await next; assert.equal(f.starts.length, 2);
    assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 2);
    assert.equal(sql(f, 'SELECT generation FROM session_generations')[0].generation, 1);
  } finally { release.resolve(); await Promise.allSettled([first, next].filter(Boolean)); await f.close(); }
});

test('v154 committed reset reports cancellation failure without undo or automatic second CAS', async () => {
  const f = await stack('app-server'); let moved = false, incremented = false;
  try {
    await f.handle(f.message(1));
    state.hook = (name, event) => {
      if (name === 'sql-result' && event.sql?.startsWith('INSERT INTO session_generations')) incremented = true;
      if (incremented && !moved && name === 'transaction-committed') {
        renameSync(join(f.dir, 'gateway.lock'), join(f.dir, 'gateway.lock.held')); moved = true;
      }
    };
    const result = await f.stack.execution.resetSession(envelope(f, f.message(9))); state.hook = null;
    assert.equal(result.generation, 1); assert.ok(result.cancellationError);
    assert.equal(sql(f, 'SELECT generation FROM session_generations')[0].generation, 1);
    assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 0);
    assert.equal(state.events.filter(e => e.name === 'sql-result' && e.sql?.startsWith('INSERT INTO session_generations')).length, 1);
    trace({ phase: 'v154-commit-cancel-failure', committedGeneration: result.generation, error: String(result.cancellationError), events: state.events });
  } finally {
    state.hook = null;
    if (moved) {
      await f.stack.shutdown().catch(() => {});
      for (const db of state.dbs) db.close(); state.dbs.clear();
      for (const timer of state.timers) clearInterval(timer); state.timers.clear();
      clean(f.dir);
    } else await f.close();
  }
});

test('v154 actual SDK stale-resume clear is fenced and retains the trusted one pre-turn recovery', async () => {
  let resumed = 0, fresh = 0;
  const f = await stack('sdk', { setup: { sdkFactory: () => ({
    resumeThread: () => ({ runStreamed: async () => { resumed++; throw Error('thread not found: stale'); } }),
    startThread: () => ({ runStreamed: async () => { fresh++; return { events: (async function* () {
      yield { type: 'thread.started', thread_id: 'fresh-thread' };
      yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'ok' } };
    })() }; } }),
  }) } });
  try {
    f.store.setSdkSessionId(envelope(f).sessionKey, 'stale'); await f.handle(f.message(1));
    assert.equal(resumed, 1); assert.equal(fresh, 1);
    assert.equal(sql(f, 'SELECT sdk_session_id FROM sdk_sessions')[0].sdk_session_id, 'fresh-thread');
    assert.ok(state.events.some(e => e.name === 'sql-result' && e.sql?.startsWith('DELETE FROM sdk_sessions')));
  } finally { await f.close(); }
});

test('v154 F3 actual SDK consumes revoked binding before a delayed lazy driver enters', async () => {
  const entered = deferred(), release = deferred(); let runs = 0, drivers = 0;
  const f = await stack('sdk', { setup: { sdkFactory: () => ({
    startThread: () => ({ runStreamed: async () => {
      runs++; entered.resolve(); await release.promise;
      return { events: (async function* () {
        drivers++;
        yield { type: 'thread.started', thread_id: 'must-not-enter' };
        yield { type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'forbidden' } };
      })() };
    } }),
  }) } }); let work;
  try {
    work = f.handle(f.message(1)); work.catch(() => {}); await entered.promise;
    f.control.allowed = false; release.resolve();
    await assert.rejects(work, error => error.name === 'HostExecutionRefusal' && error.prerequisite === 'permit-not-current');
    assert.equal(runs, 1); assert.equal(drivers, 0);
    assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions')[0].n, 0);
    assert.equal(sql(f, "SELECT count(*) n FROM messages WHERE role='assistant'")[0].n, 0);
    trace({ phase: 'v154-f3-delayed-driver-refused', runs, drivers, events: state.events });
  } finally { release.resolve(); await Promise.allSettled([work].filter(Boolean)); await f.close(); }
});

test('v154 F3 actual SDK closes an acquired lazy iterator when binding revokes before its first pull', async () => {
  let pulls = 0, collected = 0;
  const f = await stack('sdk', { setup: { sdkFactory: () => ({
    startThread: () => ({ runStreamed: async () => ({ events: {
      [Symbol.asyncIterator]() {
        f.control.allowed = false;
        return {
          async next() { pulls++; return { done: true }; },
          async return() { collected++; return { done: true }; },
        };
      },
    } }) }),
  }) } });
  try {
    await assert.rejects(f.handle(f.message(1)), error => error.name === 'HostExecutionRefusal' && error.prerequisite === 'permit-not-current');
    assert.equal(pulls, 0); assert.equal(collected, 1);
    assert.equal(sql(f, 'SELECT count(*) n FROM sdk_sessions')[0].n, 0);
    assert.equal(sql(f, "SELECT count(*) n FROM messages WHERE role='assistant'")[0].n, 0);
    trace({ phase: 'v154-f3-first-pull-refused-and-collected', pulls, collected, events: state.events });
  } finally { await f.close(); }
});

test('v154 repeated and overlapping reset observations cannot invent a generation beyond SQLite', async () => {
  const f = await stack('app-server');
  try {
    await f.handle(f.message(1));
    await f.stack.execution.observeReset(envelope(f).sessionKey);
    await f.handle(f.message(2)); // Observing generation zero must not cancel/increment it.
    const a = f.stack.execution.resetSession(envelope(f, f.message(9)));
    const b = f.stack.execution.resetSession(envelope(f, f.message(10)));
    assert.equal((await a).generation, 1); assert.equal((await b).generation, 2);
    await f.stack.execution.observeReset(envelope(f).sessionKey);
    await f.stack.execution.observeReset(envelope(f).sessionKey);
    await f.handle(f.message(11));
    assert.equal(sql(f, 'SELECT generation FROM session_generations')[0].generation, 2);
    assert.equal(sql(f, 'SELECT count(*) n FROM messages')[0].n, 2);
  } finally { await f.close(); }
});

test('v154 existing fail-closed guard remains installed for all dynamic cases', () => {
  assert.throws(() => fetch('https://owned.invalid'), /network\/API/);
  assert.equal(guardState.allowedSpawns.some(x => x.bin === 'codex'), false);
  assert.ok(guardState.network >= 1);
});

for (const phase of ['before','inside','after']) test(`v154 native crash ${phase} reset commit reopens without partial state`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'persistence-crash-')); let child;
  try {
    child = fork(new URL('./persistence-crash-peer.mjs', import.meta.url), [dir, phase], { env: { ...process.env }, stdio: ['ignore','pipe','pipe','ipc'] });
    let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
    const db = open(join(dir, 'cc-octo.db'));
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(db.prepare('SELECT generation FROM session_generations WHERE session_id=?').get('member')?.generation ?? 0, phase === 'after' ? 1 : 0);
      assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, phase === 'after' ? 0 : 1);
      assert.equal(db.prepare('SELECT count(*) n FROM sdk_sessions').get().n, phase === 'after' ? 0 : 1);
      trace({ phase: 'v154-native-crash', fence: phase, child: child.pid, code, signal, stdout, stderr, rows: db.prepare('SELECT * FROM session_generations').all() });
    } finally { db.close(); }
  } finally { if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } clean(dir); }
});

test('v154 actual inert process readers exit before SQLite close and final lease release', async () => {
  const { AppServerClient } = await import('../../dist/app-server/client.js'); const clients = [];
  const f = await stack('app-server', { setup: { appServerFactory(options) {
    const client = new AppServerClient({ ...options, bin: process.execPath, args: [new URL('../foundation/bin/fake-app-server.mjs', import.meta.url).pathname] }); clients.push(client); return client;
  } } });
  try {
    await f.handle(f.message(1));
    state.hook = name => { if (name === 'db-close') { assert.ok(clients.every(c => c.state === 'closed')); assert.equal(existsSync(join(f.dir, 'gateway.lock')), true); } };
    await f.stack.shutdown(); state.hook = null;
    assert.ok(clients.every(c => c.state === 'closed' && c.exitInfo));
    const db = open(join(f.dir, 'cc-octo.db')); try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); } finally { db.close(); }
    assert.equal(existsSync(join(f.dir, 'cc-octo.db-wal')), false); assert.equal(existsSync(join(f.dir, 'cc-octo.db-shm')), false);
    trace({ phase: 'v154-native-cleanup', clients: clients.map(c => ({ pid: c.pid, state: c.state, exit: c.exitInfo })), events: state.events });
  } finally { state.hook = null; await f.close(); }
});

test('v154 group callback reentrancy restores cache and SQL instead of publishing rejected history', async () => {
  const f = await stack('sdk');
  try {
    state.api = name => name === 'getGroupMembers' ? [] : undefined;
    const group = state.groups.at(-1), message = { ...f.message(5), channel_id: 'rollback-group', channel_type: 2,
      payload: { type: 1, content: 'must roll back', mention: { uids: [f.stack.robotUid] } } };
    state.hook = (name, event) => { if (name === 'sql-result' && event.sql?.startsWith('INSERT INTO group_messages')) f.control.allowed = false; };
    await assert.rejects(handleMessage(message, f.cfg, f.store, f.stack.router, group, new StreamRelay(), f.stack.robotUid, f.stack.execution), refusal);
    state.hook = null;
    assert.equal(sql(f, 'SELECT count(*) n FROM group_messages')[0].n, 0); assert.equal(group.buildContext('rollback-group'), '');
    assert.equal(group.getContextCursor('rollback-group'), 0);
  } finally { state.hook = null; await f.close(); }
});
