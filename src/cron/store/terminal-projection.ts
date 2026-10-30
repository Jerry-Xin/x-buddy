// SPDX-License-Identifier: Apache-2.0
import { next, timestamp } from '../schedule/engine.js';
import { validateConsume, validateOverlap } from './admission.js';
import type { Definition, JobRow, RunRow, StoreDatabase } from './types.js';

/** R8 shared effect predicates. Retry chain provenance and terminal CAS remain separate gates. */
export function consumePredicates(job: JobRow | undefined, definition: Definition, run: RunRow) {
  const currentDefinition = job !== undefined && job.id === run.job_id && job.deleted_at === null && job.generation === run.admitted_generation;
  let validConsume = false;
  if (run.schedule_ownership === 'consume') {
    if (run.authored_slot === null) throw new TypeError('Missing authored slot');
    validateConsume(run, definition, run.occurrence_id, run.authored_slot);
    validConsume = true;
  }
  return { currentDefinition, validConsume, baseConsume: currentDefinition && validConsume && run.attempt === 0 };
}

/** Validate and calculate before INSERT. This is only the overlap effect set, not finalization. */
export function overlapNext(job: JobRow, definition: Definition, run: RunRow): number {
  validateOverlap(run);
  const predicates = consumePredicates(job, definition, run);
  if (!predicates.baseConsume || job.enabled !== 1 || definition.schedule.kind === 'at') throw new TypeError('Ineligible overlap projection');
  const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: job.id } : definition.schedule;
  const cursor = Math.max(timestamp(run.queued_at), timestamp(run.authored_slot!));
  const naturalNext = next(schedule, cursor);
  if (naturalNext === undefined || naturalNext <= cursor) throw new TypeError('No next effective recurring slot');
  if (job.last_run_at !== null) timestamp(job.last_run_at);
  return naturalNext;
}

/** Caller must have a newly returned terminal INSERT in its ownership-locked BEGIN IMMEDIATE.
 * Duplicates never call this helper. A future terminal CAS must share these predicates, then
 * choose its own counter/outcome policy; it must not reuse overlap's skipped increment.
 */
export function projectNewOverlap(db: StoreDatabase, job: JobRow, definition: Definition, run: RunRow, naturalNext: number): void {
  if (!db.inTransaction || !consumePredicates(job, definition, run).baseConsume) throw new TypeError('Missing terminal-entry transaction');
  projectTerminal(db, job, definition, run, 'overlap', naturalNext);
}

export function terminalNext(job: JobRow | undefined, definition: Definition, run: RunRow): number | null | undefined {
  if (!consumePredicates(job, definition, run).baseConsume || definition.schedule.kind === 'at') return null;
  const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: run.job_id } : definition.schedule;
  return next(schedule, Math.max(timestamp(run.ended_at!), timestamp(run.authored_slot!)));
}

/** The single authored watermark/counter/cadence writer for both terminal entry operations. */
export function projectTerminal(db: StoreDatabase, job: JobRow | undefined, definition: Definition, run: RunRow,
  outcome: 'overlap' | 'success' | 'neutral', naturalNext: number | null): void {
  if (!db.inTransaction) throw new TypeError('Missing terminal-entry transaction');
  const { baseConsume } = consumePredicates(job, definition, run);
  if (!job) return;
  if (job.last_run_at !== null) timestamp(job.last_run_at);
  if (job.last_slot_watermark !== null) timestamp(job.last_slot_watermark);
  const assignments: string[] = [], args: unknown[] = [];
  if (baseConsume) {
    assignments.push('last_slot_watermark=CASE WHEN last_slot_watermark IS NULL THEN ? ELSE MAX(last_slot_watermark,?) END');
    args.push(run.authored_slot, run.authored_slot);
    if (definition.schedule.kind === 'at') {
      assignments.push('enabled=0', 'next_run_at=NULL');
    } else {
      if (naturalNext === null) throw new TypeError('Missing effective cadence');
      assignments.push('next_run_at=CASE WHEN next_run_at IS NULL THEN ? ELSE MAX(next_run_at,?) END');
      args.push(naturalNext, naturalNext);
    }
    if (outcome === 'overlap') assignments.push('consecutive_skipped=consecutive_skipped+1');
    if (outcome === 'success') assignments.push('consecutive_errors=0', 'consecutive_skipped=0', 'consecutive_target_failures=0');
  }
  for (const [column, value] of Object.entries({ last_status: run.status, last_completion: run.completion,
    last_error: run.error, last_error_reason: run.reason,
    last_duration_ms: timestamp(run.ended_at!) - (run.started_at ?? run.queued_at), last_run_at: run.ended_at })) {
    assignments.push(`${column}=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN ? ELSE ${column} END`);
    args.push(run.ended_at, value);
  }
  const changed = db.prepare(`UPDATE cron_jobs SET ${assignments.join(',')}
    WHERE id=? AND generation=? AND deleted_at IS ?`)
    .run(...args, job.id, job.generation, job.deleted_at);
  if (changed.changes !== 1) throw new TypeError('Current definition changed during terminal projection');
  if (baseConsume && outcome === 'success' && definition.schedule.kind === 'at' && definition.deleteAfterRun) {
    // Retain the terminal receipt, snapshot and W as the durable tombstone. The owner-fenced
    // successful derived retirement is not an operator edit/new watermark domain.
    const retired = db.prepare(`UPDATE cron_jobs SET deleted_at=?,updated_at=?
      WHERE id=? AND generation=? AND deleted_at IS NULL AND last_slot_watermark>=?
      AND EXISTS (SELECT 1 FROM cron_runs WHERE run_id=? AND status='ok' AND completion='succeeded'
        AND owner_incarnation=? AND admitted_generation=?)
      AND NOT EXISTS (SELECT 1 FROM cron_runs WHERE job_id=? AND status IN ('queued','running'))`)
      .run(run.ended_at, run.ended_at, job.id, run.admitted_generation, run.authored_slot,
        run.run_id, run.owner_incarnation, run.admitted_generation, job.id);
    if (retired.changes !== 1) throw new TypeError('One-shot retirement fence missed');
  }
}
