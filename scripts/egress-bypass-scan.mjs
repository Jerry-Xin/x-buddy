// SPDX-License-Identifier: Apache-2.0
/**
 * Egress bypass scan: capability provenance analyzer facade.
 *
 *   node scripts/egress-bypass-scan.mjs --config <boundary.json> [--root <dir>] [--events] [--observations]
 *
 * Every export of a configured boundary module is a guarded capability unless
 * classified as infrastructure, read or helper. Outside the authorized egress
 * locations, guarded references must match the exact legacy baseline and a
 * frozen site ledger, and no guarded value may escape, be selected
 * dynamically or extracted by rest. Incomplete analysis is UNKNOWN and fails.
 * Exit status is 0 only for outcome ALLOW.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from './egress/analyzer.mjs';

/** Synchronous scan; a mutation request is rejected here. */
export function scanEgress(cfg) {
  if (cfg && Object.hasOwn(cfg, 'mutation')) {
    throw new Error('mutation testing is not available through the enforcing entry point');
  }
  return runScan({ srcDir: 'src', egressModules: ['src/egress/'], ...cfg });
}

/** Loads a JSON config; a relative `siteLedgerPath` resolves against the config file. */
export function loadConfig(path, overrides = {}) {
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  if (cfg.siteLedgerPath) {
    cfg.siteLedger = JSON.parse(readFileSync(resolve(dirname(path), cfg.siteLedgerPath), 'utf8'));
  }
  return { ...cfg, ...overrides };
}

function argument(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config');
  if (!configPath) {
    console.error('usage: node scripts/egress-bypass-scan.mjs --config <boundary.json> [--root <dir>] [--events] [--observations]');
    process.exit(2);
  }
  let code;
  try {
    const cfg = loadConfig(configPath, { root: resolve(argument('--root') ?? process.cwd()) });
    if (process.argv.includes('--observations')) cfg.observations = true;
    const result = scanEgress(cfg);
    const out = {
      analysisVersion: result.analysisVersion,
      outcome: result.outcome,
      complete: result.complete,
      primitives: result.primitives,
      unclassified: result.unclassified,
      usages: result.usages.length,
      operations: result.operations.length,
      violations: result.violations,
      digest: result.digest,
      policyHash: result.policyHash,
      stats: result.stats,
    };
    if (process.argv.includes('--events')) Object.assign(out, { usageEvents: result.usages, operationEvents: result.operations });
    if (cfg.observations) out.observations = result.observations;
    console.log(JSON.stringify(out, null, 2));
    code = result.outcome === 'ALLOW' ? 0 : 1;
  } catch (error) {
    console.error(`egress scan failed: ${error.message}`);
    code = 1;
  }
  process.exit(code);
}
