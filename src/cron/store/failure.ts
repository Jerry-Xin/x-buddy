// SPDX-License-Identifier: Apache-2.0
import { next, timestamp } from '../schedule/engine.js';
import type { AlertIntent, Definition, DisableNoticeIntent, FailureReason, JobRow, RunRow, StoreDatabase, TerminalEffectsOptions, TerminalRequest, TerminalResult } from './types.js';
import { provenance } from './terminal.js';

export const transient = new Set<FailureReason>(['rate_limited', 'overloaded', 'network', 'runtime_unavailable', 'quarantined', 'timeout']);
export const reasons = [...transient, 'model_error', 'auth', 'invalid-definition', 'session-busy', 'target-unavailable'] as const;
const quick = [30000, 60000, 300000] as const;
const backoff = [30000, 60000, 300000, 900000, 3600000] as const;
export interface FailurePlan {
  readonly errors: number;
  readonly targets: number;
  readonly next: number | null;
  readonly retryAt?: number;
  readonly autoDisable?: {
    readonly reason: string;
    readonly at: number;
  };
  readonly alertReservation?: {
    readonly lastAlertAt: number;
    readonly incidentKey: string;
    readonly occurrence: number;
  };
  readonly alertIntent?: AlertIntent;
  readonly disableNotice?: DisableNoticeIntent;
}

/** Validate retained history, never synthesize a missing base or infer it from cadence. */
export function validateChain(db: StoreDatabase, job: JobRow | undefined, definition: Definition, run: RunRow): void {
  if (run.schedule_ownership !== 'consume') {
    if (run.attempt !== 0) throw new TypeError('Borrowed execution cannot form a retry chain');
    return;
  }
  const chain = db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt')
    .all(run.occurrence_id) as RunRow[];
  if (chain.length !== run.attempt + 1) throw new TypeError('Missing retained base/retry chain');
  for (let k = 0; k < chain.length; k++) {
    const member = chain[k];
    provenance(member, job, job?.generation === run.admitted_generation ? definition : undefined);
    if (member.attempt !== k || member.job_id !== run.job_id || member.schedule_ownership !== 'consume'
      || member.occurrence_id !== run.occurrence_id || member.authored_slot !== run.authored_slot
      || member.admitted_generation !== run.admitted_generation || member.definition_snapshot_json !== run.definition_snapshot_json
      || member.manual_mode !== run.manual_mode || member.admitted_next_run_at !== run.admitted_next_run_at
      || member.reset_generation !== run.reset_generation) throw new TypeError('Retry chain provenance differs');
    if (k === 0 && !['scheduled', 'catchup', 'manual'].includes(member.trigger)
      || k > 0 && member.trigger !== 'retry') throw new TypeError('Invalid chain trigger');
    if (member.started_at !== null && member.started_at < member.ready_at) throw new TypeError('Retry chain started before eligibility');
    if (k === 0) continue;
    const prior = chain[k - 1];
    if (prior.ended_at === null || !(prior.status === 'error' && prior.started_at !== null && transient.has(prior.reason as FailureReason)
      || prior.status === 'skipped' && prior.reason === 'session-busy')) throw new TypeError('Retry predecessor is not retryable');
    // A skipped admission can be terminal without ever starting. Its terminal time
    // must still prove eligibility; executed error predecessors require a start.
    if (prior.ended_at < prior.ready_at) throw new TypeError('Retry predecessor ended before eligibility');
    if (prior.phase !== null || prior.completion !== (prior.status === 'error' ? 'failed' : null)
      || !['not-requested', 'suppressed'].includes(prior.delivery_state) || prior.segments_sent !== 0
      || prior.history_state !== (prior.delivery_state === 'suppressed' ? 'skipped_suppressed' : 'skipped_not_requested')) {
      throw new TypeError('Retry predecessor has incompatible completion/publication facts');
    }
    const delay = prior.reason === 'session-busy' ? 30000 : quick[k - 1];
    if (member.ready_at !== timestamp(prior.ended_at + delay) || member.queued_at !== prior.ended_at) throw new TypeError('Invalid retry chain timing');
    if (definition.schedule.kind !== 'at') {
      const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: run.job_id } : definition.schedule;
      const natural = next(schedule, Math.max(prior.ended_at, run.authored_slot!));
      if (natural === undefined || member.ready_at >= natural) throw new TypeError('Retry collides with next natural slot');
    }
  }
  const current = chain.at(-1)!;
  if (current.run_id !== run.run_id) throw new TypeError('Wrong active retry');
  if (run.attempt > 0 && job && job.deleted_at === null && job.generation === run.admitted_generation
    && (job.last_slot_watermark === null || job.last_slot_watermark < run.authored_slot!)) throw new TypeError('Retry base watermark is not committed');
}

/** Alert/notice publication has no accepted transactional representation in this slice.
 * Stop BEFORE CAS at every boundary requiring one; never claim a partial failure finalizer.
 */
export function plan(job: JobRow, definition: Definition, run: RunRow, request: TerminalRequest): FailurePlan | TerminalResult {
  if (request.outcome.kind !== 'failure') throw new TypeError('Missing classified failure');
  return calculate(job, definition, run, request.outcome.reason, request.retryRunId, request.effects);
}

/** Restart is a non-transient execution interruption, never a quick retry. */
export function planRestart(job: JobRow, definition: Definition, run: RunRow, effects?: TerminalEffectsOptions): FailurePlan | TerminalResult {
  return calculate(job, definition, run, 'restart', undefined, effects);
}
function calculate(job: JobRow, definition: Definition, run: RunRow, reason: FailureReason | 'restart', retryRunId?: string, effects?: TerminalEffectsOptions): FailurePlan | TerminalResult {
  if (job.enabled !== 1) return { kind: 'deferred', reason: 'outcome-policy' };
  for (const count of [job.consecutive_errors, job.consecutive_target_failures, job.consecutive_skipped, job.schedule_error_count]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid authored counter');
  }
  const busy = reason === 'session-busy', target = reason === 'target-unavailable';
  const errors = job.consecutive_errors + (busy || target ? 0 : 1);
  const targets = job.consecutive_target_failures + (target ? 1 : 0);
  if (!Number.isSafeInteger(errors) || !Number.isSafeInteger(targets)) throw new TypeError('Counter exhausted');
  const thresholdDisable = (errors >= 10 && !busy && !target) || (target && targets >= 3);
  if (thresholdDisable && !effects?.allowDisableNotice) return { kind: 'deferred', reason: 'disable-notice-required' };
  const alertAfter = effects?.alertAfter ?? 2;
  const thresholdAlert = !busy && ((!target && errors >= alertAfter) || (target && targets >= alertAfter));
  if (!thresholdDisable && thresholdAlert && !effects?.allowAlertIntent) return { kind: 'deferred', reason: 'alert-intent-required' };
  const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: run.job_id } : definition.schedule;
  const natural = definition.schedule.kind === 'at' ? null : next(schedule, Math.max(run.ended_at!, run.authored_slot!));
  if (natural === undefined) return { kind: 'deferred', reason: 'schedule-exhausted' };
  let retryAt: number | undefined;
  if (!thresholdDisable && (busy || (reason !== 'restart' && transient.has(reason))) && run.attempt < 3) {
    const candidate = timestamp(run.ended_at! + (busy ? 30000 : quick[run.attempt]));
    if (natural === null || candidate < natural) retryAt = candidate;
  }
  const oneShotTerminalDisable = !thresholdDisable && definition.schedule.kind === 'at' && retryAt === undefined;
  if (oneShotTerminalDisable && !effects?.allowDisableNotice) return { kind: 'deferred', reason: 'disable-notice-required' };
  if (retryAt !== undefined && retryRunId === undefined) return { kind: 'deferred', reason: 'retry-successor-required' };
  const shouldAutoDisable = thresholdDisable || oneShotTerminalDisable;
  const cadence = shouldAutoDisable ? null : natural === null ? (retryAt ?? null) : Math.max(natural, job.next_run_at ?? natural);
  const nextSlot = shouldAutoDisable
    ? null
    : natural !== null && !busy && !target && retryAt === undefined
      ? Math.max(cadence!, timestamp(run.ended_at! + backoff[Math.min(errors - 1, 4)]))
      : cadence;
  const endedAt = timestamp(run.ended_at!);
  let autoDisable: FailurePlan['autoDisable'];
  let disableNotice: DisableNoticeIntent | undefined;
  if (shouldAutoDisable) {
    if (job.generation === Number.MAX_SAFE_INTEGER) throw new TypeError('Generation exhausted');
    const disableReason = target && targets >= 3 ? 'target-unavailable' : errors >= 10 ? 'consecutive-errors' : 'terminal-one-shot';
    autoDisable = { reason: disableReason, at: endedAt };
    disableNotice = {
      jobId: job.id,
      name: job.name,
      generation: job.generation + 1,
      reason: disableReason,
      creatorUid: definition.creatorUid,
      target: definition.target,
    };
  }
  let alertReservation: FailurePlan['alertReservation'];
  let alertIntent: AlertIntent | undefined;
  if (thresholdAlert && effects?.allowAlertIntent) {
    const cooldownMs = effects.alertCooldownMs ?? 3_600_000;
    const cooldownElapsed = job.last_alert_at === null || (endedAt - job.last_alert_at >= cooldownMs);
    if (cooldownElapsed) {
      const occurrence = (job.alert_occurrence ?? 0) + 1;
      const incidentKey = `${job.id}:${job.generation}:${reason}`;
      alertReservation = {
        lastAlertAt: endedAt,
        incidentKey,
        occurrence,
      };
      alertIntent = {
        jobId: job.id,
        name: job.name,
        count: target ? targets : errors,
        reason,
        nextRunAt: retryAt ?? nextSlot,
        tz: job.tz,
        incidentKey,
        occurrence,
        creatorUid: definition.creatorUid,
        target: definition.target,
      };
    }
  }
  return {
    errors,
    targets,
    next: nextSlot,
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(autoDisable === undefined ? {} : { autoDisable }),
    ...(alertReservation === undefined ? {} : { alertReservation }),
    ...(alertIntent === undefined ? {} : { alertIntent }),
    ...(disableNotice === undefined ? {} : { disableNotice }),
  };
}

/** Called only after successful terminal CAS and authored projection in the same short TX. */
export function insertSuccessor(db: StoreDatabase, run: RunRow, runId: string, readyAt: number): void {
  if (!db.inTransaction || run.attempt >= 3 || run.schedule_ownership !== 'consume') throw new TypeError('Invalid retry insertion');
  const successor: RunRow = { ...run, run_id: runId, trigger: 'retry', attempt: run.attempt + 1,
    status: 'queued', phase: null, completion: null, delivery_state: 'not-started', segments_sent: 0,
    history_state: null, reason: null, error: null, ready_at: readyAt, queued_at: run.ended_at!, started_at: null,
    ended_at: null, thread_id: null, turn_id: null, model: null, usage_json: null, summary: null, lane_wait_ms: null };
  const keys = Object.keys(successor) as (keyof RunRow)[];
  const changed = db.prepare(`INSERT INTO cron_runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => successor[k]));
  if (changed.changes !== 1) throw new TypeError('Retry successor was not inserted');
}
