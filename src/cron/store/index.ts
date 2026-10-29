// SPDX-License-Identifier: Apache-2.0
import { next, timestamp, validateTimezone } from '../schedule/engine.js';
import type { Schedule } from '../schedule/engine.js';
import { CRON_DDL } from './schema.js';
import type { StoreDatabase, StoreScope, CreateJob, JobPatch, JobRow, Definition, StoredSchedule } from './types.js';
import * as v from './validation.js';
export { CRON_DDL, CRON_DDL_SHA256, R8_CONTENT_SHA256 } from './schema.js';
export type * from './types.js';

export class StoreConflict extends Error {}
export class JobNotFound extends Error {}
export class DeferredOperation extends Error {}
export class StoreIntegrityError extends Error {}

function transaction<T>(db: StoreDatabase, work: () => T): T {
  if (db.inTransaction) throw new StoreConflict('Caller transaction must finish before store operation');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
const cleanSql = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\bIF NOT EXISTS\b/gi, '')
  .replace(/\s+/g, '').replace(/;$/, '');

/** Explicit standalone initialization only; never invoked by a constructor or host startup. */
export function initializeCronSchema(db: StoreDatabase): void {
  transaction(db, () => {
    const statements = CRON_DDL.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    for (const sql of statements) {
      const name = sql.replace(/--[^\n]*/g, '').match(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/)?.[1];
      if (!name) throw new StoreIntegrityError('Invalid schema statement');
      const existing = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined;
      if (existing && cleanSql(existing.sql) !== cleanSql(sql)) throw new StoreIntegrityError(`Incompatible existing schema: ${name}`);
    }
    db.exec(CRON_DDL);
  });
}

function initialNext(schedule: StoredSchedule, jobId: string, now: number): number | null {
  // Due lookup only returns candidates; admission owns activation/watermark/provenance gates.
  if (schedule.kind === 'at') return schedule.atMs;
  const executable: Schedule = schedule.kind === 'cron' ? { ...schedule, jobId } : schedule;
  return next(executable, now) ?? null;
}

/** Synchronous CRUD only. No receipts, terminal effects, timers, I/O or DB ownership lifecycle. */
export class CronStore {
  private readonly db: StoreDatabase;
  private readonly clock: { now(): number };
  constructor(db: StoreDatabase, clock: { now(): number }) {
    this.db = db;
    this.clock = clock;
  }

  private find(scope: StoreScope, jobId: string): JobRow | undefined {
    v.id(jobId); const filter = v.scopeSql(scope);
    return this.db.prepare(`SELECT * FROM cron_jobs WHERE id=? AND ${filter.sql}`)
      .get(jobId, ...filter.args) as JobRow | undefined;
  }
  get(scope: StoreScope, jobId: string): Readonly<JobRow> | undefined {
    const row = this.find(scope, jobId);
    return row && Object.freeze(row);
  }
  list(scope: StoreScope, options: { includeDisabled?: boolean; includeDeleted?: boolean; limit?: number; offset?: number } = {}): ReadonlyArray<Readonly<JobRow>> {
    v.keys(options, ['includeDisabled', 'includeDeleted', 'limit', 'offset']);
    if (options.includeDisabled !== undefined) v.bool(options.includeDisabled);
    if (options.includeDeleted !== undefined) v.bool(options.includeDeleted);
    const filter = v.scopeSql(scope);
    const limit = v.page(options.limit ?? 20, 1, 1000), offset = v.page(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const sql = `SELECT * FROM cron_jobs WHERE ${filter.sql}${options.includeDisabled ? '' : ' AND enabled=1'}${options.includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY created_at,id LIMIT ? OFFSET ?`;
    return v.freeze(this.db.prepare(sql).all(...filter.args, limit, offset) as JobRow[]);
  }
  /** Candidates only, not a promise that execution/admission is permitted. */
  dueCandidates(scope: StoreScope, observedNow: number, limit = 20): ReadonlyArray<Readonly<JobRow>> {
    timestamp(observedNow); v.page(limit, 1, 1000); const filter = v.scopeSql(scope);
    return v.freeze(this.db.prepare(`SELECT * FROM cron_jobs WHERE ${filter.sql} AND enabled=1 AND deleted_at IS NULL AND next_run_at<=? ORDER BY next_run_at,id LIMIT ?`)
      .all(...filter.args, observedNow, limit) as JobRow[]);
  }
  /** Immutable definition component; admission must add the full R8 section 5 snapshot fields. */
  definition(scope: StoreScope, jobId: string): Definition {
    const row = this.find(scope, jobId);
    if (!row || row.deleted_at !== null) throw new JobNotFound('Job not found');
    try {
      const schedule = v.schedule(JSON.parse(row.schedule_json), validateTimezone(row.tz), row.id, 0, false);
      const payload = v.payload(JSON.parse(row.payload_json), row.exec_mode);
      if (schedule.kind !== row.schedule_kind || payload.kind !== row.payload_kind
        || (schedule.kind === 'cron' ? schedule.staggerMs : 0) !== row.stagger_ms) throw new StoreIntegrityError('Definition columns disagree');
      v.generation(row.generation); v.text(row.creator_uid); v.delivery(row.delivery_mode);
      v.text(row.target_session); v.text(row.target_channel_id);
      if (![1, 2, 5].includes(row.target_channel_type) || ![0, 1].includes(row.delete_after_run)) throw new StoreIntegrityError('Invalid definition');
      return v.freeze({ schemaVersion: 1, jobGeneration: row.generation, schedule, payload, execMode: row.exec_mode,
        target: { sessionKey: row.target_session, channelId: row.target_channel_id, channelType: row.target_channel_type },
        deliveryMode: row.delivery_mode, deleteAfterRun: row.delete_after_run === 1, creatorUid: row.creator_uid });
    } catch (error) {
      throw new StoreIntegrityError(`Invalid stored definition: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  create(input: CreateJob): Readonly<JobRow> {
    return transaction(this.db, () => {
      const now = timestamp(this.clock.now());
      v.keys(input, ['id', 'name', 'schedule', 'tz', 'payload', 'execMode', 'target', 'creatorUid', 'deliveryMode', 'deleteAfterRun', 'enabled']);
      v.id(input.id); v.text(input.name); v.text(input.creatorUid);
      v.keys(input.target, ['sessionKey', 'channelId', 'channelType']);
      v.text(input.target.sessionKey); v.text(input.target.channelId);
      if (![1, 2, 5].includes(input.target.channelType)) throw new TypeError('Invalid target channel type');
      const tz = validateTimezone(input.tz), schedule = v.schedule(input.schedule, tz, input.id, now, true);
      const payload = v.payload(input.payload, input.execMode);
      const delivery = input.deliveryMode === undefined ? 'announce' : input.deliveryMode; v.delivery(delivery);
      const enabled = input.enabled === undefined ? true : input.enabled;
      const deleteAfterRun = input.deleteAfterRun === undefined ? schedule.kind === 'at' : input.deleteAfterRun;
      v.bool(enabled); v.bool(deleteAfterRun);
      // Tombstones and retained receipts reserve IDs even after a legacy hard delete.
      if (this.db.prepare('SELECT 1 FROM cron_jobs WHERE id=? UNION ALL SELECT 1 FROM cron_runs WHERE job_id=? LIMIT 1').get(input.id, input.id)) throw new StoreConflict('Job ID is reserved');
      this.db.prepare(`INSERT INTO cron_jobs (id,name,enabled,schedule_kind,schedule_json,tz,stagger_ms,payload_kind,payload_json,exec_mode,target_session,target_channel_id,target_channel_type,delivery_mode,delete_after_run,creator_uid,schedule_activated_at,created_at,updated_at,next_run_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.name, +enabled, schedule.kind, JSON.stringify(schedule), tz,
          schedule.kind === 'cron' ? schedule.staggerMs : 0, payload.kind, JSON.stringify(payload), input.execMode,
          input.target.sessionKey, input.target.channelId, input.target.channelType, delivery, +deleteAfterRun,
          input.creatorUid, now, now, now, enabled ? initialNext(schedule, input.id, now) : null);
      return this.get({ targetSession: input.target.sessionKey }, input.id)!;
    });
  }

  edit(scope: StoreScope, jobId: string, expectedGeneration: number, patch: JobPatch): Readonly<JobRow> {
    return transaction(this.db, () => {
      const row = this.current(scope, jobId, expectedGeneration);
      v.keys(patch, ['name', 'schedule', 'tz', 'payload', 'execMode', 'deliveryMode', 'enabled']);
      if (!Object.keys(patch).length || Object.values(patch).some(value => value === undefined || value === null)) throw new TypeError('Empty, null or undefined mutation');
      this.rejectQueued(jobId);
      const now = timestamp(this.clock.now()), old = this.definition(scope, jobId);
      const zone = validateTimezone(patch.tz ?? row.tz);
      let scheduleInput = patch.schedule ?? old.schedule;
      if (patch.schedule === undefined && scheduleInput.kind === 'cron') scheduleInput = { ...scheduleInput, tz: zone };
      const schedule = v.schedule(scheduleInput, zone, jobId, now, patch.schedule !== undefined);
      const execMode = patch.execMode ?? old.execMode, payload = v.payload(patch.payload ?? old.payload, execMode);
      if (payload.kind !== old.payload.kind) throw new TypeError('Payload kind is immutable');
      const name = patch.name ?? row.name; v.text(name);
      const delivery = patch.deliveryMode ?? row.delivery_mode; v.delivery(delivery);
      const enabled = patch.enabled ?? row.enabled === 1; v.bool(enabled);
      const enabling = patch.enabled === true;
      const result = this.db.prepare(`UPDATE cron_jobs SET name=?,schedule_kind=?,schedule_json=?,tz=?,stagger_ms=?,payload_kind=?,payload_json=?,exec_mode=?,delivery_mode=?,enabled=?,generation=generation+1,
        schedule_activated_at=?,last_slot_watermark=NULL,next_run_at=?,updated_at=?${enabling ? ',consecutive_errors=0,consecutive_skipped=0,consecutive_target_failures=0,schedule_error_count=0,auto_disabled_reason=NULL,auto_disabled_at=NULL' : ''}
        WHERE id=? AND generation=? AND deleted_at IS NULL`).run(name, schedule.kind, JSON.stringify(schedule), zone,
          schedule.kind === 'cron' ? schedule.staggerMs : 0, payload.kind, JSON.stringify(payload), execMode, delivery, +enabled,
          now, enabled ? initialNext(schedule, jobId, now) : null, now, jobId, expectedGeneration);
      if (result.changes !== 1) throw new StoreConflict('Job changed');
      return this.get(scope, jobId)!;
    });
  }
  enable(scope: StoreScope, jobId: string, generation: number): Readonly<JobRow> { return this.edit(scope, jobId, generation, { enabled: true }); }
  disable(scope: StoreScope, jobId: string, generation: number): Readonly<JobRow> { return this.edit(scope, jobId, generation, { enabled: false }); }

  /** Keep tombstone/history indefinitely in this slice. Cleanup needs terminal-consumption proof. */
  tombstone(scope: StoreScope, jobId: string, expectedGeneration: number): Readonly<JobRow> {
    return transaction(this.db, () => {
      this.current(scope, jobId, expectedGeneration);
      if (this.db.prepare("SELECT 1 FROM cron_runs WHERE job_id=? AND status IN ('queued','running') LIMIT 1").get(jobId)) throw new DeferredOperation('Active-run removal requires executor cancellation and terminal projection');
      const now = timestamp(this.clock.now());
      const result = this.db.prepare('UPDATE cron_jobs SET deleted_at=?,enabled=0,generation=generation+1,schedule_activated_at=?,last_slot_watermark=NULL,next_run_at=NULL,updated_at=? WHERE id=? AND generation=? AND deleted_at IS NULL')
        .run(now, now, now, jobId, expectedGeneration);
      if (result.changes !== 1) throw new StoreConflict('Job changed');
      return this.get(scope, jobId)!;
    });
  }
  private current(scope: StoreScope, jobId: string, expectedGeneration: number): JobRow {
    v.generation(expectedGeneration); const row = this.find(scope, jobId);
    if (!row || row.deleted_at !== null) throw new JobNotFound('Job not found');
    if (row.generation !== expectedGeneration) throw new StoreConflict('Job changed');
    if (expectedGeneration === Number.MAX_SAFE_INTEGER) throw new StoreConflict('Generation exhausted');
    return row;
  }
  private rejectQueued(jobId: string): void {
    if (this.db.prepare("SELECT 1 FROM cron_runs WHERE job_id=? AND status='queued' LIMIT 1").get(jobId)) throw new DeferredOperation('Queued-run mutation requires terminal projection; no partial edit applied');
  }
}
