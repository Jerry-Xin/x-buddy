// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const proof = JSON.parse(readFileSync(new URL('../../docs/cron-schedule/import-proof.json', import.meta.url)));
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const prefix = '// SPDX-License-Identifier: MIT\n// Ported from pinned OpenClaw; see NOTICE and import-proof.json.\n';
const replacements = {
  '@openclaw/normalization-core/number-coercion': './normalization.js',
  '@openclaw/normalization-core/string-coerce': './normalization.js',
  '@openclaw/normalization-core': './normalization.js',
  '../infra/format-time/parse-offsetless-zoned-datetime.js': './zoned-datetime.js',
  '../infra/map-size.js': './map-size.js', '../../shared/iso-time.js': './iso-time.js',
  '../map-size.js': './map-size.js', '../shared/iso-time.js': './iso-time.js',
};
for (const file of proof.files) test(`pinned source checksum: ${file.upstream}`, () => {
  const source = read(file.snapshot);
  assert.equal(createHash('sha256').update(source).digest('hex'), file.sha256);
  const name = file.snapshot.split('/').at(-1).replace(/\.txt$/, '');
  if (['numbers.ts', 'strings.ts', 'jobs-scheduling.ts', 'schedule.test.ts', 'stagger.test.ts'].includes(name)) return;
  let expected = source;
  for (const [from, to] of Object.entries(replacements)) expected = expected.replaceAll('"' + from + '"', '"' + to + '"');
  if (name === 'schedule.ts') expected = expected.replace('return Intl.DateTimeFormat().resolvedOptions().timeZone;', 'throw new RangeError("Expected an explicit IANA timezone");');
  if (name === 'zoned-datetime.ts') expected = expected
    .replace('"invalid-timezone" | "invalid-datetime"', '"invalid-timezone" | "invalid-datetime" | "ambiguous-datetime"')
    .replace('  timeZone: string,\n', '  timeZone: string,\n  rejectAmbiguous = false,\n')
    .replace('    return matchingInstants.length > 0', '    if (rejectAmbiguous && new Set(matchingInstants).size > 1) {\n      return { ok: false, reason: "ambiguous-datetime" };\n    }\n    return matchingInstants.length > 0');
  const destination = ['schedule.ts', 'stagger.ts'].includes(name) ? 'upstream-' + name : name;
  assert.equal(read('src/cron/schedule/' + destination), prefix + expected);
});

test('selected normalization functions retain exact upstream bodies', () => {
  const actual = read('src/cron/schedule/normalization.ts');
  for (const [file, names] of [
    ['numbers.ts', ['asFiniteNumber', 'asFiniteNumberInRange', 'asSafeIntegerInRange', 'parseStrictInteger', 'parseStrictFiniteNumber', 'parseStrictNonNegativeInteger', 'parseStrictPositiveInteger', 'asDateTimestampMs']],
    ['strings.ts', ['normalizeNullableString', 'normalizeOptionalString']],
  ]) {
    const source = read('test/cron-schedule/reference/' + file + '.txt');
    for (const name of names) {
      const start = source.indexOf('export function ' + name + '(');
      const body = source.slice(start, source.indexOf('\n}', start) + 2);
      assert.ok(actual.includes(body), name);
    }
  }
});
