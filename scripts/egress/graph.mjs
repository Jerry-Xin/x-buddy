// SPDX-License-Identifier: Apache-2.0
/**
 * Finite provenance graph.
 *
 * Nodes hold a fact `(C,U)`: C is the set of abstract objects a value may be
 * (guarded terminals are objects of kind `term`), U is a bitmask of security
 * uncertainty reasons. Objects own property slots (`*` is the wildcard slot).
 * Constraints are inclusion edges plus monotone handlers that fire once per
 * object reaching a node. Every node, edge and transfer is charged to the
 * deterministic budget; exhaustion aborts the analysis as incomplete.
 */

export const DEFAULT_LIMITS = Object.freeze({
  nodes: 250_000,
  edges: 1_000_000,
  transfers: 10_000_000,
  keys: 512,
  environments: 16,
  depth: 64,
});

/** Finite security uncertainty categories. */
export const REASONS = Object.freeze({
  'unsupported-expression': 1 << 0,
  'unresolved-symbol': 1 << 1,
  'unresolved-module': 1 << 2,
  'unsupported-type': 1 << 3,
  'unresolved-type': 1 << 4,
  'unsupported-infer': 1 << 5,
  'arguments-object': 1 << 6,
  'opaque-terminal-call': 1 << 7,
  'unsupported-statement': 1 << 8,
  'unsupported-declaration': 1 << 9,
});
export const reasonNames = (mask) => Object.entries(REASONS).filter(([, bit]) => mask & bit).map(([name]) => name).sort();

export class BudgetExhausted extends Error {
  constructor(limit) {
    super(`analysis budget exhausted: ${limit}`);
    this.limit = limit;
  }
}

export const WILDCARD = '*';

export class Graph {
  constructor(limits) {
    this.limits = limits;
    this.pts = [];
    this.unk = [];
    this.succ = [];
    this.handlers = [];
    this.delta = [];
    this.deltaU = [];
    this.queued = [];
    this.queue = [];
    this.queueHead = 0;
    this.edgeCount = 0;
    this.transfers = 0;
    this.objKind = [];
    this.objInfo = [];
    this.objFields = [];
    this.objWatchers = [];
    this.objWidened = [];
    this.termIndex = [];
    this.EMPTY = this.node(); // shared source-free leaf; never receives facts
  }

  charge(n = 1) {
    this.transfers += n;
    if (this.transfers > this.limits.transfers) throw new BudgetExhausted('transfers');
  }

  node() {
    const id = this.pts.length;
    if (id >= this.limits.nodes) throw new BudgetExhausted('nodes');
    this.pts.push(undefined);
    this.unk.push(0);
    this.succ.push(undefined);
    this.handlers.push(undefined);
    this.delta.push(undefined);
    this.deltaU.push(0);
    this.queued.push(false);
    return id;
  }

  object(kind, info = {}, widened = false) {
    const id = this.objKind.length;
    this.objKind.push(kind);
    this.objInfo.push(info);
    this.objFields.push(undefined);
    this.objWatchers.push(undefined);
    this.objWidened.push(widened);
    this.termIndex.push(kind === 'term' ? info.terminal.index : -1);
    return id;
  }

  enqueue(n) {
    if (!this.queued[n]) {
      this.queued[n] = true;
      this.queue.push(n);
    }
  }

  addObj(n, o) {
    if (n === this.EMPTY) return;
    let set = this.pts[n];
    if (!set) set = this.pts[n] = new Set();
    if (set.has(o)) return;
    set.add(o);
    (this.delta[n] ??= []).push(o);
    this.enqueue(n);
  }

  addUnknown(n, mask) {
    if (n === this.EMPTY || !mask) return;
    const next = this.unk[n] | mask;
    if (next === this.unk[n]) return;
    this.deltaU[n] |= next & ~this.unk[n];
    this.unk[n] = next;
    this.enqueue(n);
  }

  edge(src, dst) {
    if (src === dst || src === this.EMPTY || dst === this.EMPTY) return;
    let set = this.succ[src];
    if (!set) set = this.succ[src] = new Set();
    if (set.has(dst)) return;
    if (++this.edgeCount > this.limits.edges) throw new BudgetExhausted('edges');
    set.add(dst);
    const existing = this.pts[src];
    if (existing) { this.charge(existing.size); for (const o of existing) this.addObj(dst, o); }
    if (this.unk[src]) this.addUnknown(dst, this.unk[src]);
  }

  /** handler: { obj(o), unknown?(mask) } — applied to current and future facts of n. */
  on(n, handler) {
    if (n === this.EMPTY) return;
    (this.handlers[n] ??= []).push(handler);
    if (++this.edgeCount > this.limits.edges) throw new BudgetExhausted('edges');
    const existing = this.pts[n];
    if (existing) for (const o of [...existing]) { this.charge(); handler.obj(o); }
    if (this.unk[n] && handler.unknown) handler.unknown(this.unk[n]);
  }

  fields(o) {
    return this.objFields[o];
  }

  /**
   * Whether the wildcard slot of o can be read through literal key `key`.
   * Element slots of arrays reach index keys only (named members such as
   * `map` or `length` are prototype members); library containers expose their
   * contents only through library summaries, never through member names.
   */
  wildcardReaches(o, key) {
    if (key.startsWith('#') || key.startsWith('$')) return false;
    const kind = this.objKind[o];
    const info = this.objInfo[o];
    if (info.array) return /^(0|[1-9]\d*)$/.test(key);
    return kind !== 'lib';
  }

  /** Slot of object o; a wildcard store reaches every literal slot it can denote. */
  field(o, key) {
    let map = this.objFields[o];
    if (!map) map = this.objFields[o] = new Map();
    let f = map.get(key);
    if (f !== undefined) return f;
    f = this.node();
    map.set(key, f);
    if (key === WILDCARD) {
      for (const [k, other] of map) if (k !== WILDCARD && this.wildcardReaches(o, k)) this.edge(f, other);
    } else if (map.has(WILDCARD) && this.wildcardReaches(o, key)) {
      this.edge(map.get(WILDCARD), f);
    }
    const watchers = this.objWatchers[o];
    if (watchers) for (const w of watchers.slice()) { this.charge(); w(key, f); }
    return f;
  }

  /** Calls fn(key, fieldNode) for every current and future slot of o. */
  watchFields(o, fn) {
    (this.objWatchers[o] ??= []).push(fn);
    if (++this.edgeCount > this.limits.edges) throw new BudgetExhausted('edges');
    const map = this.objFields[o];
    if (map) for (const [k, f] of [...map]) { this.charge(); fn(k, f); }
  }

  solve() {
    while (this.queueHead < this.queue.length) {
      const n = this.queue[this.queueHead++];
      if (this.queueHead > 65536) { this.queue = this.queue.slice(this.queueHead); this.queueHead = 0; }
      this.queued[n] = false;
      const d = this.delta[n];
      const du = this.deltaU[n];
      this.delta[n] = undefined;
      this.deltaU[n] = 0;
      const succ = this.succ[n];
      const handlers = this.handlers[n];
      // Handlers registered while this delta is processed already saw it on registration.
      const handlerCount = handlers ? handlers.length : 0;
      if (d) {
        if (succ) for (const dst of succ) { this.charge(d.length); for (const o of d) this.addObj(dst, o); }
        for (let i = 0; i < handlerCount; i++) for (const o of d) { this.charge(); handlers[i].obj(o); }
      }
      if (du) {
        if (succ) for (const dst of succ) { this.charge(); this.addUnknown(dst, du); }
        for (let i = 0; i < handlerCount; i++) if (handlers[i].unknown) { this.charge(); handlers[i].unknown(du); }
      }
    }
  }
}
