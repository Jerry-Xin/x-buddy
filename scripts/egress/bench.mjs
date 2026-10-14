// SPDX-License-Identifier: Apache-2.0
/**
 * Performance and production-scan evidence.
 *
 *   node scripts/egress/bench.mjs --reference <checkout> --ledger <ledger.json> [--runs 20] [--scale 10] [--out <dir>]
 *
 * `--reference` is a checkout of the DEV-01 reference source (read in place,
 * nothing copied into this repository) with its dependencies installed. Each
 * sample is one cold, watchdog-guarded worker process. Gates: production
 * nearest-rank p95 <= 10 s and maximum peak RSS <= 512 MiB; the replicated
 * 10x corpus p95 <= 30 s, maximum peak RSS <= 1 GiB and <= 15x the production
 * transfer count. Every worker must survive the 60 s / 1 GiB watchdog, the
 * production scan must be complete and ALLOW against the frozen ledger, and
 * all production digests must be identical. Exit status is non-zero when any
 * gate fails.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { nearestRank, runWorker } from './run-worker.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const reference = resolve(arg('--reference'));
const ledgerPath = resolve(arg('--ledger'));
const runs = Number(arg('--runs', '20'));
const scale = Number(arg('--scale', '10'));
const out = resolve(arg('--out', 'egress-evidence'));
mkdirSync(out, { recursive: true });

const MIB = 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function treeHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); } else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(dir);
  return { files: files.length, sha256: sha256(files.map((f) => `${relative(dir, f)}\n${sha256(readFileSync(f))}`).join('\n')) };
}

const boundary = JSON.parse(readFileSync(join(reference, 'test/egress/egress-boundary.json'), 'utf8'));
const productionConfig = { ...boundary, srcDir: 'src', egressModules: ['src/egress/'] };
const productionConfigPath = join(out, 'production-config.json');
writeFileSync(productionConfigPath, JSON.stringify(productionConfig, null, 2));

async function sample(label, args) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const r = await runWorker({ args });
    samples.push({
      run: i + 1,
      elapsedMs: r.elapsedMs,
      peakRssKb: r.peakRssKb,
      exitCode: r.exitCode,
      signal: r.signal,
      watchdog: r.watchdog,
      outcome: r.record?.outcome,
      complete: r.record?.complete,
      digest: r.record?.digest,
      transfers: r.record?.stats?.transfers,
      nodes: r.record?.stats?.nodes,
      edges: r.record?.stats?.edges,
      widenedJoins: r.record?.stats?.widenedJoins,
      summaryEnvironments: r.record?.stats?.summaryEnvironments,
      violationCodes: r.record?.violationCodes,
    });
    process.stderr.write(`${label} ${i + 1}/${runs}: ${r.elapsedMs.toFixed(0)} ms, ${(r.peakRssKb / MIB).toFixed(1)} MiB, ${r.watchdog}, ${r.record?.outcome}\n`);
  }
  const p95 = nearestRank(samples.map((s) => s.elapsedMs), 95);
  return {
    samples,
    p95ElapsedMs: p95.value,
    p95Rank: p95.rank,
    maxPeakRssKb: Math.max(...samples.map((s) => s.peakRssKb)),
    allWatchdogOk: samples.every((s) => s.watchdog === 'ok'),
    digests: [...new Set(samples.map((s) => s.digest))],
    transfers: [...new Set(samples.map((s) => s.transfers))],
  };
}

/** Replicates the reference source `scale` times with one boundary module per copy. */
function buildScaledCorpus() {
  const root = mkdtempSync(join(tmpdir(), 'x-buddy-scaled-'));
  writeFileSync(join(root, 'package.json'), readFileSync(join(reference, 'package.json')));
  const tsconfig = JSON.parse(readFileSync(join(reference, 'tsconfig.json'), 'utf8'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ ...tsconfig, exclude: ['node_modules', 'src/**/__tests__/**/*'] }));
  symlinkSync(join(reference, 'node_modules'), join(root, 'node_modules'), 'dir');
  const boundaries = [];
  for (let i = 0; i < scale; i++) {
    cpSync(join(reference, 'src'), join(root, 'src', `copy${i}`), { recursive: true, filter: (p) => !p.includes('__tests__') });
    boundaries.push(`src/copy${i}/octo/api.ts`);
  }
  const config = { ...productionConfig, boundaryModules: boundaries, baselinePermittedCallers: [] };
  const configPath = join(out, 'scaled-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { root, configPath };
}

let referenceSha = null;
try { referenceSha = execFileSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }

const production = await sample('production', ['--config', productionConfigPath, '--root', reference, '--ledger', ledgerPath]);
const scaled = buildScaledCorpus();
let scaledResult;
try {
  scaledResult = await sample(`scaled-${scale}x`, ['--config', scaled.configPath, '--root', scaled.root]);
} finally {
  rmSync(scaled.root, { recursive: true, force: true });
}

const productionTransfers = production.transfers[0];
const scaledTransfers = scaledResult.transfers[0];
const gates = {
  productionComplete: production.samples.every((s) => s.complete === true),
  productionAllow: production.samples.every((s) => s.outcome === 'ALLOW'),
  productionDigestStable: production.digests.length === 1,
  productionP95: production.p95ElapsedMs <= 10_000,
  productionMaxRss: production.maxPeakRssKb <= 512 * MIB,
  productionWatchdog: production.allWatchdogOk,
  scaledComplete: scaledResult.samples.every((s) => s.complete === true),
  scaledDigestStable: scaledResult.digests.length === 1,
  scaledP95: scaledResult.p95ElapsedMs <= 30_000,
  scaledMaxRss: scaledResult.maxPeakRssKb <= 1024 * MIB,
  scaledTransferRatio: scaledTransfers / productionTransfers <= 15,
  scaledWatchdog: scaledResult.allWatchdogOk,
};
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    platform: platform(),
    release: release(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    node: process.version,
    typescript: ts.version,
    runner: process.env.RUNNER_NAME ?? null,
  },
  inputs: {
    referenceSha,
    referenceSource: treeHash(join(reference, 'src')),
    productionConfigSha256: sha256(readFileSync(productionConfigPath)),
    ledgerSha256: sha256(readFileSync(ledgerPath)),
    runs,
    scale,
  },
  metrics: {
    elapsed: 'monotonic launch-to-exit milliseconds per cold worker',
    rss: 'peak resident set size (KiB): max of worker getrusage maxRSS and parent samples',
    p95: 'nearest rank, ceil(0.95 * runs)',
  },
  production: { ...production, transfers: productionTransfers },
  scaled: { ...scaledResult, transfers: scaledTransfers, transferRatio: scaledTransfers / productionTransfers },
  gates,
  pass: Object.values(gates).every(Boolean),
};
const reportPath = join(out, `egress-bench-node${process.versions.node.split('.')[0]}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: reportPath, gates, pass: report.pass,
  production: { p95ElapsedMs: production.p95ElapsedMs, maxPeakRssMiB: production.maxPeakRssKb / MIB, transfers: productionTransfers, digest: production.digests[0] },
  scaled: { p95ElapsedMs: scaledResult.p95ElapsedMs, maxPeakRssMiB: scaledResult.maxPeakRssKb / MIB, transfers: scaledTransfers, ratio: scaledTransfers / productionTransfers } }, null, 2));
if (!existsSync(reportPath) || !report.pass) process.exitCode = 1;
