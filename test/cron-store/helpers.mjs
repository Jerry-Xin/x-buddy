// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CronStore, initializeCronSchema } from '../../src/cron/store/index.ts';
export const Database = createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE);
export const scope = { targetSession: 'group:fixture' };
export const globalScope = { allConversations: true };
export const now = Date.parse('2026-10-29T12:00:00Z');
export const input = (overrides = {}) => ({ id: 'j7f3k2q', name: 'fixture', schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 }, tz: 'UTC',
  payload: { kind: 'agentTurn', message: 'Hello\nworld', model: 'fixture-model', effort: 'high', timeoutSeconds: 1800 },
  execMode: 'isolated', target: { sessionKey: scope.targetSession, channelId: 'g_fixture', channelType: 2 }, creatorUid: 'u_owner', ...overrides });
export function fixture(t, initialize = true) {
  const root = resolve(process.env.CRON_STORE_SCRATCH);
  const dir = mkdtempSync(join(root, 'store-'));
  const path = join(dir, 'owned.sqlite');
  const connections = [];
  const connect = () => { const db = new Database(path, { timeout: 0 }); connections.push(db); return db; };
  const db = connect();
  const clock = { value: now, now() { return this.value; } };
  if (initialize) initializeCronSchema(db);
  const store = new CronStore(db, clock);
  t.after(() => { for (const c of connections) if (c.open) c.close(); rmSync(dir, { recursive: true }); });
  return { db, store, clock, connect, path, dir };
}
export function state(db) {
  return { jobs: db.prepare('SELECT * FROM cron_jobs ORDER BY id').all(), runs: db.prepare('SELECT * FROM cron_runs ORDER BY run_id').all() };
}
export function receipt(db, job, overrides = {}) {
  const slot = job.next_run_at;
  const snapshot = { schemaVersion: 1, jobGeneration: job.generation, occurrenceId: JSON.stringify([job.id, job.generation, slot]),
    schedule: JSON.parse(job.schedule_json), payload: JSON.parse(job.payload_json), execMode: job.exec_mode,
    target: { sessionKey: job.target_session, channelId: job.target_channel_id, channelType: job.target_channel_type },
    deliveryMode: job.delivery_mode, deleteAfterRun: !!job.delete_after_run, creatorUid: job.creator_uid, policy: {},
    manualMode: 'if-enabled', scheduleOwnership: 'borrow', authoredOccurrenceId: JSON.stringify([job.id, job.generation, slot]),
    authoredSlot: slot, admittedEnabled: !!job.enabled, admittedNextRunAt: slot };
  const row = { run_id: 'r_fixture', job_id: job.id, trigger: 'manual', manual_mode: 'if-enabled', schedule_ownership: 'borrow',
    authored_occurrence_id: snapshot.authoredOccurrenceId, authored_slot: slot, admitted_enabled: job.enabled, admitted_next_run_at: slot,
    scheduled_for: null, attempt: 0, occurrence_id: 'manual:fixture', ready_at: now, status: 'running', phase: 'executing',
    admitted_generation: job.generation, definition_snapshot_json: JSON.stringify(snapshot), reset_generation: 2,
    owner_incarnation: 'fixture-owner', exec_mode: job.exec_mode, queued_at: now, started_at: now, ...overrides };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO cron_runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
  return db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id);
}
