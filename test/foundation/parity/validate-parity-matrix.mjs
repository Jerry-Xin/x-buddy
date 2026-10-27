// SPDX-License-Identifier: Apache-2.0
/**
 * Parity-matrix validator (R8 §4 SF-5, §10.2 `parity-matrix` CI job).
 *
 *   node test/foundation/parity/validate-parity-matrix.mjs [matrix.json] [--gate]
 *
 * Always enforced (fail closed):
 *  - schema and vocabulary of every row; unique ids;
 *  - completeness: every family is contiguous and complete, with exactly 155
 *    capability ids (T/R/EP/I/S/C/O) and 59 cron ids, so no capability can be
 *    dropped silently;
 *  - no unsupported claims: a row that is `partial`/`implemented` or has run
 *    (`passed`/`failed`) must cite tests of the form `path#case`, every cited
 *    file must exist and contain the case title, and `passed` needs evidence;
 *  - `not-applicable` requires an OD reference (owner sign-off).
 * With `--gate` (milestone acceptance), every lock row and every row marked
 * implemented must also be `passed`.
 *
 * Output is a JSON report on stdout; the exit code is 1 on any error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export const DEFAULT_MATRIX = fileURLToPath(new URL('./parity-matrix.json', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Expected id sets. Sub-ids are enumerated, so a gap or extra id is an error. */
export const EXPECTED_FAMILIES = Object.freeze({
  T: range('T', 1, 26), R: range('R', 1, 8), EP: range('EP-', 1, 28, 2), I: range('I', 1, 36), S: range('S', 1, 17),
  C: range('C', 1, 16), O: range('O', 1, 24), K: range('K-', 1, 17, 2), KA: range('KA-', 1, 7), BX: range('BX-', 1, 12),
  INV: [...range('INV-P', 1, 10), ...range('INV-C', 1, 6)],
  CR: [
    ...range('CR-1.', 1, 7), ...range('CR-2.', 1, 9), ...range('CR-3.', 1, 7), ...range('CR-4.', 1, 9), ...range('CR-5.', 1, 7),
    ...range('CR-6.', 1, 8), ...range('CR-7.', 1, 7), ...range('CR-8.', 1, 5),
  ],
});
export const CAPABILITY_FAMILIES = Object.freeze(['T', 'R', 'EP', 'I', 'S', 'C', 'O']);
export const EXPECTED_CAPABILITY_COUNT = 155;
export const EXPECTED_CRON_COUNT = 59;
const DISPOSITIONS = new Set(['REUSE', 'ADAPT', 'REWRITE', 'NA-OD', 'TIER-OD', 'SPIKE', 'PRESERVE', 'GAP-OD', 'NA',
  'NOT-PORTED', 'FIX-IN-PORT', 'RELEASE-GATE', 'ACCEPT-IGNORE']);
const IMPL = new Set(['missing', 'partial', 'implemented', 'not-applicable']);
const EXEC = new Set(['not-run', 'passed', 'failed', 'pending']);
const LAYERS = new Set([null, 'unit', 'fake-server', 'real-binary', 'real-model', 'deployed', 'black-box']);

function range(prefix, from, to, pad = 0) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(prefix + String(i).padStart(pad, '0'));
  return out;
}

/**
 * @param {object} matrix parsed matrix
 * @param {{ gate?: boolean, root?: string, fileExists?: (p: string) => boolean, readFile?: (p: string) => string }} [opts]
 */
export function validate(matrix, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const fileExists = opts.fileExists ?? (p => existsSync(resolve(root, p)));
  const readFile = opts.readFile ?? (p => readFileSync(resolve(root, p), 'utf8'));
  const errors = [];
  const warnings = [];
  const err = (id, msg) => errors.push(`${id}: ${msg}`);

  if (matrix?.schemaVersion !== 1) err('matrix', 'schemaVersion must be 1');
  if (!/^[a-f0-9]{64}$/.test(matrix?.source?.contentSha256 ?? '')) err('matrix', 'source.contentSha256 must pin the R8 record');
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  if (rows.length === 0) err('matrix', 'rows must be a non-empty array');

  const seen = new Map();
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '<missing id>';
    if (seen.has(id)) err(id, 'duplicate id');
    seen.set(id, row);
    if (!EXPECTED_FAMILIES[row.family]) { err(id, `unknown family ${row.family}`); continue; }
    if (!EXPECTED_FAMILIES[row.family].includes(id)) err(id, `id is not in the expected ${row.family} set`);
    if (typeof row.label !== 'string' || row.label.trim() === '') err(id, 'label required');
    if (!Array.isArray(row.dispositionCodes) || row.dispositionCodes.length === 0) err(id, 'at least one disposition code required');
    else for (const c of row.dispositionCodes) if (!DISPOSITIONS.has(c)) err(id, `unknown disposition ${c}`);
    if (!IMPL.has(row.implementationStatus)) err(id, `bad implementationStatus ${row.implementationStatus}`);
    if (!EXEC.has(row.executionStatus)) err(id, `bad executionStatus ${row.executionStatus}`);
    if (!LAYERS.has(row.layer ?? null)) err(id, `bad layer ${row.layer}`);
    if (!Array.isArray(row.tests) || !Array.isArray(row.evidence) || !Array.isArray(row.owner) || !Array.isArray(row.odRefs)) {
      err(id, 'tests, evidence, owner and odRefs must be arrays');
      continue;
    }
    if (typeof row.lockRequired !== 'boolean') err(id, 'lockRequired must be boolean');

    const claims = ['partial', 'implemented'].includes(row.implementationStatus) || ['passed', 'failed'].includes(row.executionStatus);
    if (claims && row.tests.length === 0) err(id, 'status claims progress but cites no tests');
    for (const ref of row.tests) {
      const m = typeof ref === 'string' ? /^([^#\s]+)#(.+)$/.exec(ref) : null;
      if (!m) { err(id, `test reference must be "path#case": ${ref}`); continue; }
      if (m[1].startsWith('/') || m[1].includes('..')) { err(id, `test path must be repository-relative: ${m[1]}`); continue; }
      if (!fileExists(m[1])) { err(id, `cited test file does not exist: ${m[1]}`); continue; }
      if (!readFile(m[1]).includes(m[2])) err(id, `cited case not found in ${m[1]}: ${m[2]}`);
    }
    if (row.executionStatus === 'passed' && row.evidence.length === 0) err(id, 'passed requires evidence');
    if (row.implementationStatus === 'not-applicable' && row.odRefs.length === 0) err(id, 'not-applicable requires an OD reference');
    if (row.expansion && row.expansion.status === 'pending' && row.implementationStatus === 'implemented') {
      err(id, 'bundle row cannot be implemented while its action-level expansion is pending');
    }
    if (opts.gate) {
      if (row.lockRequired && row.executionStatus !== 'passed') err(id, 'gate: lock row has not passed');
      if (row.implementationStatus === 'implemented' && row.executionStatus !== 'passed') err(id, 'gate: implemented row has not passed');
    }
    if (row.owner.length === 0) warnings.push(`${id}: no owning stage recorded`);
  }

  for (const [family, ids] of Object.entries(EXPECTED_FAMILIES)) {
    for (const id of ids) if (!seen.has(id)) err(id, `missing ${family} row (silent omission)`);
  }
  const capability = rows.filter(r => CAPABILITY_FAMILIES.includes(r.family)).length;
  const cron = rows.filter(r => r.family === 'CR').length;
  if (capability !== EXPECTED_CAPABILITY_COUNT) err('matrix', `expected ${EXPECTED_CAPABILITY_COUNT} capability rows, found ${capability}`);
  if (cron !== EXPECTED_CRON_COUNT) err('matrix', `expected ${EXPECTED_CRON_COUNT} cron rows, found ${cron}`);

  const count = (pred) => rows.filter(pred).length;
  return {
    ok: errors.length === 0,
    gate: Boolean(opts.gate),
    totals: {
      rows: rows.length, capability, cron,
      lockRequired: count(r => r.lockRequired), lockWithoutTests: count(r => r.lockRequired && r.tests.length === 0),
      implemented: count(r => r.implementationStatus === 'implemented'), partial: count(r => r.implementationStatus === 'partial'),
      missing: count(r => r.implementationStatus === 'missing'), passed: count(r => r.executionStatus === 'passed'),
      expansionPending: count(r => r.expansion?.status === 'pending'),
    },
    errors,
    warnings,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const path = args.find(a => !a.startsWith('--')) ?? DEFAULT_MATRIX;
  const report = validate(JSON.parse(readFileSync(path, 'utf8')), { gate: args.includes('--gate') });
  const { warnings, ...rest } = report;
  console.log(JSON.stringify({ ...rest, warningCount: warnings.length }, null, 2));
  if (!report.ok) process.exit(1);
}
