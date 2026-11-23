// SPDX-License-Identifier: Apache-2.0
/**
 * Seed `parity-matrix.json` from the accepted R8 architecture record.
 *
 *   node test/foundation/parity/extract-r8.mjs <r8.md> [--write] [--write-seed]
 *
 * The input is the exact UTF-8 content of XIN-2050 comment
 * 709cfb70-e0aa-49e2-8163-d4a4142abc1e, read through the workspace's
 * authenticated tools (it is not stored in this repository). The digest is
 * pinned; any other input is rejected. Only identifiers, short labels,
 * disposition codes, stage and OD references are extracted; notes and
 * rationale stay in the record.
 *
 * This is a one-time seed. After seeding, the committed matrix is the
 * maintained artifact: every DEV change updates rows in place, and
 * `validate-parity-matrix.mjs` guards it. Re-running the extractor with
 * `--write` refuses to overwrite a matrix that has diverged from the seed.
 * `--write-seed` writes the immutable seed (`parity-seed.v1.json`, see
 * `seed.mjs`); its digest must then be pinned in the validator by hand.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { SEED_PATH, seedOf, seedText } from './seed.mjs';

export const R8_SOURCE = Object.freeze({
  record: 'XIN-2050',
  commentId: '709cfb70-e0aa-49e2-8163-d4a4142abc1e',
  contentSha256: 'c40ff6b67f2f32c28b7a57bba8605c2204212497ae0001cfc064c2e875b753a0',
  amendments: ['fca24437-f435-46a1-938b-47c1d65c1e5a'],
});
export const MATRIX_PATH = fileURLToPath(new URL('./parity-matrix.json', import.meta.url));

const CODES = ['NA-OD', 'TIER-OD', 'GAP-OD', 'REUSE', 'ADAPT', 'REWRITE', 'SPIKE', 'PRESERVE', 'NA'];
const LOCKED_REUSE = ['T11', 'T23', 'R4', 'R5', 'I1', 'I4', 'I9', 'I26', 'I29', 'S7', 'S14', 'O2', 'O10', 'EP-13', 'EP-28'];
const BUNDLES = {
  'EP-03': 'type-1 send variants: mentions, reply, client_msg_no, OBO',
  'EP-04': 'type 2 and type 8 payloads',
  'EP-12': 'groups list and get',
  'EP-15': 'GET and PUT',
  'EP-16': 'GET and PUT',
  'EP-17': 'group info, create, members add, members remove',
  'EP-18': 'threads create, list, get, delete, members, join, leave',
  'EP-20': 'space members, resolve targets',
  'EP-22': 'presigned request and PUT upload',
  'EP-23': 'voice context GET, PUT, DELETE',
  'EP-26': 'events long-poll and ack',
  'EP-27': 'docs comments, comment-task, ppt, replies',
  O24: '24 octo_management actions incl. write-secret, 3 message actions, 5 compatibility routes (AMEND-R8-01 PM-05)',
};

export function extract(markdown) {
  const digest = createHash('sha256').update(markdown, 'utf8').digest('hex');
  const lines = markdown.split('\n');
  const section = (start, end) => {
    const a = lines.findIndex(l => l.startsWith(start));
    const b = lines.findIndex((l, i) => i > a && l.startsWith(end));
    if (a < 0 || b < 0) throw new Error(`section ${start} not found`);
    return lines.slice(a, b);
  };
  const rows = [];
  let header = null;
  for (const line of [...section('## 4. ', '## 5. '), ...section('## 5. ', '## 6. ')]) {
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = splitRow(line);
    if (cells.every(c => /^-+$/.test(c))) continue;
    if (cells[0] === 'ID' || cells[0] === 'EP') { header = cells; continue; }
    if (!header) continue;
    const get = (name) => { const i = header.findIndex(h => h.startsWith(name)); return i >= 0 ? cells[i] : null; };
    const id = cells[0];
    const label = get('Capability') ?? get('Endpoint') ?? get('Behavior') ?? get('B key') ?? get('B defect');
    const disposition = get('Disposition') ?? '';
    const stage = get('Stage');
    const notes = get('Notes') ?? '';
    if (id.startsWith('KA-1..7')) {
      const parts = label.replace(/^A-only:\s*/, '').split(';').map(s => s.trim());
      if (parts.length !== 7) throw new Error('KA-1..7 did not expand to 7 keys');
      parts.forEach((p, i) => rows.push(makeRow(`KA-${i + 1}`, p, disposition, stage, notes)));
      continue;
    }
    const inherit = /^as (EP-\d+)$/.exec(disposition);
    const base = inherit ? rows.find(r => r.id === inherit[1]) : null;
    if (inherit && !base) throw new Error(`${id} inherits unknown row ${inherit[1]}`);
    const row = makeRow(id, label, disposition, stage, notes);
    if (base) { row.dispositionCodes = [...base.dispositionCodes]; row.inheritsFrom = base.id; }
    rows.push(row);
  }
  const inv = section('### 7.1 ', '## 8. ');
  for (const line of inv) {
    const m = /^- \*\*((?:P|C)\d+)\. ([^:*]+)/.exec(line);
    if (!m) continue;
    const id = `INV-${m[1]}`;
    rows.push(makeRow(id, m[2].trim(), 'release gate (R8 §7.1, adopted verbatim from XIN-2041 §5)', null, ''));
  }
  return { digest, rows };
}

function makeRow(id, label, disposition, stage, notes) {
  const family = familyOf(id);
  const codes = CODES.filter(c => new RegExp(`(^|[^A-Z-])${c.replace('-', '\\-')}($|[^A-Z-])`).test(disposition));
  if (family === 'BX') codes.push(/fixed in the port/.test(disposition) ? 'FIX-IN-PORT' : 'NOT-PORTED');
  if (family === 'INV') codes.push('RELEASE-GATE');
  if (/accept and ignore/.test(disposition) && !codes.includes('ACCEPT-IGNORE')) codes.push('ACCEPT-IGNORE');
  const stageText = clean(stage ?? '');
  const owners = [...new Set((stageText.match(/DEV-\d+/g) ?? []))];
  const odRefs = [...new Set(`${disposition} ${notes} ${label}`.match(/OD-\d+[a-z]?/g) ?? [])].sort();
  const lockRequired = LOCKED_REUSE.includes(id) || family === 'BX' || family === 'INV' || /DEV-01/.test(stageText);
  const row = {
    id, family, label: clean(label).slice(0, 140), dispositionCodes: [...new Set(codes)], stage: stageText || null,
    owner: owners.length ? owners : (lockRequired ? ['DEV-01'] : []), odRefs,
    acceptance: 'R8 §10.9 milestone manifest', lockRequired,
    tests: [], layer: null, fixture: null, evidence: [],
    executionStatus: 'not-run', implementationStatus: 'missing',
    gap: 'No x-buddy implementation or test evidence yet.',
  };
  if (BUNDLES[id]) row.expansion = { status: 'pending', members: BUNDLES[id] };
  return row;
}

export function familyOf(id) {
  const m = /^(EP|BX|KA|K|CR|INV|T|R|I|S|C|O)-?/.exec(id);
  if (!m) throw new Error(`unknown id family: ${id}`);
  return m[1];
}

function splitRow(line) {
  const out = [];
  let cur = '';
  let inCode = false;
  for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function clean(s) {
  return String(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

export function buildMatrix(markdown) {
  const { digest, rows } = extract(markdown);
  if (R8_SOURCE.contentSha256 && digest !== R8_SOURCE.contentSha256) {
    throw new Error(`R8 content digest mismatch: got ${digest}, pinned ${R8_SOURCE.contentSha256}`);
  }
  return {
    schemaVersion: 1,
    source: { ...R8_SOURCE, contentSha256: digest },
    statusVocabulary: {
      implementationStatus: ['missing', 'partial', 'implemented', 'not-applicable'],
      executionStatus: ['not-run', 'passed', 'failed', 'pending'],
    },
    rows,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = process.argv[2];
  if (!input) { console.error('usage: extract-r8.mjs <r8.md> [--write]'); process.exit(2); }
  const matrix = buildMatrix(readFileSync(input, 'utf8'));
  const text = JSON.stringify(matrix, null, 2) + '\n';
  if (process.argv.includes('--write-seed')) {
    const seed = seedText(seedOf(matrix));
    writeFileSync(SEED_PATH, seed);
    console.log(`wrote ${SEED_PATH} (sha256 ${createHash('sha256').update(seed, 'utf8').digest('hex')})`);
  } else if (process.argv.includes('--write')) {
    if (existsSync(MATRIX_PATH) && readFileSync(MATRIX_PATH, 'utf8') !== text) {
      console.error('refusing to overwrite a maintained parity matrix that differs from the seed');
      process.exit(1);
    }
    writeFileSync(MATRIX_PATH, text);
    console.log(`wrote ${MATRIX_PATH} (${matrix.rows.length} rows)`);
  } else process.stdout.write(text);
}
