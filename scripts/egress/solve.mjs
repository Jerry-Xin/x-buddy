// SPDX-License-Identifier: Apache-2.0
/**
 * Fixed-point solving and closure certificates (R1.2, solver steps 1–6).
 *
 * Constraint generation and propagation alternate until no function body,
 * initializer or lazily materialized slot remains: each fact bit is added at
 * most once, so the loop terminates on the finite graph. After convergence
 * the object/slot graph is condensed into strongly connected components; an
 * SCC's aggregate envelope (MayC, OpaqueReasons) is the union of its local
 * seeds and its successor certificates. Complete holds only without opacity
 * anywhere downstream; SourceFree additionally requires an empty MayC.
 */
import { BudgetExhausted, DEFAULT_LIMITS, Graph, reasonNames } from './graph.mjs';
import { Builder } from './value-transfer.mjs';

export function resolveLimits(requested = {}) {
  const limits = { ...DEFAULT_LIMITS };
  const errors = [];
  for (const [key, value] of Object.entries(requested)) {
    if (!(key in DEFAULT_LIMITS)) errors.push(`unknown limit ${key}`);
    else if (!Number.isInteger(value) || value < 1) errors.push(`limit ${key} must be a positive integer`);
    else if (value > DEFAULT_LIMITS[key]) errors.push(`limit ${key} may not exceed the reviewed default ${DEFAULT_LIMITS[key]}`);
    else limits[key] = value;
  }
  return { limits, errors };
}

export function solve(ctx, policy, cfg, limits, mutation, hooks = {}) {
  const graph = new Graph(limits);
  const builder = new Builder(ctx, policy, graph, cfg, limits, mutation);
  builder.onWire = hooks.onWire;
  let budget;
  try {
    for (const sf of ctx.scanned) {
      if (mutation?.name === 'omit-source-module' && ctx.fileInfo.get(sf).path === mutation.file) continue;
      builder.visitFile(sf);
    }
    for (;;) {
      builder.drainPending();
      graph.solve();
      if (builder.pending.length === 0) break;
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    budget = error.limit;
    if (mutation?.name === 'budget-success') budget = undefined;
  }
  return { graph, builder, budget };
}

/** SCC condensation of the object/slot graph with per-component envelopes. */
export class Certificates {
  constructor(graph) {
    this.g = graph;
    const count = graph.objKind.length;
    this.component = new Int32Array(count).fill(-1);
    this.componentTerms = [];
    this.componentUnknown = [];
    this.componentWidened = [];
    this.componentSize = [];
    this.componentSlots = [];
    this.cyclic = 0;
    this.compute(count);
  }

  successors(o) {
    const out = [];
    const fields = this.g.objFields[o];
    if (!fields) return out;
    for (const [k, f] of fields) {
      if (k.startsWith('$')) continue;
      const pts = this.g.pts[f];
      if (pts) for (const x of pts) out.push(x);
    }
    return out;
  }

  localUnknown(o) {
    let mask = 0;
    const fields = this.g.objFields[o];
    if (fields) for (const [k, f] of fields) if (!k.startsWith('$')) mask |= this.g.unk[f];
    return mask;
  }

  compute(count) {
    // Iterative Tarjan; components are numbered in reverse topological order,
    // so every successor component is final before its predecessors.
    const index = new Int32Array(count).fill(-1);
    const low = new Int32Array(count);
    const onStack = new Uint8Array(count);
    const stack = [];
    let next = 0;
    for (let start = 0; start < count; start++) {
      if (index[start] !== -1) continue;
      const work = [[start, this.successors(start), 0]];
      index[start] = low[start] = next++;
      stack.push(start);
      onStack[start] = 1;
      while (work.length) {
        const frame = work[work.length - 1];
        const [v, succ] = frame;
        if (frame[2] < succ.length) {
          const w = succ[frame[2]++];
          if (index[w] === -1) {
            index[w] = low[w] = next++;
            stack.push(w);
            onStack[w] = 1;
            work.push([w, this.successors(w), 0]);
          } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
          continue;
        }
        work.pop();
        if (work.length) { const parent = work[work.length - 1][0]; low[parent] = Math.min(low[parent], low[v]); }
        if (low[v] !== index[v]) continue;
        const id = this.componentTerms.length;
        const members = [];
        let w;
        do { w = stack.pop(); onStack[w] = 0; this.component[w] = id; members.push(w); } while (w !== v);
        const terms = new Set();
        let unknown = 0;
        let widened = false;
        let slots = 0;
        let selfLoop = false;
        for (const m of members) {
          const t = this.g.termIndex[m];
          if (t >= 0) terms.add(t);
          unknown |= this.localUnknown(m);
          widened ||= this.g.objWidened[m];
          slots += this.g.objFields[m]?.size ?? 0;
          for (const s of this.successors(m)) {
            const c = this.component[s];
            if (c === id) { selfLoop = true; continue; }
            for (const x of this.componentTerms[c]) terms.add(x);
            unknown |= this.componentUnknown[c];
            widened ||= this.componentWidened[c];
          }
        }
        if (members.length > 1 || selfLoop) this.cyclic++;
        this.componentTerms.push(terms);
        this.componentUnknown.push(unknown);
        this.componentWidened.push(widened);
        this.componentSize.push(members.length);
        this.componentSlots.push(slots);
      }
    }
  }

  /** Envelope of a value node: (MayC, OpaqueReasons, widened, complete, sourceFree). */
  envelope(n) {
    const terms = new Set();
    let unknown = this.g.unk[n];
    let widened = false;
    const pts = this.g.pts[n];
    if (pts) {
      for (const o of pts) {
        const c = this.component[o];
        for (const t of this.componentTerms[c]) terms.add(t);
        unknown |= this.componentUnknown[c];
        widened ||= this.componentWidened[c];
      }
    }
    return this.finish(terms, unknown, widened);
  }

  /** Envelope of every slot except `excluded` keys (rest extraction). */
  envelopeExcept(n, excluded) {
    const terms = new Set();
    let unknown = this.g.unk[n];
    let widened = false;
    const pts = this.g.pts[n];
    if (pts) {
      for (const o of pts) {
        const t = this.g.termIndex[o];
        if (t >= 0) { terms.add(t); continue; }
        widened ||= this.g.objWidened[o];
        const fields = this.g.objFields[o];
        if (!fields) continue;
        for (const [k, f] of fields) {
          if (k.startsWith('$') || excluded.has(k)) continue;
          const e = this.envelope(f);
          for (const x of e.terms) terms.add(x);
          unknown |= e.unknownMask;
          widened ||= e.widened;
        }
      }
    }
    return this.finish(terms, unknown, widened);
  }

  finish(terms, unknownMask, widened) {
    const complete = unknownMask === 0;
    return { terms, unknownMask, reasons: reasonNames(unknownMask), widened, complete, sourceFree: complete && terms.size === 0 };
  }
}
