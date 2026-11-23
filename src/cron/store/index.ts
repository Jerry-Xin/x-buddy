// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { next, previousOrBefore, occurrenceId, timestamp, validateTimezone } from '../schedule/engine.js';
import type { Schedule } from '../schedule/engine.js';
import { CRON_DDL } from './schema.js';
import type { StoreDatabase, StoreScope, CreateJob, JobPatch, JobRow, Definition, StoredSchedule, AdmissionRequest, AdmissionResult, AdmissionTestSeams, RunRow, TerminalRequest, TerminalResult, BeginDeliveryRequest, ExecutionMetadata, DisableNoticeIntent } from './types.js';
import * as admission from './admission.js';
import { overlapNext, projectNewOverlap, terminalNext, projectTerminal } from './terminal-projection.js';
import * as terminal from './terminal.js';
import * as failure from './failure.js';
import * as execution from './execution.js';
import * as storedOutcome from './outcome.js';
import * as supersession from './supersession.js';
import * as manual from './manual.js';
import * as restart from './restart.js';
import type { RestartBinding } from './types.js';
import type { ExecutionAdmissionRequest, ExecutionAdmissionResult, ExecutionAdmissionVerifier, ManualAdmissionRequest, ManualAdmissionResult, RestartReconciliationRequest, RestartReconciliationResult } from './types.js';
import * as v from './validation.js';
export { CRON_DDL, CRON_DDL_SHA256, R8_CONTENT_SHA256 } from './schema.js';
export type * from './types.js';
export { expectation as terminalExpectation } from './terminal.js';

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

function capUtf8Bytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let out = '';
  let used = 0;
  for (const ch of input) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (used + bytes > maxBytes) break;
    out += ch;
    used += bytes;
  }
  return out;
}

function hasTable(db: StoreDatabase, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
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
  private readonly executionVerifier: ExecutionAdmissionVerifier | undefined;
  #restart: ReturnType<typeof restart.bind> | undefined;
  constructor(db: StoreDatabase, clock: { now(): number }, admissionTestSeams: AdmissionTestSeams = {}, executionVerifier?: ExecutionAdmissionVerifier, restartBinding?: RestartBinding) {
    this.db = db;
    this.clock = clock;
    this.admissionTestSeams = admissionTestSeams;
    this.executionVerifier = executionVerifier;
    this.#restart = restartBinding === undefined ? undefined : restart.bind(restartBinding);
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
    return this.decodeDefinition(row);
  }
  private decodeDefinition(row: JobRow): Definition {
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
      if (active && schedule.kind === 'at') {
        // One-shots preserve authored eligibility and their existing typed deferral.
        return v.freeze({ kind: 'deferred', reason: active.status === 'queued' && active.trigger === 'retry'
          ? 'queued-retry-supersession' : 'one-shot-busy',
          activeRunId: active.run_id, recheckAfterMs: 30000 });
      }
      let superseded: { row: RunRow; next: number; chain: RunRow[] } | undefined;
      if (active?.status === 'queued' && active.trigger === 'retry') {
        if (active.owner_incarnation !== request.ownership.ownerIncarnation
          || active.reset_generation !== request.ownership.resetGeneration || active.admitted_generation !== job.generation) {
          // Recovery/ownership transfer is outside this branch. Preserve the
          // existing no-write deferral rather than overwrite another owner.
          admission.assertOwnership(request);
          return v.freeze({ kind: 'deferred', reason: 'queued-retry-supersession', activeRunId: active.run_id, recheckAfterMs: 30000 });
        }
        let prepared: ReturnType<typeof supersession.prepare>;
        try { prepared = supersession.prepare(this.db, job, definition, active, slot, now); }
        catch (error) { throw new StoreIntegrityError(`Invalid supersession provenance; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
        if ('kind' in prepared) { admission.assertOwnership(request); return v.freeze(prepared); }
        superseded = prepared;
        if (!execution.authorityMatches(request, job, definition, active)) {
          throw new StoreConflict('Current authority/policy does not match queued retry');
        }
      }
      const snapshot = admission.snapshot(definition, occurrence, slot, job.next_run_at, policy);
      // Only the validated queued retry may be retired. Other active work is
      // preserved by direct-terminal overlap. Validate cadence before mutation.
      const overlap: RunRow | undefined = active && !superseded ? {
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
      let projectedJob = job;
      if (superseded) {
        if (this.admissionTestSeams.beforeSupersessionCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
        const columns = Object.keys(active!) as (keyof RunRow)[];
        const changed = this.db.prepare(`UPDATE cron_runs SET status='skipped',phase=NULL,completion=NULL,
          delivery_state='not-requested',history_state='skipped_not_requested',reason='retry-superseded',error=NULL,ended_at=?
          WHERE status='queued' AND ${columns.map(k => `${k} IS ?`).join(' AND ')}`)
          .run(now, ...columns.map(k => active![k]));
        if (changed.changes !== 1) throw new StoreConflict('Queued retry supersession CAS missed');
        if (this.admissionTestSeams.afterTerminalCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
        if (!execution.sameJob(job, this.find(scope, jobId))) throw new StoreConflict('Job changed during supersession');
        try { projectTerminal(this.db, job, definition, superseded.row, 'neutral', superseded.next); }
        catch (error) { throw new StoreIntegrityError(`Supersession projection failed: ${error instanceof Error ? error.message : 'unknown'}`); }
        projectedJob = this.find(scope, jobId)!;
      }
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
        if (superseded) throw new StoreIntegrityError('New base reservation conflicted after supersession');
        stored.push(...this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? AND attempt=0').all(occurrence) as RunRow[]);
        return existing();
      }
      const reserved = superseded ? this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow : undefined;
      if (this.admissionTestSeams.afterReceiptInsert?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (overlap) {
        try { projectNewOverlap(this.db, job, definition, overlap, terminalNext!); }
        catch (error) { throw new StoreIntegrityError(`Terminal projection failed: ${error instanceof Error ? error.message : 'unknown'}`); }
        if (this.admissionTestSeams.afterJobProjection?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
        admission.assertOwnership(request);
        return v.freeze({ kind: 'overlap', run: this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow });
      }
      // The new reservation adds no consumption, counter or informational effect.
      // At keeps its authored slot; recurring scheduled uses slot(S), catch-up uses slot(now).
      const naturalNext = schedule.kind === 'at' ? job.next_run_at : next(schedule, request.trigger === 'catchup' ? now : slot) ?? null;
      if (superseded && !execution.sameJob(projectedJob, this.find(scope, jobId))) throw new StoreConflict('Job changed before base reservation projection');
      const nextRun = superseded ? Math.max(projectedJob.next_run_at!, naturalNext ?? projectedJob.next_run_at!) : naturalNext;
      const update = this.db.prepare('UPDATE cron_jobs SET next_run_at=? WHERE id=? AND generation=? AND enabled=1 AND deleted_at IS NULL')
        .run(nextRun, jobId, job.generation);
      if (update.changes !== 1) throw new StoreConflict('Job changed during admission');
      if (this.admissionTestSeams.afterJobProjection?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      admission.assertOwnership(request);
      if (superseded) {
        admission.validateRequest(request, job, definition);
        if (!execution.authorityMatches(request, job, definition, active!)) throw new StoreConflict('Authority changed before supersession commit');
        const commitNow = timestamp(this.clock.now());
        if (commitNow < now || commitNow < slot) throw new StoreConflict('Clock changed before supersession commit');
        if (!execution.sameJob({ ...projectedJob, next_run_at: nextRun }, this.find(scope, jobId))) throw new StoreConflict('Job changed before supersession commit');
        const retained = this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(active!.occurrence_id) as RunRow[];
        if (!execution.sameChain(superseded.chain.map(member => member.run_id === active!.run_id ? superseded.row : member), retained)
          || !execution.sameRun(reserved!, this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow)) {
          throw new StoreIntegrityError('Supersession receipts changed before commit');
        }
        const currentActive = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").all(jobId) as RunRow[];
        if (currentActive.length !== 1 || currentActive[0]!.run_id !== inserted.run_id) throw new StoreIntegrityError('New base is not the sole active receipt');
      }
      return v.freeze({ kind: 'reserved', run: this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow });
    });
  }

  /** Reserve an explicit local invocation. No operator authority or execution permit is minted. */
  admitManual(scope: StoreScope, jobId: string, request: ManualAdmissionRequest): ManualAdmissionResult {
    return transaction(this.db, () => {
      const job = this.find(scope, jobId);
      if (!job || job.deleted_at !== null) throw new JobNotFound('Job not found');
      if (job.generation !== request.generation) throw new StoreConflict('Job generation changed');
      const definition = this.decodeDefinition(job), policy = manual.validate(request, job, definition);
      const identity = () => [request.trigger, request.manualMode, request.generation, request.runId, request.invocationId,
        request.ownership.ownerIncarnation, request.ownership.resetGeneration];
      const admittedIdentity = identity();
      const now = timestamp(this.clock.now());
      const finish = (result: ManualAdmissionResult): ManualAdmissionResult => {
        const currentPolicy = manual.validate(request, job, definition);
        if (!execution.sameJob(job, this.find(scope, jobId)) || !isDeepStrictEqual(policy, currentPolicy)
          || !isDeepStrictEqual(admittedIdentity, identity())) throw new StoreConflict('Manual definition/authority changed before commit');
        if (timestamp(this.clock.now()) < now) throw new StoreConflict('Clock moved backward before manual commit');
        return v.freeze(result);
      };
      const validateExisting = (row: RunRow, invocationReplay: boolean): ManualAdmissionResult => {
        if (row.admitted_generation !== job.generation) throw new StoreConflict('Manual invocation belongs to another generation');
        try { manual.existing(this.db, row, job, definition); }
        catch (error) { throw new StoreIntegrityError(`Invalid manual receipt; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
        if (row.owner_incarnation !== request.ownership.ownerIncarnation || row.reset_generation !== request.ownership.resetGeneration
          || !execution.authorityMatches(request, job, definition, row)) throw new StoreConflict('Manual receipt owner/authority changed');
        if (invocationReplay && (row.trigger !== 'manual' || row.manual_mode !== request.manualMode
          || row.schedule_ownership === 'borrow' && row.occurrence_id !== request.invocationId)) throw new StoreConflict('Manual invocation identity changed');
        return finish({ kind: 'existing', run: row });
      };
      const repeats = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? OR occurrence_id=?')
        .all(request.runId, request.invocationId) as RunRow[];
      if (repeats.length) {
        if (repeats.length !== 1 || repeats[0]!.job_id !== jobId) throw new StoreIntegrityError('Conflicting manual invocation identities');
        return validateExisting(repeats[0]!, true);
      }
      const active = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").get(jobId) as RunRow | undefined;
      if (active) return finish({ kind: 'already-running', activeRunId: active.run_id });
      if (job.enabled !== 1 && request.manualMode !== 'force') return finish({ kind: 'disabled' });
      let selected: ReturnType<typeof manual.selection>;
      try { selected = manual.selection(job, definition, now, request.manualMode); }
      catch (error) { throw new StoreIntegrityError(`Invalid manual eligibility: ${error instanceof Error ? error.message : 'unknown'}`); }
      if (request.manualMode === 'due' && !selected.due
        || job.enabled === 1 && definition.schedule.kind === 'at' && definition.schedule.atMs <= now && !selected.due) {
        return finish({ kind: 'not-due' });
      }
      const snapshot = manual.snapshot(definition, job, request, selected, policy);
      if (selected.consume) {
        const canonical = this.db.prepare(`SELECT * FROM cron_runs WHERE (occurrence_id=? AND attempt=0)
          OR (job_id=? AND admitted_generation=? AND scheduled_for=? AND attempt=0)`)
          .all(snapshot.occurrenceId, jobId, job.generation, snapshot.authoredSlot) as RunRow[];
        if (canonical.length) {
          if (canonical.length !== 1) throw new StoreIntegrityError('Conflicting authored receipts');
          return validateExisting(canonical[0]!, false);
        }
      }
      const inserted = this.db.prepare(`INSERT INTO cron_runs (run_id,job_id,trigger,manual_mode,schedule_ownership,
        authored_occurrence_id,authored_slot,admitted_enabled,admitted_next_run_at,scheduled_for,attempt,occurrence_id,
        ready_at,status,definition_snapshot_json,admitted_generation,reset_generation,owner_incarnation,exec_mode,queued_at)
        VALUES (?,?,'manual',?,?,?,?,?,?,?,0,?,?,'queued',?,?,?,?,?,?) RETURNING run_id`)
        .get(request.runId, jobId, request.manualMode, snapshot.scheduleOwnership, snapshot.authoredOccurrenceId,
          snapshot.authoredSlot, +snapshot.admittedEnabled, snapshot.admittedNextRunAt, selected.consume ? snapshot.authoredSlot : null,
          snapshot.occurrenceId, now, JSON.stringify(snapshot), job.generation, request.ownership.resetGeneration,
          request.ownership.ownerIncarnation, definition.execMode, now) as { run_id: string } | undefined;
      if (!inserted) throw new StoreIntegrityError('Manual receipt was not inserted');
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(inserted.run_id) as RunRow;
      if (this.admissionTestSeams.afterReceiptInsert?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (this.admissionTestSeams.beforeManualCommit?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (!execution.sameRun(row, this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id) as RunRow)) throw new StoreIntegrityError('Manual receipt changed before commit');
      const currentActive = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").all(jobId) as RunRow[];
      if (currentActive.length !== 1 || !execution.sameRun(row, currentActive[0]!)) throw new StoreIntegrityError('Manual receipt is not sole active work');
      return finish({ kind: 'reserved', run: row });
    });
  }

  /** Store-only recovery under the same constructor-bound canonical lease.
   * No dispatch, authority grant, resend, publication or lifecycle acquisition.
   */
  reconcileRestart(scope: StoreScope, jobId: string, request: RestartReconciliationRequest): RestartReconciliationResult {
    v.scopeSql(scope); v.id(jobId);
    v.keys(request, ['expected', 'ownership', 'effects']);
    const envelope: TerminalRequest = {
      expected: request.expected,
      ownership: request.ownership,
      outcome: { kind: 'restart' },
      ...(request.effects === undefined ? {} : { effects: request.effects }),
    };
    terminal.validateRequest(envelope, jobId);
    terminal.assertHeld(envelope);
    if (!this.#restart) return v.freeze({ kind: 'deferred', reason: 'restart-reconciliation', prerequisite: 'previous-child-termination-unavailable' });
    const binding = this.#restart, captured = restart.capture(request), expected = captured.expected;
    const guard = () => {
      terminal.assertHeld(captured); binding.assertCurrent();
      if (captured.ownership.ownerIncarnation !== binding.expected.currentIncarnationId) throw new StoreConflict('Restart owner differs from the canonical lease');
    };
    guard(); // Missing/lost/forged native origin stops before any DB access.
    return transaction(this.db, () => {
      guard();
      const finish = (result: RestartReconciliationResult): RestartReconciliationResult => { guard(); return v.freeze(result); };
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? AND job_id=?').get(expected.run_id, jobId) as RunRow | undefined;
      if (!row) return finish({ kind: 'miss' });
      const job = this.find(scope, jobId);
      let definition: Definition;
      let chain: RunRow[];
      try {
        definition = terminal.provenance(row, job, job ? this.decodeDefinition(job) : undefined);
        if (row.trigger === 'manual') manual.validateReceipt(row, definition);
        storedOutcome.validate(row, definition);
        chain = this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[];
        if (!chain.length || !chain.some(member => execution.sameRun(member, row))) throw new TypeError('Missing retained receipt');
        for (const member of chain) {
          terminal.provenance(member, job, job?.generation === member.admitted_generation ? definition : undefined);
          if (member.trigger === 'manual') manual.validateReceipt(member, definition);
          storedOutcome.validate(member, definition);
        }
        failure.validateChain(this.db, job, definition, chain.at(-1)!);
        if (row.started_at !== null && row.started_at < row.ready_at) throw new TypeError('Receipt started before readiness');
      } catch (error) { throw new StoreIntegrityError(`Invalid restart provenance; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
      if ('targetSession' in scope && definition.target.sessionKey !== scope.targetSession) throw new JobNotFound('Receipt not in scope');
      const old = binding.expected.previousIncarnationId, current = binding.expected.currentIncarnationId;
      if (old === current || expected.owner_incarnation !== old || captured.ownership.resetGeneration !== row.reset_generation
        || !terminal.identityColumns.every(k => k === 'owner_incarnation' || isDeepStrictEqual(row[k], expected[k]))) {
        return finish({ kind: 'miss', run: row });
      }
      // A transferred reservation may already have started. This is stored data,
      // never a second transfer or execution grant. Current work is not stolen.
      if (row.owner_incarnation === current && expected.status === 'queued' && row.trigger !== 'manual') return finish({ kind: 'existing', run: row });
      if (row.owner_incarnation !== old) return finish({ kind: 'miss', run: row });
      if (!['queued', 'running'].includes(row.status)) return finish({ kind: 'existing', run: row });
      if (row.status !== expected.status) return finish({ kind: 'miss', run: row });
      const active = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").all(jobId) as RunRow[];
      if (active.length !== 1 || !execution.sameRun(active[0]!, row)
        || chain.some(member => ![old, current].includes(member.owner_incarnation))) throw new StoreIntegrityError('Foreign or conflicting restart chain');
      const ended = timestamp(this.clock.now());
      if (ended < (row.started_at ?? row.queued_at)) throw new StoreIntegrityError('Restart clock predates the receipt');
      const resumed = row.status === 'queued' && row.trigger !== 'manual';
      let result: RunRow;
      let plan: failure.FailurePlan | undefined;
      let natural: number | null = null;
      if (resumed) {
        if (!job || job.deleted_at !== null || job.enabled !== 1 || job.generation !== row.admitted_generation) return finish({ kind: 'deferred', reason: 'outcome-policy' });
        try {
          execution.clean(row);
          if (row.authored_slot! < timestamp(job.schedule_activated_at)) throw new TypeError('Reservation predates activation');
        } catch (error) { throw new StoreIntegrityError(`Invalid retained reservation: ${error instanceof Error ? error.message : 'unknown'}`); }
        result = { ...row, owner_incarnation: current };
      } else {
        const uncertain = row.phase === 'delivering';
        if (!uncertain) {
          const unsupported = terminal.noResultDeferred(row);
          if (unsupported) return finish(unsupported);
        } else if (!['started', 'unknown', 'not-started', 'not-requested', 'suppressed'].includes(row.delivery_state)) {
          return finish({ kind: 'deferred', reason: 'publication-or-delivery' });
        }
        result = { ...row, status: row.status === 'queued' ? 'skipped' : 'interrupted', phase: null,
          completion: uncertain ? 'unknown' : null, delivery_state: uncertain ? 'unknown' : row.delivery_state === 'suppressed' ? 'suppressed' : 'not-requested',
          history_state: uncertain ? 'skipped_not_delivered' : row.delivery_state === 'suppressed' ? 'skipped_suppressed' : 'skipped_not_requested',
          reason: 'restart', error: null, ended_at: ended };
        const authored = job && job.deleted_at === null && job.generation === row.admitted_generation && row.schedule_ownership === 'consume';
        if (authored && row.status === 'running') {
          const planned = failure.planRestart(job, definition, result, captured.effects);
          if ('kind' in planned) return finish(planned);
          plan = planned;
        }
        const next = terminalNext(job, definition, result);
        if (next === undefined) return finish({ kind: 'deferred', reason: 'schedule-exhausted' });
        natural = next;
      }
      if (this.admissionTestSeams.beforeRestartCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (!isDeepStrictEqual(job, this.find(scope, jobId))) throw new StoreConflict('Job changed before restart CAS');
      guard(); // Last synchronous native/ownership check immediately before CAS.
      const columns = Object.keys(row) as (keyof RunRow)[];
      const changed = this.db.prepare(`UPDATE cron_runs SET owner_incarnation=?,status=?,phase=?,completion=?,delivery_state=?,history_state=?,reason=?,error=?,ended_at=?
        WHERE ${columns.map(k => `${k} IS ?`).join(' AND ')}`)
        .run(result.owner_incarnation, result.status, result.phase, result.completion, result.delivery_state, result.history_state,
          result.reason, result.error, result.ended_at, ...columns.map(k => row[k]));
      if (changed.changes !== 1) throw new StoreConflict('Restart full-receipt CAS missed');
      if (this.admissionTestSeams.afterRestartCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (!isDeepStrictEqual(job, this.find(scope, jobId))) throw new StoreConflict('Job changed after restart CAS');
      if (!resumed) projectTerminal(this.db, job, definition, result, plan ? 'failure' : 'neutral', natural, plan);
      const projected = this.find(scope, jobId);
      if (this.admissionTestSeams.afterJobProjection?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (this.admissionTestSeams.beforeRestartCommit?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (!isDeepStrictEqual(projected, this.find(scope, jobId)) || timestamp(this.clock.now()) < ended
        || !execution.sameChain(chain.map(member => member.run_id === row.run_id ? result : member),
          this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[])) {
        throw new StoreConflict('Restart facts changed before commit');
      }
      return finish({ kind: resumed ? 'resumed' : 'repaired', run: result });
    });
  }

  /** Bounded R8 terminal CAS. Unsupported policy/publication work returns before any writes. */
  finalize(scope: StoreScope, jobId: string, request: TerminalRequest): TerminalResult {
    return transaction(this.db, () => {
      v.id(jobId); v.scopeSql(scope); terminal.validateRequest(request, jobId);
      const finish = (result: TerminalResult): TerminalResult => { terminal.assertHeld(request); return v.freeze(result); };
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? AND job_id=?')
        .get(request.expected.run_id, jobId) as RunRow | undefined;
      if (!row) return finish({ kind: 'miss' });
      const job = this.find(scope, jobId);
      let definition: Definition;
      try {
        definition = terminal.provenance(row, job, job ? this.decodeDefinition(job) : undefined);
        if (row.trigger === 'manual') manual.validateReceipt(row, definition);
      }
      catch (error) { throw new StoreIntegrityError(`Invalid terminal provenance; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
      if ('targetSession' in scope && definition.target.sessionKey !== scope.targetSession) throw new JobNotFound('Receipt not in scope');
      if (!terminal.matches(row, request)) return finish({ kind: 'miss', run: row });
      if (row.trigger === 'manual' && request.ownership.resetGeneration !== row.reset_generation) return finish({ kind: 'miss', run: row });
      if (!['queued', 'running'].includes(row.status)) {
        try { storedOutcome.validate(row, definition); }
        catch (error) { throw new StoreIntegrityError(`Invalid stored terminal outcome; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
        return finish({ kind: 'existing', run: row });
      }
      if (row.status !== request.expected.status) return finish({ kind: 'miss', run: row });
      const manualOutcome = row.trigger === 'manual' ? { ...request.outcome } : undefined;
      if (request.retryChain === true || request.outcome.kind === 'failure') {
        try { failure.validateChain(this.db, job, definition, row); }
        catch (error) { throw new StoreIntegrityError(`Invalid retry chain; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
      }
      const deferred = terminal.deferred(row, definition, request);
      if (deferred) return finish(deferred);
      const ended = timestamp(this.clock.now());
      if (ended < row.queued_at || row.started_at !== null && (row.started_at < row.queued_at || ended < row.started_at)
        || row.status === 'running' && row.started_at === null || row.status === 'queued' && row.started_at !== null) {
        throw new StoreIntegrityError('Invalid receipt timing');
      }
      const success = request.outcome.kind === 'success';
      const unknownDelivery = success && request.outcome.deliveryState === 'unknown';
      const deliveredDelivery = success && request.outcome.deliveryState === 'delivered';
      const classified = request.outcome.kind === 'failure' ? request.outcome : undefined;
      const busy = classified?.reason === 'session-busy', targetFailure = classified?.reason === 'target-unavailable';
      const delivery = request.outcome.kind === 'success' ? request.outcome.deliveryState : row.delivery_state === 'suppressed' ? 'suppressed' : 'not-requested';
      let historyState: string;
      let currentSessionResetGen = row.reset_generation;
      if (deliveredDelivery) {
        if (hasTable(this.db, 'session_generations')) {
          const genRow = this.db.prepare('SELECT generation FROM session_generations WHERE session_id=?').get(definition.target.sessionKey) as { generation: number } | undefined;
          currentSessionResetGen = genRow?.generation ?? 0;
        }
        if (currentSessionResetGen !== row.reset_generation) {
          historyState = 'skipped_reset';
        } else if (row.exec_mode === 'session') {
          historyState = 'skipped_session_mode';
        } else {
          historyState = 'published';
        }
      } else if (unknownDelivery || targetFailure) {
        historyState = 'skipped_not_delivered';
      } else if (delivery === 'suppressed') {
        historyState = 'skipped_suppressed';
      } else {
        historyState = 'skipped_not_requested';
      }
      const neutralAuthorityRevoked = request.outcome.kind === 'neutral' && request.outcome.reason === 'authority_revoked';
      const result: RunRow = { ...row,
        status: classified ? (busy ? 'skipped' : targetFailure ? 'ok' : 'error')
          : success ? 'ok'
          : (row.status === 'queued' || neutralAuthorityRevoked) ? 'skipped' : 'interrupted',
        phase: null,
        completion: unknownDelivery ? 'unknown' : success ? 'succeeded' : classified && !busy ? 'failed' : null,
        delivery_state: targetFailure ? 'not-delivered' : delivery,
        history_state: historyState,
        reason: classified?.reason ?? (request.outcome.kind === 'neutral' ? request.outcome.reason : (unknownDelivery ? (request.outcome.reason ?? null) : null)),
        error: (classified?.redactedError ?? classified?.error) ?? (unknownDelivery ? (request.outcome.error ?? null) : null),
        ended_at: ended };
      let effectPlan: failure.FailurePlan | undefined;
      if (classified && job && job.deleted_at === null && job.generation === row.admitted_generation && row.schedule_ownership === 'consume') {
        let planned: failure.FailurePlan | TerminalResult;
        try { planned = failure.plan(job, definition, result, request); }
        catch (error) { throw new StoreIntegrityError(`Invalid failure projection; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
        if ('kind' in planned) return finish(planned);
        effectPlan = planned;
      }
      let naturalNext: number | null | undefined;
      try { naturalNext = terminalNext(job, definition, result); }
      catch (error) { throw new StoreIntegrityError(`Invalid terminal projection: ${error instanceof Error ? error.message : 'unknown'}`); }
      if (naturalNext === undefined) return finish({ kind: 'deferred', reason: 'schedule-exhausted' });
      const changed = this.db.prepare(`UPDATE cron_runs SET status=?,phase=NULL,completion=?,delivery_state=?,history_state=?,reason=?,error=?,ended_at=?
        WHERE status=? AND ${terminal.identityColumns.map(k => `${k} IS ?`).join(' AND ')}`)
        .run(result.status, result.completion, result.delivery_state, result.history_state, result.reason, result.error, ended,
          request.expected.status, ...terminal.identityColumns.map(k => request.expected[k]));
      if (changed.changes !== 1) return finish({ kind: 'miss', run: row });
      if (this.admissionTestSeams.afterTerminalCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (row.trigger === 'manual' && (!execution.sameJob(job!, this.find(scope, jobId))
        || !execution.sameRun(result, this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id) as RunRow))) {
        throw new StoreConflict('Manual terminal facts changed after CAS');
      }
      const projectionOutcome = classified ? 'failure' : (success && !unknownDelivery) ? 'success' : 'neutral';
      try { projectTerminal(this.db, job, definition, result, projectionOutcome, naturalNext, effectPlan); }
      catch (error) { throw new StoreIntegrityError(`Terminal projection failed: ${error instanceof Error ? error.message : 'unknown'}`); }
      const projectedManualJob = row.trigger === 'manual' ? this.find(scope, jobId) : undefined;
      if (this.admissionTestSeams.afterJobProjection?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      if (effectPlan?.retryAt !== undefined) {
        if (this.admissionTestSeams.beforeRetryInsert?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
        failure.insertSuccessor(this.db, result, request.retryRunId!, effectPlan.retryAt);
        if (this.admissionTestSeams.afterRetryInsert?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      }
      if (deliveredDelivery && (historyState === 'published' || historyState === 'skipped_session_mode')) {
        const pubContent = request.effects?.publication?.content;
        if (typeof pubContent === 'string' && pubContent.length > 0 && hasTable(this.db, 'sessions') && hasTable(this.db, 'messages')) {
          this.db.prepare(
            'INSERT INTO sessions (id, channel_id, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
          ).run(definition.target.sessionKey, definition.target.channelId, definition.target.channelType, ended, ended);
          this.db.prepare(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)",
          ).run(definition.target.sessionKey, pubContent, ended);
        }
        if (historyState === 'published' && hasTable(this.db, 'context_notes')) {
          const rawNote = request.effects?.publication?.noteText ?? pubContent ?? `[scheduled task ${jobId}]`;
          const noteText = capUtf8Bytes(rawNote, 8192);
          this.db.prepare(
            "INSERT INTO context_notes (session_id, run_id, generation, kind, text, created_at) VALUES (?, ?, ?, 'cron_result', ?, ?)",
          ).run(definition.target.sessionKey, row.run_id, row.reset_generation, noteText, ended);
        }
      }
      if (row.trigger === 'manual') {
        if (!isDeepStrictEqual(projectedManualJob, this.find(scope, jobId))
          || !execution.sameRun(result, this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id) as RunRow)
          || timestamp(this.clock.now()) < ended || request.ownership.resetGeneration !== row.reset_generation
          || !terminal.matches(result, request) || !isDeepStrictEqual(manualOutcome, request.outcome)) {
          throw new StoreConflict('Manual terminal facts changed before commit');
        }
      }
      const finalizedRun = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id) as RunRow;
      if (request.effects !== undefined && (effectPlan?.alertIntent || effectPlan?.disableNotice)) {
        return finish({
          kind: 'finalized',
          run: finalizedRun,
          ...(effectPlan.alertIntent ? { alertIntent: effectPlan.alertIntent } : {}),
          ...(effectPlan.disableNotice ? { disableNotice: effectPlan.disableNotice } : {}),
        });
      }
      return finish({ kind: 'finalized', run: finalizedRun });
    });
  }

  /** Ready-to-dispatch entry for a retained base. Reservation and terminal effects stay separate. */
  startBase(scope: StoreScope, jobId: string, request: ExecutionAdmissionRequest): ExecutionAdmissionResult {
    return this.startExecution(scope, jobId, request, 'base');
  }
  /** Manual-specific entry; uses the same constructor-bound issuer and fixed deadline. */
  startManual(scope: StoreScope, jobId: string, request: ExecutionAdmissionRequest): ExecutionAdmissionResult {
    return this.startExecution(scope, jobId, request, 'manual');
  }
  admitRetry(scope: StoreScope, jobId: string, request: ExecutionAdmissionRequest): ExecutionAdmissionResult;
  admitRetry(scope: StoreScope, jobId: string, runId: string, ownership: TerminalRequest['ownership']): Readonly<{ kind: 'deferred'; reason: 'retry-admission' }>;
  admitRetry(scope: StoreScope, jobId: string, input: string | ExecutionAdmissionRequest, ownership?: TerminalRequest['ownership']): ExecutionAdmissionResult | Readonly<{ kind: 'deferred'; reason: 'retry-admission' }> {
    if (typeof input !== 'string') return this.startExecution(scope, jobId, input, 'retry');
    // Exact legacy no-write API, with no implied candidate verification or execution grant.
    return transaction(this.db, () => {
      v.scopeSql(scope); v.id(jobId); v.text(input);
      v.keys(ownership, ['ownerIncarnation', 'resetGeneration', 'assertHeld']);
      v.text(ownership!.ownerIncarnation); v.page(ownership!.resetGeneration, 0, Number.MAX_SAFE_INTEGER);
      const proof = { ownership } as TerminalRequest;
      terminal.assertHeld(proof);
      terminal.assertHeld(proof);
      return v.freeze({ kind: 'deferred', reason: 'retry-admission' });
    });
  }

  private startExecution(scope: StoreScope, jobId: string, input: ExecutionAdmissionRequest, entry: 'base' | 'manual' | 'retry'): ExecutionAdmissionResult {
    this.#restart?.assertCurrent();
    const retry = entry === 'retry', manualEntry = entry === 'manual';
    v.scopeSql(scope); v.id(jobId);
    if (this.db.inTransaction) throw new StoreConflict('Caller transaction must finish before store operation');
    const request = execution.capture(input, jobId);
    // External resolution finishes before BEGIN. There is deliberately no default issuer.
    const prepared = request && this.executionVerifier?.prepare(request);
    if (prepared !== undefined) {
      v.keys(prepared, ['assertCurrent']);
      if (typeof prepared.assertCurrent !== 'function') throw new TypeError('Expected synchronous prepared issuer guard');
    }
    const deferred = (prerequisite: 'proof-missing' | 'issuer-unavailable' | 'not-ready' | 'permit-not-current' | 'schedule-exhausted'): ExecutionAdmissionResult =>
      ({ kind: 'deferred', reason: retry ? 'retry-admission' : 'execution-admission', prerequisite });
    return transaction(this.db, () => {
      const ownership = request?.ownership ?? input.ownership;
      execution.held(ownership);
      const finish = (result: ExecutionAdmissionResult): ExecutionAdmissionResult => {
        execution.held(ownership);
        if (prepared) execution.guard(() => prepared.assertCurrent());
        this.#restart?.assertCurrent();
        return v.freeze(result);
      };
      if (!request) return finish(deferred('proof-missing'));
      if (!prepared) return finish(deferred('issuer-unavailable'));
      execution.guard(() => prepared.assertCurrent());
      const job = this.find(scope, jobId);
      if (!job) throw new JobNotFound('Job not found');
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? AND job_id=?')
        .get(request.expected.run_id, jobId) as RunRow | undefined;
      if (!row) return finish({ kind: 'miss' });
      let definition: Definition;
      try { definition = terminal.provenance(row, job, this.decodeDefinition(job)); }
      catch (error) { throw new StoreIntegrityError(`Invalid execution provenance; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
      if (!execution.matches(row, request)) return finish({ kind: 'miss', run: row });
      if (!execution.authorityMatches(request, job, definition, row)) throw new StoreConflict('Current authority/policy does not match the receipt');
      if (manualEntry ? row.trigger !== 'manual' || row.attempt !== 0 || !['consume', 'borrow'].includes(row.schedule_ownership)
        : row.schedule_ownership !== 'consume' || (retry ? row.trigger !== 'retry' || row.attempt < 1 || row.attempt > 3
          : row.attempt !== 0 || !['scheduled', 'catchup'].includes(row.trigger))) throw new StoreConflict('Wrong execution admission candidate');
      if (manualEntry) {
        try { manual.validateReceipt(row, definition); }
        catch (error) { throw new StoreIntegrityError(`Invalid manual execution provenance: ${error instanceof Error ? error.message : 'unknown'}`); }
      }
      // Stored outcomes are data, never permission for a second dispatch or a new deadline.
      if (row.status !== 'queued') {
        if (row.started_at !== null && row.started_at < row.ready_at) throw new StoreIntegrityError('Stored execution predates readiness');
        try {
          const retained = this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[];
          const latest = retained.at(-1);
          if (!latest || !retained.some(member => execution.sameRun(member, row))) throw new TypeError('Stored outcome is missing from its chain');
          for (const member of retained) storedOutcome.validate(member, definition);
          failure.validateChain(this.db, job, definition, latest);
        } catch (error) { throw new StoreIntegrityError(`Invalid stored execution chain; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
        return finish({ kind: 'existing', run: row });
      }
      if (job.deleted_at !== null) throw new JobNotFound('Job not found');
      const disabledForce = manualEntry && row.schedule_ownership === 'borrow' && row.manual_mode === 'force'
        && row.admitted_enabled === 0 && job.enabled === 0;
      if ((!disabledForce && job.enabled !== 1) || job.generation !== row.admitted_generation
        || manualEntry && job.enabled !== row.admitted_enabled) throw new StoreConflict('Job generation or enablement changed');
      let predecessor: RunRow | undefined;
      let retained: RunRow[];
      try {
        execution.clean(row);
        if (job.last_slot_watermark !== null) timestamp(job.last_slot_watermark);
        failure.validateChain(this.db, job, definition, row);
        const chain = retained = this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[];
        if (manualEntry && row.schedule_ownership === 'borrow' && chain.length !== 1) throw new TypeError('Borrowed invocation has a forged retry');
        if (chain.some(member => member.owner_incarnation !== row.owner_incarnation)) {
          if (!this.#restart || row.owner_incarnation !== this.#restart.expected.currentIncarnationId
            || chain.some(member => ![row.owner_incarnation, this.#restart!.expected.previousIncarnationId].includes(member.owner_incarnation))) {
            throw new TypeError('Old-owner chain requires separately validated recovery');
          }
          this.#restart.assertCurrent();
        }
        predecessor = retry ? chain[row.attempt - 1] : undefined;
        if (row.schedule_ownership === 'consume' && row.authored_slot! < timestamp(job.schedule_activated_at)) throw new TypeError('Reserved slot predates activation');
      } catch (error) { throw new StoreIntegrityError(`Invalid execution chain; quarantine required: ${error instanceof Error ? error.message : 'unknown'}`); }
      const active = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").all(jobId) as RunRow[];
      if (active.length !== 1 || active[0]!.run_id !== row.run_id) throw new StoreIntegrityError('Execution candidate is not the sole active receipt');
      const now = timestamp(this.clock.now()), proof = request.executionProof;
      if (now < row.ready_at || now < row.queued_at) return finish(deferred('not-ready'));
      if (now < proof.permitGrantedAtMs || now >= proof.admissionDeadlineMs) return finish(deferred('permit-not-current'));
      const natural = execution.priority(definition, row, predecessor);
      if (retry && definition.schedule.kind !== 'at' && natural === undefined) return finish(deferred('schedule-exhausted'));
      if (natural !== undefined && now >= natural) return finish({ kind: 'deferred', reason: 'queued-retry-supersession', activeRunId: row.run_id, recheckAfterMs: 30000 });
      if (this.admissionTestSeams.beforeExecutionCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      this.#restart?.assertCurrent();
      const changed = this.db.prepare(`UPDATE cron_runs SET status='running',phase='executing',started_at=?
        WHERE status='queued' AND ${terminal.identityColumns.map(k => `${k} IS ?`).join(' AND ')}
        AND ${execution.cleanColumns.map(k => `${k} IS NULL`).join(' AND ')} AND delivery_state='not-started' AND segments_sent=0`)
        .run(now, ...terminal.identityColumns.map(k => request.expected[k]));
      if (changed.changes !== 1) throw new StoreConflict('Execution admission CAS missed');
      if (this.admissionTestSeams.afterExecutionCas?.() !== undefined) throw new TypeError('Fault seam must be synchronous');
      execution.held(ownership); execution.guard(() => prepared.assertCurrent());
      const commitNow = timestamp(this.clock.now());
      if (commitNow < now || commitNow < proof.permitGrantedAtMs || commitNow >= proof.admissionDeadlineMs
        || natural !== undefined && commitNow >= natural) throw new StoreConflict('Execution permit expired or clock/priority changed before commit');
      if (!execution.sameJob(job, this.find(scope, jobId))) throw new StoreConflict('Job changed before execution commit');
      const stored = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id) as RunRow;
      if (!execution.sameRun(stored, { ...row, status: 'running', phase: 'executing', started_at: now })) throw new StoreIntegrityError('Execution receipt changed before commit');
      const currentChain = this.db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[];
      if (!execution.sameChain(retained.map(member => member.run_id === row.run_id ? stored : member), currentChain)) {
        throw new StoreIntegrityError('Retained execution chain changed before commit');
      }
      this.#restart?.assertCurrent();
      return v.freeze({ kind: 'admitted', run: stored });
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
  tombstone(scope: StoreScope, jobId: string, expectedGeneration: number, options?: { allowActiveRunning?: boolean }): Readonly<JobRow> {
    return transaction(this.db, () => {
      this.current(scope, jobId, expectedGeneration);
      if (options?.allowActiveRunning === true) {
        if (this.db.prepare("SELECT 1 FROM cron_runs WHERE job_id=? AND status='queued' LIMIT 1").get(jobId)) {
          throw new DeferredOperation('Queued-run removal requires terminal projection before tombstone');
        }
      } else if (this.db.prepare("SELECT 1 FROM cron_runs WHERE job_id=? AND status IN ('queued','running') LIMIT 1").get(jobId)) {
        throw new DeferredOperation('Active-run removal requires executor cancellation and terminal projection');
      }
      const now = timestamp(this.clock.now());
      const result = this.db.prepare('UPDATE cron_jobs SET deleted_at=?,enabled=0,generation=generation+1,schedule_activated_at=?,last_slot_watermark=NULL,next_run_at=NULL,updated_at=? WHERE id=? AND generation=? AND deleted_at IS NULL')
        .run(now, now, now, jobId, expectedGeneration);
      if (result.changes !== 1) throw new StoreConflict('Job changed');
      return this.get(scope, jobId)!;
    });
  }

  countJobs(scope: StoreScope, options: { includeDisabled?: boolean; includeDeleted?: boolean } = {}): number {
    v.keys(options, ['includeDisabled', 'includeDeleted']);
    if (options.includeDisabled !== undefined) v.bool(options.includeDisabled);
    if (options.includeDeleted !== undefined) v.bool(options.includeDeleted);
    const filter = v.scopeSql(scope);
    const sql = `SELECT COUNT(*) AS n FROM cron_jobs WHERE ${filter.sql}${options.includeDisabled ? '' : ' AND enabled=1'}${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}`;
    const row = this.db.prepare(sql).get(...filter.args) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  listRuns(scope: StoreScope, jobId: string, options: { limit?: number; offset?: number } = {}): ReadonlyArray<Readonly<RunRow>> {
    v.keys(options, ['limit', 'offset']);
    const job = this.find(scope, jobId);
    if (!job) throw new JobNotFound('Job not found');
    const limit = v.page(options.limit ?? 10, 1, 200);
    const offset = v.page(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = this.db.prepare('SELECT * FROM cron_runs WHERE job_id=? ORDER BY queued_at DESC, attempt DESC, run_id DESC LIMIT ? OFFSET ?')
      .all(jobId, limit, offset) as RunRow[];
    return v.freeze(rows);
  }

  getRun(scope: StoreScope, jobId: string, runId: string): Readonly<RunRow> | undefined {
    v.text(runId);
    const job = this.find(scope, jobId);
    if (!job) return undefined;
    const row = this.db.prepare('SELECT * FROM cron_runs WHERE job_id=? AND run_id=?').get(jobId, runId) as RunRow | undefined;
    return row && v.freeze(row);
  }

  activeRunForJob(jobId: string): Readonly<RunRow> | undefined {
    v.id(jobId);
    const row = this.db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status IN ('queued','running')").get(jobId) as RunRow | undefined;
    return row && v.freeze(row);
  }

  listNonTerminalRuns(): ReadonlyArray<Readonly<RunRow>> {
    const rows = this.db.prepare("SELECT * FROM cron_runs WHERE status IN ('queued','running') ORDER BY queued_at ASC, attempt ASC, run_id ASC").all() as RunRow[];
    return v.freeze(rows);
  }

  beginDelivery(scope: StoreScope, jobId: string, request: BeginDeliveryRequest): Readonly<RunRow> {
    return transaction(this.db, () => {
      v.id(jobId);
      v.scopeSql(scope);
      v.keys(request, ['expected', 'ownership', 'metadata']);
      execution.held(request.ownership);
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? AND job_id=?')
        .get(request.expected.run_id, jobId) as RunRow | undefined;
      if (!row) throw new StoreConflict('Running receipt not found for delivery');
      const job = this.find(scope, jobId);
      const definition = terminal.provenance(row, job, job ? this.decodeDefinition(job) : undefined);
      if ('targetSession' in scope && definition.target.sessionKey !== scope.targetSession) throw new JobNotFound('Receipt not in scope');
      if (row.owner_incarnation !== request.ownership.ownerIncarnation
        || !terminal.identityColumns.every(k => isDeepStrictEqual(row[k], request.expected[k]))) {
        throw new StoreConflict('Delivery expectation mismatch');
      }
      if (row.status !== 'running' || row.phase !== 'executing' || row.delivery_state !== 'not-started' || row.segments_sent !== 0) {
        throw new StoreConflict('Receipt is not in clean executing phase for delivery');
      }
      if (definition.deliveryMode !== 'announce') {
        throw new TypeError('Delivery fence cannot open when deliveryMode is none');
      }
      const meta = request.metadata ?? {};
      const changed = this.db.prepare(`UPDATE cron_runs SET phase='delivering',delivery_state='started',
        thread_id=COALESCE(?,thread_id),turn_id=COALESCE(?,turn_id),model=COALESCE(?,model),
        usage_json=COALESCE(?,usage_json),summary=COALESCE(?,summary),lane_wait_ms=COALESCE(?,lane_wait_ms)
        WHERE run_id=? AND job_id=? AND status='running' AND phase='executing' AND delivery_state='not-started'
        AND segments_sent=0 AND owner_incarnation=? AND admitted_generation=?`)
        .run(
          meta.threadId ?? null,
          meta.turnId ?? null,
          meta.model ?? null,
          meta.usageJson ?? null,
          meta.summary ?? null,
          meta.laneWaitMs ?? null,
          row.run_id,
          jobId,
          request.ownership.ownerIncarnation,
          row.admitted_generation,
        );
      if (changed.changes !== 1) throw new StoreConflict('Delivery phase CAS missed');
      execution.held(request.ownership);
      const updated = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(row.run_id) as RunRow;
      storedOutcome.validate(updated, definition);
      return v.freeze(updated);
    });
  }

  recordExecutionMetadata(scope: StoreScope, jobId: string, runId: string, meta: ExecutionMetadata, ownership: AdmissionRequest['ownership']): Readonly<RunRow> {
    return transaction(this.db, () => {
      v.id(jobId); v.text(runId); v.scopeSql(scope);
      execution.held(ownership);
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? AND job_id=?').get(runId, jobId) as RunRow | undefined;
      if (!row || row.status !== 'running' || row.owner_incarnation !== ownership.ownerIncarnation) {
        throw new StoreConflict('Running receipt not found for metadata update');
      }
      this.db.prepare(`UPDATE cron_runs SET
        thread_id=COALESCE(?,thread_id),turn_id=COALESCE(?,turn_id),model=COALESCE(?,model),
        usage_json=COALESCE(?,usage_json),summary=COALESCE(?,summary),lane_wait_ms=COALESCE(?,lane_wait_ms)
        WHERE run_id=? AND job_id=? AND status='running' AND owner_incarnation=?`)
        .run(
          meta.threadId ?? null,
          meta.turnId ?? null,
          meta.model ?? null,
          meta.usageJson ?? null,
          meta.summary ?? null,
          meta.laneWaitMs ?? null,
          runId,
          jobId,
          ownership.ownerIncarnation,
        );
      execution.held(ownership);
      return v.freeze(this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(runId) as RunRow);
    });
  }

  recordSegmentDelivered(scope: StoreScope, jobId: string, runId: string, segmentsSent: number, ownership: AdmissionRequest['ownership']): Readonly<RunRow> {
    return transaction(this.db, () => {
      v.id(jobId); v.text(runId); v.scopeSql(scope);
      v.page(segmentsSent, 1, Number.MAX_SAFE_INTEGER);
      execution.held(ownership);
      const row = this.db.prepare('SELECT * FROM cron_runs WHERE run_id=? AND job_id=?').get(runId, jobId) as RunRow | undefined;
      if (!row || row.status !== 'running' || row.phase !== 'delivering' || row.delivery_state !== 'started'
        || row.owner_incarnation !== ownership.ownerIncarnation || segmentsSent < row.segments_sent) {
        throw new StoreConflict('Invalid delivering receipt for segment progress');
      }
      const changed = this.db.prepare(`UPDATE cron_runs SET segments_sent=?
        WHERE run_id=? AND job_id=? AND status='running' AND phase='delivering' AND delivery_state='started' AND owner_incarnation=?`)
        .run(segmentsSent, runId, jobId, ownership.ownerIncarnation);
      if (changed.changes !== 1) throw new StoreConflict('Segment progress CAS missed');
      execution.held(ownership);
      return v.freeze(this.db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(runId) as RunRow);
    });
  }

  recordScheduleError(scope: StoreScope, jobId: string, expectedGeneration: number, ownership: AdmissionRequest['ownership']): { job: Readonly<JobRow>; disableNotice?: DisableNoticeIntent } {
    return transaction(this.db, () => {
      execution.held(ownership);
      const job = this.current(scope, jobId, expectedGeneration);
      const now = timestamp(this.clock.now());
      const nextErrors = job.schedule_error_count + 1;
      let disableNotice: DisableNoticeIntent | undefined;
      if (nextErrors >= 3) {
        const res = this.db.prepare(`UPDATE cron_jobs SET schedule_error_count=?,enabled=0,next_run_at=NULL,
          generation=generation+1,auto_disabled_reason='schedule-errors',auto_disabled_at=?,updated_at=?
          WHERE id=? AND generation=? AND deleted_at IS NULL`)
          .run(nextErrors, now, now, jobId, expectedGeneration);
        if (res.changes !== 1) throw new StoreConflict('Job changed');
        disableNotice = v.freeze({
          jobId,
          name: job.name,
          generation: expectedGeneration + 1,
          reason: 'schedule-errors',
          creatorUid: job.creator_uid,
          target: {
            sessionKey: job.target_session,
            channelId: job.target_channel_id,
            channelType: job.target_channel_type,
          },
        });
      } else {
        const res = this.db.prepare('UPDATE cron_jobs SET schedule_error_count=?,updated_at=? WHERE id=? AND generation=? AND deleted_at IS NULL')
          .run(nextErrors, now, jobId, expectedGeneration);
        if (res.changes !== 1) throw new StoreConflict('Job changed');
      }
      execution.held(ownership);
      return { job: this.get(scope, jobId)!, ...(disableNotice ? { disableNotice } : {}) };
    });
  }

  pruneHistory(options: { retentionDays?: number; maxPerJob?: number } = {}): { deletedRuns: number; deletedContextNotes: number } {
    return transaction(this.db, () => {
      v.keys(options, ['retentionDays', 'maxPerJob']);
      const now = timestamp(this.clock.now());
      const retentionDays = v.page(options.retentionDays ?? 30, 1, 3650);
      const maxPerJob = v.page(options.maxPerJob ?? 200, 1, 10000);
      const cutoffMs = now - retentionDays * 86_400_000;
      const jobs = this.db.prepare('SELECT * FROM cron_jobs').all() as JobRow[];
      const jobMap = new Map(jobs.map(j => [j.id, j]));
      const allJobIds = new Set<string>([
        ...jobs.map(j => j.id),
        ...(this.db.prepare('SELECT DISTINCT job_id FROM cron_runs').all() as Array<{ job_id: string }>).map(r => r.job_id),
      ]);
      let deletedRuns = 0;
      const deleteStmt = this.db.prepare('DELETE FROM cron_runs WHERE run_id=?');
      for (const jobId of allJobIds) {
        const job = jobMap.get(jobId);
        const definition = job && job.deleted_at === null ? this.decodeDefinition(job) : undefined;
        const runs = this.db.prepare('SELECT * FROM cron_runs WHERE job_id=? ORDER BY queued_at DESC, attempt DESC, run_id DESC').all(jobId) as RunRow[];
        const activeOccurrences = new Set<string>();
        for (const r of runs) {
          if (r.status === 'queued' || r.status === 'running') {
            activeOccurrences.add(r.occurrence_id);
          }
        }
        let terminalSeen = 0;
        for (const r of runs) {
          if (r.status === 'queued' || r.status === 'running' || activeOccurrences.has(r.occurrence_id)) {
            continue;
          }
          terminalSeen += 1;
          const runTimestamp = r.ended_at ?? r.queued_at;
          const shouldPrune = terminalSeen > maxPerJob || runTimestamp < cutoffMs;
          if (!shouldPrune) continue;
          if (job && job.deleted_at === null && r.admitted_generation === job.generation && r.attempt === 0 && r.schedule_ownership === 'consume') {
            try {
              const admittedDef = terminal.provenance(r, job, definition);
              storedOutcome.validate(r, admittedDef);
            } catch (error) {
              throw new StoreIntegrityError(`Pruning guard failed provenance check: ${error instanceof Error ? error.message : 'unknown'}`);
            }
            if (job.last_slot_watermark === null || r.authored_slot === null || job.last_slot_watermark < r.authored_slot) {
              throw new StoreIntegrityError('Pruning guard refused to delete current-generation consume receipt without committed watermark');
            }
          }
          const res = deleteStmt.run(r.run_id);
          deletedRuns += res.changes;
        }
      }
      let deletedContextNotes = 0;
      if (hasTable(this.db, 'context_notes')) {
        const res = this.db.prepare('DELETE FROM context_notes WHERE consumed_at IS NOT NULL AND consumed_at < ?').run(cutoffMs);
        deletedContextNotes = res.changes;
      }
      return { deletedRuns, deletedContextNotes };
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
