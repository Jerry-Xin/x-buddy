// SPDX-License-Identifier: Apache-2.0
/**
 * Immutable R8 seed for the parity matrix.
 *
 * `parity-seed.v1.json` holds, for every row, the fields that come from the
 * accepted R8 record and must never change in the maintained matrix: id,
 * family, label, disposition codes, stage, lockRequired, the inherited row,
 * the OD references found in R8 and the bundle expansion members. It also
 * lists the lock set explicitly.
 *
 * The seed is produced by `extract-r8.mjs --write-seed` from the pinned R8
 * content, and its SHA-256 is pinned in `validate-parity-matrix.mjs`.
 * Changing a seed field therefore needs a visible edit to the validator, not
 * only to JSON data.
 */
import { fileURLToPath, URL } from 'node:url';

export const SEED_PATH = fileURLToPath(new URL('./parity-seed.v1.json', import.meta.url));

/** @param {object} matrix a matrix produced by `buildMatrix` (or the committed seed-equal matrix) */
export function seedOf(matrix) {
  return {
    schemaVersion: 1,
    source: matrix.source,
    lockRequired: matrix.rows.filter(r => r.lockRequired).map(r => r.id),
    rows: matrix.rows.map(seedRow),
  };
}

/** The immutable part of one row. */
export function seedRow(row) {
  const out = {
    id: row.id, family: row.family, label: row.label, dispositionCodes: row.dispositionCodes, stage: row.stage,
    lockRequired: row.lockRequired, odRefs: row.odRefs,
  };
  if (row.inheritsFrom !== undefined) out.inheritsFrom = row.inheritsFrom;
  if (row.expansion !== undefined) out.expansionMembers = row.expansion.members;
  return out;
}

export function seedText(seed) { return JSON.stringify(seed, null, 2) + '\n'; }
