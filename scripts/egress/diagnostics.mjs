// SPDX-License-Identifier: Apache-2.0
/**
 * Authorization, event normalization and frozen ledgers (R2.3).
 *
 * Extraction (reference) events and operation events are normalized to
 * `(file, structural address, role, TerminalId)`: one event per terminal per
 * site no matter how many routes or witnesses produced it. Legacy reference
 * counts are checked exactly against the configured baseline; independently,
 * every reference and operation outside egress must consume one matching
 * frozen ledger row (typed-AST digest included). Escapes, dynamic and rest
 * selections are never creditable. Demanded uncertainty yields UNKNOWN.
 */
import { canonicalJson, sha256 } from './policy.mjs';
import { kindName } from './program.mjs';

export const LEDGER_ENCODING = 'typed-ast-v1';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const RESOLUTIONS = {
  'unresolved-boundary-extraction': 'Select the capability with a literal key inside an authorized egress module, or prove the selection excludes every guarded slot.',
  'unauthorized-reexport': 'Do not re-export boundary capabilities outside egress; export a reviewed egress function instead.',
  'unauthorized-dynamic-import': 'Import the boundary statically from an authorized egress module.',
  'unresolved-module': 'Use a literal module specifier that resolves inside the analyzed closure.',
  'analysis-incomplete': 'Simplify the construct or add a reviewed transfer rule with allow/deny tests; unknown provenance is never approved.',
};

export function structuralAddress(ts, node) {
  const parts = [];
  for (let n = node; n.parent; n = n.parent) {
    let index = 0;
    let found = -1;
    ts.forEachChild(n.parent, (child) => { if (child === n) found = index; index++; });
    parts.push(`${kindName(n.parent.kind)}.${found}`);
  }
  parts.reverse();
  parts.push(kindName(node.kind));
  return parts.join('/');
}

function typedAst(ts, node) {
  const out = { kind: kindName(node.kind) };
  if (ts.isNumericLiteral(node)) out.text = String(Number(node.text));
  else if (typeof node.text === 'string' && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isLiteralKind(node.kind)
    || ts.isTemplateLiteralKind(node.kind))) out.text = node.text;
  if (typeof node.operator === 'number') out.operator = kindName(node.operator);
  const children = [];
  ts.forEachChild(node, (child) => { children.push(typedAst(ts, child)); });
  if (children.length) out.children = children;
  return out;
}

export function nodeDigest(ts, node) {
  return sha256(canonicalJson([LEDGER_ENCODING, typedAst(ts, node)]));
}

function position(sf, node) {
  const start = node.getStart(sf);
  const lc = sf.getLineAndCharacterOfPosition(start);
  return { start, end: node.end, line: lc.line + 1, column: lc.character + 1 };
}

const text = (node, max = 120) => {
  const t = node.getText().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function evaluate({ ctx, policy, graph: g, builder: b, certificates, cfg }) {
  const ts = ctx.ts;
  const terminals = policy.guardedTerminals;
  const violations = [];
  const diagnostics = [];
  const observations = [];
  const usageEvents = new Map();
  const operationEvents = new Map();
  const addressCache = new Map();
  const addressOf = (node) => {
    let a = addressCache.get(node);
    if (a === undefined) { a = structuralAddress(ts, node); addressCache.set(node, a); }
    return a;
  };
  const termsIn = (n) => {
    const out = new Set();
    const pts = n === undefined ? undefined : g.pts[n];
    if (pts) for (const o of pts) if (g.termIndex[o] >= 0) out.add(g.termIndex[o]);
    return out;
  };
  const sortedTerminals = (set) => [...set].map((i) => terminals[i]).sort((x, y) => compare(x.terminalId, y.terminalId));
  const witness = (caps) => caps.map((t) => ({ terminalId: t.terminalId, declaration: t.representative, routes: t.routes }));
  const diagnostic = (site, code, outcome, extra) => {
    const pos = position(site.sf, site.node);
    diagnostics.push({ code, outcome, file: site.file, ...pos, ...extra, resolution: RESOLUTIONS[code] });
  };
  const unknown = (site, reasons, selector, operation) => {
    diagnostic(site, 'analysis-incomplete', 'UNKNOWN', { selector, operation, reasons });
    violations.push({ code: 'analysis-incomplete', file: site.file, symbol: selector, reasons });
  };

  // Extraction (reference) events.
  for (const site of b.sites.usage) {
    let found;
    if (site.role === 'identifier') found = new Set([site.direct.index]);
    else {
      found = termsIn(site.result);
      for (const t of termsIn(site.receiver)) if (!site.direct || site.direct.index !== t) found.delete(t);
      if (site.direct) found.add(site.direct.index);
    }
    const resultUnknown = site.role === 'identifier' ? 0 : g.unk[site.result];
    if (resultUnknown) unknown(site, certificates.finish(new Set(), resultUnknown, false).reasons, site.selector ?? text(site.node), `selection:${site.role}`);
    for (const terminal of sortedTerminals(found)) {
      const address = addressOf(site.node);
      const key = `${site.file}|${address}|${site.role}|${terminal.terminalId}`;
      if (usageEvents.has(key)) continue;
      usageEvents.set(key, { site, terminal, address, role: site.role });
    }
  }
  // Operation events.
  for (const site of b.sites.op) {
    const mask = g.unk[site.callee];
    if (mask) unknown(site, certificates.finish(new Set(), mask, false).reasons, text(site.node.expression ?? site.node, 60), `operation:${site.role}`);
    for (const terminal of sortedTerminals(termsIn(site.callee))) {
      const address = addressOf(site.node);
      const key = `${site.file}|${address}|${site.role}|${terminal.terminalId}`;
      if (!operationEvents.has(key)) operationEvents.set(key, { site, terminal, address, role: site.role });
    }
  }

  const observe = (site, operation, selector, envelope) => {
    if (!cfg.observations) return;
    const pos = position(site.sf, site.node);
    observations.push({
      file: site.file,
      line: pos.line,
      column: pos.column,
      operation,
      selector,
      mayC: sortedTerminals(envelope.terms).map((t) => t.display),
      terminalIds: sortedTerminals(envelope.terms).map((t) => t.terminalId),
      opaque: envelope.reasons,
      complete: envelope.complete,
      sourceFree: envelope.sourceFree,
      widened: envelope.widened,
    });
  };
  const judge = (site, operation, selector, envelope, denyCode = 'unresolved-boundary-extraction') => {
    observe(site, operation, selector, envelope);
    if (envelope.terms.size) {
      const caps = sortedTerminals(envelope.terms);
      diagnostic(site, denyCode, 'DENY', { selector, operation, capabilities: caps.map((t) => t.display), terminalIds: caps.map((t) => t.terminalId), witness: witness(caps) });
      violations.push({ code: denyCode, file: site.file, symbol: selector, capabilities: caps.map((t) => t.display) });
    }
    if (!envelope.complete) unknown(site, envelope.reasons, selector, operation);
  };

  for (const site of b.sites.escape) judge(site, 'escape', text(site.context), certificates.envelope(site.value));
  for (const site of b.sites.dynamic) judge(site, 'dynamic-selection', site.selector, certificates.envelope(site.receiver));
  for (const site of b.sites.rest) judge(site, 'rest-selection', site.selector, certificates.envelopeExcept(site.src, new Set(site.excluded)));
  for (const site of b.sites.reexport) {
    if (site.terminal) {
      diagnostic(site, 'unauthorized-reexport', 'DENY', { selector: site.symbol, capabilities: [site.terminal.display], terminalIds: [site.terminal.terminalId], witness: witness([site.terminal]) });
      violations.push({ code: 'unauthorized-reexport', file: site.file, symbol: site.symbol });
      continue;
    }
    const envelope = certificates.envelope(site.value);
    if (envelope.terms.size) {
      const caps = sortedTerminals(envelope.terms);
      diagnostic(site, 'unauthorized-reexport', 'DENY', { selector: site.symbol, capabilities: caps.map((t) => t.display), terminalIds: caps.map((t) => t.terminalId), witness: witness(caps) });
      violations.push({ code: 'unauthorized-reexport', file: site.file, symbol: site.symbol });
    }
    if (!envelope.complete) unknown(site, envelope.reasons, site.symbol, 're-export');
  }
  for (const site of b.sites.dynImport) {
    if (site.target === undefined) {
      diagnostic(site, 'unresolved-module', 'UNKNOWN', { selector: text(site.node) });
      violations.push({ code: 'unresolved-module', file: site.file, symbol: text(site.node) });
    } else if (site.boundary) {
      diagnostic(site, 'unauthorized-dynamic-import', 'DENY', { selector: site.target });
      violations.push({ code: 'unauthorized-dynamic-import', file: site.file, symbol: site.target });
    }
  }
  for (const item of b.sites.incomplete) {
    if (!item.always) continue;
    if (item.code === 'unresolved-module') continue; // reported through the dynamic-import site
    diagnostic({ ...item }, 'analysis-incomplete', 'UNKNOWN', { reasons: [item.reason] });
    violations.push({ code: 'analysis-incomplete', file: item.file, symbol: item.reason });
  }

  // Normalized events, sorted for stable output.
  const finishEvent = (event, kind) => {
    const pos = position(event.site.sf, event.site.node);
    return {
      file: event.site.file,
      symbol: event.terminal.label,
      display: event.terminal.display,
      line: pos.line,
      role: event.role,
      via: event.role,
      kind,
      terminalId: event.terminal.terminalId,
      address: event.address,
      digest: nodeDigest(ts, event.site.node),
      routes: event.terminal.routes,
    };
  };
  const order = (x, y) => compare(x.file, y.file) || x.line - y.line || compare(x.address, y.address) || compare(x.role, y.role) || compare(x.terminalId, y.terminalId);
  const usages = [...usageEvents.values()].map((e) => finishEvent(e, 'reference')).sort(order);
  const operations = [...operationEvents.values()].map((e) => finishEvent(e, 'operation')).sort(order);

  // Layer 1: exact legacy reference counts.
  const observed = new Map();
  for (const u of usages) observed.set(`${u.file}#${u.symbol}`, (observed.get(`${u.file}#${u.symbol}`) ?? 0) + 1);
  const baseline = new Map((cfg.baselinePermittedCallers ?? []).map((row) => [`${row.file}#${row.symbol}`, row.count]));
  for (const [key, count] of [...observed].sort(([a], [c]) => compare(a, c))) {
    const [file, symbol] = key.split('#');
    const allowed = baseline.get(key) ?? 0;
    if (count > allowed) violations.push({ code: 'unauthorized-call', file, symbol, observed: count, baseline: allowed });
  }
  for (const [key, count] of [...baseline].sort(([a], [c]) => compare(a, c))) {
    const [file, symbol] = key.split('#');
    if ((observed.get(key) ?? 0) < count) violations.push({ code: 'stale-baseline', file, symbol, observed: observed.get(key) ?? 0, baseline: count });
  }

  // Layer 2: frozen site ledger, single-use credit per exact event.
  const ledger = Array.isArray(cfg.siteLedger) ? cfg.siteLedger : cfg.siteLedger?.rows;
  const rows = new Map();
  if (ledger) {
    for (const [i, row] of ledger.entries()) {
      const terminal = row.terminalId ? terminals.find((t) => t.terminalId === row.terminalId)
        : terminals.filter((t) => t.label === row.symbol).length === 1 ? terminals.find((t) => t.label === row.symbol) : undefined;
      if (!terminal || !['reference', 'operation'].includes(row.kind) || !row.address || !row.digest || !row.role || !row.file
        || (row.encoding ?? LEDGER_ENCODING) !== LEDGER_ENCODING) {
        violations.push({ code: 'invalid-ledger-row', file: row.file ?? '', symbol: row.symbol ?? row.terminalId ?? String(i) });
        continue;
      }
      const key = `${row.kind}|${row.file}|${row.address}|${row.role}|${terminal.terminalId}`;
      if (rows.has(key)) {
        violations.push({ code: 'ambiguous-ledger-row', file: row.file, symbol: terminal.label });
        continue;
      }
      rows.set(key, { row, terminal, used: false });
    }
  }
  const credit = (event) => {
    const entry = rows.get(`${event.kind}|${event.file}|${event.address}|${event.role}|${event.terminalId}`);
    if (!entry || entry.used || entry.row.digest !== event.digest) return false;
    entry.used = true;
    return true;
  };
  const missingLedger = new Set();
  for (const u of usages) {
    u.credited = credit(u);
    if (u.credited) continue;
    if ((baseline.get(`${u.file}#${u.symbol}`) ?? 0) > 0) {
      if (!ledger) {
        if (!missingLedger.has(`${u.file}#${u.symbol}`)) {
          missingLedger.add(`${u.file}#${u.symbol}`);
          violations.push({ code: 'ledger-missing', file: u.file, symbol: u.symbol });
        }
      } else violations.push({ code: 'unledgered-reference', file: u.file, symbol: u.symbol, line: u.line, role: u.role });
    }
  }
  for (const op of operations) {
    op.credited = credit(op);
    if (!op.credited) violations.push({ code: 'unauthorized-operation', file: op.file, symbol: op.symbol, line: op.line, role: op.role });
  }
  for (const entry of rows.values()) {
    if (!entry.used) violations.push({ code: 'stale-ledger-row', file: entry.row.file, symbol: entry.terminal.label, role: entry.row.role, address: entry.row.address });
  }

  diagnostics.sort((x, y) => compare(x.file, y.file) || x.start - y.start || compare(x.code, y.code)
    || compare(JSON.stringify(x.terminalIds ?? []), JSON.stringify(y.terminalIds ?? [])) || compare(x.selector ?? '', y.selector ?? ''));
  observations.sort((x, y) => compare(x.file, y.file) || x.line - y.line || x.column - y.column || compare(x.operation, y.operation));
  return { usages, operations, violations, diagnostics, observations };
}
