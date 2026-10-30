// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { occurrenceId, timestamp, validateTimezone } from '../schedule/engine.js';
import { policy, validateConsume } from './admission.js';
import type { Definition, JobRow, RunRow, TerminalExpectation, TerminalRequest, TerminalResult } from './types.js';
import * as v from './validation.js';

export const identityColumns = ['run_id', 'job_id', 'trigger', 'manual_mode', 'schedule_ownership',
  'authored_occurrence_id', 'authored_slot', 'admitted_enabled', 'admitted_next_run_at', 'scheduled_for',
  'attempt', 'occurrence_id', 'admitted_generation', 'definition_snapshot_json', 'reset_generation',
  'owner_incarnation', 'exec_mode', 'queued_at', 'ready_at'] as const;

export function expectation(run: Readonly<RunRow>): TerminalExpectation {
  if (!['queued', 'running'].includes(run.status)) throw new TypeError('Expected an active receipt');
  return Object.freeze(Object.fromEntries([...identityColumns, 'status'].map(k => [k, run[k as keyof RunRow]]))) as TerminalExpectation;
}

export function assertHeld(request: TerminalRequest): void {
  if (typeof request.ownership.assertHeld !== 'function' || request.ownership.assertHeld() !== undefined) {
    throw new TypeError('Expected synchronous held-ownership proof');
  }
}

export function validateRequest(request: TerminalRequest, jobId: string): void {
  v.keys(request, ['expected', 'ownership', 'outcome']);
  v.keys(request.expected, [...identityColumns, 'status']);
  if ([...identityColumns, 'status'].some(k => !Object.hasOwn(request.expected, k))) throw new TypeError('Incomplete terminal expectation');
  const e = request.expected;
  v.text(e.run_id); v.id(e.job_id); v.text(e.owner_incarnation); v.generation(e.admitted_generation);
  if (e.job_id !== jobId || !['queued', 'running'].includes(e.status)) throw new TypeError('Invalid terminal expectation');
  v.keys(request.ownership, ['ownerIncarnation', 'resetGeneration', 'assertHeld']);
  v.text(request.ownership.ownerIncarnation); v.page(request.ownership.resetGeneration, 0, Number.MAX_SAFE_INTEGER);
  assertHeld(request);
  const o = request.outcome;
  v.keys(o, o.kind === 'success' ? ['kind', 'deliveryState'] : o.kind === 'neutral' ? ['kind', 'reason'] : ['kind']);
  if (o.kind === 'success') {
    if (!['not-requested', 'suppressed', 'delivered', 'not-delivered', 'unknown'].includes(o.deliveryState)) throw new TypeError('Invalid delivery outcome');
  } else if (o.kind === 'neutral') {
    if (!['stopped', 'reset', 'reload', 'shutdown'].includes(o.reason)) throw new TypeError('Invalid neutral outcome');
  } else if (!['error', 'target-failure', 'restart', 'session-busy', 'retry-superseded'].includes(o.kind)) throw new TypeError('Invalid terminal outcome');
}

export function matches(row: RunRow, request: TerminalRequest): boolean {
  return row.owner_incarnation === request.ownership.ownerIncarnation
    && identityColumns.every(k => isDeepStrictEqual(row[k], request.expected[k]));
}

/** Validate against the admitted definition, including stale/borrowed callbacks. */
export function provenance(row: RunRow, job: JobRow | undefined, current: Definition | undefined): Definition {
  const raw = JSON.parse(row.definition_snapshot_json);
  v.keys(raw, ['schemaVersion', 'jobGeneration', 'schedule', 'payload', 'execMode', 'target', 'deliveryMode', 'deleteAfterRun',
    'creatorUid', 'occurrenceId', 'policy', 'manualMode', 'scheduleOwnership', 'authoredOccurrenceId', 'authoredSlot', 'admittedEnabled', 'admittedNextRunAt']);
  const { occurrenceId: admittedId, policy: admittedPolicy, manualMode, scheduleOwnership, authoredOccurrenceId,
    authoredSlot, admittedEnabled, admittedNextRunAt, ...definition } = raw;
  v.generation(row.admitted_generation); v.id(row.job_id); v.text(row.owner_incarnation);
  v.page(row.reset_generation, 0, Number.MAX_SAFE_INTEGER); v.page(row.attempt, 0, 3);
  v.text(row.run_id); v.text(row.occurrence_id); timestamp(row.ready_at); timestamp(row.queued_at);
  if (row.started_at !== null) timestamp(row.started_at);
  if (row.ended_at !== null) timestamp(row.ended_at);
  if (row.started_at !== null && row.started_at < row.queued_at
    || row.ended_at !== null && row.ended_at < (row.started_at ?? row.queued_at)
    || row.status === 'queued' && (row.phase !== null || row.started_at !== null || row.ended_at !== null)
    || row.status === 'running' && (row.started_at === null || row.ended_at !== null || !['admission', 'executing', 'delivering'].includes(row.phase!))
    || !['queued', 'running'].includes(row.status) && row.ended_at === null) throw new TypeError('Invalid stored lifecycle');
  v.page(row.segments_sent, 0, Number.MAX_SAFE_INTEGER);
  if (definition.schemaVersion !== 1 || definition.jobGeneration !== row.admitted_generation) throw new TypeError('Invalid snapshot version/generation');
  const zone = definition.schedule?.kind === 'cron' ? validateTimezone(definition.schedule.tz) : 'UTC';
  const schedule = v.storedSchedule(definition.schedule, zone, row.job_id);
  v.payload(definition.payload, definition.execMode); v.delivery(definition.deliveryMode);
  v.bool(definition.deleteAfterRun); v.text(definition.creatorUid);
  v.keys(definition.target, ['sessionKey', 'channelId', 'channelType']);
  v.text(definition.target.sessionKey); v.text(definition.target.channelId);
  if (![1, 2, 5].includes(definition.target.channelType)) throw new TypeError('Invalid admitted target');
  policy(admittedPolicy);
  if (row.exec_mode !== definition.execMode || admittedId !== row.occurrence_id || scheduleOwnership !== row.schedule_ownership
    || ![0, 1].includes(row.admitted_enabled) || admittedEnabled !== (row.admitted_enabled === 1)
    || admittedNextRunAt !== row.admitted_next_run_at || authoredOccurrenceId !== row.authored_occurrence_id
    || authoredSlot !== row.authored_slot) throw new TypeError('Inconsistent admitted provenance');
  if (admittedNextRunAt !== null) timestamp(admittedNextRunAt);
  if (job && row.admitted_generation > job.generation) throw new TypeError('Receipt is ahead of current generation');
  if (job && job.generation === row.admitted_generation && !isDeepStrictEqual(definition, current)) throw new TypeError('Current generation snapshot differs');
  if (row.schedule_ownership === 'consume') {
    if (row.authored_slot === null) throw new TypeError('Missing consuming slot');
    validateConsume(row, definition, row.occurrence_id, row.authored_slot);
    if (row.queued_at < row.authored_slot) throw new TypeError('Consume receipt was admitted before its slot');
    if (row.attempt === 0 && row.trigger === 'manual') {
      if (!['due', 'if-enabled', 'force'].includes(row.manual_mode!) || manualMode !== row.manual_mode
        || schedule.kind !== 'at' && row.manual_mode !== 'due') throw new TypeError('Invalid consuming manual mode');
    } else if (row.attempt === 0) {
      if (!['scheduled', 'catchup'].includes(row.trigger) || row.manual_mode !== null || manualMode !== undefined
        || row.ready_at !== row.authored_slot) throw new TypeError('Invalid timed consume provenance');
    } else if (row.trigger !== 'retry') throw new TypeError('Invalid retry provenance');
    if (job && job.deleted_at === null && job.generation === row.admitted_generation
      && !['queued', 'running'].includes(row.status)
      && (job.last_slot_watermark === null || job.last_slot_watermark < row.authored_slot)) throw new TypeError('Terminal consume lacks committed watermark');
  } else {
    if (!['borrow', 'none'].includes(row.schedule_ownership) || row.trigger !== 'manual' || row.attempt !== 0
      || !['if-enabled', 'force'].includes(row.manual_mode!) || manualMode !== row.manual_mode
      || !/^manual:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.occurrence_id)
      || row.scheduled_for !== null) throw new TypeError('Invalid borrowed/manual provenance');
    if (row.authored_slot === null) {
      if (row.authored_occurrence_id !== null || schedule.kind === 'at') throw new TypeError('Missing referenced authored slot');
    } else if (row.authored_occurrence_id !== occurrenceId(row.job_id, row.admitted_generation, timestamp(row.authored_slot))
      || schedule.kind !== 'at' || schedule.atMs !== row.authored_slot) throw new TypeError('Invalid borrowed authored reference');
  }
  return definition;
}

/** All unreached policy/publication branches stop before the terminal CAS. */
export function deferred(row: RunRow, definition: Definition, request: TerminalRequest): TerminalResult | undefined {
  if (row.attempt > 0) return { kind: 'deferred', reason: 'retry-chain' };
  if (!['success', 'neutral'].includes(request.outcome.kind)) return { kind: 'deferred', reason: 'outcome-policy' };
  if (row.completion !== null || row.error !== null || row.reason !== null) return { kind: 'deferred', reason: 'outcome-policy' };
  if (row.segments_sent !== 0 || !['not-started', 'not-requested', 'suppressed'].includes(row.delivery_state)
    || row.history_state !== null && row.history_state !== 'not-published') return { kind: 'deferred', reason: 'publication-or-delivery' };
  if (request.outcome.kind === 'success') {
    if (!['not-requested', 'suppressed'].includes(request.outcome.deliveryState)) return { kind: 'deferred', reason: 'publication-or-delivery' };
    if (row.status === 'queued') return { kind: 'deferred', reason: 'queued-success' };
    if (row.phase === 'admission') return { kind: 'deferred', reason: 'outcome-policy' };
    if ((definition.deliveryMode === 'none') !== (request.outcome.deliveryState === 'not-requested')) throw new TypeError('Delivery outcome disagrees with admitted mode');
  }
  return undefined;
}
