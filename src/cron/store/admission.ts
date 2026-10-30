// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { occurrenceId as canonicalId, previousOrBefore, timestamp } from '../schedule/engine.js';
import type { AdmissionRequest, AdmissionPolicy, AdmissionSnapshot, Definition, JobRow, RunRow } from './types.js';
import * as v from './validation.js';

export function policy(value: AdmissionPolicy): AdmissionPolicy {
  v.keys(value, ['tools', 'egressAllowlist']);
  if (!['none', 'octo-standard', 'doc-task'].includes(value.tools)) throw new TypeError('Invalid admission policy');
  if (value.egressAllowlist !== undefined) {
    if (!Array.isArray(value.egressAllowlist)) throw new TypeError('Invalid egress allowlist');
    value.egressAllowlist.forEach(v.text);
    return { tools: value.tools, egressAllowlist: [...value.egressAllowlist] };
  }
  return { tools: value.tools };
}

/** Must be called inside BEGIN IMMEDIATE, including for a duplicate lookup. */
export function validateRequest(request: AdmissionRequest, job: JobRow, definition: Definition): AdmissionPolicy {
  v.keys(request, ['trigger', 'generation', 'slot', 'runId', 'authority', 'ownership']);
  if (!['scheduled', 'catchup'].includes(request.trigger)) throw new TypeError('Only timed base admission is supported');
  v.generation(request.generation); timestamp(request.slot); v.text(request.runId);
  const authority = request.authority, ownership = request.ownership;
  v.keys(authority, ['jobId', 'definition', 'creatorAuthorized', 'targetAuthorized', 'ownerIncarnation', 'resetGeneration', 'policy']);
  v.keys(ownership, ['ownerIncarnation', 'resetGeneration', 'assertHeld']);
  v.text(ownership.ownerIncarnation); v.page(ownership.resetGeneration, 0, Number.MAX_SAFE_INTEGER);
  assertOwnership(request);
  if (authority.jobId !== job.id || authority.creatorAuthorized !== true || authority.targetAuthorized !== true
    || authority.ownerIncarnation !== ownership.ownerIncarnation || authority.resetGeneration !== ownership.resetGeneration
    || !isDeepStrictEqual(authority.definition, definition)) throw new TypeError('Stale or foreign validated authority snapshot');
  return policy(authority.policy);
}

export function assertOwnership(request: AdmissionRequest): void {
  if (typeof request.ownership.assertHeld !== 'function'
    || request.ownership.assertHeld() !== undefined) throw new TypeError('Expected synchronous held-ownership proof');
}

export function snapshot(definition: Definition, occurrence: string, slot: number, admittedNext: number, admittedPolicy: AdmissionPolicy): AdmissionSnapshot {
  return v.freeze({ ...definition, occurrenceId: occurrence, policy: admittedPolicy, scheduleOwnership: 'consume',
    authoredOccurrenceId: occurrence, authoredSlot: slot, admittedEnabled: true, admittedNextRunAt: admittedNext });
}

/** Immutable consume identity, independent of terminal entry, attempt and current-job effects. */
export function validateConsume(row: RunRow, definition: Definition, occurrence: string, slot: number): void {
  const raw: AdmissionSnapshot = JSON.parse(row.definition_snapshot_json);
  v.keys(raw, ['schemaVersion', 'jobGeneration', 'schedule', 'payload', 'execMode', 'target', 'deliveryMode', 'deleteAfterRun',
    'creatorUid', 'occurrenceId', 'policy', 'manualMode', 'scheduleOwnership', 'authoredOccurrenceId', 'authoredSlot', 'admittedEnabled', 'admittedNextRunAt']);
  const { occurrenceId, policy: storedPolicy, manualMode, scheduleOwnership, authoredOccurrenceId, authoredSlot,
    admittedEnabled, admittedNextRunAt, ...storedDefinition } = raw;
  policy(storedPolicy);
  const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: row.job_id } : definition.schedule;
  if (canonicalId(row.job_id, row.admitted_generation, slot) !== occurrence || previousOrBefore(schedule, slot) !== slot
    || !isDeepStrictEqual(storedDefinition, definition) || row.admitted_generation !== definition.jobGeneration
    || row.occurrence_id !== occurrence || row.authored_occurrence_id !== occurrence || row.authored_slot !== slot
    || row.scheduled_for !== slot || row.schedule_ownership !== 'consume' || row.admitted_enabled !== 1
    || occurrenceId !== occurrence || authoredOccurrenceId !== occurrence || authoredSlot !== slot
    || scheduleOwnership !== 'consume' || admittedEnabled !== true || admittedNextRunAt !== row.admitted_next_run_at
    || row.exec_mode !== definition.execMode) throw new TypeError('Inconsistent stored consume provenance');
  timestamp(admittedNextRunAt);
  if (admittedNextRunAt > slot) throw new TypeError('Receipt predates its admission eligibility');
}

/** Validate retained provenance, without comparing it to a newly advanced cadence or owner. */
export function validateExisting(row: RunRow, job: JobRow, definition: Definition, occurrence: string, slot: number): void {
  validateConsume(row, definition, occurrence, slot);
  const { manualMode } = JSON.parse(row.definition_snapshot_json) as AdmissionSnapshot;
  if (row.job_id !== job.id || row.admitted_generation !== job.generation || row.attempt !== 0) throw new TypeError('Invalid base provenance');
  if (row.trigger === 'manual') {
    if (!['if-enabled', 'due', 'force'].includes(row.manual_mode!) || manualMode !== row.manual_mode) throw new TypeError('Invalid consuming manual provenance');
  } else if (!['scheduled', 'catchup'].includes(row.trigger) || row.manual_mode !== null || manualMode !== undefined
    || row.ready_at !== slot) throw new TypeError('Invalid timed base provenance');
  v.text(row.run_id); v.text(row.owner_incarnation); v.page(row.reset_generation, 0, Number.MAX_SAFE_INTEGER);
  timestamp(row.ready_at); timestamp(row.queued_at);
  if (!['queued', 'running', 'ok', 'error', 'skipped', 'interrupted'].includes(row.status)) throw new TypeError('Invalid stored outcome');
  if (row.status !== 'queued' && row.status !== 'running'
    && (job.last_slot_watermark === null || job.last_slot_watermark < slot)) throw new TypeError('Terminal consume receipt lacks its committed watermark');
  if (row.reason === 'overlap') validateOverlap(row);
}

/** A direct-terminal overlap has never held an execution or publication permit. */
export function validateOverlap(row: RunRow): void {
  timestamp(row.queued_at);
  if (row.status !== 'skipped' || row.reason !== 'overlap' || row.attempt !== 0 || row.manual_mode !== null
    || !['scheduled', 'catchup'].includes(row.trigger) || row.schedule_ownership !== 'consume'
    || row.phase !== null || row.completion !== null || row.delivery_state !== 'not-requested'
    || row.segments_sent !== 0 || row.history_state !== 'not-published' || row.started_at !== null
    || row.ended_at !== row.queued_at || row.authored_slot === null || row.queued_at < row.authored_slot
    || row.thread_id !== null || row.turn_id !== null
    || row.model !== null || row.usage_json !== null || row.summary !== null || row.lane_wait_ms !== null || row.error !== null) {
    throw new TypeError('Invalid direct-terminal overlap outcome');
  }
}
