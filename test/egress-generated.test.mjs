// SPDX-License-Identifier: Apache-2.0
/**
 * Metamorphic adversarial corpus: 1,000 guarded variants and 1,000 paired
 * controls from the committed seed set, batched into a few Programs. A
 * guarded variant must be DENY naming its capability (never ALLOW, never
 * UNKNOWN); its control must be ALLOW. Failures persist seed, minimized
 * transform list and source, source hash and expected CapabilityId.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { scanEgress } from '../scripts/egress-bypass-scan.mjs';
import { buildVariant, variantOwns, writeProject } from '../scripts/egress/generate-corpus.mjs';

const { seeds } = JSON.parse(readFileSync(new URL('./fixtures/egress-generated/seeds.json', import.meta.url), 'utf8'));
const BATCH = 250;
const work = mkdtempSync(join(tmpdir(), 'x-buddy-generated-'));
after(() => rmSync(work, { recursive: true, force: true }));
const evidenceDir = process.env.EGRESS_EVIDENCE_DIR;
const summary = { node: process.version, seeds: seeds.length, seedSetSha256: createHash('sha256').update(JSON.stringify(seeds)).digest('hex'), batches: [] };

let projects = 0;
function scanBatch(variants) {
  const cfg = writeProject(join(work, `p${projects++}`), variants);
  return scanEgress(cfg);
}

function judge(result, variant) {
  const own = result.violations.filter((v) => variantOwns(variant.id, v.file));
  if (variant.kind === 'control') return own.length === 0 ? undefined : `control not ALLOW: ${JSON.stringify(own)}`;
  if (own.some((v) => v.code === 'analysis-incomplete' || v.code === 'compiler-error' || v.code === 'unresolved-module')) return `guarded variant UNKNOWN: ${JSON.stringify(own)}`;
  const events = [...result.usages, ...result.operations].filter((e) => variantOwns(variant.id, e.file) && e.symbol === variant.key);
  const denies = result.diagnostics.filter((d) => variantOwns(variant.id, d.file) && d.outcome === 'DENY' && (d.capabilities ?? []).includes(variant.key));
  if (own.length === 0 || (events.length === 0 && denies.length === 0)) return `guarded variant not DENY for ${variant.key}: ${JSON.stringify(own)}`;
  return undefined;
}

/** Delta-minimizes a failing transform list, one transform at a time. */
function minimize(variant) {
  let plan = variant.transforms.slice();
  for (let i = plan.length - 1; i >= 0; i--) {
    const candidate = [...plan.slice(0, i), ...plan.slice(i + 1)];
    const v = buildVariant(variant.seed, variant.kind, 'm0', candidate);
    if (judge(scanBatch([v]), v)) plan = candidate;
  }
  return buildVariant(variant.seed, variant.kind, 'm0', plan);
}

function runKind(kind) {
  const failures = [];
  let applied = 0;
  let deniedAtFinalUse = 0;
  for (let start = 0; start < seeds.length; start += BATCH) {
    const variants = seeds.slice(start, start + BATCH).map((seed, i) => buildVariant(seed, kind, `g${start + i}`));
    const started = process.hrtime.bigint();
    const result = scanBatch(variants);
    summary.batches.push({ kind, start, size: variants.length, outcome: result.outcome, complete: result.complete,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, transfers: result.stats.transfers, digest: result.digest });
    for (const v of variants) {
      applied += v.transforms.length;
      if (kind === 'guarded' && result.operations.some((o) => variantOwns(v.id, o.file))) deniedAtFinalUse++;
      const problem = judge(result, v);
      if (!problem) continue;
      const min = minimize(v);
      const capability = result.terminals.find((t) => t.label === v.key)?.terminalId ?? null;
      failures.push({ seed: v.seed, kind, problem, transforms: v.transforms, minimizedTransforms: min.transforms, minimizedSource: min.files, sourceHash: v.sourceHash, expectedCapabilityId: capability });
    }
  }
  summary[kind] = { variants: seeds.length, failures: failures.length, meanTransforms: applied / seeds.length, ...(kind === 'guarded' ? { operationEventAtFinalUse: deniedAtFinalUse } : {}) };
  if (failures.length && evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `egress-generated-failures-${kind}.json`), JSON.stringify(failures, null, 2));
  }
  return failures;
}

describe('generated adversarial corpus (1,000 guarded + 1,000 paired controls)', () => {
  const started = process.hrtime.bigint();
  it('every guarded variant is DENY naming its capability', () => {
    const failures = runKind('guarded');
    assert.deepEqual(failures.map((f) => ({ seed: f.seed, problem: f.problem, minimized: f.minimizedTransforms })), []);
  });
  it('every paired control is ALLOW', () => {
    const failures = runKind('control');
    assert.deepEqual(failures.map((f) => ({ seed: f.seed, problem: f.problem, minimized: f.minimizedTransforms })), []);
  });
  it('the whole generated suite stays within the 120-second aggregate target', () => {
    summary.elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, `egress-generated-summary-node${process.versions.node.split('.')[0]}.json`), JSON.stringify(summary, null, 2));
    }
    assert.ok(summary.elapsedMs <= 120_000, `generated suite took ${summary.elapsedMs} ms`);
    assert.equal(summary.batches.length, 8);
  });
});
