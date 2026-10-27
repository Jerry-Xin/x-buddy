// SPDX-License-Identifier: Apache-2.0
/**
 * Parity-matrix validator (R8 §4 SF-5, §10.2 `parity-matrix` CI job).
 *
 *   node test/foundation/parity/validate-parity-matrix.mjs [matrix.json] [--gate]
 *
 * Always enforced (fail closed):
 *  - seed integrity: `source` equals the pinned R8 record, and every row's
 *    R8 fields (id, family, label, disposition codes, stage, lockRequired,
 *    inherited row, R8 OD references, expansion members) equal the immutable
 *    seed `parity-seed.v1.json`, whose SHA-256 is pinned below. The lock set
 *    must be exactly the seeded 58 rows, so clearing `lockRequired` cannot
 *    take a row out of the gate;
 *  - schema and vocabulary of every row; unique ids;
 *  - completeness: every family is contiguous and complete, with exactly 155
 *    capability ids (T/R/EP/I/S/C/O) and 59 cron ids, so no capability can be
 *    dropped silently;
 *  - no unsupported claims: a row that is `partial`/`implemented` or has run
 *    (`passed`/`failed`) must cite tests of the form `path#case`, where the
 *    path is a `test/**` test file and the case is declared there by exact
 *    title (`test('<case>'` / `it(...)` / `describe(...)` / `suite(...)`);
 *  - `passed` needs run evidence: `{kind:'node-test-tap', path, sha256}`
 *    entries whose file bytes match the digest and whose TAP output reports
 *    every cited case as `ok` (not skipped, not todo, never `not ok`);
 *  - a bundle whose action-level expansion is pending cannot be
 *    `implemented` or `passed`;
 *  - `not-applicable` requires an `OD-<n>` reference (owner sign-off).
 * With `--gate` (milestone acceptance), every lock row and every row marked
 * implemented must also be `passed`.
 *
 * This proves that claims are consistent with committed files. It does not
 * prove that the evidence was produced honestly; reviewers still read the
 * cited tests and evidence bytes.
 *
 * Output is a JSON report on stdout; the exit code is 1 on any error.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { R8_SOURCE } from './extract-r8.mjs';
import { SEED_PATH, seedRow } from './seed.mjs';

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
/** R8 lock rows: 15 REUSE "—" locks, 12 BX, 16 INV and the rows staged in DEV-01. */
export const EXPECTED_LOCK_COUNT = 58;
/** SHA-256 of `parity-seed.v1.json`. Changing the seed requires changing this line. */
export const PINNED_SEED_SHA256 = 'af5c2ac1f6654c7973911f329fffced027a98f4d2b9ce1c021bf7a84acbd00b3';
const DISPOSITIONS = new Set(['REUSE', 'ADAPT', 'REWRITE', 'NA-OD', 'TIER-OD', 'SPIKE', 'PRESERVE', 'GAP-OD', 'NA',
  'NOT-PORTED', 'FIX-IN-PORT', 'RELEASE-GATE', 'ACCEPT-IGNORE']);
const IMPL = new Set(['missing', 'partial', 'implemented', 'not-applicable']);
const EXEC = new Set(['not-run', 'passed', 'failed', 'pending']);
const LAYERS = new Set([null, 'unit', 'fake-server', 'real-binary', 'real-model', 'deployed', 'black-box']);
const EXPANSION = new Set(['pending']);
const OD_REF = /^OD-\d+[a-z]?$/;
const TEST_PATH = /^test\/(?:[\w.-]+\/)*[\w.-]+\.test\.(?:mjs|cjs|js|ts)$/;
const SHA256 = /^[a-f0-9]{64}$/;

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

  const seed = loadSeed(opts.seedText ?? readFileSync(SEED_PATH, 'utf8'), err);
  const seedRows = new Map((seed?.rows ?? []).map(r => [r.id, r]));

  if (matrix?.schemaVersion !== 1) err('matrix', 'schemaVersion must be 1');
  if (!SHA256.test(matrix?.source?.contentSha256 ?? '')) err('matrix', 'source.contentSha256 must pin the R8 record');
  if (!sameJson(matrix?.source, R8_SOURCE)) err('matrix', 'source must equal the pinned R8 record (record, commentId, contentSha256, amendments)');
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
    for (const ref of row.odRefs) if (typeof ref !== 'string' || !OD_REF.test(ref)) err(id, `odRefs entry must be an OD id (OD-<n>): ${ref}`);
    checkSeed(id, row, seedRows.get(id), err);

    const claims = ['partial', 'implemented'].includes(row.implementationStatus) || ['passed', 'failed'].includes(row.executionStatus);
    if (claims && row.tests.length === 0) err(id, 'status claims progress but cites no tests');
    const cases = [];
    for (const ref of row.tests) {
      const m = typeof ref === 'string' ? /^([^#\s]+)#(.+)$/.exec(ref) : null;
      if (!m) { err(id, `test reference must be "path#case": ${ref}`); continue; }
      if (m[1].startsWith('/') || m[1].includes('..')) { err(id, `test path must be repository-relative: ${m[1]}`); continue; }
      if (!TEST_PATH.test(m[1])) { err(id, `test path must be a test/** *.test.* file: ${m[1]}`); continue; }
      if (!fileExists(m[1])) { err(id, `cited test file does not exist: ${m[1]}`); continue; }
      if (!declaresCase(readFile(m[1]), m[2])) { err(id, `cited case not declared in ${m[1]}: ${m[2]}`); continue; }
      cases.push(m[2]);
    }
    if (row.executionStatus === 'passed') {
      if (row.evidence.length === 0) err(id, 'passed requires evidence');
      else checkEvidence(id, row.evidence, cases, { fileExists, readFile }, err);
    }
    if (row.implementationStatus === 'not-applicable' && row.odRefs.length === 0) err(id, 'not-applicable requires an OD reference');
    if (row.expansion !== undefined) {
      if (!EXPANSION.has(row.expansion?.status)) err(id, `bad expansion.status ${row.expansion?.status}`);
      if (row.expansion?.status === 'pending' && row.implementationStatus === 'implemented') {
        err(id, 'bundle row cannot be implemented while its action-level expansion is pending');
      }
      if (row.expansion?.status === 'pending' && row.executionStatus === 'passed') {
        err(id, 'bundle row cannot be passed while its action-level expansion is pending');
      }
    }
    if (opts.gate) {
      if (row.lockRequired && row.executionStatus !== 'passed') err(id, 'gate: lock row has not passed');
      if (row.implementationStatus === 'implemented' && row.executionStatus !== 'passed') err(id, 'gate: implemented row has not passed');
    }
    if (row.owner.length === 0) warnings.push(`${id}: no owning stage recorded`);
  }

  if (seed) {
    const locks = rows.filter(r => r?.lockRequired === true).map(r => r.id);
    if (locks.length !== EXPECTED_LOCK_COUNT || !sameJson([...locks].sort(), [...seed.lockRequired].sort())) {
      err('matrix', `lock set must be exactly the ${EXPECTED_LOCK_COUNT} seeded R8 lock rows (found ${locks.length})`);
    }
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

function loadSeed(text, err) {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  if (digest !== PINNED_SEED_SHA256) { err('seed', `parity-seed.v1.json digest ${digest} does not match the pinned ${PINNED_SEED_SHA256}`); return null; }
  const seed = JSON.parse(text);
  if (!sameJson(seed.source, R8_SOURCE)) { err('seed', 'seed source does not match the pinned R8 record'); return null; }
  if (seed.lockRequired.length !== EXPECTED_LOCK_COUNT) { err('seed', `seed must list ${EXPECTED_LOCK_COUNT} lock rows`); return null; }
  return seed;
}

function checkSeed(id, row, expected, err) {
  if (!expected) return; // id-set errors are reported by the completeness check
  const actual = seedRow(row);
  for (const field of ['family', 'label', 'dispositionCodes', 'stage', 'lockRequired', 'inheritsFrom', 'expansionMembers']) {
    if (!sameJson(actual[field], expected[field])) err(id, `${field} differs from the R8 seed`);
  }
  if (Array.isArray(row.odRefs)) {
    for (const ref of expected.odRefs) if (!row.odRefs.includes(ref)) err(id, `R8 OD reference ${ref} was removed`);
  }
}

/** True when `source` declares a test, suite or subtest with exactly this title. */
export function declaresCase(source, title) {
  const quoted = ['\'', '"', '`'].map(q => q + title + q);
  return quoted.some(q => new RegExp(`\\b(?:test|it|describe|suite)(?:\\.(?:only|skip|todo))?\\(\\s*${escapeRe(q)}\\s*,`).test(source));
}

/**
 * Evidence for `passed`: node --test TAP output pinned by digest that reports
 * every cited case as `ok` without a SKIP/TODO directive, and never `not ok`.
 */
function checkEvidence(id, evidence, cases, io, err) {
  const okCases = new Set();
  const failedCases = new Set();
  for (const ev of evidence) {
    if (ev === null || typeof ev !== 'object' || ev.kind !== 'node-test-tap' || typeof ev.path !== 'string' || !SHA256.test(ev.sha256 ?? '')) {
      err(id, `evidence entry must be {kind:'node-test-tap', path, sha256}: ${JSON.stringify(ev)}`);
      continue;
    }
    if (ev.path.startsWith('/') || ev.path.includes('..')) { err(id, `evidence path must be repository-relative: ${ev.path}`); continue; }
    if (!io.fileExists(ev.path)) { err(id, `evidence file does not exist: ${ev.path}`); continue; }
    const text = io.readFile(ev.path);
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    if (digest !== ev.sha256) { err(id, `evidence digest mismatch for ${ev.path}`); continue; }
    for (const line of text.split('\n')) {
      const m = /^\s*(not ok|ok) \d+ - (.*?)\s*$/.exec(line);
      if (!m) continue;
      const directive = /\s+#\s*(SKIP|TODO)\b.*$/i.exec(m[2]);
      const title = unescapeTap(directive ? m[2].slice(0, directive.index) : m[2]);
      if (m[1] === 'not ok') failedCases.add(title);
      else if (!directive) okCases.add(title);
    }
  }
  for (const c of cases) {
    if (failedCases.has(c)) err(id, `evidence reports cited case as not ok: ${c}`);
    else if (!okCases.has(c)) err(id, `evidence does not report cited case as ok: ${c}`);
  }
}

/** Reverses the node:test TAP reporter's escaping of `\\` and `#` in titles. */
function unescapeTap(s) { return s.replace(/\\([\\#])/g, '$1'); }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const path = args.find(a => !a.startsWith('--')) ?? DEFAULT_MATRIX;
  const report = validate(JSON.parse(readFileSync(path, 'utf8')), { gate: args.includes('--gate') });
  const { warnings, ...rest } = report;
  console.log(JSON.stringify({ ...rest, warningCount: warnings.length }, null, 2));
  if (!report.ok) process.exit(1);
}
