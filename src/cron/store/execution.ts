// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { next, timestamp } from '../schedule/engine.js';
import { policy } from './admission.js';
import { identityColumns } from './terminal.js';
import type { Definition, ExecutionAdmissionRequest, JobRow, RunRow } from './types.js';
import * as v from './validation.js';

/** Copy plain data before supplying a frozen envelope to the separately wired issuer. */
function data<T>(value: T): T {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.map(data) as T;
    v.object(value);
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new TypeError('Admission data cannot contain accessors');
      copy[key] = data(descriptor.value);
    }
    return copy as T;
  }
  if (['function', 'symbol', 'bigint'].includes(typeof value)) throw new TypeError('Expected admission data');
  return value;
}
export function capture(input: ExecutionAdmissionRequest, jobId: string): ExecutionAdmissionRequest | undefined {
  v.keys(input, ['expected', 'authority', 'ownership', 'executionProof']);
  const noAccessors = (object: object) => {
    if (Object.values(Object.getOwnPropertyDescriptors(object)).some(d => !('value' in d))) throw new TypeError('Admission envelopes cannot contain accessors');
  };
  noAccessors(input);
  const expected = data(input.expected);
  v.keys(expected, [...identityColumns, 'status']);
  if ([...identityColumns, 'status'].some(k => !Object.hasOwn(expected, k))) throw new TypeError('Incomplete queued expectation');
  if (expected.status !== 'queued' || expected.job_id !== jobId) throw new TypeError('Expected a queued receipt for this job');
  v.text(expected.run_id); v.id(expected.job_id); v.text(expected.owner_incarnation); v.generation(expected.admitted_generation);
  const original = input.ownership;
  v.keys(original, ['ownerIncarnation', 'resetGeneration', 'assertHeld']);
  noAccessors(original);
  v.text(original.ownerIncarnation); v.page(original.resetGeneration, 0, Number.MAX_SAFE_INTEGER);
  const assertHeld = original.assertHeld;
  if (typeof assertHeld !== 'function') throw new TypeError('Missing held ownership guard');
  if (input.authority === undefined || input.executionProof === undefined) return undefined;
  const authority = data(input.authority);
  v.keys(authority, ['jobId', 'definition', 'creatorAuthorized', 'targetAuthorized', 'ownerIncarnation', 'resetGeneration', 'policy']);
  if (['jobId', 'definition', 'creatorAuthorized', 'targetAuthorized', 'ownerIncarnation', 'resetGeneration', 'policy']
    .some(k => !Object.hasOwn(authority, k))) return undefined;
  const proof = input.executionProof;
  v.keys(proof, ['permitGrantedAtMs', 'admissionDeadlineMs', 'runtimeGeneration', 'assertCurrent']);
  noAccessors(proof);
  if (['permitGrantedAtMs', 'admissionDeadlineMs', 'runtimeGeneration', 'assertCurrent'].some(k => !Object.hasOwn(proof, k))) return undefined;
  timestamp(proof.permitGrantedAtMs); timestamp(proof.admissionDeadlineMs); v.generation(proof.runtimeGeneration);
  const wait = proof.admissionDeadlineMs - proof.permitGrantedAtMs;
  if (!Number.isSafeInteger(wait) || wait < 1000 || wait > 1800000) throw new RangeError('Invalid fixed admission budget');
  if (typeof proof.assertCurrent !== 'function') throw new TypeError('Missing issuer proof handle');
  return v.freeze({ expected, authority: { ...authority, policy: policy(authority.policy) },
    ownership: { ownerIncarnation: original.ownerIncarnation, resetGeneration: original.resetGeneration,
      assertHeld() { return assertHeld.call(original); } },
    executionProof: { permitGrantedAtMs: proof.permitGrantedAtMs, admissionDeadlineMs: proof.admissionDeadlineMs,
      runtimeGeneration: proof.runtimeGeneration, assertCurrent: proof.assertCurrent } });
}
export function held(ownership: ExecutionAdmissionRequest['ownership']): void {
  if (ownership.assertHeld() !== undefined) throw new TypeError('Expected synchronous held ownership guard');
}
export function guard(assertCurrent: () => void): void {
  if (assertCurrent() !== undefined) throw new TypeError('Expected synchronous issuer guard');
}
export function matches(row: RunRow, request: ExecutionAdmissionRequest): boolean {
  return row.owner_incarnation === request.ownership.ownerIncarnation && row.reset_generation === request.ownership.resetGeneration
    && identityColumns.every(k => isDeepStrictEqual(row[k], request.expected[k]));
}
export function authorityMatches(request: ExecutionAdmissionRequest, job: JobRow, definition: Definition, row: RunRow): boolean {
  const a = request.authority;
  return a.jobId === job.id && a.creatorAuthorized === true && a.targetAuthorized === true
    && a.ownerIncarnation === row.owner_incarnation && a.resetGeneration === row.reset_generation
    && isDeepStrictEqual(a.definition, definition) && isDeepStrictEqual(a.policy, JSON.parse(row.definition_snapshot_json).policy);
}
export const sameJob = (before: JobRow, after: JobRow | undefined): boolean => isDeepStrictEqual(before, after);
export const sameRun = (before: RunRow, after: RunRow): boolean => isDeepStrictEqual(before, after);
export const sameChain = (before: readonly RunRow[], after: readonly RunRow[]): boolean => isDeepStrictEqual(before, after);
export const cleanColumns = ['phase', 'started_at', 'ended_at', 'completion', 'history_state', 'reason', 'error',
  'thread_id', 'turn_id', 'model', 'usage_json', 'summary', 'lane_wait_ms'] as const;
export function clean(row: RunRow): void {
  if (cleanColumns.some(k => row[k] !== null) || row.delivery_state !== 'not-started' || row.segments_sent !== 0) {
    throw new TypeError('Queued execution receipt is not clean');
  }
}
/** Original predecessor end fixes natural-slot priority; cadence/W cannot create a new grant. */
export function priority(definition: Definition, row: RunRow, predecessor: RunRow | undefined): number | undefined {
  if (!predecessor || definition.schedule.kind === 'at') return undefined;
  const schedule = definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: row.job_id } : definition.schedule;
  return next(schedule, Math.max(timestamp(predecessor.ended_at!), timestamp(row.authored_slot!)));
}
