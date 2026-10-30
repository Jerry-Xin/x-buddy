// SPDX-License-Identifier: Apache-2.0
import { next, timestamp } from '../schedule/engine.js';
import { validateConsume, validateOverlap } from './admission.js';
import type { Definition, JobRow, RunRow, StoreDatabase } from './types.js';

/** R8 shared effect predicates. Retry chain provenance and terminal CAS remain separate gates. */
export function consumePredicates(job: JobRow, definition: Definition, run: RunRow) {
  const currentDefinition = job.id === run.job_id && job.deleted_at === null && job.generation === run.admitted_generation;
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
  const changed = db.prepare(`UPDATE cron_jobs SET
    last_slot_watermark=CASE WHEN last_slot_watermark IS NULL THEN ? ELSE MAX(last_slot_watermark,?) END,
    next_run_at=CASE WHEN next_run_at IS NULL THEN ? ELSE MAX(next_run_at,?) END,
    consecutive_skipped=consecutive_skipped+1,
    last_status=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN 'skipped' ELSE last_status END,
    last_completion=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN NULL ELSE last_completion END,
    last_error=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN NULL ELSE last_error END,
    last_error_reason=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN 'overlap' ELSE last_error_reason END,
    last_duration_ms=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN 0 ELSE last_duration_ms END,
    last_run_at=CASE WHEN last_run_at IS NULL OR last_run_at<? THEN ? ELSE last_run_at END
    WHERE id=? AND generation=? AND deleted_at IS NULL`)
    .run(run.authored_slot, run.authored_slot, naturalNext, naturalNext,
      run.ended_at, run.ended_at, run.ended_at, run.ended_at, run.ended_at, run.ended_at, run.ended_at,
      job.id, run.admitted_generation);
  if (changed.changes !== 1) throw new TypeError('Current definition changed during terminal projection');
}
