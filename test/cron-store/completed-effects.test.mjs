// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { CronStore, terminalExpectation } from '../../src/cron/store/index.ts';
import { CONTEXT_NOTES_DDL } from '../../dist/runtime/session-state.js';
import { fixture, input, scope, globalScope } from './helpers.mjs';

function addSessionTables(db) {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      codex_thread_id TEXT,
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE session_generations (
      session_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(CONTEXT_NOTES_DDL);
}

test('CronStore completed delivery effects: atomic messages + context_notes publication and reset generation fencing', (t) => {
  const f = fixture(t);
  addSessionTables(f.db);
  const verifier = {
    prepare() {
      return Object.freeze({ assertCurrent() {} });
    },
  };
  const store = new CronStore(f.db, f.clock, {}, verifier);

  f.db.prepare('INSERT INTO session_generations (session_id, generation, updated_at) VALUES (?, ?, ?)').run(
    scope.targetSession,
    3,
    f.clock.value,
  );

  const created = store.create(input({ id: 'j234567', deliveryMode: 'announce' }));
  assert.equal(created.id, 'j234567');
  assert.equal(store.countJobs(globalScope), 1);

  f.clock.value = created.next_run_at;
  const def = store.definition(scope, 'j234567');
  const own = { ownerIncarnation: 'inc-1', resetGeneration: 3, assertHeld() {} };
  const auth = {
    jobId: 'j234567',
    definition: def,
    creatorAuthorized: true,
    targetAuthorized: true,
    ownerIncarnation: 'inc-1',
    resetGeneration: 3,
    policy: { tools: 'none' },
  };
  const admitted = store.admitBase(scope, 'j234567', {
    trigger: 'scheduled',
    generation: created.generation,
    slot: created.next_run_at,
    runId: 'run-1',
    authority: auth,
    ownership: own,
  });
  assert.equal(admitted.kind, 'reserved');

  const started = store.startBase(scope, 'j234567', {
    expected: terminalExpectation(admitted.run),
    authority: auth,
    ownership: own,
    executionProof: Object.freeze({
      permitGrantedAtMs: f.clock.value,
      admissionDeadlineMs: f.clock.value + 30_000,
      runtimeGeneration: 1,
      assertCurrent() {},
    }),
  });
  assert.equal(started.kind, 'admitted');

  store.recordExecutionMetadata(
    scope,
    'j234567',
    'run-1',
    {
      threadId: 'th-1',
      turnId: 'tu-1',
      model: 'gpt-5-codex',
      usageJson: '{"input_tokens":10}',
      summary: 'Daily report ready',
      laneWaitMs: 12,
    },
    own,
  );

  const delivering = store.beginDelivery(scope, 'j234567', {
    expected: terminalExpectation(started.run),
    ownership: own,
  });
  assert.equal(delivering.phase, 'delivering');
  assert.equal(delivering.delivery_state, 'started');

  const seg1 = store.recordSegmentDelivered(scope, 'j234567', 'run-1', 1, own);
  assert.equal(seg1.segments_sent, 1);

  const finalized = store.finalize(scope, 'j234567', {
    expected: terminalExpectation(seg1),
    ownership: own,
    outcome: { kind: 'success', deliveryState: 'delivered' },
    effects: {
      publication: {
        botName: 'CodeBot',
        content: 'Daily report ready',
        noteText: 'Daily report ready',
      },
    },
  });
  assert.equal(finalized.kind, 'finalized');
  assert.equal(finalized.run.status, 'ok');
  assert.equal(finalized.run.delivery_state, 'delivered');
  assert.equal(finalized.run.history_state, 'published');

  const messages = f.db.prepare('SELECT * FROM messages WHERE session_id = ?').all(scope.targetSession);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.match(messages[0].content, /Daily report ready/);

  const notes = f.db.prepare('SELECT * FROM context_notes WHERE session_id = ?').all(scope.targetSession);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].run_id, 'run-1');
  assert.equal(notes[0].generation, 3);
  assert.equal(notes[0].consumed_at, null);

  // Advance reset generation before a second run finalizes -> skipped_reset
  const jobAfterFirst = store.get(scope, 'j234567');
  f.clock.value = jobAfterFirst.next_run_at;
  const adm2 = store.admitBase(scope, 'j234567', {
    trigger: 'scheduled',
    generation: jobAfterFirst.generation,
    slot: jobAfterFirst.next_run_at,
    runId: 'run-2',
    authority: auth,
    ownership: own,
  });
  const start2 = store.startBase(scope, 'j234567', {
    expected: terminalExpectation(adm2.run),
    authority: auth,
    ownership: own,
    executionProof: Object.freeze({
      permitGrantedAtMs: f.clock.value,
      admissionDeadlineMs: f.clock.value + 30_000,
      runtimeGeneration: 1,
      assertCurrent() {},
    }),
  });
  store.beginDelivery(scope, 'j234567', {
    expected: terminalExpectation(start2.run),
    ownership: own,
  });
  const seg2 = store.recordSegmentDelivered(scope, 'j234567', 'run-2', 1, own);
  f.db.prepare('UPDATE session_generations SET generation = 4 WHERE session_id = ?').run(scope.targetSession);
  const fin2 = store.finalize(scope, 'j234567', {
    expected: terminalExpectation(seg2),
    ownership: own,
    outcome: { kind: 'success', deliveryState: 'delivered' },
    effects: {
      publication: {
        botName: 'CodeBot',
        content: 'Stale generation output',
        noteText: 'Stale generation output',
      },
    },
  });
  assert.equal(fin2.kind, 'finalized');
  assert.equal(fin2.run.history_state, 'skipped_reset');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(scope.targetSession).n, 1);
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM context_notes WHERE session_id = ?').get(scope.targetSession).n,
    1,
  );
});

test('CronStore failure alert intents, target-unavailable auto-disable, schedule error auto-disable, and history pruning', (t) => {
  const f = fixture(t);
  addSessionTables(f.db);
  const verifier = {
    prepare() {
      return Object.freeze({ assertCurrent() {} });
    },
  };
  const store = new CronStore(f.db, f.clock, {}, verifier);
  store.create(input({ id: 'j345678', deliveryMode: 'announce' }));
  const def = store.definition(scope, 'j345678');
  const own = { ownerIncarnation: 'inc-1', resetGeneration: 0, assertHeld() {} };
  const auth = {
    jobId: 'j345678',
    definition: def,
    creatorAuthorized: true,
    targetAuthorized: true,
    ownerIncarnation: 'inc-1',
    resetGeneration: 0,
    policy: { tools: 'none' },
  };

  // Schedule errors auto-disable after 3 consecutive schedule errors
  const se1 = store.recordScheduleError(scope, 'j345678', 1, own);
  assert.equal(se1.job.schedule_error_count, 1);
  assert.equal(se1.disableNotice, undefined);
  store.recordScheduleError(scope, 'j345678', 1, own);
  const se3 = store.recordScheduleError(scope, 'j345678', 1, own);
  assert.equal(se3.job.enabled, 0);
  assert.equal(se3.job.auto_disabled_reason, 'schedule-errors');
  assert.equal(se3.disableNotice?.reason, 'schedule-errors');

  // Re-enable and test target-unavailable auto-disable at 3 consecutive target failures
  store.enable(scope, 'j345678', se3.job.generation);
  for (let i = 1; i <= 3; i += 1) {
    const cur = store.get(scope, 'j345678');
    const curDef = store.definition(scope, 'j345678');
    const curAuth = {
      ...auth,
      definition: curDef,
    };
    f.clock.value = cur.next_run_at;
    const adm = store.admitBase(scope, 'j345678', {
      trigger: 'scheduled',
      generation: cur.generation,
      slot: cur.next_run_at,
      runId: `target-fail-${i}`,
      authority: curAuth,
      ownership: own,
    });
    const st = store.startBase(scope, 'j345678', {
      expected: terminalExpectation(adm.run),
      authority: curAuth,
      ownership: own,
      executionProof: Object.freeze({
        permitGrantedAtMs: f.clock.value,
        admissionDeadlineMs: f.clock.value + 30_000,
        runtimeGeneration: 1,
        assertCurrent() {},
      }),
    });
    const deliv = store.beginDelivery(scope, 'j345678', {
      expected: terminalExpectation(st.run),
      ownership: own,
    });
    const fin = store.finalize(scope, 'j345678', {
      expected: terminalExpectation(deliv),
      ownership: own,
      outcome: { kind: 'failure', reason: 'target-unavailable', redactedError: 'HTTP 404 channel gone' },
      effects: {
        allowAlertIntent: true,
        allowDisableNotice: true,
        alertAfter: 2,
        alertCooldownMs: 3_600_000,
      },
    });
    const updatedJob = store.get(scope, 'j345678');
    if (i < 3) {
      assert.equal(updatedJob.enabled, 1);
      assert.equal(fin.disableNotice, undefined);
    } else {
      assert.equal(updatedJob.enabled, 0);
      assert.equal(updatedJob.auto_disabled_reason, 'target-unavailable');
      assert.equal(fin.disableNotice?.reason, 'target-unavailable');
    }
  }

  // Prune history respects 30d age and watermark rules
  const runsBeforePrune = store.listRuns(scope, 'j345678', { limit: 10 });
  assert.equal(runsBeforePrune.length, 3);
  f.clock.value += 31 * 86_400_000;
  const pruned = store.pruneHistory({ retentionDays: 30, maxPerJob: 200 });
  assert.equal(pruned.deletedRuns, 3);
  assert.equal(store.listRuns(scope, 'j345678', { limit: 10 }).length, 0);
});
