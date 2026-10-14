// SPDX-License-Identifier: Apache-2.0
/**
 * Analyzer pipeline: loadProgram -> buildPolicy -> solve -> certificates ->
 * evaluate. Every failure path returns `complete: false` with an explicit
 * violation; there is no syntax-only or legacy fallback that can approve.
 */
import { buildPolicy, canonicalJson, sha256 } from './policy.mjs';
import { loadProgram } from './program.mjs';
import { Certificates, resolveLimits, solve } from './solve.mjs';
import { evaluate } from './diagnostics.mjs';

export const ANALYSIS_VERSION = 'provenance-v2.0';
export const MUTATIONS = Object.freeze([
  'drop-import-alias', 'drop-assignment', 'drop-property-selection', 'drop-mapped-value', 'drop-generic-substitution',
  'drop-call-return', 'drop-union-member', 'ignore-unknown', 'budget-success', 'omit-source-module',
]);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const violationOrder = (x, y) => compare(x.code, y.code) || compare(x.file ?? '', y.file ?? '') || compare(String(x.symbol ?? ''), String(y.symbol ?? ''))
  || (x.line ?? 0) - (y.line ?? 0) || compare(x.role ?? '', y.role ?? '');

/** Stable digest over everything except statistics and timing. */
export function resultDigest(result) {
  return sha256(canonicalJson({
    analysisVersion: result.analysisVersion,
    complete: result.complete,
    outcome: result.outcome,
    primitives: result.primitives,
    unclassified: result.unclassified,
    terminals: result.terminals,
    usages: result.usages,
    operations: result.operations,
    violations: result.violations,
    diagnostics: result.diagnostics,
    policyHash: result.policyHash,
  }));
}

function emptyResult(violations, extra = {}) {
  return { primitives: [], unclassified: [], terminals: [], usages: [], operations: [], violations, diagnostics: [], observations: [], ...extra };
}

/**
 * @param {object} cfg scanner configuration
 * @param {{mutation?: {name: string, file?: string}}} [internal] mutation testing only
 */
export function runScan(cfg, internal = {}) {
  const started = process.hrtime.bigint();
  const mutation = internal.mutation;
  const { limits, errors } = resolveLimits(cfg.limits);
  let result;
  let complete = true;
  const stats = {};
  if (errors.length) {
    result = emptyResult(errors.map((e) => ({ code: 'invalid-config', file: '', symbol: e })));
    complete = false;
  } else {
    let ctx;
    try {
      ctx = loadProgram(cfg);
    } catch (error) {
      ctx = undefined;
      result = emptyResult([{ code: 'analysis-incomplete', file: '', symbol: `program construction failed: ${error.message}` }]);
      complete = false;
    }
    if (ctx) {
      const projectViolations = ctx.diagnostics.map((d) => ({ code: d.code, file: d.file, symbol: d.reason, line: d.line }));
      if (!ctx.complete) complete = false;
      const policy = buildPolicy(ctx, cfg);
      const policyViolations = policy.diagnostics.map((d) => ({ code: d.code, file: d.file, symbol: d.symbol ?? d.reason, reason: d.reason }));
      if (policy.diagnostics.some((d) => d.code !== 'boundary-policy-alias-conflict')) complete = false;
      try {
        const { graph, builder, budget } = solve(ctx, policy, cfg, limits, mutation);
        stats.nodes = graph.pts.length;
        stats.edges = graph.edgeCount;
        stats.objects = graph.objKind.length;
        stats.transfers = graph.transfers;
        stats.exactEnvironments = builder.types.stats.exactEnvironments;
        stats.summaryEnvironments = builder.types.stats.summaryEnvironments;
        stats.widenedJoins = builder.types.stats.widenedJoins;
        stats.keyOverflows = builder.types.stats.keyOverflows;
        stats.unsupportedConstructs = builder.sites.incomplete.length;
        stats.sourceFiles = ctx.scanned.length;
        if (budget) {
          complete = false;
          result = emptyResult([...projectViolations, ...policyViolations, { code: 'analysis-budget-exhausted', file: '', symbol: budget }]);
        } else {
          const certificates = new Certificates(graph);
          stats.components = certificates.componentTerms.length;
          stats.cyclicComponents = certificates.cyclic;
          const evaluated = evaluate({ ctx, policy, graph, builder, certificates, cfg });
          if (mutation?.name === 'ignore-unknown') {
            evaluated.violations = evaluated.violations.filter((v) => v.code !== 'analysis-incomplete');
            evaluated.diagnostics = evaluated.diagnostics.filter((d) => d.outcome !== 'UNKNOWN');
          }
          if (evaluated.violations.some((v) => ['analysis-incomplete', 'unresolved-module', 'invalid-ledger-row', 'ambiguous-ledger-row'].includes(v.code))) complete = false;
          result = {
            ...evaluated,
            violations: [...projectViolations, ...policyViolations, ...evaluated.violations],
          };
        }
      } catch (error) {
        complete = false;
        if (process.env.EGRESS_DEBUG) console.error(error);
        result = emptyResult([...projectViolations, ...policyViolations, { code: 'analysis-incomplete', file: '', symbol: `analyzer failure: ${error.message}` }]);
      }
      result.primitives = policy.primitives;
      result.unclassified = policy.unclassified;
      result.terminals = policy.terminals.map((t) => ({
        terminalId: t.terminalId, label: t.label, display: t.display, class: t.class, guarded: t.guarded, routes: t.routes, conflict: t.conflict,
      }));
      result.policyHash = policy.policyHash;
      result.profile = ctx.profile;
      result.compiler = ctx.compilerVersion;
    }
  }
  result.violations.sort(violationOrder);
  const outcome = !complete ? 'UNKNOWN' : result.violations.length || result.unclassified.length ? 'DENY' : 'ALLOW';
  const final = {
    analysisVersion: ANALYSIS_VERSION,
    complete,
    outcome,
    ...result,
    stats: { ...stats, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 },
  };
  final.digest = resultDigest(final);
  return final;
}
