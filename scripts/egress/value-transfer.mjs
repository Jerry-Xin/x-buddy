// SPDX-License-Identifier: Apache-2.0
/**
 * Value provenance transfers and site discovery.
 *
 * Flow-insensitive: every write to a binding, slot or parameter is joined, so
 * reassignment, assertion or overwrite never erases an origin. Policy sites
 * (extractions, operations, escapes, dynamic/rest selections, re-exports and
 * dynamic imports) are recorded only for files where location policy applies;
 * propagation runs over the whole source closure including egress and boundary
 * bodies.
 */
import { REASONS, WILDCARD } from './graph.mjs';
import { TypeEvaluator, normalizeKey } from './type-transfer.mjs';
import { resolveAlias } from './policy.mjs';
import {
  LIBRARY_FUNCTION_SLOT, LIBRARY_SLOT, classObject, fnObject, storeLibraryArgument, installCall, instanceObject, libraryCall, parameterTypes, processFunction, resultOf, wireCall,
} from './function-transfer.mjs';

const WRAPPERS = new Set();
const FUNCTION_MEMBERS = new Set(['length', 'name', 'prototype', 'toString', 'caller', 'arguments', 'constructor']);

export class Builder {
  constructor(ctx, policy, graph, cfg, limits, mutation) {
    this.ctx = ctx;
    this.policy = policy;
    this.g = graph;
    this.cfg = cfg;
    this.limits = limits;
    this.mutation = mutation;
    this.ts = ctx.ts;
    this.checker = ctx.checker;
    this.types = new TypeEvaluator(this);
    this.ids = new WeakMap();
    this.nextId = 1;
    this.symbolIds = new Map();
    this.symNodes = new Map();
    this.storageNodes = new Map();
    this.exprNodes = new Map();
    this.nsObjects = new Map();
    this.nsNodes = new Map();
    this.termObjects = new Map();
    this.fnInfos = new Map();
    this.classInfos = new Map();
    this.classRoots = new Map();
    this.instances = new Map();
    this.loads = new Map();
    this.loadAlls = new Map();
    this.wired = new Set();
    this.pending = [];
    this.frame = undefined;
    this.file = undefined;
    this.siteSeq = 0;
    this.sites = { usage: [], op: [], escape: [], dynamic: [], rest: [], reexport: [], dynImport: [], demand: [], incomplete: [] };
    const egress = (cfg.egressModules ?? []).map((m) => (m.endsWith('/') || m.endsWith('.ts') ? m : `${m}/`));
    this.isEgressPath = (path) => egress.some((m) => (m.endsWith('/') ? path.startsWith(m) : path === m));
    this.boundaryPaths = new Set(cfg.boundaryModules ?? []);
    const K = this.ts.SyntaxKind;
    for (const k of [K.ParenthesizedExpression, K.AsExpression, K.TypeAssertionExpression, K.SatisfiesExpression, K.NonNullExpression]) WRAPPERS.add(k);
  }

  astId(node) {
    let id = this.ids.get(node);
    if (id === undefined) { id = this.nextId++; this.ids.set(node, id); }
    return id;
  }

  symbolId(symbol) {
    let id = this.symbolIds.get(symbol);
    if (id === undefined) { id = this.symbolIds.size + 1; this.symbolIds.set(symbol, id); }
    return id;
  }

  isExternalNode(node) {
    const info = this.ctx.fileInfo.get(node.getSourceFile());
    return !info || info.external;
  }

  resolve(symbol) {
    if (!symbol) return undefined;
    if (this.mutation?.name === 'drop-import-alias' && symbol.flags & this.ts.SymbolFlags.Alias) return undefined;
    return resolveAlias(this.ctx, symbol);
  }

  /** Enters a source file and frame for constraint generation. */
  withFrame(sf, frame, fn) {
    const savedFile = this.file;
    const savedFrame = this.frame;
    const info = this.ctx.fileInfo.get(sf);
    this.file = {
      sf,
      path: info.path,
      policy: !info.external && !info.declaration && !this.boundaryPaths.has(info.path) && !this.isEgressPath(info.path),
    };
    this.frame = frame;
    try { fn(); } finally { this.file = savedFile; this.frame = savedFrame; }
  }

  unknownNode(reason) {
    const n = this.g.node();
    this.g.addUnknown(n, REASONS[reason]);
    return n;
  }

  // ---- objects and symbols ------------------------------------------------

  termObject(terminal) {
    let o = this.termObjects.get(terminal);
    if (o !== undefined) return o;
    o = this.g.object('term', { terminal });
    this.termObjects.set(terminal, o);
    for (const symbol of terminal.symbols) {
      if (symbol.flags & this.ts.SymbolFlags.ValueModule && symbol.exports) {
        // A merged namespace's members are separate slots, not the terminal itself.
        for (const member of this.checker.getExportsOfModule(symbol)) {
          if (member.flags & this.ts.SymbolFlags.Value) this.g.edge(this.valueOfSymbol(member), this.g.field(o, member.name));
        }
      }
    }
    return o;
  }

  /** Storage node of a variable/parameter/property symbol (all writes join here). */
  storage(symbol) {
    if (!symbol) return this.unknownNode('unresolved-symbol');
    let n = this.storageNodes.get(symbol);
    if (n === undefined) { n = this.g.node(); this.storageNodes.set(symbol, n); }
    return n;
  }

  valueOfSymbol(raw) {
    if (!raw) return this.unknownNode('unresolved-symbol');
    const cached = this.symNodes.get(raw);
    if (cached !== undefined) return cached;
    const ts = this.ts;
    const F = ts.SymbolFlags;
    const g = this.g;
    let n;
    const target = this.resolve(raw);
    if (!target) {
      const exportAssignment = raw.declarations?.find((d) => ts.isExportAssignment(d));
      n = exportAssignment ? this.expr(exportAssignment.expression) : this.unknownNode('unresolved-symbol');
      this.symNodes.set(raw, n);
      return n;
    }
    if (target !== raw) {
      n = this.valueOfSymbol(target);
      this.symNodes.set(raw, n);
      return n;
    }
    const decls = raw.declarations ?? [];
    const terminal = this.policy.terminalBySymbol.get(raw);
    if (terminal?.guarded) {
      n = g.node();
      this.symNodes.set(raw, n);
      g.addObj(n, this.termObject(terminal));
      return n;
    }
    if (decls.length === 0 || decls.every((d) => this.isExternalNode(d))) {
      // Library values are closed-world data; the arguments object is not modeled.
      n = raw.escapedName === 'arguments' && decls.length === 0 ? this.unknownNode('arguments-object') : g.EMPTY;
      this.symNodes.set(raw, n);
      return n;
    }
    const exportAssignment = decls.find((d) => ts.isExportAssignment(d));
    if (exportAssignment) {
      n = this.expr(exportAssignment.expression);
      this.symNodes.set(raw, n);
      return n;
    }
    if (raw.flags & F.Function || raw.flags & F.Method) {
      const impl = decls.find((d) => ts.isFunctionLike(d) && d.body) ?? decls.find((d) => ts.isFunctionLike(d));
      n = g.node();
      this.symNodes.set(raw, n);
      if (impl) {
        const fn = fnObject(this, impl);
        g.addObj(n, fn);
        if (raw.flags & F.ValueModule) this.namespaceFields(raw, fn);
      }
      return n;
    }
    if (raw.flags & F.Class) {
      const decl = decls.find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
      n = g.node();
      this.symNodes.set(raw, n);
      if (decl) g.addObj(n, classObject(this, decl));
      return n;
    }
    if (raw.flags & F.ValueModule) {
      n = this.namespaceNode(raw);
      this.symNodes.set(raw, n);
      return n;
    }
    if (raw.flags & (F.Enum | F.EnumMember)) {
      this.symNodes.set(raw, g.EMPTY);
      return g.EMPTY;
    }
    if (raw.flags & (F.Variable | F.Property | F.Accessor)) {
      n = this.storage(raw);
      this.symNodes.set(raw, n);
      return n;
    }
    n = this.unknownNode('unresolved-symbol');
    this.symNodes.set(raw, n);
    return n;
  }

  namespaceFields(symbol, o) {
    const g = this.g;
    for (const member of this.checker.getExportsOfModule(symbol).slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const target = this.resolve(member) ?? member;
      if (!(target.flags & this.ts.SymbolFlags.Value)) continue;
      g.edge(this.valueOfSymbol(member), g.field(o, member.escapedName === 'default' ? 'default' : member.name));
    }
  }

  /** Module namespace object; external modules are closed-world data (EMPTY). */
  namespaceNode(moduleSymbol) {
    let n = this.nsNodes.get(moduleSymbol);
    if (n !== undefined) return n;
    const decls = moduleSymbol.declarations ?? [];
    if (decls.length === 0 || decls.every((d) => this.isExternalNode(d))) {
      this.nsNodes.set(moduleSymbol, this.g.EMPTY);
      return this.g.EMPTY;
    }
    n = this.g.node();
    this.nsNodes.set(moduleSymbol, n);
    const o = this.g.object('ns', { module: moduleSymbol.name });
    this.nsObjects.set(moduleSymbol, o);
    this.g.addObj(n, o);
    this.namespaceFields(moduleSymbol, o);
    return n;
  }

  /** Module symbol for a specifier: undefined when unresolved, null when external. */
  resolveModuleSymbol(specifier, sf) {
    const ts = this.ts;
    const resolved = ts.resolveModuleName(specifier, sf.fileName, this.ctx.options, ts.sys).resolvedModule;
    if (!resolved) return undefined;
    const target = this.ctx.program.getSourceFile(resolved.resolvedFileName);
    if (!target) return undefined;
    if (this.ctx.fileInfo.get(target)?.external) return null;
    return this.checker.getSymbolAtLocation(target) ?? null;
  }

  /** Declared type at a node is primitive-only (after awaiting), per the checker. */
  primitiveOnly(node) {
    const ts = this.ts;
    let type;
    try { type = this.checker.getTypeAtLocation(node); } catch { return false; }
    if (!type) return false;
    const awaited = this.checker.getAwaitedType(type) ?? type;
    const F = ts.TypeFlags;
    const DATA = F.String | F.Number | F.Boolean | F.BigInt | F.StringLiteral | F.NumberLiteral | F.BooleanLiteral
      | F.BigIntLiteral | F.Void | F.Undefined | F.Null | F.Never | F.EnumLiteral | F.Enum | F.ESSymbol | F.UniqueESSymbol
      | F.TemplateLiteral | F.StringMapping;
    const check = (t) => (t.isUnion() ? t.types.every(check) : (t.flags & DATA) !== 0);
    return check(awaited);
  }

  /** Level of a library result: 'data' (no object), 'container' (fresh collection) or 'value'. */
  resultShape(node) {
    if (this.primitiveOnly(node)) return 'data';
    let type;
    try { type = this.checker.getTypeAtLocation(node); } catch { return 'value'; }
    const awaited = this.checker.getAwaitedType(type) ?? type;
    const CONTAINERS = new Set(['Set', 'ReadonlySet', 'Map', 'ReadonlyMap', 'Iterator', 'IterableIterator', 'Generator',
      'AsyncGenerator', 'AsyncIterableIterator', 'MapIterator', 'SetIterator', 'ArrayIterator']);
    const isContainer = (t) => this.checker.isArrayType(t) || this.checker.isTupleType(t)
      || CONTAINERS.has(t.getSymbol()?.name ?? '');
    const members = awaited.isUnion() ? awaited.types : [awaited];
    return members.some(isContainer) ? 'container' : 'value';
  }

  /**
   * Values a receiver holds as far as library code is concerned: elements of
   * collections, everything inside library objects, and only what was passed
   * through library methods for source objects and instances.
   */
  libraryContents(src, dataOnly = false) {
    const g = this.g;
    if (src === g.EMPTY) return g.EMPTY;
    const id = `contents|${dataOnly}|${src}`;
    let dst = this.loadAlls.get(id);
    if (dst !== undefined) return dst;
    dst = g.node();
    this.loadAlls.set(id, dst);
    g.on(src, {
      obj: (o) => {
        const kind = g.objKind[o];
        if (kind === 'term') { g.addObj(dst, o); return; }
        if (kind === 'fn' || kind === 'fntype' || kind === 'class') return;
        const all = kind === 'lib' || g.objInfo[o].array;
        g.watchFields(o, (k, f) => {
          if (dataOnly && k === LIBRARY_FUNCTION_SLOT) return;
          if (all ? !k.startsWith('$') : (k === LIBRARY_SLOT || k === LIBRARY_FUNCTION_SLOT)) g.edge(f, dst);
        });
      },
      unknown: (m) => g.addUnknown(dst, m),
    });
    return dst;
  }

  /** A library method whose declared result is its receiver type (fluent `this`). */
  returnsReceiver(node) {
    const ts = this.ts;
    const callee = node?.expression;
    if (!callee || !(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) return false;
    try {
      return this.checker.getTypeAtLocation(node) === this.checker.getTypeAtLocation(callee.expression);
    } catch { return false; }
  }

  instanceObject(decl) { return instanceObject(this, decl); }
  resultOf(o, which) { return resultOf(this, o, which); }
  parameterTypes(o) { return parameterTypes(this, o); }

  // ---- selections ---------------------------------------------------------

  /** Selection of slot `key`; `method` selections (callees) do not read library contents. */
  load(src, key, method = false) {
    const g = this.g;
    if (src === g.EMPTY) return g.EMPTY;
    key = normalizeKey(key);
    const id = `${src}|${key}${method ? '|m' : ''}`;
    let dst = this.loads.get(id);
    if (dst !== undefined) return dst;
    dst = g.node();
    this.loads.set(id, dst);
    if (this.mutation?.name === 'drop-property-selection') return dst;
    g.on(src, {
      obj: (o) => {
        const kind = g.objKind[o];
        if (kind === 'term' || kind === 'fn' || kind === 'fntype' || kind === 'class') {
          const fields = g.fields(o);
          if (fields?.has(key)) { g.edge(fields.get(key), dst); return; }
          if (kind === 'term') { g.addObj(dst, o); return; } // bind/call/apply keep the capability
          if (key === 'bind' || key === 'call' || key === 'apply') { g.addObj(dst, o); return; }
          if (FUNCTION_MEMBERS.has(key) || kind === 'fntype') return;
          g.edge(g.field(o, key), dst);
          return;
        }
        g.edge(g.field(o, key), dst);
        if (!method && kind === 'lib' && !g.objInfo[o].array) {
          // A library object's members may expose anything it received.
          const contents = this.objectContents(o);
          g.edge(contents, dst);
          g.edge(this.load(contents, key), dst);
        }
      },
      unknown: (m) => g.addUnknown(dst, m),
    });
    return dst;
  }

  /** Received contents of one library object (all of its slots). */
  objectContents(o) {
    const g = this.g;
    const id = `object|${o}`;
    let dst = this.loadAlls.get(id);
    if (dst !== undefined) return dst;
    dst = g.node();
    this.loadAlls.set(id, dst);
    g.watchFields(o, (k, f) => { if (!k.startsWith('$')) g.edge(f, dst); });
    return dst;
  }

  /** Every slot of every object reaching src (one level); `dataOnly` skips stored library functions. */
  loadAll(src, dataOnly = false) {
    const g = this.g;
    if (src === g.EMPTY) return g.EMPTY;
    const id = dataOnly ? `data|${src}` : src;
    let dst = this.loadAlls.get(id);
    if (dst !== undefined) return dst;
    dst = g.node();
    this.loadAlls.set(id, dst);
    g.on(src, {
      obj: (o) => {
        if (g.objKind[o] === 'term') { g.addObj(dst, o); return; }
        g.watchFields(o, (k, f) => { if (!k.startsWith('$') && !(dataOnly && k === LIBRARY_FUNCTION_SLOT)) g.edge(f, dst); });
      },
      unknown: (m) => g.addUnknown(dst, m),
    });
    return dst;
  }

  store(base, key, value) {
    const g = this.g;
    key = normalizeKey(key);
    g.on(base, {
      obj: (o) => { if (g.objKind[o] !== 'term') g.edge(value, g.field(o, key)); },
    });
  }

  copyFields(src, dstObj, exclude) {
    const g = this.g;
    g.on(src, {
      obj: (o) => {
        if (g.objKind[o] === 'term') return;
        g.watchFields(o, (k, f) => { if (!k.startsWith('$') && !exclude?.has(k)) g.edge(f, g.field(dstObj, k)); });
      },
      unknown: (m) => g.addUnknown(g.field(dstObj, WILDCARD), m),
    });
  }

  /** Syntax-proven constant key, or undefined. Asserted types are never trusted. */
  constantKey(expr, depth = 0) {
    const ts = this.ts;
    if (!expr || depth > 32) return undefined;
    while (WRAPPERS.has(expr.kind)) expr = expr.expression;
    if (ts.isStringLiteralLike(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return normalizeKey(expr.text);
    if (ts.isTemplateExpression(expr)) {
      let out = expr.head.text;
      for (const span of expr.templateSpans) {
        const part = this.constantKey(span.expression, depth + 1);
        if (part === undefined) return undefined;
        out += part + span.literal.text;
      }
      return out;
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'Symbol') {
      const symbol = this.checker.getSymbolAtLocation(expr.expression);
      if (!symbol || (symbol.declarations ?? []).every((d) => this.isExternalNode(d))) return `@@Symbol.${expr.name.text}`;
    }
    if (!ts.isIdentifier(expr)) return undefined;
    const decl = this.checker.getSymbolAtLocation(expr)?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer
      || !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return undefined;
    let init = decl.initializer;
    while (WRAPPERS.has(init.kind)) init = init.expression;
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'Symbol') {
      const sf = decl.getSourceFile();
      return `@@unique:${this.ctx.fileInfo.get(sf).path}:${decl.getStart(sf)}`;
    }
    return this.constantKey(decl.initializer, depth + 1);
  }

  // ---- sites ----------------------------------------------------------------

  site(kind, record) {
    if (!this.file?.policy) return;
    this.sites[kind].push({ file: this.file.path, sf: this.file.sf, seq: this.siteSeq++, ...record });
  }

  escape(node, value, context) {
    this.site('escape', { node, value, context: context ?? node });
  }

  // ---- expressions --------------------------------------------------------

  expr(node) {
    const cached = this.exprNodes.get(node);
    if (cached !== undefined) return cached;
    const n = this.computeExpr(node);
    this.exprNodes.set(node, n);
    return n;
  }

  visitChildrenAsExpressions(node) {
    this.ts.forEachChild(node, (child) => {
      if (this.ts.isTypeNode(child)) return;
      if (this.ts.isExpression(child)) this.expr(child);
      else this.visitChildrenAsExpressions(child);
    });
  }

  computeExpr(node) {
    const ts = this.ts;
    const K = ts.SyntaxKind;
    const g = this.g;
    switch (node.kind) {
      case K.Identifier: return this.identifier(node);
      case K.StringLiteral: case K.NumericLiteral: case K.BigIntLiteral: case K.NoSubstitutionTemplateLiteral:
      case K.RegularExpressionLiteral: case K.TrueKeyword: case K.FalseKeyword: case K.NullKeyword:
      case K.OmittedExpression:
        return g.EMPTY;
      case K.TemplateExpression:
        for (const span of node.templateSpans) this.expr(span.expression);
        return g.EMPTY;
      case K.ThisKeyword: case K.SuperKeyword:
        return this.frame?.thisNode ?? g.EMPTY;
      case K.ParenthesizedExpression: case K.NonNullExpression: case K.AwaitExpression:
        return this.expr(node.expression);
      case K.SatisfiesExpression:
        return this.expr(node.expression);
      case K.AsExpression: case K.TypeAssertionExpression: {
        // Assertions keep operand provenance and join definite declared evidence.
        const n = g.node();
        g.edge(this.expr(node.expression), n);
        if (!ts.isConstTypeReference(node.type)) g.edge(this.types.value(node.type), n);
        return n;
      }
      case K.ExpressionWithTypeArguments:
        return this.expr(node.expression);
      case K.PropertyAccessExpression: return this.propertyAccess(node);
      case K.ElementAccessExpression: return this.elementAccess(node);
      case K.CallExpression: return this.call(node, false);
      case K.NewExpression: return this.call(node, true);
      case K.TaggedTemplateExpression: {
        const callee = this.expr(node.tag);
        const args = [];
        if (ts.isTemplateExpression(node.template)) for (const span of node.template.templateSpans) args.push({ node: this.expr(span.expression) });
        return this.callSite(node, callee, undefined, args, false);
      }
      case K.ObjectLiteralExpression: return this.objectLiteral(node);
      case K.ArrayLiteralExpression: return this.arrayLiteral(node);
      case K.FunctionExpression: case K.ArrowFunction: {
        const n = g.node();
        g.addObj(n, fnObject(this, node));
        return n;
      }
      case K.ClassExpression: {
        const n = g.node();
        g.addObj(n, classObject(this, node));
        return n;
      }
      case K.ConditionalExpression: {
        this.expr(node.condition);
        const n = g.node();
        g.edge(this.expr(node.whenTrue), n);
        g.edge(this.expr(node.whenFalse), n);
        return n;
      }
      case K.BinaryExpression: return this.binary(node);
      case K.PrefixUnaryExpression: case K.PostfixUnaryExpression:
        this.expr(node.operand);
        return g.EMPTY;
      case K.TypeOfExpression: case K.VoidExpression: case K.DeleteExpression:
        this.expr(node.expression);
        return g.EMPTY;
      case K.YieldExpression: {
        if (node.expression) {
          const v = this.expr(node.expression);
          if (this.frame?.returnNode !== undefined) g.edge(v, this.frame.returnNode);
          this.escape(node.expression, v, node);
        }
        return g.EMPTY;
      }
      case K.SpreadElement:
        return this.loadAll(this.expr(node.expression));
      case K.MetaProperty:
        return g.EMPTY;
      default: {
        this.visitChildrenAsExpressions(node);
        this.sites.incomplete.push({ file: this.file?.path, sf: this.file?.sf, node, reason: `unsupported expression ${ts.SyntaxKind[node.kind]}` });
        return this.unknownNode('unsupported-expression');
      }
    }
  }

  isTypePosition(node) {
    return this.ts.isPartOfTypeNode(node);
  }

  identifier(node) {
    const g = this.g;
    if (node.text === 'undefined' || node.text === 'NaN' || node.text === 'Infinity') {
      const symbol = this.checker.getSymbolAtLocation(node);
      if (!symbol || (symbol.declarations ?? []).every((d) => this.isExternalNode(d))) return g.EMPTY;
    }
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) {
      this.sites.incomplete.push({ file: this.file?.path, sf: this.file?.sf, node, reason: `unresolved identifier ${node.text}` });
      return this.unknownNode('unresolved-symbol');
    }
    const n = this.valueOfSymbol(symbol);
    const terminal = this.policy.terminalBySymbol.get(this.resolve(symbol) ?? symbol);
    if (terminal?.guarded) this.site('usage', { node, role: 'identifier', result: n, receiver: undefined, direct: terminal });
    return n;
  }

  directTerminal(nameNode) {
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    const terminal = symbol && this.policy.terminalBySymbol.get(this.resolve(symbol) ?? symbol);
    return terminal?.guarded ? terminal : undefined;
  }

  propertyAccess(node, method = false) {
    const g = this.g;
    const receiver = this.expr(node.expression);
    const key = node.name.text;
    const loaded = this.load(receiver, key, method);
    const direct = this.directTerminal(node.name);
    let n = loaded;
    if (direct) {
      n = g.node();
      g.edge(loaded, n);
      g.addObj(n, this.termObject(direct));
    }
    this.site('usage', { node, role: 'property', result: n, receiver, direct, selector: key });
    return n;
  }

  elementAccess(node, method = false) {
    const receiver = this.expr(node.expression);
    this.expr(node.argumentExpression);
    const key = this.constantKey(node.argumentExpression);
    if (key !== undefined) {
      const n = this.load(receiver, key, method);
      this.site('usage', { node, role: 'element', result: n, receiver, selector: key });
      return n;
    }
    const n = this.loadAll(receiver);
    this.site('dynamic', { node, receiver, selector: `[${node.argumentExpression.getText()}]` });
    return n;
  }

  isLibraryValue(expr) {
    const symbol = this.checker.getSymbolAtLocation(expr);
    return Boolean(symbol) && (symbol.declarations ?? []).length > 0 && symbol.declarations.every((d) => this.isExternalNode(d));
  }

  call(node, isNew) {
    const ts = this.ts;
    const calleeExpr = node.expression;
    // Dynamic import / require of a module.
    if (!isNew && (calleeExpr.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(calleeExpr) && calleeExpr.text === 'require' && (!this.checker.getSymbolAtLocation(calleeExpr) || this.isLibraryValue(calleeExpr))))) {
      return this.dynamicImport(node);
    }
    // Modeled reflective selection: Reflect.get(receiver, key).
    if (!isNew && ts.isPropertyAccessExpression(calleeExpr) && ts.isIdentifier(calleeExpr.expression)
      && calleeExpr.expression.text === 'Reflect' && calleeExpr.name.text === 'get' && this.isLibraryValue(calleeExpr.expression)
      && node.arguments.length >= 2 && !node.arguments.some((a) => ts.isSpreadElement(a))) {
      const receiver = this.expr(node.arguments[0]);
      this.expr(node.arguments[1]);
      for (const extra of node.arguments.slice(2)) this.expr(extra);
      const key = this.constantKey(node.arguments[1]);
      if (key !== undefined) {
        const n = this.load(receiver, key);
        this.site('usage', { node, role: 'reflect', result: n, receiver, selector: key });
        return n;
      }
      this.site('dynamic', { node, receiver, selector: node.getText().slice(0, 120) });
      return this.loadAll(receiver);
    }
    let callee;
    let receiver;
    if (calleeExpr.kind === ts.SyntaxKind.SuperKeyword) {
      return this.superCall(node);
    }
    if (ts.isPropertyAccessExpression(calleeExpr) || ts.isElementAccessExpression(calleeExpr)) {
      callee = this.exprNodes.get(calleeExpr);
      if (callee === undefined) {
        callee = ts.isPropertyAccessExpression(calleeExpr) ? this.propertyAccess(calleeExpr, true) : this.elementAccess(calleeExpr, true);
        this.exprNodes.set(calleeExpr, callee);
      }
      receiver = this.expr(calleeExpr.expression);
    } else callee = this.expr(calleeExpr);
    const args = (node.arguments ?? []).map((a) => {
      if (ts.isSpreadElement(a)) {
        const inner = this.expr(a.expression);
        this.escape(a.expression, inner, node);
        return { node: this.loadAll(inner), spread: true };
      }
      const v = this.expr(a);
      this.escape(a, v, node);
      return { node: v };
    });
    return this.callSite(node, callee, receiver, args, isNew);
  }

  callSite(node, callee, receiver, args, isNew) {
    const g = this.g;
    const result = g.node();
    const site = { id: this.siteSeq++, callee, receiver, args, result, isNew, node };
    installCall(this, site);
    const signature = this.ts.isCallExpression(node) || this.ts.isNewExpression(node) || this.ts.isTaggedTemplateExpression(node)
      ? this.checker.getResolvedSignature(node) : undefined;
    const decl = signature?.declaration;
    if (!decl || this.isExternalNode(decl)) {
      libraryCall(this, site);
      if (isNew && (!decl || this.isExternalNode(decl))) {
        const o = g.object('lib', { site: this.astId(node) });
        g.addObj(result, o);
        for (const a of args) storeLibraryArgument(this, o, LIBRARY_SLOT, a.node);
      }
    } else if (this.ts.isFunctionLike(decl) && decl.body && !this.ts.isConstructorDeclaration(decl)) {
      // Static resolution supplements dynamic dispatch when the callee value is not tracked.
      wireCall(this, this.fnInfos.get(decl) ?? (fnObject(this, decl), this.fnInfos.get(decl)), site);
    }
    this.site('op', { node, role: isNew ? 'new' : 'call', callee });
    return result;
  }

  superCall(node) {
    const g = this.g;
    const args = node.arguments.map((a) => {
      const v = this.expr(this.ts.isSpreadElement(a) ? a.expression : a);
      this.escape(a, v, node);
      return { node: this.ts.isSpreadElement(a) ? this.loadAll(v) : v, spread: this.ts.isSpreadElement(a) };
    });
    const result = g.node();
    let cls = node.parent;
    while (cls && !this.ts.isClassLike(cls)) cls = cls.parent;
    const site = { id: this.siteSeq++, args, result, isNew: true, node, receiver: undefined };
    const signature = this.checker.getResolvedSignature(node);
    const decl = signature?.declaration;
    if (decl && !this.isExternalNode(decl) && this.ts.isConstructorDeclaration(decl) && decl.body) {
      fnObject(this, decl);
      wireCall(this, this.fnInfos.get(decl), site);
    } else if (!decl || this.isExternalNode(decl)) libraryCall(this, site);
    return result;
  }

  dynamicImport(node) {
    const ts = this.ts;
    const g = this.g;
    const arg = node.arguments[0];
    for (const a of node.arguments) this.expr(a);
    if (!arg || !ts.isStringLiteralLike(arg)) {
      this.site('dynImport', { node, target: undefined });
      this.sites.incomplete.push({ file: this.file?.path, sf: this.file?.sf, node, reason: 'nonliteral module specifier', code: 'unresolved-module', always: true });
      return this.unknownNode('unresolved-module');
    }
    const moduleSymbol = this.checker.getSymbolAtLocation(arg) ?? this.resolveModuleSymbol(arg.text, node.getSourceFile());
    if (moduleSymbol === undefined) return this.unknownNode('unresolved-module');
    if (moduleSymbol === null) return g.EMPTY;
    const sf = moduleSymbol.declarations?.[0]?.getSourceFile();
    const path = sf && this.ctx.fileInfo.get(sf)?.path;
    this.site('dynImport', { node, target: path, boundary: path && this.boundaryPaths.has(path) });
    return this.namespaceNode(moduleSymbol);
  }

  objectLiteral(node) {
    const ts = this.ts;
    const g = this.g;
    const o = g.object('obj', { site: this.astId(node) });
    const n = g.node();
    g.addObj(n, o);
    const selfThis = g.node();
    g.addObj(selfThis, o);
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) {
        this.copyFields(this.expr(p.expression), o);
        continue;
      }
      const key = p.name ? (this.types.memberKey(p.name) ?? WILDCARD) : WILDCARD;
      if (p.name && ts.isComputedPropertyName(p.name)) this.expr(p.name.expression);
      const slot = g.field(o, key);
      if (ts.isPropertyAssignment(p)) g.edge(this.expr(p.initializer), slot);
      else if (ts.isShorthandPropertyAssignment(p)) {
        const symbol = this.checker.getShorthandAssignmentValueSymbol(p);
        const value = this.valueOfSymbol(symbol);
        const terminal = symbol && this.policy.terminalBySymbol.get(this.resolve(symbol) ?? symbol);
        if (terminal?.guarded) this.site('usage', { node: p.name, role: 'identifier', result: value, receiver: undefined, direct: terminal });
        g.edge(value, slot);
        if (p.objectAssignmentInitializer) g.edge(this.expr(p.objectAssignmentInitializer), slot);
      } else if (ts.isMethodDeclaration(p)) {
        const fn = fnObject(this, p);
        g.addObj(slot, fn);
        g.edge(selfThis, this.fnInfos.get(p).thisNode);
      } else if (ts.isGetAccessorDeclaration(p)) {
        fnObject(this, p);
        g.edge(this.fnInfos.get(p).returnNode, slot);
        g.edge(selfThis, this.fnInfos.get(p).thisNode);
      } else if (ts.isSetAccessorDeclaration(p)) {
        fnObject(this, p);
        const setter = this.fnInfos.get(p);
        if (setter.params[0] !== undefined) g.edge(slot, setter.params[0]);
        g.edge(selfThis, setter.thisNode);
      }
    }
    return n;
  }

  arrayLiteral(node) {
    const ts = this.ts;
    const g = this.g;
    const o = g.object('obj', { site: this.astId(node), array: true });
    const n = g.node();
    g.addObj(n, o);
    const slot = g.field(o, WILDCARD);
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const inner = this.expr(element.expression);
        this.escape(element.expression, inner, node);
        g.edge(this.loadAll(inner), slot);
      } else {
        const v = this.expr(element);
        this.escape(element, v, node);
        g.edge(v, slot);
      }
    }
    return n;
  }

  binary(node) {
    const ts = this.ts;
    const K = ts.SyntaxKind;
    const g = this.g;
    const op = node.operatorToken.kind;
    if (op === K.EqualsToken || op === K.QuestionQuestionEqualsToken || op === K.BarBarEqualsToken || op === K.AmpersandAmpersandEqualsToken) {
      const value = this.expr(node.right);
      const n = g.node();
      g.edge(value, n);
      if (op !== K.EqualsToken) g.edge(this.expr(node.left), n);
      this.assign(node.left, value, node);
      return n;
    }
    if (op === K.CommaToken) { this.expr(node.left); return this.expr(node.right); }
    if (op === K.QuestionQuestionToken || op === K.BarBarToken || op === K.AmpersandAmpersandToken) {
      const n = g.node();
      g.edge(this.expr(node.left), n);
      g.edge(this.expr(node.right), n);
      return n;
    }
    this.expr(node.left);
    this.expr(node.right);
    return g.EMPTY;
  }

  /** Assignment target: binding, slot store or destructuring pattern. */
  assign(target, value, context) {
    const ts = this.ts;
    const g = this.g;
    let t = target;
    while (ts.isParenthesizedExpression(t) || ts.isNonNullExpression(t) || ts.isAsExpression(t) || ts.isSatisfiesExpression(t) || ts.isTypeAssertionExpression(t)) t = t.expression;
    if (ts.isIdentifier(t)) {
      if (this.mutation?.name === 'drop-assignment') return;
      const symbol = this.checker.getSymbolAtLocation(t);
      g.edge(value, this.valueOfSymbol(symbol));
      return;
    }
    if (ts.isPropertyAccessExpression(t)) {
      const base = this.expr(t.expression);
      this.store(base, t.name.text, value);
      this.escape(context === undefined ? t : t, value, context ?? t);
      return;
    }
    if (ts.isElementAccessExpression(t)) {
      const base = this.expr(t.expression);
      this.expr(t.argumentExpression);
      const key = this.constantKey(t.argumentExpression);
      this.store(base, key ?? WILDCARD, value);
      this.escape(t, value, context ?? t);
      return;
    }
    if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) {
      this.destructureAssignment(t, value);
      return;
    }
    this.expr(t);
  }

  destructureAssignment(pattern, src) {
    const ts = this.ts;
    const g = this.g;
    if (ts.isArrayLiteralExpression(pattern)) {
      pattern.elements.forEach((element, i) => {
        if (ts.isOmittedExpression(element)) return;
        if (ts.isSpreadElement(element)) {
          const rest = g.object('obj', { site: this.astId(element), array: true, rest: true });
          const restNode = g.node();
          g.addObj(restNode, rest);
          g.edge(this.loadAll(src), g.field(rest, WILDCARD));
          this.site('rest', { node: element, src, excluded: [], selector: `...${element.expression.getText()}` });
          this.assign(element.expression, restNode);
          return;
        }
        const selected = this.load(src, String(i));
        this.withDefault(element, selected, (target, v) => this.assign(target, v));
      });
      return;
    }
    const excluded = [];
    for (const p of pattern.properties) {
      if (ts.isSpreadAssignment(p)) {
        const rest = g.object('obj', { site: this.astId(p), rest: true });
        const restNode = g.node();
        g.addObj(restNode, rest);
        this.copyFields(src, rest, new Set(excluded));
        this.site('rest', { node: p, src, excluded: excluded.slice(), selector: `...${p.expression.getText()}` });
        this.assign(p.expression, restNode);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        excluded.push(p.name.text);
        const selected = this.load(src, p.name.text);
        this.site('usage', { node: p, role: 'binding', result: selected, receiver: src, selector: p.name.text });
        const value = g.node();
        g.edge(selected, value);
        if (p.objectAssignmentInitializer) g.edge(this.expr(p.objectAssignmentInitializer), value);
        const symbol = this.checker.getShorthandAssignmentValueSymbol(p);
        if (this.mutation?.name !== 'drop-assignment') g.edge(value, this.valueOfSymbol(symbol));
        continue;
      }
      if (ts.isPropertyAssignment(p)) {
        const key = this.types.memberKey(p.name);
        if (p.name && ts.isComputedPropertyName(p.name)) this.expr(p.name.expression);
        let selected;
        if (key === undefined) {
          selected = this.loadAll(src);
          this.site('dynamic', { node: p, receiver: src, selector: `[${p.name.expression?.getText() ?? p.name.getText()}]` });
        } else {
          excluded.push(key);
          selected = this.load(src, key);
          this.site('usage', { node: p, role: 'binding', result: selected, receiver: src, selector: key });
        }
        this.withDefault(p.initializer, selected, (target, v) => this.assign(target, v));
      }
    }
  }

  withDefault(target, selected, assignFn) {
    const ts = this.ts;
    const g = this.g;
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const v = g.node();
      g.edge(selected, v);
      g.edge(this.expr(target.right), v);
      assignFn(target.left, v);
      return;
    }
    assignFn(target, selected);
  }

  /** Binding pattern in a declaration or parameter. */
  destructure(pattern, src) {
    const ts = this.ts;
    const g = this.g;
    const bind = (name, value) => {
      if (ts.isIdentifier(name)) {
        if (this.mutation?.name === 'drop-assignment') return;
        g.edge(value, this.storage(this.checker.getSymbolAtLocation(name)));
      } else this.destructure(name, value);
    };
    if (ts.isArrayBindingPattern(pattern)) {
      pattern.elements.forEach((element, i) => {
        if (ts.isOmittedExpression(element)) return;
        if (element.dotDotDotToken) {
          const rest = g.object('obj', { site: this.astId(element), array: true, rest: true });
          const restNode = g.node();
          g.addObj(restNode, rest);
          g.edge(this.loadAll(src), g.field(rest, WILDCARD));
          this.site('rest', { node: element, src, excluded: [], selector: `...${element.name.getText()}` });
          bind(element.name, restNode);
          return;
        }
        const value = g.node();
        g.edge(this.load(src, String(i)), value);
        if (element.initializer) g.edge(this.expr(element.initializer), value);
        bind(element.name, value);
      });
      return;
    }
    const excluded = [];
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        const rest = g.object('obj', { site: this.astId(element), rest: true });
        const restNode = g.node();
        g.addObj(restNode, rest);
        this.copyFields(src, rest, new Set(excluded));
        this.site('rest', { node: element, src, excluded: excluded.slice(), selector: `...${element.name.getText()}` });
        bind(element.name, restNode);
        continue;
      }
      const keyNode = element.propertyName ?? element.name;
      let key;
      if (ts.isComputedPropertyName(keyNode)) { this.expr(keyNode.expression); key = this.constantKey(keyNode.expression); }
      else if (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode) || ts.isNumericLiteral(keyNode)) key = normalizeKey(keyNode.text);
      let selected;
      if (key === undefined) {
        selected = this.loadAll(src);
        this.site('dynamic', { node: element, receiver: src, selector: `[${ts.isComputedPropertyName(keyNode) ? keyNode.expression.getText() : keyNode.getText()}]` });
      } else {
        excluded.push(key);
        selected = this.load(src, key);
        this.site('usage', { node: element, role: 'binding', result: selected, receiver: src, selector: key });
      }
      const value = g.node();
      g.edge(selected, value);
      if (element.initializer) g.edge(this.expr(element.initializer), value);
      bind(element.name, value);
    }
  }

  // ---- statements ---------------------------------------------------------

  statements(list) {
    for (const s of list) this.statement(s);
  }

  statement(s) {
    const ts = this.ts;
    const K = ts.SyntaxKind;
    const g = this.g;
    switch (s.kind) {
      case K.VariableStatement:
        this.variableList(s.declarationList);
        return;
      case K.ExpressionStatement:
        this.expr(s.expression);
        return;
      case K.ReturnStatement:
        if (s.expression) {
          const v = this.expr(s.expression);
          if (this.frame?.returnNode !== undefined) g.edge(v, this.frame.returnNode);
          this.escape(s.expression, v, s);
        }
        return;
      case K.ThrowStatement: {
        const v = this.expr(s.expression);
        this.escape(s.expression, v, s);
        return;
      }
      case K.FunctionDeclaration:
        if (s.body) {
          fnObject(this, s);
          const symbol = s.name && this.checker.getSymbolAtLocation(s.name);
          if (symbol) this.valueOfSymbol(symbol);
        }
        return;
      case K.ClassDeclaration:
        classObject(this, s);
        return;
      case K.ForOfStatement: {
        const iterable = this.expr(s.expression);
        this.forBinding(s.initializer, this.loadAll(iterable));
        this.statement(s.statement);
        return;
      }
      case K.ForInStatement:
        this.expr(s.expression);
        this.forBinding(s.initializer, g.EMPTY);
        this.statement(s.statement);
        return;
      case K.ExportAssignment: {
        const v = this.expr(s.expression);
        this.escape(s.expression, v, s);
        return;
      }
      case K.ExportDeclaration:
        this.exportDeclaration(s);
        return;
      case K.ImportDeclaration: case K.InterfaceDeclaration: case K.TypeAliasDeclaration: case K.EmptyStatement:
      case K.DebuggerStatement: case K.ImportEqualsDeclaration: case K.NamespaceExportDeclaration:
        return;
      case K.EnumDeclaration:
        for (const m of s.members) if (m.initializer) this.expr(m.initializer);
        return;
      case K.ModuleDeclaration:
        if (s.body && ts.isModuleBlock(s.body)) this.statements(s.body.statements);
        else if (s.body) this.statement(s.body);
        return;
      case K.WithStatement:
        this.sites.incomplete.push({ file: this.file?.path, sf: this.file?.sf, node: s, reason: 'with statement', always: true });
        this.expr(s.expression);
        this.statement(s.statement);
        return;
      case K.Block: case K.ModuleBlock:
        this.statements(s.statements);
        return;
      case K.LabeledStatement:
        this.statement(s.statement);
        return;
      case K.BreakStatement: case K.ContinueStatement:
        return;
      case K.ClassStaticBlockDeclaration:
        this.statements(s.body.statements);
        return;
      default:
        // if/while/do/for/switch/try/labeled/catch: visit nested statements and expressions.
        ts.forEachChild(s, (child) => {
          if (ts.isTypeNode(child)) return;
          if (ts.isExpression(child)) this.expr(child);
          else if (ts.isVariableDeclarationList(child)) this.variableList(child);
          else if (ts.isCatchClause(child)) { if (child.variableDeclaration) this.variableDeclaration(child.variableDeclaration); this.statement(child.block); }
          else if (ts.isCaseBlock(child)) for (const clause of child.clauses) { if (clause.expression) this.expr(clause.expression); this.statements(clause.statements); }
          else this.statement(child);
        });
    }
  }

  forBinding(initializer, value) {
    const ts = this.ts;
    if (ts.isVariableDeclarationList(initializer)) {
      for (const d of initializer.declarations) {
        if (ts.isIdentifier(d.name)) this.g.edge(value, this.storage(this.checker.getSymbolAtLocation(d.name)));
        else this.destructure(d.name, value);
      }
    } else this.assign(initializer, value);
  }

  variableList(list) {
    for (const d of list.declarations) this.variableDeclaration(d);
  }

  variableDeclaration(d) {
    const ts = this.ts;
    const g = this.g;
    const value = g.node();
    if (d.initializer) g.edge(this.expr(d.initializer), value);
    if (d.type) g.edge(this.types.value(d.type), value);
    if (ts.isIdentifier(d.name)) {
      if (this.mutation?.name === 'drop-assignment' && d.initializer) return;
      g.edge(value, this.storage(this.checker.getSymbolAtLocation(d.name)));
    } else this.destructure(d.name, value);
  }

  exportDeclaration(s) {
    const ts = this.ts;
    if (s.isTypeOnly || !this.file?.policy) return;
    if (!s.exportClause && s.moduleSpecifier) {
      const moduleSymbol = this.checker.getSymbolAtLocation(s.moduleSpecifier);
      if (moduleSymbol) this.site('reexport', { node: s, symbol: '*', value: this.namespaceNode(moduleSymbol), star: moduleSymbol });
      return;
    }
    if (s.exportClause && ts.isNamespaceExport(s.exportClause)) {
      const moduleSymbol = s.moduleSpecifier && this.checker.getSymbolAtLocation(s.moduleSpecifier);
      if (moduleSymbol) this.site('reexport', { node: s, symbol: `* as ${s.exportClause.name.text}`, value: this.namespaceNode(moduleSymbol) });
      return;
    }
    if (s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const local = this.checker.getExportSpecifierLocalTargetSymbol(el);
        const target = this.resolve(local) ?? local;
        const terminal = target && this.policy.terminalBySymbol.get(target);
        if (target && !(target.flags & ts.SymbolFlags.Value)) continue;
        this.site('reexport', { node: el, symbol: terminal?.guarded ? terminal.label : el.name.text, terminal: terminal?.guarded ? terminal : undefined, value: this.valueOfSymbol(local) });
      }
    }
  }

  // ---- driver ---------------------------------------------------------------

  visitFile(sf) {
    this.withFrame(sf, { thisNode: this.g.EMPTY, returnNode: undefined }, () => {
      if (this.ctx.fileInfo.get(sf).declaration) {
        this.ambientDeclarations(sf.statements);
        return;
      }
      this.statements(sf.statements);
    });
  }

  ambientDeclarations(statements) {
    const ts = this.ts;
    for (const s of statements) {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.type) this.g.edge(this.types.value(d.type), this.storage(this.checker.getSymbolAtLocation(d.name)));
        }
      } else if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body)) this.ambientDeclarations(s.body.statements);
      else if (ts.isExportDeclaration(s)) this.exportDeclaration(s);
    }
  }

  drainPending() {
    let worked = false;
    while (this.pending.length) {
      worked = true;
      const item = this.pending.shift();
      if (item.kind === 'function') processFunction(this, item);
      else if (item.kind === 'initializer') {
        this.withFrame(item.sf, { thisNode: item.thisNode, returnNode: undefined }, () => this.g.edge(this.expr(item.expr), item.slot));
      } else if (item.kind === 'block') {
        this.withFrame(item.sf, { thisNode: item.thisNode, returnNode: undefined }, () => this.statements(item.block.statements));
      }
    }
    return worked;
  }
}
