// SPDX-License-Identifier: MIT
// Executes pure helpers extracted from checksum-verified pinned source snapshots.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const proof = JSON.parse(readFileSync(new URL('../../docs/cron-schedule/import-proof.json', import.meta.url)));
const source = new Map();
for (const file of proof.files) {
  const bytes = readFileSync(new URL('../../' + file.snapshot, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Source checksum mismatch: ${file.snapshot}`);
  source.set(file.snapshot.split('/').at(-1).replace(/\.txt$/, ''), bytes.toString());
}
const data = js => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const modules = new Map();
const croner = import.meta.resolve('croner');
const aliases = {
  '@openclaw/normalization-core/number-coercion': 'numbers.ts',
  '@openclaw/normalization-core/string-coerce': 'strings.ts',
  './string-coerce.ts': 'strings.ts',
  '../infra/format-time/parse-offsetless-zoned-datetime.js': 'zoned-datetime.ts',
  '../infra/map-size.js': 'map-size.ts', '../map-size.js': 'map-size.ts',
  '../../shared/iso-time.js': 'iso-time.ts', '../shared/iso-time.js': 'iso-time.ts',
  './parse.js': 'parse.ts', './schedule-number.js': 'schedule-number.ts',
};
function moduleUrl(name) {
  if (modules.has(name)) return modules.get(name);
  let js = stripTypeScriptTypes(source.get(name));
  js = js.replace(/from "([^"]+)"/g, (match, specifier) => {
    if (specifier === 'croner') return `from ${JSON.stringify(croner)}`;
    const dependency = aliases[specifier];
    if (!dependency) throw new Error(`Unapproved reference import: ${specifier}`);
    return `from ${JSON.stringify(moduleUrl(dependency))}`;
  });
  const url = data(js); modules.set(name, url); return url;
}
const raw = await import(moduleUrl('schedule.ts'));
let staggerSource = source.get('stagger.ts').replace(/import \{ expectDefined \} from "@openclaw\/normalization-core";/,
  'function expectDefined(value, message) { if (value === undefined) throw new Error(message); return value; }');
source.set('stagger-adapted.ts', staggerSource);
const stagger = await import(moduleUrl('stagger-adapted.ts'));
const scheduling = source.get('jobs-scheduling.ts');
const extracted = scheduling.slice(scheduling.indexOf('function resolveStableCronOffsetMs('), scheduling.indexOf('function isStaggeredCronRunAtMs('));
const effective = await import(data(stripTypeScriptTypes(`
import crypto from 'node:crypto';
const { computeNextRunAtMs, computePreviousRunAtMs } = await import(${JSON.stringify(moduleUrl('schedule.ts'))});
const { resolveCronStaggerMs } = await import(${JSON.stringify(moduleUrl('stagger-adapted.ts'))});
const { pruneMapToMaxSize } = await import(${JSON.stringify(moduleUrl('map-size.ts'))});
const { asDateTimestampMs } = await import(${JSON.stringify(moduleUrl('numbers.ts'))});
const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = new Map();
function isFiniteTimestamp(value) { return asDateTimestampMs(value) !== undefined; }
${extracted}
export { resolveStableCronOffsetMs, computeStaggeredCronNextRunAtMs, computeStaggeredCronPreviousRunAtOrBeforeMs };
`)));

// Copy table object bytes directly; no hand-derived replacements for upstream expectations.
const tests = source.get('schedule.test.ts');
const firstTable = tests.match(/it\.each\(\[([\s\S]*?)\]\)\("\$label"/)[1];
const verbatim = runInNewContext('[' + firstTable + ']');
for (const [marker, label] of [
  ['never spills a nonexistent year-limited reminder', 'year-limited nonexistent'],
  ['recovers the first occurrence of a year-limited reminder', 'year-limited repeated hour'],
]) {
  const block = tests.slice(tests.indexOf('it("' + marker)).split('\n    });')[0];
  const schedule = runInNewContext('(' + block.match(/const schedule = (\{[\s\S]*?\});/)[1].replace(' as const', '') + ')');
  const now = block.match(/const nowMs = Date.parse\("([^"]+)"\)/)[1];
  const previous = block.match(/computePreviousRunAtMs\(schedule, nowMs\)\)\.toBe\(Date.parse\("([^"]+)"\)\)/)?.[1] ?? null;
  verbatim.push({ label, timezone: schedule.tz, expression: schedule.expr, now, next: null, previous });
}
const annualBlock = tests.slice(tests.indexOf('it.each(["30 2 * 3 SUN#2"])')).split('\n    );')[0];
verbatim.push({ label: 'historical annual gap rules', timezone: 'America/New_York',
  expression: annualBlock.match(/it\.each\(\["([^"]+)"\]/)[1],
  now: annualBlock.match(/const nowMs = Date.parse\("([^"]+)"\)/)[1], next: null,
  previous: annualBlock.match(/Date.parse\("([^"]+)"\),/)[1] });
const retryTable = tests.slice(tests.indexOf('label: "next-second retry')).split('])("$label"')[0];
const retries = runInNewContext('[{' + retryTable + ']');
for (const entry of retries) verbatim.push({ ...entry, next: entry.expected });

const inputs = [
  ['London spring', 'Europe/London', '30 1 * * *', '2026-03-29T00:45:00Z'],
  ['London repeated first', 'Europe/London', '30 1 * * *', '2026-10-25T00:15:00Z'],
  ['London repeated second', 'Europe/London', '30 1 * * *', '2026-10-25T01:15:00Z'],
  ['NY spring', 'America/New_York', '30 2 * * *', '2026-03-08T06:45:00Z'],
  ['NY repeated first', 'America/New_York', '30 1 * * *', '2026-11-01T05:15:00Z'],
  ['NY repeated second', 'America/New_York', '30 1 * * *', '2026-11-01T06:15:00Z'],
  ['Shanghai control', 'Asia/Shanghai', '30 1 * * *', '2026-03-29T00:45:00Z'],
  ['Shanghai year rollback', 'Asia/Shanghai', '0 8 * * *', '2026-03-01T00:00:00Z'],
  ['DOM DOW OR', 'UTC', '0 0 13 * MON', '2026-10-12T00:00:00Z'],
  ['DOM DOW AND', 'UTC', '0 0 13 * +MON', '2026-10-12T00:00:00Z'],
  ['six field', 'UTC', '0 0 12 * * *', '2026-02-08T12:00:00.021Z'],
];
const iso = value => value === undefined ? null : new Date(value).toISOString();
const generated = inputs.map(([label, tz, expr, now]) => {
  const schedule = { kind: 'cron', tz, expr }; const clock = Date.parse(now);
  return { label, schedule, now, next: iso(raw.computeNextRunAtMs(schedule, clock)), previous: iso(raw.computePreviousRunAtMs(schedule, clock)),
    previousOrBefore: iso(effective.computeStaggeredCronPreviousRunAtOrBeforeMs({ id: 'fixture', schedule: { ...schedule, staggerMs: 0 } }, clock)) };
});
const staggered = [];
for (const [label, tz, expr, now] of [
  ['STAG-03 before', 'UTC', '0 * * * *', '2026-10-13T10:04:13.352Z'],
  ['STAG-04 exact boundary', 'UTC', '0 * * * *', '2026-10-13T10:04:13.353Z'],
  ['STAG-05 after/restart', 'UTC', '0 * * * *', '2026-10-13T10:04:13.354Z'],
  ['STAG-07 gap', 'Europe/Oslo', '30 2 * * *', '2026-03-29T00:45:00Z'],
  ['STAG-07 repeated hour', 'America/New_York', '30 1 * * *', '2026-11-01T06:15:00Z'],
  ['STAG-08 inside offset', 'UTC', '0 * * * *', '2026-10-13T10:02:00Z'],
]) for (const width of [undefined, 0, 300000]) {
  const schedule = { kind: 'cron', tz, expr, ...(width === undefined ? {} : { staggerMs: width }) };
  const job = { id: 'j7f3k2q', schedule }; const clock = Date.parse(now);
  const resolvedWidth = stagger.resolveCronStaggerMs(schedule);
  staggered.push({ label, schedule, jobId: job.id, now, resolvedWidth,
    offset: effective.resolveStableCronOffsetMs(job.id, resolvedWidth),
    next: iso(effective.computeStaggeredCronNextRunAtMs(job, clock)),
    previousOrBefore: iso(effective.computeStaggeredCronPreviousRunAtOrBeforeMs(job, clock)) });
}
const anchor = Date.parse('2026-03-08T06:30:00Z');
const every = [0, 1, 2, 3].map(k => {
  const schedule = { kind: 'every', everyMs: 3600000, anchorMs: anchor };
  const now = anchor + k * 3600000;
  return { schedule, now: iso(now), next: iso(raw.computeNextRunAtMs(schedule, now)) };
});
const payload = { pin: proof.pin, croner: '10.0.1', verbatim, generated, staggered, every };
const output = new URL('./expected-fixtures.json', import.meta.url);
const bytes = JSON.stringify(payload, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== bytes) throw new Error('Generated fixture drift');
} else writeFileSync(output, bytes);
console.log(JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), verbatim: verbatim.length,
  generated: generated.length, staggered: staggered.length, every: every.length }));
