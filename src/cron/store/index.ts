// SPDX-License-Identifier: Apache-2.0
import { next, previousOrBefore, occurrenceId, timestamp, validateTimezone } from '../schedule/engine.js';
import type { Schedule } from '../schedule/engine.js';
import { CRON_DDL } from './schema.js';
import type { StoreDatabase, StoreScope, CreateJob, JobPatch, JobRow, Definition, StoredSchedule, AdmissionRequest, AdmissionResult, AdmissionTestSeams, RunRow } from './types.js';
import * as admission from './admission.js';
import { overlapNext, projectNewOverlap } from './terminal-projection.js';
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
function schemaTokens(sql: string): string {
  // Tokenize quoted contents before comments/spacing so literals remain byte-exact.
  const tokens = (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[^\s]/g) ?? [])
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'))
    .map(token => /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(token) ? token.toUpperCase() : token);
  const optional = tokens[1] === 'UNIQUE' && tokens[2] === 'INDEX' ? 3 : 2;
  if (tokens[0] === 'CREATE' && (tokens[1] === 'TABLE' || tokens[1] === 'INDEX' || optional === 3)
    && tokens.slice(optional, optional + 3).join(' ') === 'IF NOT EXISTS') tokens.splice(optional, 3);
  if (tokens.at(-1) === ';') tokens.pop();
  return JSON.stringify(tokens);
}

/** Explicit standalone initialization only; never invoked by a constructor or host startup. */
export function initializeCronSchema(db: StoreDatabase): void {
  transaction(db, () => {
    const statements = CRON_DDL.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    for (const sql of statements) {
      const name = sql.replace(/--[^\n]*/g, '').match(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/)?.[1];
      if (!name) throw new StoreIntegrityError('Invalid schema statement');
      const existing = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined;
      if (existing && schemaTokens(existing.sql) !== schemaTokens(sql)) throw new StoreIntegrityError(`Incompatible existing schema: ${name}`);
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

/** Synchronous injected store. No timers, external I/O, execution or DB ownership lifecycle. */
export class CronStore {
  private readonly db: StoreDatabase;
  private readonly clock: { now(): number };
  private readonly admissionTestSeams: AdmissionTestSeams;
  constructor(db: StoreDatabase, clock: { now(): number }, admissionTestSeams: AdmissionTestSeams = {}) {
    this.db = db;
    this.clock = clock;
    this.admissionTestSeams = admissionTestSeams;
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
      const schedule = v.storedSchedule(JSON.parse(row.schedule_json), validateTimezone(row.tz), row.id);
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

  /** Reserve a timed base occurrence. An existing row is a stored result, not a runtime execution grant. */
  admitBase(scope: StoreScope, jobId: string, request: AdmissionRequest): AdmissionResult {
    return transaction(this.db, () => {
      v.generation(request.generation);
      const job = this.find(scope, jobId);
      if (!job || job.deleted_at !== null) throw new JobNotFound('Job not found');
      if (job.generation !== request.generation || job.enabled !== 1) throw new StoreConflict('Job generation or enablement changed');
      const definition = this.definition(scope, jobId);
      const policy = admission.validateRequest(request, job, definition);
      const now = timestamp(this.clock.now()), slot = timestamp(request.slot);
      timestamp(job.schedule_activated_at);
      if (job.last_slot_watermark !== null) timestamp(job.last_slot_watermark);
      const schedule: Schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId } : definition.schedule;
      if (previousOrBefore(schedule, slot) !== slot) throw new StoreConflict('Not an effective authored slot');
      const occurrence = occurrenceId(jobId, job.generation, slot);
      const stored = this.db.prepare(`SELECT * FROM cron_runs WHERE (occurrence_id=? AND attempt=0)
        OR (job_id=? AND admitted_generation=? AND scheduled_for=? AND attempt=0)`)
        .all(occurrence, jobId, job.generation, slot) as RunRow[];
      const existing = (): AdmissionResult => {
        if (stored.length !== 1) throw new StoreIntegrityError('Conflicting occurrence receipts');
        try { admission.validateExisting(stored[0]!, job, definition, occurrence, slot); }
        catch (error) { throw new StoreIntegrityError(`Invalid stored receipt: ${error instanceof Error ? error.message : 'unknown'}`); }
        admission.assertOwnership(request);
        return v.freeze({ kind: 'existing', run: stored[0]! });
      };
      // Re-entrant/recovered reservations retain their original outcome even behind a later W/cadence.
      if (stored.length) return existing();
      if (job.last_slot_watermark !== null && slot <= job.last_slot_watermark) return { kind: 'already-consumed' };
      if (slot > now || slot < job.schedule_activated_at || job.next_run_at === null
        || timestamp(job.next_run_at) > slot) throw new StoreConflict('Slot is not currently eligible');
      if (request.trigger === 'scheduled' ? slot !== job.next_run_at : slot !== previousOrBefore(schedule, now)) {
        throw new StoreConflict('Expected the scheduled slot or latest catch-up slot');
      }
      const active = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").get(jobId) as RunRow | undefined;
      if (active && (active.status === 'queued' && active.trigger === 'retry' || schedule.kind === 'at')) {
        // Queued retry supersession requires its own terminal CAS; one-shots preserve authored eligibility.
        return v.freeze({ kind: 'deferred', reason: active.status === 'queued' && active.trigger === 'retry'
          ? 'queued-retry-supersession' : 'one-shot-busy',
          activeRunId: active.run_id, recheckAfterMs: 30000 });
      }
      const snapshot = admission.snapshot(definition, occurrence, slot, job.next_run_at, policy);
      // The active row is observed under this write lock and is never modified. All validation,
      // including natural effective cadence, finishes before the first mutation.
      const overlap: RunRow | undefined = active ? {
        run_id: request.runId, job_id: jobId, trigger: request.trigger, manual_mode: null, schedule_ownership: 'consume',
        authored_occurrence_id: occurrence, authored_slot: slot, admitted_enabled: 1, admitted_next_run_at: job.next_run_at,
        scheduled_for: slot, attempt: 0, occurrence_id: occurrence, ready_at: slot, status: 'skipped', phase: null,
        completion: null, delivery_state: 'not-requested', segments_sent: 0, history_state: 'not-published', reason: 'overlap', error: null,
        admitted_generation: job.generation, definition_snapshot_json: JSON.stringify(snapshot), reset_generation: request.ownership.resetGeneration,
        owner_incarnation: request.ownership.ownerIncarnation, exec_mode: definition.execMode, thread_id: null, turn_id: null,
        model: null, usage_json: null, summary: null, lane_wait_ms: null, queued_at: now, started_at: null, ended_at: now,
      } : undefined;
      let terminalNext: number | undefined;
      try { if (overlap) terminalNext = overlapNext(job, definition, overlap); }
      catch (error) { throw new StoreIntegrityError(`Invalid overlap projection: ${error instanceof Error ? error.message : 'unknown'}`); }
      let inserted: { run_id: string } | undefined;
      try {
        if (overlap) {
          const columns = Object.keys(overlap) as (keyof RunRow)[];
          inserted = this.db.prepare(`INSERT INTO cron_runs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
            ON CONFLICT(occurrence_id,attempt) DO NOTHING RETURNING run_id`)
            .get(...columns.map(column => overlap[column])) as { run_id: string } | undefined;
        } else inserted = this.db.prepare(`INSERT INTO cron_runs (run_id,job_id,trigger,manual_mode,schedule_ownership,
          authored_occurrence_id,authored_slot,admitted_enabled,admitted_next_run_at,scheduled_for,attempt,occurrence_id,
          ready_at,status,definition_snapshot_json,admitted_generation,reset_generation,owner_incarnation,exec_mode,queued_at)
          VALUES (?,?,?,NULL,'consume',?,?,1,?,?,0,?,?,'queued',?,?,?,?,?,?)
          ON CONFLICT(occurrence_id,attempt) DO NOTHING RETURNING run_id`)
          .get(request.runId, jobId, request.trigger, occurrence, slot, job.next_run_at, slot, occurrence, slot,
            JSON.stringify(snapshot), job.generation, request.ownership.resetGeneration, request.ownership.ownerIncarnation,
            definition.execMode, now) as { run_id: string } | undefined;
      } catch (error) {
        if (String((error as { code?: string }).code).startsWith('SQLITE_CONSTRAINT')) throw new StoreIntegrityError('Unrelated receipt constraint failure');
        throw error;
      }
      if (!inserted) {
        stored.push(...this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? AND attempt=0').all(occurrence) as RunRow[]);
        return existing();
      }
      if (this.admissionTestSeams.afterReceiptInsert?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (overlap) {
        try { projectNewOverlap(this.db, job, definition, overlap, terminalNext!); }
        catch (error) { throw new StoreIntegrityError(`Terminal projection failed: ${error instanceof Error ? error.message : 'unknown'}`); }
        if (this.admissionTestSeams.afterJobProjection?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
        admission.assertOwnership(request);
        return v.freeze({ kind: 'overlap', run: this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow });
      }
      // Reservation is not consumption: W, counters and all last_* fields stay untouched.
      // At keeps its authored slot; recurring scheduled uses slot(S), catch-up uses slot(now).
      const naturalNext = schedule.kind === 'at' ? job.next_run_at : next(schedule, request.trigger === 'catchup' ? now : slot) ?? null;
      const update = this.db.prepare('UPDATE cron_jobs SET next_run_at=? WHERE id=? AND generation=? AND enabled=1 AND deleted_at IS NULL')
        .run(naturalNext, jobId, job.generation);
      if (update.changes !== 1) throw new StoreConflict('Job changed during admission');
      if (this.admissionTestSeams.afterJobProjection?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      admission.assertOwnership(request);
      return v.freeze({ kind: 'reserved', run: this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow });
    });
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
