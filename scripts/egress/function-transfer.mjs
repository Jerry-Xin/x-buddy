// SPDX-License-Identifier: Apache-2.0
/**
 * Function, class and call transfers.
 *
 * Context-insensitive: every call site joins its arguments into the callee's
 * parameters and the callee's returns into the call result. A callable's own
 * identity, its parameters and its result are separate roles, so a parameter
 * typed with a boundary namespace does not taint the function value itself.
 * Library code is not interpreted: a library call joins its receiver and
 * arguments into its result and into any callback it receives.
 */
import { REASONS, WILDCARD } from './graph.mjs';

export function fnObject(b, decl) {
  const known = b.fnInfos.get(decl);
  if (known) return known.obj;
  const ts = b.ctx.ts;
  const g = b.g;
  const info = {
    decl,
    params: [],
    rest: -1,
    thisNode: g.node(),
    returnNode: g.node(),
    isArrow: ts.isArrowFunction(decl),
    lexicalThis: b.frame?.thisNode ?? g.EMPTY,
    patterns: [],
  };
  info.obj = g.object('fn', info);
  b.fnInfos.set(decl, info);
  decl.parameters.forEach((p, i) => {
    if (p.dotDotDotToken) info.rest = i;
    let node;
    if (ts.isIdentifier(p.name)) node = b.storage(b.ctx.checker.getSymbolAtLocation(p.name));
    else { node = g.node(); info.patterns.push([p.name, node]); }
    info.params.push(node);
  });
  if (!decl.body) {
    // Ambient or overload-only declaration: declared result provenance.
    g.edge(b.types.value(decl.type), info.returnNode);
    decl.parameters.forEach((p, i) => g.edge(b.types.value(p.type), info.params[i]));
  } else {
    b.pending.push({ kind: 'function', decl, info });
  }
  return info.obj;
}

export function processFunction(b, { decl, info }) {
  const ts = b.ctx.ts;
  const g = b.g;
  b.withFrame(decl.getSourceFile(), { thisNode: info.isArrow ? info.lexicalThis : info.thisNode, returnNode: info.returnNode, fn: info }, () => {
    decl.parameters.forEach((p, i) => {
      if (p.type) g.edge(b.types.value(p.type), info.params[i]);
      if (p.initializer) g.edge(b.expr(p.initializer), info.params[i]);
    });
    for (const [pattern, node] of info.patterns) b.destructure(pattern, node);
    if (ts.isBlock(decl.body)) b.statements(decl.body.statements);
    else {
      const value = b.expr(decl.body);
      g.edge(value, info.returnNode);
      b.escape(decl.body, value, decl);
    }
  });
}

export function classRoot(b, decl) {
  if (b.classRoots.has(decl)) return b.classRoots.get(decl);
  b.classRoots.set(decl, decl);
  const base = baseClass(b, decl);
  const root = base ? classRoot(b, base) : decl;
  b.classRoots.set(decl, root);
  return root;
}

export function baseClass(b, decl) {
  const ts = b.ctx.ts;
  const clause = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
  const expr = clause?.types[0]?.expression;
  if (!expr) return undefined;
  const symbol = b.resolve(b.ctx.checker.getSymbolAtLocation(expr));
  const target = symbol?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d));
  return target && !b.isExternalNode(target) ? target : undefined;
}

export function instanceObject(b, decl) {
  const root = classRoot(b, decl);
  let o = b.instances.get(root);
  if (o === undefined) {
    o = b.g.object('inst', { decl: root });
    b.instances.set(root, o);
    classObject(b, root);
  }
  return o;
}

export function classObject(b, decl) {
  const known = b.classInfos.get(decl);
  if (known) return known.obj;
  const ts = b.ctx.ts;
  const g = b.g;
  const info = { decl, ctor: undefined };
  info.obj = g.object('class', info);
  b.classInfos.set(decl, info);
  const inst = instanceObject(b, decl);
  info.inst = inst;
  const thisInst = g.node();
  g.addObj(thisInst, inst);
  const thisStatic = g.node();
  g.addObj(thisStatic, info.obj);
  info.thisInst = thisInst;
  const isStatic = (m) => ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static;
  const base = baseClass(b, decl);
  if (base) classObject(b, base);
  for (const m of decl.members) {
    const owner = isStatic(m) ? info.obj : inst;
    const ownerThis = isStatic(m) ? thisStatic : thisInst;
    const key = m.name ? b.types.memberKey(m.name) ?? WILDCARD : undefined;
    if (ts.isConstructorDeclaration(m)) {
      if (!m.body) continue;
      fnObject(b, m);
      const ctor = b.fnInfos.get(m);
      info.ctor = ctor;
      g.edge(thisInst, ctor.thisNode);
      m.parameters.forEach((p, i) => {
        if (ts.isParameterPropertyDeclaration(p, m) && ts.isIdentifier(p.name)) g.edge(ctor.params[i], g.field(inst, p.name.text));
      });
    } else if (ts.isMethodDeclaration(m)) {
      if (!m.body && decl.members.some((other) => other !== m && ts.isMethodDeclaration(other) && other.body && b.types.memberKey(other.name) === key)) continue;
      const fn = fnObject(b, m);
      g.edge(ownerThis, b.fnInfos.get(m).thisNode);
      g.addObj(g.field(owner, key), fn);
    } else if (ts.isGetAccessorDeclaration(m)) {
      fnObject(b, m);
      const getter = b.fnInfos.get(m);
      g.edge(ownerThis, getter.thisNode);
      g.edge(getter.returnNode, g.field(owner, key));
    } else if (ts.isSetAccessorDeclaration(m)) {
      fnObject(b, m);
      const setter = b.fnInfos.get(m);
      g.edge(ownerThis, setter.thisNode);
      if (setter.params[0] !== undefined) g.edge(g.field(owner, key), setter.params[0]);
    } else if (ts.isPropertyDeclaration(m)) {
      const slot = g.field(owner, key);
      if (m.type) g.edge(b.types.value(m.type), slot);
      if (m.initializer) b.pending.push({ kind: 'initializer', sf: decl.getSourceFile(), thisNode: ownerThis, expr: m.initializer, slot });
    } else if (ts.isClassStaticBlockDeclaration(m)) {
      b.pending.push({ kind: 'block', sf: decl.getSourceFile(), thisNode: thisStatic, block: m.body });
    }
  }
  return info.obj;
}

function constructorOf(b, decl) {
  for (let d = decl; d; d = baseClass(b, d)) {
    classObject(b, d);
    const ctor = b.classInfos.get(d).ctor;
    if (ctor) return ctor;
  }
  return undefined;
}

/** Wires one call site into one known function body (once per pair). */
export function wireCall(b, info, site) {
  const key = `${site.id}|${info.obj}`;
  if (b.wired.has(key)) return;
  b.wired.add(key);
  b.onWire?.(site, info);
  const g = b.g;
  let index = 0;
  let restArray;
  const restSlot = () => {
    if (!restArray) {
      restArray = g.object('obj', { array: true, rest: true });
      g.addObj(info.params[info.rest], restArray);
    }
    return g.field(restArray, WILDCARD);
  };
  for (const arg of site.args) {
    if (arg.spread) {
      for (let k = index; k < info.params.length; k++) g.edge(arg.node, k === info.rest ? restSlot() : info.params[k]);
      if (info.rest >= 0 && info.rest < index) g.edge(arg.node, restSlot());
      continue;
    }
    if (index === info.rest) { g.edge(arg.node, restSlot()); continue; }
    if (index < info.params.length) g.edge(arg.node, info.params[index]);
    index++;
  }
  if (info.rest >= 0) restSlot();
  if (site.receiver !== undefined && !info.isArrow) g.edge(site.receiver, info.thisNode);
  if (b.mutation?.name !== 'drop-call-return') g.edge(info.returnNode, site.result);
}

/** Implementation function of a terminal, when it is function-like. */
export function terminalImplementation(b, terminal) {
  const ts = b.ctx.ts;
  for (const symbol of terminal.symbols) {
    for (const d of symbol.declarations ?? []) {
      if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body) return d;
      if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
    }
  }
  for (const symbol of terminal.symbols) {
    const d = (symbol.declarations ?? []).find((x) => ts.isFunctionDeclaration(x));
    if (d) return d;
  }
  return undefined;
}

/** Dynamic dispatch on every object that reaches a call's callee. */
export function installCall(b, site) {
  const g = b.g;
  g.on(site.callee, {
    obj: (o) => {
      const kind = g.objKind[o];
      const info = g.objInfo[o];
      if (site.isNew) {
        if (kind === 'class') {
          g.addObj(site.result, info.inst);
          const ctor = constructorOf(b, info.decl);
          if (ctor) wireCall(b, ctor, { ...site, receiver: undefined, id: `${site.id}:ctor` });
        } else if (kind === 'tobj' && info.newResult !== undefined) g.edge(info.newResult, site.result);
        else if (kind === 'fntype') g.edge(info.result, site.result);
        else if (kind === 'term') terminalCall(b, info.terminal, site);
        return;
      }
      if (kind === 'fn') wireCall(b, info, site);
      else if (kind === 'term') terminalCall(b, info.terminal, site);
      else if (kind === 'fntype') g.edge(info.result, site.result);
      else if (kind === 'tobj' && info.callResult !== undefined) g.edge(info.callResult, site.result);
      else if (kind === 'lib') g.addObj(site.result, o);
    },
    unknown: (m) => g.addUnknown(site.result, m),
  });
}

function terminalCall(b, terminal, site) {
  const impl = terminalImplementation(b, terminal);
  if (!impl) { b.g.addUnknown(site.result, REASONS['opaque-terminal-call']); return; }
  fnObject(b, impl);
  wireCall(b, b.fnInfos.get(impl), site);
}

/** Slots holding values a library container received: data, and stored functions. */
export const LIBRARY_SLOT = '#lib';
export const LIBRARY_FUNCTION_SLOT = '#libfn';

/** Stores a library argument: functions are kept apart so callbacks never receive them. */
export function storeLibraryArgument(b, container, slotKey, argNode) {
  const g = b.g;
  const data = g.field(container, slotKey);
  const functions = slotKey === LIBRARY_SLOT ? g.field(container, LIBRARY_FUNCTION_SLOT) : data;
  g.on(argNode, {
    obj: (o) => g.addObj(g.objKind[o] === 'fn' ? functions : data, o),
    unknown: (m) => g.addUnknown(data, m),
  });
}
const CALLABLE = new Set(['fn', 'fntype', 'class', 'term']);

/**
 * Reviewed built-in summary for calls into code outside the source closure.
 * Method calls store their arguments in the receiver (element slot or library
 * slot); static library functions read their data arguments. The declared
 * result type decides the level of the result: primitive data carries no
 * object, a container type yields a fresh per-site container whose elements
 * are the contents, anything else yields the contents themselves. Callbacks
 * see the receiver and its contents. Guarded arguments are escapes and are
 * denied by policy; this summary keeps returned values tracked.
 */
export function libraryCall(b, site) {
  const g = b.g;
  // Members of library globals (Promise.resolve, Object.assign, JSON.parse) are static functions.
  const receiver = site.receiver === g.EMPTY ? undefined : site.receiver;
  const shape = site.node !== undefined ? b.resultShape(site.node) : 'value';
  const contents = g.node();
  if (receiver !== undefined) {
    if (shape !== 'data' && b.returnsReceiver(site.node)) g.edge(receiver, site.result);
    g.edge(b.libraryContents(receiver), contents);
    g.on(receiver, {
      obj: (o) => {
        const kind = g.objKind[o];
        if (CALLABLE.has(kind)) return;
        const slotKey = (kind === 'obj' || kind === 'lib') && g.objInfo[o].array ? WILDCARD : LIBRARY_SLOT;
        for (const a of site.args) storeLibraryArgument(b, o, slotKey, a.node);
      },
      unknown: (m) => g.addUnknown(site.result, m),
    });
  } else {
    for (const a of site.args) {
      g.on(a.node, {
        obj: (o) => { if (!CALLABLE.has(g.objKind[o]) || g.objKind[o] === 'term') g.addObj(contents, o); },
        unknown: (m) => g.addUnknown(site.result, m),
      });
      g.edge(b.loadAll(a.node), contents);
    }
  }
  if (shape === 'value') g.edge(contents, site.result);
  else if (shape === 'container') {
    const container = g.object('lib', { site: `${site.id}`, array: true, container: true });
    g.edge(contents, g.field(container, WILDCARD));
    g.addObj(site.result, container);
  }
  site.args.forEach((arg, position) => {
    g.on(arg.node, {
      obj: (o) => {
        if (g.objKind[o] !== 'fn') return;
        const info = g.objInfo[o];
        const key = `${site.id}|cb${position}|${o}`;
        if (b.wired.has(key)) return;
        b.wired.add(key);
        const sources = receiver !== undefined ? [receiver, b.libraryContents(receiver, true)] : [];
        site.args.forEach((other, j) => { if (j !== position) sources.push(b.loadAll(other.node, true)); });
        info.decl.parameters.forEach((p, i) => {
          if (b.primitiveOnly(p.name)) return;
          for (const src of sources) g.edge(src, info.params[i]);
        });
        g.edge(info.returnNode, contents);
      },
    });
  });
}

export function resultOf(b, o, which) {
  const g = b.g;
  const kind = g.objKind[o];
  const info = g.objInfo[o];
  if (which === 'newResult') {
    if (kind === 'class') { const n = g.node(); g.addObj(n, info.inst); return n; }
    if (kind === 'tobj') return info.newResult;
    return undefined;
  }
  if (kind === 'fn') return info.returnNode;
  if (kind === 'fntype') return info.result;
  if (kind === 'tobj') return info.callResult;
  if (kind === 'term') {
    const impl = terminalImplementation(b, info.terminal);
    if (!impl) return undefined;
    fnObject(b, impl);
    return b.fnInfos.get(impl).returnNode;
  }
  return undefined;
}

export function parameterTypes(b, o) {
  const g = b.g;
  const kind = g.objKind[o];
  const info = g.objInfo[o];
  if (kind === 'fntype') return info.paramTypes;
  if (kind === 'fn') return info.decl.parameters.map((p) => ({ typeNode: p.type, env: b.types.ROOT }));
  if (kind === 'term') {
    const impl = terminalImplementation(b, info.terminal);
    return impl ? impl.parameters.map((p) => ({ typeNode: p.type, env: b.types.ROOT })) : [];
  }
  return [];
}
