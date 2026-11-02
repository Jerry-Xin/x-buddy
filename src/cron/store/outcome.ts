// SPDX-License-Identifier: Apache-2.0
import type { Definition, RunRow } from './types.js';

/** Receipt consistency only: this does not establish remote delivery/publication.
 * Called at stored execution/terminal replay gates, after immutable provenance.
 * Active finalization's existing unsupported-state deferrals remain separate.
 */
export function validate(row: RunRow, definition: Definition): void {
  const active = row.status === 'queued' || row.status === 'running';
  const noSend = row.delivery_state === 'not-started' || row.delivery_state === 'not-requested' || row.delivery_state === 'suppressed';
  if (active) {
    if (row.completion !== null || row.reason !== null || row.error !== null
      || row.history_state !== null && row.history_state !== 'not-published') {
      throw new TypeError('Active receipt contains terminal completion/publication facts');
    }
    if (noSend ? row.segments_sent !== 0 : row.phase !== 'delivering') {
      throw new TypeError('Active delivery facts disagree with execution phase');
    }
    if (row.status === 'queued' && (row.delivery_state !== 'not-started' || row.segments_sent !== 0)) {
      throw new TypeError('Queued receipt contains delivery activity');
    }
    return;
  }

  // Direct-terminal overlap is the explicit R8 no-execution accounting exception.
  if (row.status === 'skipped' && row.reason === 'overlap') {
    if (row.completion !== null || row.delivery_state !== 'not-requested' || row.segments_sent !== 0
      || row.history_state !== 'not-published' || row.started_at !== null || row.error !== null) {
      throw new TypeError('Inconsistent terminal overlap outcome');
    }
    return;
  }
  const history = row.delivery_state === 'not-requested' ? 'skipped_not_requested'
    : row.delivery_state === 'suppressed' ? 'skipped_suppressed'
    : row.delivery_state === 'not-delivered' || row.delivery_state === 'unknown' ? 'skipped_not_delivered' : undefined;
  if (row.delivery_state === 'not-started' || row.delivery_state === 'started') {
    throw new TypeError('Terminal receipt retains unfinished delivery state');
  }
  if (history !== undefined && row.history_state !== history) throw new TypeError('Terminal delivery/history facts disagree');
  if (row.delivery_state === 'delivered' && (row.segments_sent < 1
    || !['published', 'skipped_reset', 'skipped_session_mode'].includes(row.history_state!))) {
    throw new TypeError('Confirmed delivery lacks consistent publication disposition');
  }
  if (noSend && row.segments_sent !== 0) throw new TypeError('No-send outcome contains sent segments');

  if (row.status === 'ok') {
    const expected = row.completion === 'succeeded' ? ['not-requested', 'suppressed', 'delivered']
      : row.completion === 'failed' ? ['not-delivered'] : row.completion === 'unknown' ? ['unknown'] : [];
    if (!expected.includes(row.delivery_state)) throw new TypeError('Completed receipt has inconsistent completion/delivery');
    if (row.completion === 'succeeded' && (row.reason !== null || row.error !== null
      || (definition.deliveryMode === 'none') !== (row.delivery_state === 'not-requested'))) {
      throw new TypeError('Success disagrees with admitted delivery policy or failure facts');
    }
  } else if (row.status === 'error') {
    if (row.completion !== 'failed' || !['not-requested', 'suppressed'].includes(row.delivery_state)) {
      throw new TypeError('Execution error lacks failed/no-result disposition');
    }
  } else if (row.status === 'skipped' || row.status === 'interrupted') {
    const ambiguousRestart = row.status === 'interrupted' && row.reason === 'restart'
      && row.completion === 'unknown' && row.delivery_state === 'unknown';
    if (!ambiguousRestart && (row.completion !== null || !['not-requested', 'suppressed'].includes(row.delivery_state))) {
      throw new TypeError('Neutral/skipped outcome contains incompatible completion/delivery');
    }
  } else throw new TypeError('Unknown stored outcome status');
}
