// SPDX-License-Identifier: Apache-2.0
import { timestamp } from '../schedule/engine.js';
import type { Definition, JobRow, RunRow, StoreDatabase } from './types.js';
import * as terminal from './terminal.js';
import * as execution from './execution.js';
import * as failure from './failure.js';
import * as outcome from './outcome.js';
import { terminalNext } from './terminal-projection.js';

/** Prepare only. The caller has already validated the NEW natural recurring slot
 * and current authority/ownership inside its BEGIN IMMEDIATE. Never starts work.
 */
export function prepare(db: StoreDatabase, job: JobRow, definition: Definition, row: RunRow,
  slot: number, now: number): { row: RunRow; next: number; chain: RunRow[] }
    | Readonly<{ kind: 'deferred'; reason: 'outcome-policy' | 'publication-or-delivery' | 'schedule-exhausted' }> {
  terminal.provenance(row, job, definition);
  if (definition.schedule.kind === 'at' || row.status !== 'queued' || row.trigger !== 'retry'
    || row.attempt < 1 || row.attempt > 3 || row.schedule_ownership !== 'consume') throw new TypeError('Not a queued recurring retry');
  if (row.authored_slot! < timestamp(job.schedule_activated_at)) throw new TypeError('Retry predates activation');
  const unsupported = terminal.noResultDeferred(row);
  if (unsupported) return unsupported;
  execution.clean(row);
  failure.validateChain(db, job, definition, row);
  const chain = db.prepare('SELECT * FROM cron_runs WHERE occurrence_id=? ORDER BY attempt').all(row.occurrence_id) as RunRow[];
  for (const member of chain) {
    outcome.validate(member, definition);
    if (member.owner_incarnation !== row.owner_incarnation) throw new TypeError('Old-owner chain requires validated recovery');
  }
  const natural = execution.priority(definition, row, chain[row.attempt - 1]);
  if (natural === undefined) return { kind: 'deferred' as const, reason: 'schedule-exhausted' as const };
  if (slot < natural || now < natural || slot <= row.authored_slot!) throw new TypeError('New base does not supersede this retry');
  const retired: RunRow = { ...row, status: 'skipped', phase: null, completion: null,
    delivery_state: 'not-requested', history_state: 'skipped_not_requested', reason: 'retry-superseded', error: null, ended_at: now };
  const next = terminalNext(job, definition, retired);
  if (next === undefined || next === null) return { kind: 'deferred' as const, reason: 'schedule-exhausted' as const };
  return { row: retired, next, chain };
}
