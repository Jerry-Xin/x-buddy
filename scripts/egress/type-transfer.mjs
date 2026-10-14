// SPDX-License-Identifier: Apache-2.0
/**
 * Type-expression provenance (R1.1–R1.3).
 *
 * A declared type is evaluated under a finite environment into graph nodes.
 * Generic declarations are finite templates: up to `environments` exact
 * instantiations per declaration (and nesting `depth`), after which every
 * further instantiation joins one widened summary environment. A summary never
 * resets its inputs, so a late source keeps flowing to a fixed point. Selections
 * (`T[K]`, Pick, mapped `as` remaps) bind each original key and evaluate the
 * selected value expression, so a rename changes a key, never an origin.
 * Unsupported relations attach an uncertainty reason rather than vanish.
 */
import { REASONS, WILDCARD } from './graph.mjs';

const ANY_KEYS = Object.freeze({ any: true, keys: new Set() });
const keysOf = (iterable) => ({ any: false, keys: new Set(iterable) });
const WIDENED = Object.freeze({ kind: 'widened' });
const OTHER = Object.freeze({ kind: 'other' });

export const normalizeKey = (key) => {
  if (typeof key === 'number') return String(key);
  if (/^(0|[1-9]\d*)$/.test(key)) return key;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(key) && String(Number(key)) !== 'NaN') return String(Number(key));
  return key;
};

export class TypeEvaluator {
  constructor(b) {
    this.b = b;
    this.ts = b.ctx.ts;
    this.checker = b.ctx.checker;
    this.g = b.g;
    this.memo = new Map();
    this.objects = new Map();
    this.instances = new Map();
    this.declCount = new Map();
    this.summaries = new Map();
    this.mappedEnvs = new Map();
    this.nextEnv = 1;
    this.ROOT = { id: 0, parent: null, bindings: new Map(), depth: 0, widened: false };
    this.stats = { exactEnvironments: 0, summaryEnvironments: 0, widenedJoins: 0, keyOverflows: 0 };
  }

  newEnv(parent, depth, widened) {
    return { id: this.nextEnv++, parent, bindings: new Map(), depth, widened };
  }

  lookup(env, decl) {
    for (let e = env; e; e = e.parent) if (e.bindings.has(decl)) return e.bindings.get(decl);
    return undefined;
  }

  isExternal(decl) {
    return this.b.isExternalNode(decl);
  }

  typeObject(t, env, kind = 'tobj', info = {}) {
    const key = `${this.b.astId(t)}|${env.id}|${kind}`;
    const existing = this.objects.get(key);
    if (existing !== undefined) return { o: existing, created: false };
    const o = this.g.object(kind, { typeNode: t, ...info }, env.widened);
    this.objects.set(key, o);
    return { o, created: true };
  }

  /** Graph node for the values a type expression can denote under env. */
  value(t, env = this.ROOT) {
    if (!t) return this.g.EMPTY;
    const key = `${this.b.astId(t)}|${env.id}`;
    let n = this.memo.get(key);
    if (n !== undefined) return n;
    n = this.g.node();
    this.memo.set(key, n); // placeholder: recursive references become back-edges
    this.evalInto(t, env, n);
    return n;
  }

  evalInto(t, env, n) {
    const ts = this.ts;
    const g = this.g;
    const K = ts.SyntaxKind;
    switch (t.kind) {
      case K.AnyKeyword: case K.UnknownKeyword: case K.StringKeyword: case K.NumberKeyword:
      case K.BooleanKeyword: case K.BigIntKeyword: case K.SymbolKeyword: case K.VoidKeyword:
      case K.UndefinedKeyword: case K.NeverKeyword: case K.ObjectKeyword: case K.IntrinsicKeyword:
      case K.ThisType: case K.LiteralType: case K.TemplateLiteralType: case K.TypePredicate:
        return;
      case K.ParenthesizedType: case K.OptionalType: case K.RestType:
        g.edge(this.value(t.type, env), n);
        return;
      case K.NamedTupleMember:
        g.edge(this.value(t.type, env), n);
        return;
      case K.TypeOperator:
        if (t.operator === K.ReadonlyKeyword) g.edge(this.value(t.type, env), n);
        return; // keyof / unique symbol denote keys, which are source-free
      case K.UnionType: case K.IntersectionType:
        for (const member of t.types) {
          if (this.b.mutation?.name === 'drop-union-member' && member === t.types[t.types.length - 1]) continue;
          g.edge(this.value(member, env), n);
        }
        return;
      case K.ArrayType: {
        const { o, created } = this.typeObject(t, env, 'lib', { array: true });
        if (created) g.edge(this.value(t.elementType, env), g.field(o, WILDCARD));
        g.addObj(n, o);
        return;
      }
      case K.TupleType: {
        const { o, created } = this.typeObject(t, env, 'lib', { array: true });
        if (created) {
          const slot = g.field(o, WILDCARD);
          for (const element of t.elements) {
            const inner = ts.isNamedTupleMember(element) ? element : element;
            const isRest = ts.isRestTypeNode(inner) || (ts.isNamedTupleMember(inner) && inner.dotDotDotToken);
            if (isRest) g.edge(this.b.loadAll(this.value(inner.type, env)), slot);
            else g.edge(this.value(inner, env), slot);
          }
        }
        g.addObj(n, o);
        return;
      }
      case K.TypeLiteral: {
        const { o, created } = this.typeObject(t, env);
        if (created) this.members(o, t.members, env);
        g.addObj(n, o);
        return;
      }
      case K.FunctionType: case K.ConstructorType:
        g.addObj(n, this.functionType(t, env));
        return;
      case K.MappedType:
        this.mapped(t, env, n);
        return;
      case K.IndexedAccessType:
        this.indexed(t, env, n);
        return;
      case K.ConditionalType:
        this.conditional(t, env, n);
        return;
      case K.TypeQuery:
        g.edge(this.typeQuery(t.exprName), n);
        return;
      case K.ImportType:
        this.importType(t, env, n);
        return;
      case K.TypeReference: case K.ExpressionWithTypeArguments:
        this.reference(t, env, n);
        return;
      case K.InferType:
        g.addUnknown(n, REASONS['unsupported-infer']);
        return;
      default:
        g.addUnknown(n, REASONS['unsupported-type']);
    }
  }

  /** Members of a type literal / interface / class-like type into object o. */
  members(o, members, env) {
    const ts = this.ts;
    const g = this.g;
    for (const m of members) {
      if (ts.isIndexSignatureDeclaration(m)) {
        g.edge(this.value(m.type, env), g.field(o, WILDCARD));
        continue;
      }
      if (ts.isCallSignatureDeclaration(m)) {
        const info = g.objInfo[o];
        info.callResult ??= g.node();
        g.edge(this.value(m.type, env), info.callResult);
        continue;
      }
      if (ts.isConstructSignatureDeclaration(m)) {
        const info = g.objInfo[o];
        info.newResult ??= g.node();
        g.edge(this.value(m.type, env), info.newResult);
        continue;
      }
      const key = this.memberKey(m.name);
      const slot = g.field(o, key ?? WILDCARD);
      if (ts.isPropertySignature(m) || ts.isGetAccessorDeclaration(m) || ts.isPropertyDeclaration(m)) {
        g.edge(this.value(m.type, env), slot);
      } else if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
        g.addObj(slot, this.functionType(m, env));
      }
    }
  }

  memberKey(name) {
    const ts = this.ts;
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return normalizeKey(name.text);
    if (ts.isComputedPropertyName(name)) return this.b.constantKey(name.expression);
    return undefined;
  }

  functionType(t, env) {
    const { o, created } = this.typeObject(t, env, 'fntype');
    if (created) {
      const info = this.g.objInfo[o];
      info.result = this.value(t.type, env);
      info.paramTypes = t.parameters.map((p) => ({ typeNode: p.type, env }));
    }
    return o;
  }

  typeQuery(name) {
    const ts = this.ts;
    if (ts.isIdentifier(name)) return this.b.valueOfSymbol(this.checker.getSymbolAtLocation(name), name);
    if (ts.isQualifiedName(name)) return this.b.load(this.typeQuery(name.left), name.right.text);
    const n = this.g.node();
    this.g.addUnknown(n, REASONS['unsupported-type']);
    return n;
  }

  moduleOfImportType(t) {
    const ts = this.ts;
    const arg = t.argument;
    if (!ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return undefined;
    return this.b.resolveModuleSymbol(arg.literal.text, t.getSourceFile());
  }

  importType(t, env, n) {
    const g = this.g;
    const moduleSymbol = this.moduleOfImportType(t);
    if (moduleSymbol === undefined) { g.addUnknown(n, REASONS['unresolved-module']); return; }
    if (moduleSymbol === null) return; // external module: closed-world data
    if (t.isTypeOf) {
      let node = this.b.namespaceNode(moduleSymbol);
      for (const part of this.qualifierParts(t.qualifier)) node = this.b.load(node, part);
      g.edge(node, n);
      return;
    }
    let symbol = moduleSymbol;
    for (const part of this.qualifierParts(t.qualifier)) {
      symbol = this.checker.getExportsOfModule(symbol).find((s) => s.name === part);
      if (!symbol) { g.addUnknown(n, REASONS['unresolved-type']); return; }
    }
    this.referenceSymbol(this.b.resolve(symbol), t.typeArguments ?? [], env, n, t);
  }

  qualifierParts(q) {
    const ts = this.ts;
    if (!q) return [];
    if (ts.isIdentifier(q)) return [q.text];
    return [...this.qualifierParts(q.left), q.right.text];
  }

  reference(t, env, n) {
    const ts = this.ts;
    const nameNode = ts.isTypeReferenceNode(t) ? t.typeName : t.expression;
    const raw = this.checker.getSymbolAtLocation(ts.isQualifiedName(nameNode) ? nameNode.right : nameNode)
      ?? this.checker.getSymbolAtLocation(nameNode);
    const symbol = this.b.resolve(raw);
    if (!symbol) { this.g.addUnknown(n, REASONS['unresolved-type']); return; }
    this.referenceSymbol(symbol, t.typeArguments ?? [], env, n, t);
  }

  referenceSymbol(symbol, args, env, n, ref) {
    const ts = this.ts;
    const g = this.g;
    const F = ts.SymbolFlags;
    if (symbol.flags & F.TypeParameter) {
      const binding = this.lookup(env, symbol.declarations?.[0]);
      if (binding) g.edge(binding.node, n);
      return; // unbound type parameters take their values from value flow
    }
    const decls = symbol.declarations ?? [];
    if (decls.length && decls.every((d) => this.isExternal(d))) {
      this.builtin(symbol.name, args, env, n, ref);
      return;
    }
    if (symbol.flags & F.TypeAlias) {
      const decl = decls.find((d) => ts.isTypeAliasDeclaration(d));
      if (!decl) { g.addUnknown(n, REASONS['unresolved-type']); return; }
      const inner = this.instantiate(decl, [decl], args, env);
      g.edge(this.value(decl.type, inner), n);
      return;
    }
    if (symbol.flags & F.Class) {
      const decl = decls.find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
      if (decl) { g.addObj(n, this.b.instanceObject(decl)); return; }
    }
    if (symbol.flags & F.Interface) {
      const interfaces = decls.filter((d) => ts.isInterfaceDeclaration(d) && !this.isExternal(d));
      const inner = this.instantiate(interfaces[0], interfaces, args, env);
      g.addObj(n, this.interfaceObject(symbol, interfaces, inner));
      return;
    }
    if (symbol.flags & (F.Enum | F.EnumMember)) return;
    if (symbol.flags & F.Module) return; // namespace used as a qualifier only
    g.addUnknown(n, REASONS['unsupported-type']);
  }

  interfaceObject(symbol, decls, env) {
    const g = this.g;
    const key = `iface|${this.b.symbolId(symbol)}|${env.id}`;
    let o = this.objects.get(key);
    if (o !== undefined) return o;
    o = g.object('tobj', { interface: symbol.name }, env.widened);
    this.objects.set(key, o);
    for (const d of decls) {
      this.members(o, d.members, env);
      for (const clause of d.heritageClauses ?? []) {
        for (const base of clause.types) this.copyFieldsInto(this.value(base, env), o);
      }
    }
    return o;
  }

  copyFieldsInto(src, dst, exclude) {
    const g = this.g;
    g.on(src, {
      obj: (o) => {
        if (g.objKind[o] === 'term') return;
        g.watchFields(o, (k, f) => { if (!exclude?.has(k)) g.edge(f, g.field(dst, k)); });
      },
      unknown: (m) => g.addUnknown(g.field(dst, WILDCARD), m),
    });
  }

  /**
   * Binds a declaration's formal parameters. Exact environments are interned
   * by (argument syntax, caller environment); beyond the per-declaration limit
   * or nesting depth, all further substitutions join one summary environment.
   */
  instantiate(decl, decls, args, callerEnv) {
    const params = decl?.typeParameters ?? [];
    if (!decl || params.length === 0) return this.ROOT;
    const b = this.b;
    const key = `${b.astId(decl)}|${params.map((p, i) => (args[i] ? `${b.astId(args[i])}@${callerEnv.id}` : 'default')).join(',')}`;
    const existing = this.instances.get(key);
    if (existing) return existing;
    const count = this.declCount.get(decl) ?? 0;
    const depth = callerEnv.depth + 1;
    const limits = b.limits;
    const allParams = (i) => decls.map((d) => d.typeParameters?.[i]).filter(Boolean);
    if (count < limits.environments && depth <= limits.depth) {
      this.declCount.set(decl, count + 1);
      this.stats.exactEnvironments++;
      const env = this.newEnv(this.ROOT, depth, false);
      this.instances.set(key, env);
      params.forEach((p, i) => {
        const arg = args[i] ?? p.default;
        const argEnv = args[i] ? callerEnv : env;
        const binding = arg
          ? { node: this.value(arg, argEnv), sketch: this.sketch(arg, argEnv), keySrc: { typeNode: arg, env: argEnv } }
          : { node: this.g.EMPTY, sketch: OTHER, keySrc: null };
        for (const tp of allParams(i)) env.bindings.set(tp, binding);
      });
      return env;
    }
    let summary = this.summaries.get(decl);
    if (!summary) {
      summary = this.newEnv(this.ROOT, 0, true);
      this.stats.summaryEnvironments++;
      params.forEach((p, i) => {
        const binding = { node: this.g.node(), sketch: WIDENED, keySrc: null };
        for (const tp of allParams(i)) summary.bindings.set(tp, binding);
      });
      this.summaries.set(decl, summary);
    }
    this.instances.set(key, summary);
    if (b.mutation?.name !== 'drop-generic-substitution') {
      params.forEach((p, i) => {
        const arg = args[i] ?? p.default;
        if (!arg) return;
        this.stats.widenedJoins++;
        this.g.edge(this.value(arg, args[i] ? callerEnv : summary), summary.bindings.get(p).node);
      });
    }
    return summary;
  }

  builtin(name, args, env, n, ref) {
    const g = this.g;
    const arg = (i) => this.value(args[i], env);
    const blob = (sources, array = false) => {
      const { o, created } = this.typeObject(ref, env, 'lib', { builtin: name, array });
      if (created) for (const s of sources) g.edge(s, g.field(o, WILDCARD));
      g.addObj(n, o);
    };
    switch (name) {
      case 'Promise': case 'PromiseLike': case 'Awaited': case 'NonNullable': case 'Partial': case 'Required':
      case 'Readonly': case 'NoInfer': case 'Exclude': case 'Extract':
        if (args[0]) g.edge(arg(0), n);
        return;
      case 'Pick': case 'Omit': this.pick(name === 'Omit', args, env, n, ref); return;
      case 'Record': {
        const { o, created } = this.typeObject(ref, env, 'tobj', { builtin: 'Record' });
        if (created) {
          const keys = this.keyEval(args[0], env);
          const value = arg(1);
          if (keys.any) g.edge(value, g.field(o, WILDCARD));
          else for (const k of keys.keys) g.edge(value, g.field(o, k));
        }
        g.addObj(n, o);
        return;
      }
      case 'ReturnType': this.callResults(arg(0), n, 'callResult'); return;
      case 'InstanceType': this.callResults(arg(0), n, 'newResult'); return;
      case 'Parameters': case 'ConstructorParameters': {
        const { o, created } = this.typeObject(ref, env, 'lib', { builtin: name, array: true });
        if (created) {
          const slot = g.field(o, WILDCARD);
          g.on(arg(0), { obj: (f) => { for (const p of this.b.parameterTypes(f)) g.edge(this.value(p.typeNode, p.env), slot); } });
        }
        g.addObj(n, o);
        return;
      }
      case 'Uppercase': case 'Lowercase': case 'Capitalize': case 'Uncapitalize': case 'ThisType':
        return;
      case 'Array': case 'ReadonlyArray': case 'ConcatArray':
        if (args.length) blob([arg(0)], true);
        return;
      default:
        if (args.length) blob(args.map((_, i) => arg(i)));
    }
  }

  callResults(src, n, which) {
    const g = this.g;
    g.on(src, {
      obj: (o) => { const r = this.b.resultOf(o, which); if (r !== undefined) g.edge(r, n); },
      unknown: (m) => g.addUnknown(n, m),
    });
  }

  pick(omit, args, env, n, ref) {
    const g = this.g;
    const { o, created } = this.typeObject(ref, env, 'tobj', { builtin: omit ? 'Omit' : 'Pick' });
    g.addObj(n, o);
    if (!created) return;
    const src = this.value(args[0], env);
    const keys = this.keyEval(args[1], env);
    if (omit) {
      if (!keys.any) this.copyFieldsInto(src, o, keys.keys);
      return;
    }
    if (keys.any) { this.copyFieldsInto(src, o); return; }
    for (const k of keys.keys) g.edge(this.b.load(src, k), g.field(o, k));
  }

  mapped(t, env, n) {
    const ts = this.ts;
    const g = this.g;
    const { o, created } = this.typeObject(t, env);
    g.addObj(n, o);
    if (!created) return;
    const param = t.typeParameter;
    const constraint = param.constraint;
    let count = 0;
    let overflowed = false;
    const handle = (key) => {
      if (key !== WILDCARD && ++count > this.b.limits.keys) {
        if (overflowed) return;
        overflowed = true;
        this.stats.keyOverflows++;
        key = WILDCARD;
      }
      const envK = this.mappedEnv(t, env, param, key);
      const out = t.nameType ? this.keyEval(t.nameType, envK) : key === WILDCARD ? ANY_KEYS : keysOf([key]);
      if (this.b.mutation?.name === 'drop-mapped-value') return;
      const value = t.type ? this.value(t.type, envK) : g.EMPTY;
      if (out.any) g.edge(value, g.field(o, WILDCARD));
      else for (const k of out.keys) g.edge(value, g.field(o, k));
    };
    if (constraint && ts.isTypeOperatorNode(constraint) && constraint.operator === ts.SyntaxKind.KeyOfKeyword) {
      const src = this.value(constraint.type, env);
      const seen = new Set();
      g.on(src, {
        obj: (s) => g.watchFields(s, (k) => {
          if (k.startsWith('$') || seen.has(k)) return;
          seen.add(k);
          handle(k);
        }),
        unknown: (m) => g.addUnknown(g.field(o, WILDCARD), m),
      });
      return;
    }
    const keys = constraint ? this.keyEval(constraint, env) : ANY_KEYS;
    if (keys.any) handle(WILDCARD);
    else for (const k of [...keys.keys].sort()) handle(k);
  }

  mappedEnv(t, env, param, key) {
    const id = `${this.b.astId(t)}|${env.id}|${key}`;
    let e = this.mappedEnvs.get(id);
    if (!e) {
      e = this.newEnv(env, env.depth, env.widened);
      e.bindings.set(param, {
        node: this.g.EMPTY,
        sketch: key === WILDCARD ? { kind: 'prim', name: 'string' } : { kind: 'lit', value: `s:${key}` },
        keySrc: null,
        keyLiteral: key,
      });
      this.mappedEnvs.set(id, e);
    }
    return e;
  }

  indexed(t, env, n) {
    const g = this.g;
    const src = this.value(t.objectType, env);
    const keys = this.keyEval(t.indexType, env);
    if (keys.any) { g.edge(this.b.loadAll(src), n); return; }
    for (const k of keys.keys) if (k !== 'length') g.edge(this.b.load(src, k), n);
  }

  conditional(t, env, n) {
    const ts = this.ts;
    const g = this.g;
    let hasInfer = false;
    const scan = (node) => { if (ts.isInferTypeNode(node)) hasInfer = true; else ts.forEachChild(node, scan); };
    scan(t.extendsType);
    if (hasInfer) {
      g.addUnknown(n, REASONS['unsupported-infer']);
      g.edge(this.value(t.trueType, env), n);
      g.edge(this.value(t.falseType, env), n);
      return;
    }
    const decision = this.decide(t.checkType, t.extendsType, env);
    if (decision !== false) g.edge(this.value(t.trueType, env), n);
    if (decision !== true) g.edge(this.value(t.falseType, env), n);
  }

  decide(check, ext, env) {
    const a = this.sketch(check, env);
    const b = this.sketch(ext, env);
    if (a.kind === 'widened' || b.kind === 'widened') return undefined;
    if (b.kind === 'any') return true;
    if (a.kind === 'lit' && b.kind === 'lit') return a.value === b.value;
    if (a.kind === 'lit' && b.kind === 'prim') return a.value.startsWith(`${b.name[0]}:`) ? true : undefined;
    if (a.kind === 'prim' && b.kind === 'prim' && a.name === b.name) return true;
    return undefined;
  }

  /** Finite structural sketch used only to decide conditional predicates exactly. */
  sketch(t, env) {
    const ts = this.ts;
    const K = ts.SyntaxKind;
    if (!t) return OTHER;
    switch (t.kind) {
      case K.LiteralType: {
        const lit = t.literal;
        if (ts.isStringLiteral(lit)) return { kind: 'lit', value: `s:${lit.text}` };
        if (ts.isNumericLiteral(lit)) return { kind: 'lit', value: `n:${Number(lit.text)}` };
        if (lit.kind === K.TrueKeyword) return { kind: 'lit', value: 'b:true' };
        if (lit.kind === K.FalseKeyword) return { kind: 'lit', value: 'b:false' };
        if (lit.kind === K.NullKeyword) return { kind: 'lit', value: 'null' };
        return OTHER;
      }
      case K.StringKeyword: return { kind: 'prim', name: 'string' };
      case K.NumberKeyword: return { kind: 'prim', name: 'number' };
      case K.BooleanKeyword: return { kind: 'prim', name: 'boolean' };
      case K.AnyKeyword: case K.UnknownKeyword: return { kind: 'any' };
      case K.ParenthesizedType: return this.sketch(t.type, env);
      case K.TupleType: {
        let length = 0;
        for (const element of t.elements) {
          if (ts.isRestTypeNode(element) || (ts.isNamedTupleMember(element) && element.dotDotDotToken)) {
            const inner = this.sketch(element.type, env);
            if (inner.kind === 'widened') return WIDENED;
            if (inner.kind !== 'tuple') return OTHER;
            length += inner.length;
          } else if (ts.isOptionalTypeNode(element) || (ts.isNamedTupleMember(element) && element.questionToken)) {
            return OTHER;
          } else length++;
        }
        return { kind: 'tuple', length };
      }
      case K.IndexedAccessType: {
        const keys = this.keyEval(t.indexType, env);
        if (!keys.any && keys.keys.size === 1 && keys.keys.has('length')) {
          const obj = this.sketch(t.objectType, env);
          if (obj.kind === 'widened') return WIDENED;
          if (obj.kind === 'tuple') return { kind: 'lit', value: `n:${obj.length}` };
        }
        return OTHER;
      }
      case K.TypeReference: {
        const symbol = this.b.resolve(this.checker.getSymbolAtLocation(t.typeName));
        if (!symbol) return OTHER;
        if (symbol.flags & ts.SymbolFlags.TypeParameter) return this.lookup(env, symbol.declarations?.[0])?.sketch ?? OTHER;
        const alias = symbol.declarations?.find((d) => ts.isTypeAliasDeclaration(d));
        if (alias && !this.isExternal(alias)) return this.sketch(alias.type, this.instantiate(alias, [alias], t.typeArguments ?? [], env));
        return OTHER;
      }
      default:
        return OTHER;
    }
  }

  /** Finite key domain of a key-position type, or ANY. */
  keyEval(t, env) {
    const ts = this.ts;
    const K = ts.SyntaxKind;
    const limit = this.b.limits.keys;
    const bounded = (set) => (set.size > limit ? (this.stats.keyOverflows++, ANY_KEYS) : { any: false, keys: set });
    if (!t) return ANY_KEYS;
    switch (t.kind) {
      case K.LiteralType: {
        const lit = t.literal;
        if (ts.isStringLiteral(lit)) return keysOf([lit.text]);
        if (ts.isNumericLiteral(lit)) return keysOf([normalizeKey(lit.text)]);
        return keysOf([]);
      }
      case K.NeverKeyword: return keysOf([]);
      case K.ParenthesizedType: return this.keyEval(t.type, env);
      case K.UnionType: {
        const out = new Set();
        for (const member of t.types) {
          const r = this.keyEval(member, env);
          if (r.any) return ANY_KEYS;
          for (const k of r.keys) out.add(k);
        }
        return bounded(out);
      }
      case K.TemplateLiteralType: {
        let acc = new Set([t.head.text]);
        for (const span of t.templateSpans) {
          const r = this.keyEval(span.type, env);
          if (r.any) return ANY_KEYS;
          const next = new Set();
          for (const prefix of acc) for (const k of r.keys) next.add(`${prefix}${k}${span.literal.text}`);
          if (next.size > limit) { this.stats.keyOverflows++; return ANY_KEYS; }
          acc = next;
        }
        return { any: false, keys: acc };
      }
      case K.ConditionalType: {
        const decision = this.decide(t.checkType, t.extendsType, env);
        const parts = [];
        if (decision !== false) parts.push(this.keyEval(t.trueType, env));
        if (decision !== true) parts.push(this.keyEval(t.falseType, env));
        if (parts.some((p) => p.any)) return ANY_KEYS;
        return bounded(new Set(parts.flatMap((p) => [...p.keys])));
      }
      case K.TypeReference: {
        const symbol = this.b.resolve(this.checker.getSymbolAtLocation(t.typeName));
        if (!symbol) return ANY_KEYS;
        if (symbol.flags & ts.SymbolFlags.TypeParameter) {
          const binding = this.lookup(env, symbol.declarations?.[0]);
          if (!binding) return ANY_KEYS;
          if (binding.keyLiteral !== undefined) return binding.keyLiteral === WILDCARD ? ANY_KEYS : keysOf([binding.keyLiteral]);
          return binding.keySrc ? this.keyEval(binding.keySrc.typeNode, binding.keySrc.env) : ANY_KEYS;
        }
        const decls = symbol.declarations ?? [];
        const alias = decls.find((d) => ts.isTypeAliasDeclaration(d));
        if (alias && !this.isExternal(alias)) return this.keyEval(alias.type, this.instantiate(alias, [alias], t.typeArguments ?? [], env));
        const args = t.typeArguments ?? [];
        const transform = { Uppercase: (s) => s.toUpperCase(), Lowercase: (s) => s.toLowerCase(),
          Capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1), Uncapitalize: (s) => s.charAt(0).toLowerCase() + s.slice(1) }[symbol.name];
        if (transform && decls.every((d) => this.isExternal(d))) {
          const r = this.keyEval(args[0], env);
          return r.any ? ANY_KEYS : keysOf([...r.keys].map(transform));
        }
        if ((symbol.name === 'Exclude' || symbol.name === 'Extract') && decls.every((d) => this.isExternal(d))) {
          const a = this.keyEval(args[0], env);
          const b = this.keyEval(args[1], env);
          if (a.any) return ANY_KEYS;
          if (b.any) return symbol.name === 'Exclude' ? a : a;
          return keysOf([...a.keys].filter((k) => (symbol.name === 'Exclude' ? !b.keys.has(k) : b.keys.has(k))));
        }
        if (symbol.name === 'NonNullable' && decls.every((d) => this.isExternal(d))) return this.keyEval(args[0], env);
        return ANY_KEYS;
      }
      default:
        return ANY_KEYS;
    }
  }
}
