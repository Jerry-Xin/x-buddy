// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-runtime determinism gate: normalized analyzer digests recorded on two
 * Node.js versions must be byte-identical (fixtures, generated batches,
 * production scan and replicated corpus). Timing and memory are excluded.
 *
 *   node scripts/egress/compare-evidence.mjs <evidence-dir-a> <evidence-dir-b>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [a, b] = process.argv.slice(2);
const load = (dir, prefix) => {
  const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!name) throw new Error(`${dir}: missing ${prefix}*.json`);
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
};
const normalized = (dir) => {
  const fixtures = load(dir, 'egress-fixture-digests-node');
  const generated = load(dir, 'egress-generated-summary-node');
  const bench = load(dir, 'egress-bench-node');
  return {
    fixtures,
    generated: generated.batches.map(({ kind, start, size, outcome, complete, digest, transfers }) => ({ kind, start, size, outcome, complete, digest, transfers })),
    generatedSeedSet: generated.seedSetSha256,
    production: { digests: bench.production.digests, transfers: bench.production.transfers },
    scaled: { digests: bench.scaled.digests, transfers: bench.scaled.transfers },
    inputs: bench.inputs,
  };
};
const left = normalized(a);
const right = normalized(b);
const sections = Object.keys(left).map((key) => ({ section: key, identical: JSON.stringify(left[key]) === JSON.stringify(right[key]) }));
const result = { compared: [a, b], fixtureCount: Object.keys(left.fixtures).length, sections, identical: sections.every((s) => s.identical) };
console.log(JSON.stringify(result, null, 2));
if (!result.identical) process.exitCode = 1;
