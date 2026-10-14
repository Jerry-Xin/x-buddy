// SPDX-License-Identifier: Apache-2.0
/**
 * Scanner worker: one cold analysis per process. Prints exactly one final JSON
 * record line; the parent runner treats a missing record as incomplete.
 *
 *   node scripts/egress/worker.mjs --config <boundary.json> --root <dir> [--ledger <ledger.json>] [--root-order-seed N]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanEgress } from '../egress-bypass-scan.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const cfg = JSON.parse(readFileSync(arg('--config'), 'utf8'));
cfg.root = resolve(arg('--root') ?? process.cwd());
if (arg('--ledger')) cfg.siteLedger = JSON.parse(readFileSync(arg('--ledger'), 'utf8'));
if (arg('--root-order-seed') !== undefined) cfg.rootOrderSeed = Number(arg('--root-order-seed'));
if (arg('--boundary-modules')) cfg.boundaryModules = JSON.parse(arg('--boundary-modules'));
const result = scanEgress(cfg);
const record = {
  outcome: result.outcome,
  complete: result.complete,
  digest: result.digest,
  usages: result.usages.length,
  operations: result.operations.length,
  violations: result.violations.length,
  violationCodes: [...new Set(result.violations.map((v) => v.code))].sort(),
  stats: result.stats,
  compiler: result.compiler,
  maxRssKb: process.resourceUsage().maxRSS,
};
process.stdout.write(`${JSON.stringify({ record })}\n`);
process.exitCode = result.outcome === 'ALLOW' ? 0 : 1;
