// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { occurrenceId, previousOrBefore, timestamp } from '../schedule/engine.js';
import { policy } from './admission.js';
import { provenance } from './terminal.js';
import * as outcome from './outcome.js';
import { validateChain } from './failure.js';
import type { Definition, JobRow, ManualAdmissionRequest, ManualAdmissionSnapshot, RunRow, StoreDatabase } from './types.js';
import * as v from './validation.js';

export const invocationPattern = /^manual:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validate(request: ManualAdmissionRequest, job: JobRow, definition: Definition) {
  v.keys(request, ['trigger', 'manualMode', 'generation', 'runId', 'invocationId', 'authority', 'ownership']);
  if (request.trigger !== 'manual' || !['if-enabled', 'due', 'force'].includes(request.manualMode)) throw new TypeError('Invalid manual admission mode');
  v.generation(request.generation); v.text(request.runId); v.text(request.invocationId);
  if (!invocationPattern.test(request.invocationId)) throw new TypeError('Expected manual UUID invocation identity');
  const a = request.authority, o = request.ownership;
  v.keys(a, ['jobId', 'definition', 'creatorAuthorized', 'targetAuthorized', 'ownerIncarnation', 'resetGeneration', 'policy']);
  v.keys(o, ['ownerIncarnation', 'resetGeneration', 'assertHeld']);
  v.text(o.ownerIncarnation); v.page(o.resetGeneration, 0, Number.MAX_SAFE_INTEGER);
  held(request);
  if (a.jobId !== job.id || a.creatorAuthorized !== true || a.targetAuthorized !== true
    || a.ownerIncarnation !== o.ownerIncarnation || a.resetGeneration !== o.resetGeneration
    || !isDeepStrictEqual(a.definition, definition)) throw new TypeError('Stale or foreign validated authority snapshot');
  return policy(a.policy);
}
export function held(request: Pick<ManualAdmissionRequest, 'ownership'>): void {
  if (typeof request.ownership.assertHeld !== 'function' || request.ownership.assertHeld() !== undefined) {
    throw new TypeError('Expected synchronous held-ownership proof');
  }
}
export function selection(job: JobRow, definition: Definition, now: number, mode: ManualAdmissionRequest['manualMode']) {
  timestamp(job.schedule_activated_at);
  if (job.last_slot_watermark !== null) timestamp(job.last_slot_watermark);
  if (job.next_run_at !== null) timestamp(job.next_run_at);
  if (![0, 1].includes(job.enabled)) throw new TypeError('Invalid stored enablement');
  const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: job.id } : definition.schedule;
  const slot = definition.schedule.kind === 'at' ? definition.schedule.atMs : previousOrBefore(schedule, now);
  const due = job.enabled === 1 && slot !== undefined && slot <= now && slot >= job.schedule_activated_at
    && (job.last_slot_watermark === null || slot > job.last_slot_watermark)
    && job.next_run_at !== null && job.next_run_at <= slot;
  const consume = due && (mode === 'due' || definition.schedule.kind === 'at');
  // The at reference remains useful even when disabled. Recurring receipts retain
  // the admitted natural next slot when one exists; backoff is never an authored slot.
  const reference = definition.schedule.kind === 'at' ? definition.schedule.atMs
    : job.next_run_at !== null && previousOrBefore(schedule, job.next_run_at) === job.next_run_at ? job.next_run_at : null;
  return { due, consume, slot, reference };
}
export function snapshot(definition: Definition, job: JobRow, request: ManualAdmissionRequest,
  selected: ReturnType<typeof selection>, admittedPolicy: ManualAdmissionSnapshot['policy']): ManualAdmissionSnapshot {
  const authoredSlot = selected.consume ? selected.slot! : selected.reference;
  const authoredOccurrenceId = authoredSlot === null ? null : occurrenceId(job.id, job.generation, authoredSlot);
  return v.freeze({ ...definition, occurrenceId: selected.consume ? authoredOccurrenceId! : request.invocationId,
    policy: admittedPolicy, manualMode: request.manualMode, scheduleOwnership: selected.consume ? 'consume' : 'borrow',
    authoredOccurrenceId, authoredSlot, admittedEnabled: job.enabled === 1, admittedNextRunAt: job.next_run_at });
}
/** Dedupe is allowed only after validation of complete immutable provenance/outcome. */
export function existing(db: StoreDatabase, row: RunRow, job: JobRow, definition: Definition): void {
  provenance(row, job, definition);
  outcome.validate(row, definition);
  if (row.attempt !== 0) throw new TypeError('Not a base receipt');
  if (row.trigger === 'manual') validateReceipt(row, definition);
  const chain = db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[];
  if (!chain.length || !chain.some(member => isDeepStrictEqual(member, row))
    || row.schedule_ownership === 'borrow' && chain.length !== 1) throw new TypeError('Invalid retained manual chain');
  for (const member of chain) { provenance(member, job, definition); outcome.validate(member, definition); }
  validateChain(db, job, definition, chain.at(-1)!);
}

export function validateReceipt(row: RunRow, definition: Definition): void {
  if (row.trigger !== 'manual' || row.attempt !== 0 || !['consume', 'borrow'].includes(row.schedule_ownership)
    || !['if-enabled', 'due', 'force'].includes(row.manual_mode!)) throw new TypeError('Invalid manual entry');
  if (row.admitted_enabled === 0 && (row.manual_mode !== 'force' || row.schedule_ownership !== 'borrow')) throw new TypeError('Disabled manual must be force borrow');
  if (row.schedule_ownership === 'borrow') {
    if (row.manual_mode === 'due' || row.ready_at !== row.queued_at) throw new TypeError('Invalid borrowed admission');
    if (definition.schedule.kind === 'at' && row.admitted_enabled === 1 && row.queued_at >= definition.schedule.atMs) throw new TypeError('Enabled overdue at cannot borrow');
  } else if (row.ready_at !== row.queued_at || row.queued_at < row.authored_slot!) throw new TypeError('Invalid manual consume readiness');
}
