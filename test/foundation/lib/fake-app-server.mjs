// SPDX-License-Identifier: Apache-2.0
/**
 * Scripted fake Codex App Server peer (stdio JSONL, R8 §3.3 / §6.3).
 *
 * This is a deterministic layer-1/2 double for the App Server client. It is
 * NOT evidence of pinned 0.142.3 behaviour: class-G facts (SB-1..SB-14,
 * SP-T1) are proven only by the real-binary job. Defaults below mirror the
 * shapes R8 records so client tests can start; scenarios override them.
 *
 * Wire: one JSON object per line, no `jsonrpc` member. Client and server ids
 * may be integers or strings; server-originated request ids start at 0.
 * Every line, complete or partial, is capped at MAX_LINE_BYTES: an oversize
 * line is dropped up to its newline (anomaly `line-too-long`, no reply) and
 * reading resumes with the next line. A client request id that was already
 * used in this process is recorded as `duplicate-request-id`; by default the
 * request is still served, and `scenario.duplicateRequestIds: 'reject'`
 * answers it with -32600 instead. Both rules are fixture contracts chosen
 * for client tests, not pinned 0.142.3 behaviour.
 *
 * Use in-process via `streams()` (child-process-like stdin/stdout PassThroughs)
 * or as a subprocess via `test/foundation/bin/fake-app-server.mjs`.
 */
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as realSetTimeout } from 'node:timers';
import { NO_FAULTS } from './fault-plan.mjs';

export const RPC_ERRORS = Object.freeze({
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, SERVER: -32000, OVERLOADED: -32001,
});
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** The FaultPlan points this fake consults. */
export const FAKE_APP_SERVER_FAULT_POINTS = Object.freeze([
  'runtime.dropInterruptResponse', 'runtime.dropTurnCompleted', 'runtime.failUnsubscribe', 'runtime.killChild',
]);
const DUPLICATE_ID_MODES = ['serve', 'reject'];

/**
 * @typedef {object} TurnStep
 * @property {string} [notify]   notification method; `params` sent with placeholders expanded
 * @property {string} [request]  server→client request method; waits for the reply before continuing
 * @property {object} [params]
 * @property {number|string} [id] explicit server request id (default: next integer, from 0)
 * @property {number} [delayMs]  pause before this step (uses the injected clock)
 * @property {'completed'|'failed'|'interrupted'} [complete] shorthand for `turn/completed`
 * @property {boolean} [waitInterrupt] hold here until `turn/interrupt` (hung turn)
 *
 * @typedef {object} Scenario
 * @property {Record<string, object|((params: object, ctx: object) => object)>} [methods] result overrides by method
 * @property {Array<TurnStep[]>} [turns] scripts consumed by successive `turn/start`
 * @property {TurnStep[]} [defaultTurn] used when `turns` is exhausted
 * @property {'serve'|'reject'} [duplicateRequestIds] handling of a reused client request id (default `serve`)
 */

const DEFAULT_TURN = Object.freeze([
  { notify: 'item/started', params: { threadId: '$threadId', turnId: '$turnId', item: { id: '$itemId', type: 'agentMessage', text: '' } } },
  { notify: 'item/completed', params: { threadId: '$threadId', turnId: '$turnId', item: { id: '$itemId', type: 'agentMessage', text: 'ok' } } },
  { complete: 'completed' },
]);

export class FakeAppServer extends EventEmitter {
  #scenario; #faults; #clock;
  #initialized = false; #initializedNotified = false; #exited = false;
  #log = []; #seq = 0; #buf = ''; #bufBytes = 0; #discarding = false;
  /** Keeps a multibyte UTF-8 sequence that is split across chunks intact. */
  #decoder = new StringDecoder('utf8');
  /** idKey → seq of the first client request that used the id */
  #clientIds = new Map();
  #threads = new Map(); #nextThread = 1; #nextTurn = 1; #nextItem = 1; #nextServerId = 0; #turnIndex = 0;
  /** @type {Map<string, {method:string, resolve:(m:object)=>void, settled:boolean}>} */
  #pendingServer = new Map();
  /** @type {Map<string, {threadId:string, turnId:string, interrupted:boolean, wakeInterrupt?:()=>void, done:boolean}>} */
  #activeTurns = new Map();
  #stdin = new PassThrough(); #stdout = new PassThrough();
  #write = (line) => { if (!this.#exited) this.#stdout.write(line + '\n'); };

  /**
   * @param {Scenario} [scenario]
   * @param {{ faults?: import('./fault-plan.mjs').FaultPlan, clock?: { setTimeout: Function } }} [opts]
   */
  constructor(scenario = {}, opts = {}) {
    super();
    if (scenario.duplicateRequestIds !== undefined && !DUPLICATE_ID_MODES.includes(scenario.duplicateRequestIds)) {
      throw new TypeError(`duplicateRequestIds must be one of ${DUPLICATE_ID_MODES.join(', ')}`);
    }
    this.#scenario = scenario;
    this.#faults = opts.faults ?? NO_FAULTS;
    this.#clock = opts.clock ?? { setTimeout: realSetTimeout };
    this.#stdin.on('data', chunk => this.receive(chunk));
    this.#stdin.on('end', () => this.exit({ code: 0, reason: 'stdin-eof' }));
  }

  /** Child-process-like stream pair: write requests to `stdin`, read lines from `stdout`. */
  streams() { return { stdin: this.#stdin, stdout: this.#stdout }; }

  /** Redirect output (subprocess entry uses process.stdout). */
  pipeOutput(writeLine) { this.#write = (line) => { if (!this.#exited) writeLine(line + '\n'); }; return this; }

  /**
   * Feed raw bytes as if written to stdin. Byte chunks go through one
   * streaming UTF-8 decoder, so a character split across chunks is decoded
   * once it is complete. Lines are split on `\n`; each line is capped at
   * MAX_LINE_BYTES whether or not its newline has arrived.
   */
  receive(chunk) {
    let text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? this.#decoder.write(chunk) : String(chunk);
    while (text.length > 0 && !this.#exited) {
      const nl = text.indexOf('\n');
      const piece = nl < 0 ? text : text.slice(0, nl);
      text = nl < 0 ? '' : text.slice(nl + 1);
      if (this.#discarding) {
        if (nl >= 0) this.#discarding = false;
        continue;
      }
      this.#buf += piece;
      this.#bufBytes += Buffer.byteLength(piece);
      if (this.#bufBytes > MAX_LINE_BYTES) {
        this.#record('anomaly', { kind: 'line-too-long', bytes: this.#bufBytes, complete: nl >= 0 });
        this.#buf = ''; this.#bufBytes = 0;
        if (nl < 0) this.#discarding = true;
        continue;
      }
      if (nl < 0) continue;
      const line = this.#buf.trim();
      this.#buf = ''; this.#bufBytes = 0;
      if (line) this.#onLine(line);
    }
  }

  /**
   * Simulate process exit (SIGKILL, SIGTERM, EOF). Output already sent stays
   * sent; in-flight turns are abandoned (no `turn/completed`) and pending
   * server requests are dropped. The exit record lists both.
   */
  exit({ code = null, signal = null, reason = 'exit' } = {}) {
    if (this.#exited) return;
    this.#exited = true;
    const abandonedTurns = [...this.#activeTurns.values()].filter(t => !t.done).map(t => t.turnId);
    const pendingServerRequests = [...this.#pendingServer.values()].filter(p => !p.settled).map(p => p.id);
    this.#record('exit', { code, signal, reason, abandonedTurns, pendingServerRequests });
    for (const t of this.#activeTurns.values()) t.wakeInterrupt?.();
    for (const p of this.#pendingServer.values()) if (!p.settled) { p.settled = true; p.resolve({ exited: true }); }
    this.#stdout.end();
    this.emit('exit', code, signal);
  }

  get exited() { return this.#exited; }

  // ─── inspection ─────────────────────────────────────────────────────────

  log() { return this.#log.map(e => globalThis.structuredClone(e)); }
  /** Client requests received for `method`, in order. */
  requests(method) { return this.#log.filter(e => e.dir === 'in' && e.msg.method === method && 'id' in e.msg).map(e => globalThis.structuredClone(e.msg)); }
  notificationsSent(method) { return this.#log.filter(e => e.dir === 'out' && e.msg.method === method && !('id' in e.msg)).map(e => globalThis.structuredClone(e.msg)); }
  anomalies() { return this.#log.filter(e => e.dir === 'anomaly').map(e => globalThis.structuredClone(e)); }
  threads() { return [...this.#threads.values()].map(t => globalThis.structuredClone(t)); }

  // ─── dispatch ───────────────────────────────────────────────────────────

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      this.#record('anomaly', { kind: 'parse-error', excerpt: line.slice(0, 200) });
      return this.#send({ id: null, error: { code: RPC_ERRORS.PARSE, message: 'Parse error' } });
    }
    this.#record('in', { msg });
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return this.#send({ id: null, error: { code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid request' } });
    }
    const hasId = Object.hasOwn(msg, 'id');
    if (typeof msg.method === 'string') {
      if (hasId) return this.#onRequest(msg);
      return this.#onNotification(msg);
    }
    if (hasId && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) return this.#onResponse(msg);
    this.#record('anomaly', { kind: 'unclassified', msg });
  }

  #onNotification(msg) {
    if (msg.method === 'initialized') {
      if (!this.#initialized || this.#initializedNotified) this.#record('anomaly', { kind: 'unexpected-initialized' });
      this.#initializedNotified = true;
    }
  }

  #onResponse(msg) {
    const key = idKey(msg.id);
    const pending = this.#pendingServer.get(key);
    if (!pending) return this.#record('anomaly', { kind: 'unknown-response-id', id: msg.id });
    if (pending.settled) return this.#record('anomaly', { kind: 'duplicate-response', id: msg.id });
    pending.settled = true;
    pending.resolve(msg);
  }

  async #onRequest(msg) {
    const { id, method, params = {} } = msg;
    const key = idKey(id);
    const firstSeq = this.#clientIds.get(key);
    if (firstSeq !== undefined) {
      this.#record('anomaly', { kind: 'duplicate-request-id', id, method, firstSeq });
      if (this.#scenario.duplicateRequestIds === 'reject') return this.#error(id, RPC_ERRORS.INVALID_REQUEST, `Duplicate request id: ${JSON.stringify(id)}`);
    } else this.#clientIds.set(key, this.#seq);
    if (method === 'initialize') {
      if (this.#initialized) return this.#error(id, RPC_ERRORS.INVALID_REQUEST, 'Already initialized');
      this.#initialized = true;
      return this.#result(id, this.#override(method, params) ?? { userAgent: 'fake-app-server/0' });
    }
    if (!this.#initialized) return this.#error(id, RPC_ERRORS.INVALID_REQUEST, 'Not initialized');
    const custom = this.#scenario.methods?.[method];
    switch (method) {
      case 'thread/start': {
        const threadId = `thr_${this.#nextThread++}`;
        this.#threads.set(threadId, { id: threadId, params: globalThis.structuredClone(params), turns: [], subscribed: true, resumes: 0 });
        const result = this.#override(method, params, { threadId }) ?? { thread: { id: threadId } };
        this.#result(id, result);
        return this.#send({ method: 'thread/started', params: { thread: { id: threadId } } });
      }
      case 'thread/resume': {
        const t = this.#threads.get(params.threadId);
        if (!t) return this.#error(id, RPC_ERRORS.SERVER, `thread not found: ${params.threadId}`);
        t.resumes++; t.subscribed = true; t.lastResume = globalThis.structuredClone(params);
        return this.#result(id, this.#override(method, params, { threadId: t.id }) ?? { thread: { id: t.id } });
      }
      case 'thread/unsubscribe': {
        if (this.#faults.hit('runtime.failUnsubscribe')) return this.#error(id, RPC_ERRORS.SERVER, 'unsubscribe failed (injected)');
        const t = this.#threads.get(params.threadId);
        if (t) t.subscribed = false;
        return this.#result(id, {});
      }
      case 'thread/loaded/list':
        return this.#result(id, { data: [...this.#threads.values()].filter(t => t.subscribed).map(t => t.id) });
      case 'account/login/start':
        return this.#result(id, this.#override(method, params) ?? {});
      case 'turn/start':
        return this.#startTurn(id, params);
      case 'turn/interrupt': {
        const t = this.#activeTurns.get(params.turnId);
        if (t && !t.done) { t.interrupted = true; t.wakeInterrupt?.(); }
        if (this.#faults.hit('runtime.dropInterruptResponse')) return this.#record('fault', { point: 'runtime.dropInterruptResponse', id });
        return this.#result(id, {});
      }
      default:
        if (custom !== undefined) return this.#result(id, this.#override(method, params));
        return this.#error(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  #startTurn(id, params) {
    const thread = this.#threads.get(params.threadId);
    if (!thread) return this.#error(id, RPC_ERRORS.SERVER, `thread not found: ${params.threadId}`);
    const turnId = `turn_${this.#nextTurn++}`;
    thread.turns.push({ id: turnId, params: globalThis.structuredClone(params) });
    const turn = { threadId: thread.id, turnId, interrupted: false, done: false };
    this.#activeTurns.set(turnId, turn);
    this.#result(id, this.#override('turn/start', params, { threadId: thread.id, turnId }) ?? { turn: { id: turnId, status: 'inProgress' } });
    const script = this.#scenario.turns?.[this.#turnIndex++] ?? this.#scenario.defaultTurn ?? DEFAULT_TURN;
    this.#runTurn(turn, script).catch(err => this.#record('anomaly', { kind: 'turn-script-error', error: String(err) }));
  }

  async #runTurn(turn, script) {
    const vars = { $threadId: turn.threadId, $turnId: turn.turnId, $itemId: `item_${this.#nextItem++}` };
    this.#send({ method: 'turn/started', params: { threadId: turn.threadId, turn: { id: turn.turnId, status: 'inProgress' } } });
    for (const step of script) {
      if (this.#exited) return;
      if (turn.interrupted) break;
      if (step.delayMs) await this.#sleep(step.delayMs, turn);
      if (this.#exited) return;
      if (turn.interrupted) break;
      if (this.#faults.hit('runtime.killChild')) { this.exit({ signal: 'SIGKILL', reason: 'injected' }); return; }
      if (step.waitInterrupt) { await new Promise(r => { turn.wakeInterrupt = r; }); break; }
      if (step.notify) this.#send({ method: step.notify, params: expand(step.params ?? {}, vars) });
      if (step.request) {
        const sid = step.id ?? this.#nextServerId++;
        const reply = await this.#serverRequest(sid, step.request, expand(step.params ?? {}, vars));
        if (reply.exited) return;
      }
      if (step.complete) return this.#completeTurn(turn, step.complete);
    }
    if (this.#exited) return;
    this.#completeTurn(turn, turn.interrupted ? 'interrupted' : 'completed');
  }

  #completeTurn(turn, status) {
    if (turn.done) return;
    turn.done = true;
    this.#activeTurns.delete(turn.turnId);
    if (this.#faults.hit('runtime.dropTurnCompleted')) return this.#record('fault', { point: 'runtime.dropTurnCompleted', turnId: turn.turnId });
    this.#send({ method: 'turn/completed', params: { threadId: turn.threadId, turn: { id: turn.turnId, status } } });
  }

  #serverRequest(id, method, params) {
    const key = idKey(id);
    if (this.#pendingServer.has(key) && !this.#pendingServer.get(key).settled) throw new Error(`server request id ${key} already pending`);
    return new Promise(resolve => {
      this.#pendingServer.set(key, { id, method, resolve, settled: false });
      this.#send({ id, method, params });
    });
  }

  #sleep(ms, turn) {
    return new Promise(resolve => {
      const wake = () => resolve();
      turn.wakeInterrupt = wake;
      this.#clock.setTimeout(wake, ms);
    });
  }

  #override(method, params, ids = {}) {
    const o = this.#scenario.methods?.[method];
    if (o === undefined) return undefined;
    return typeof o === 'function' ? o(params, ids) : expand(o, { $threadId: ids.threadId, $turnId: ids.turnId });
  }

  #result(id, result) { this.#send({ id, result }); }
  #error(id, code, message) { this.#send({ id, error: { code, message } }); }
  #send(msg) { this.#record('out', { msg }); this.#write(JSON.stringify(msg)); }
  #record(dir, data) { this.#log.push({ seq: ++this.#seq, dir, ...globalThis.structuredClone(data) }); }
}

/** Ids are compared by type and value: 0 and "0" are different ids. */
export function idKey(id) { return `${typeof id}:${String(id)}`; }

function expand(value, vars) {
  if (typeof value === 'string') return Object.hasOwn(vars, value) && vars[value] !== undefined ? vars[value] : value;
  if (Array.isArray(value)) return value.map(v => expand(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}
