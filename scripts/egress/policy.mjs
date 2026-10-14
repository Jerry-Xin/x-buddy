// SPDX-License-Identifier: Apache-2.0
/**
 * Boundary policy: canonical terminal identities (R2.1), conservative route
 * policy joins and stable display labels (R2.2).
 *
 * TerminalId encodes the full sorted declaration-anchor group of an
 * alias-resolved merged value declaration. ExportRouteId separately names a
 * configured boundary export. Policy is joined over every route that reaches a
 * terminal before any fact is seeded.
 */
import { createHash } from 'node:crypto';
import { kindName } from './program.mjs';

export const PERMITTED_CLASSES = new Set(['infrastructure', 'read', 'helper']);
const GUARDED_CLASSES = new Set(['primitive']);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareTuple = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = typeof a[i] === 'number' && typeof b[i] === 'number' ? a[i] - b[i] : compare(String(a[i]), String(b[i]));
    if (c) return c;
  }
  return a.length - b.length;
};

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Declarations that make up a terminal's runtime identity. */
function isAnchorDeclaration(ts, decl) {
  return ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl) || ts.isClassDeclaration(decl)
    || ts.isEnumDeclaration(decl) || ts.isModuleDeclaration(decl) || ts.isBindingElement(decl)
    || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl) || ts.isClassExpression(decl)
    || ts.isExportAssignment(decl);
}

export function anchorOf(ctx, decl) {
  const sf = decl.getSourceFile();
  return [ctx.fileInfo.get(sf)?.path ?? sf.fileName, decl.getStart(sf), decl.end, kindName(decl.kind)];
}

/** Resolves an alias chain completely; returns undefined when resolution fails. */
export function resolveAlias(ctx, symbol) {
  const { ts, checker } = ctx;
  if (!symbol) return undefined;
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  const target = checker.getAliasedSymbol(symbol);
  if (!target || target.flags === ts.SymbolFlags.None || checker.isUnknownSymbol(target)) return undefined;
  return target;
}

function classificationFor(cfg, boundary, name) {
  return cfg.boundaryClassification?.[boundary]?.[name] ?? cfg.classification?.[name];
}

/**
 * @returns policy with guarded terminals indexed for bitsets, a symbol lookup
 * for every boundary terminal, legacy fields and policy diagnostics.
 */
export function buildPolicy(ctx, cfg) {
  const { ts, checker } = ctx;
  const diagnostics = [];
  const routes = [];
  const boundaries = [...new Set(cfg.boundaryModules ?? [])].sort();
  for (const boundary of boundaries) {
    const sf = ctx.canonical.get(boundary);
    if (!sf) continue; // reported by loadProgram as missing-boundary
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) {
      diagnostics.push({ code: 'analysis-incomplete', file: boundary, reason: 'boundary module has no module symbol (no exports)' });
      continue;
    }
    const exports = checker.getExportsOfModule(moduleSymbol).slice().sort((a, b) => compare(a.name, b.name));
    for (const exported of exports) {
      const target = resolveAlias(ctx, exported);
      if (!target) {
        diagnostics.push({ code: 'analysis-incomplete', file: boundary, reason: `export ${exported.name} does not resolve to a terminal declaration` });
        continue;
      }
      if (!(target.flags & ts.SymbolFlags.Value)) continue; // type-only exports carry provenance but are not capabilities
      const anchorDecls = (target.declarations ?? []).filter((d) => isAnchorDeclaration(ts, d));
      if (anchorDecls.length === 0) {
        diagnostics.push({ code: 'analysis-incomplete', file: boundary, reason: `export ${exported.name} has no value declaration anchor` });
        continue;
      }
      const name = exported.escapedName === 'default' ? 'default' : exported.name;
      const entry = classificationFor(cfg, boundary, name);
      routes.push({
        routeId: JSON.stringify(['export-v2', boundary, name]),
        boundary,
        name,
        class: entry?.class,
        reason: entry?.reason,
        symbol: target,
        anchors: anchorDecls.map((d) => anchorOf(ctx, d)),
        originalName: target.name,
      });
    }
  }

  // R2.1 equivalence classes: same terminal symbol or overlapping anchors, closed transitively.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const anchorKey = (a) => JSON.stringify(a);
  for (const route of routes) {
    for (const a of route.anchors) if (!parent.has(anchorKey(a))) parent.set(anchorKey(a), anchorKey(a));
    for (const a of route.anchors.slice(1)) union(anchorKey(route.anchors[0]), anchorKey(a));
  }
  const groups = new Map();
  for (const route of routes) {
    const rootKey = find(anchorKey(route.anchors[0]));
    if (!groups.has(rootKey)) groups.set(rootKey, { routes: [], anchors: new Map(), symbols: new Set() });
    const group = groups.get(rootKey);
    group.routes.push(route);
    group.symbols.add(route.symbol);
    for (const a of route.anchors) group.anchors.set(anchorKey(a), a);
  }

  const terminals = [];
  for (const group of groups.values()) {
    const anchors = [...group.anchors.values()].sort(compareTuple);
    const terminalId = JSON.stringify(['terminal-v2', anchors]);
    const groupRoutes = group.routes.slice().sort((a, b) => compare(a.boundary, b.boundary) || compare(a.name, b.name));
    const classes = groupRoutes.map((r) => r.class);
    const unclassifiedRoutes = groupRoutes.filter((r) => !r.class || (!GUARDED_CLASSES.has(r.class) && !PERMITTED_CLASSES.has(r.class)));
    const guardedRoutes = groupRoutes.filter((r) => GUARDED_CLASSES.has(r.class));
    const permittedRoutes = groupRoutes.filter((r) => PERMITTED_CLASSES.has(r.class));
    const guarded = unclassifiedRoutes.length > 0 || guardedRoutes.length > 0;
    const representative = anchors[0];
    const owning = groupRoutes.filter((r) => r.boundary === representative[0]);
    const display = owning.find((r) => r.name === r.originalName) ?? owning[0] ?? groupRoutes[0];
    terminals.push({
      terminalId,
      anchors,
      representative,
      label: display.name,
      guarded,
      class: guarded ? (guardedRoutes.length ? 'primitive' : 'unclassified') : permittedRoutes[0].class,
      classes,
      reasons: groupRoutes.map((r) => r.reason).filter(Boolean),
      routes: groupRoutes.map((r) => r.routeId),
      unclassified: unclassifiedRoutes.map((r) => r.name),
      conflict: guarded && permittedRoutes.length > 0,
      symbols: group.symbols,
    });
  }
  terminals.sort((a, b) => compare(a.terminalId, b.terminalId));

  // Qualified display for colliding labels; legacy `symbol` keeps the plain label.
  const byLabel = new Map();
  for (const t of terminals) byLabel.set(t.label, (byLabel.get(t.label) ?? 0) + 1);
  for (const t of terminals) t.display = byLabel.get(t.label) > 1 ? `${t.representative[0]}::${t.label}` : t.label;

  const guardedTerminals = terminals.filter((t) => t.guarded);
  guardedTerminals.forEach((t, index) => { t.index = index; });
  const terminalBySymbol = new Map();
  for (const t of terminals) for (const s of t.symbols) terminalBySymbol.set(s, t);

  for (const t of terminals) {
    if (t.conflict) {
      diagnostics.push({
        code: 'boundary-policy-alias-conflict',
        file: t.representative[0],
        symbol: t.label,
        terminalId: t.terminalId,
        reason: `routes ${t.routes.join(', ')} classify one terminal as both guarded and permitted`,
      });
    }
  }

  // Legacy baseline rows must name exactly one guarded terminal.
  const baselineTerminals = new Map();
  for (const row of cfg.baselinePermittedCallers ?? []) {
    const matches = guardedTerminals.filter((t) => t.label === row.symbol);
    if (matches.length !== 1) {
      diagnostics.push({
        code: 'invalid-config',
        file: row.file,
        symbol: row.symbol,
        reason: matches.length ? 'baseline symbol is ambiguous across terminals; use a terminal-aware ledger row' : 'baseline symbol is not a guarded boundary terminal',
      });
    } else baselineTerminals.set(`${row.file}#${row.symbol}`, matches[0]);
  }

  const unclassified = [...new Set(terminals.flatMap((t) => t.unclassified))].sort();
  const policyHash = sha256(canonicalJson({
    boundaries,
    egress: [...(cfg.egressModules ?? [])].sort(),
    routes: routes.map((r) => [r.routeId, r.class ?? null]).sort(),
    terminals: terminals.map((t) => [t.terminalId, t.class]),
  }));

  return {
    routes,
    terminals,
    guardedTerminals,
    terminalBySymbol,
    baselineTerminals,
    unclassified,
    primitives: [...new Set(guardedTerminals.map((t) => t.label))].sort(),
    diagnostics,
    policyHash,
  };
}
