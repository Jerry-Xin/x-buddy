// SPDX-License-Identifier: Apache-2.0
/** Staged per-bot runtime. No host activation, database access or outbound transport. */
import { AppServerClient } from '../app-server/client.js';
import { AppServerExitedError, AppServerRpcError, capMessage } from '../app-server/errors.js';
import type { RpcNotification } from '../app-server/protocol.js';
import { bounded, deferred, EventQueue, identifier, object, realClock, runtimeError } from './support.js';
import type { RuntimeClient, RuntimeClock, RuntimeOptions, TurnContext, TurnHandle, TurnOutcome, TurnRequest } from './types.js';

type State = 'idle' | 'starting' | 'ready' | 'crashed' | 'circuit-open' | 'recycling' | 'draining' | 'closed' | 'unavailable';
interface ProcessOwner { generation: number; client: RuntimeClient; off: () => void; exited: boolean; intentional: boolean }
interface Lane { key: string; threadId?: string; resetGeneration?: number; active?: Entry; queue: Entry[]; quarantined: boolean }
interface Entry {
  seq: number; req: TurnRequest; lane: Lane; resetGeneration: number; generation: number;
  events: EventQueue<RpcNotification>; done: ReturnType<typeof deferred<TurnOutcome>>;
  stop: ReturnType<typeof deferred<void>>; terminal: ReturnType<typeof deferred<void>>;
  threadId?: string; turnId?: string; controlWritten: boolean; accepted: boolean;
  buffer: RpcNotification[]; cancelError?: Error; settled: boolean; terminalStatus?: string;
  terminalError?: string; messages: Map<string, string>; timers: Set<unknown>; removeAbort?: () => void;
}

export class BotCodexRuntime {
  readonly #options: RuntimeOptions;
  readonly #clock: RuntimeClock;
  readonly #maxQueued: number;
  readonly #confirmMs: number;
  readonly #drainMs: number;
  readonly #ceilingMs: number;
  #state: State = 'idle';
  #owner?: ProcessOwner;
  #starting?: Promise<ProcessOwner>;
  #shutdown?: Promise<void>;
  #recycle?: Promise<void>;
  #generation = 0;
  #sequence = 0;
  #lanes = new Map<string, Lane>();
  #entries = new Set<Entry>();
  #contexts = new Map<string, Readonly<TurnContext>>();
  #reset = new Map<string, number>();
  #crashes: number[] = [];
  #retryAt = 0;
  #circuitUntil = 0;
  #stale = 0;
  #restarts = 0;
  #recycles = 0;
  #delayWaiters = new Set<() => void>();
  #stopping = deferred<void>();

  constructor(options: RuntimeOptions) {
    this.#options = options;
    this.#clock = options.clock ?? realClock;
    this.#maxQueued = bounded(options.laneMaxQueued, 3, 1, 10, 'laneMaxQueued');
    this.#confirmMs = bounded(options.interruptConfirmMs, 10_000, 1_000, 60_000, 'interruptConfirmMs');
    this.#drainMs = bounded(options.recycleDrainMs, 120_000, 0, 600_000, 'recycleDrainMs');
    this.#ceilingMs = bounded(options.chatTurnCeilingMs, 1_800_000, 60_000, 7_200_000, 'chatTurnCeilingMs');
  }

  stats() {
    return Object.freeze({ state: this.#state, generation: this.#generation, pid: this.#owner?.client.pid,
      activeTurns: [...this.#entries].filter(e => e.turnId && !e.settled).length,
      queuedTurns: [...new Set(this.#lanes.values())].reduce((n, l) => n + l.queue.length, 0),
      contexts: this.#contexts.size, restarts: this.#restarts, recycles: this.#recycles,
      staleGenerationEvents: this.#stale });
  }

  /** Ready is shared per process; failure never replays an admitted turn. */
  async ensureReady(): Promise<void> { await this.#ready(); }

  openTurn(request: TurnRequest): TurnHandle {
    // Snapshot caller-owned authority and params; later mutations cannot change an admitted turn.
    const req: TurnRequest = { ...request, ctx: freezeContext(request.ctx),
      threadParams: { ...request.threadParams, runtimeWorkspaceRoots: request.threadParams.runtimeWorkspaceRoots?.slice() },
      turnParams: { ...request.turnParams } };
    const session = req.sessionKey ?? (req.ctx.origin === 'chat' ? req.ctx.session.sessionKey : '');
    const resetGeneration = req.ctx.session.resetGeneration;
    const key = req.resumeThreadId ?? (session ? `new:${session}` : req.laneKey);
    let lane = this.#lanes.get(key);
    if (!lane) { lane = { key, queue: [], quarantined: false }; this.#lanes.set(key, lane); }
    const e: Entry = { seq: ++this.#sequence, req, lane, resetGeneration, generation: 0,
      events: new EventQueue(), done: deferred(), stop: deferred(), terminal: deferred(),
      controlWritten: false, accepted: false, buffer: [], settled: false, messages: new Map(), timers: new Set() };
    const handle: TurnHandle = { events: this.#events(e), done: e.done.promise,
      cancel: async (reason = 'turn interrupted') => { this.#cancel(e, runtimeError('TurnInterruptedError', reason)); return e.done.promise; } };
    this.#entries.add(e);
    let error: Error | undefined;
    if (!this.#admitting()) error = runtimeError('RuntimeUnavailableError', 'Codex runtime unavailable');
    else if (!this.#current(e)) error = runtimeError('ResetCancelledError');
    else if (req.signal?.aborted) error = runtimeError('TurnInterruptedError');
    else if (req.laneDeadlineMs !== undefined && (!Number.isFinite(req.laneDeadlineMs) || req.laneDeadlineMs <= this.#clock.now())) error = runtimeError('LaneDeadlineError');
    else if (req.ceilingMs !== undefined && (!Number.isInteger(req.ceilingMs) || req.ceilingMs < 10_000 || req.ceilingMs > 7_200_000)) error = runtimeError('RuntimeUnavailableError', 'invalid ceilingMs');
    else if (lane.quarantined) error = runtimeError('ThreadQuarantinedError');
    else if (lane.active && lane.queue.length >= this.#maxQueued) error = runtimeError('LaneOverflowError');
    if (error) this.#finish(e, error, 'not-started');
    else {
      lane.queue.push(e);
      if (req.signal) {
        const abort = () => this.#cancel(e, runtimeError('TurnInterruptedError'));
        req.signal.addEventListener('abort', abort, { once: true });
        e.removeAbort = () => req.signal!.removeEventListener('abort', abort);
      }
      if (req.laneDeadlineMs !== undefined) this.#timer(e, Math.max(0, req.laneDeadlineMs - this.#clock.now()), () => {
        if (!e.accepted) this.#cancel(e, runtimeError('LaneDeadlineError'));
      });
      this.#pump(lane);
    }
    return handle;
  }

  async *runTurn(req: TurnRequest): AsyncGenerator<RpcNotification> {
    const handle = this.openTurn(req);
    try {
      for await (const event of handle.events) yield event;
      const result = await handle.done;
      if (result.error) throw runtimeError(result.error.class, result.error.message);
    } finally { await handle.cancel('event consumer abandoned'); }
  }

  async *#events(e: Entry): AsyncGenerator<RpcNotification> {
    try { yield* e.events; }
    finally { if (!e.settled) { this.#cancel(e, runtimeError('TurnInterruptedError', 'event consumer abandoned')); await e.done.promise; } }
  }

  isThreadBusy(threadId: string): boolean {
    const lane = this.#lanes.get(threadId);
    return !!lane && (!!lane.active || lane.quarantined);
  }

  /** Request only. The caller must not interpret this RPC response as idle. */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    const owner = this.#owner;
    if (!owner || owner.exited) throw runtimeError('RuntimeUnavailableError');
    await owner.client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: this.#confirmMs });
  }

  async cancelSession(sessionKey: string): Promise<void> {
    this.#reset.set(sessionKey, Math.max((this.#reset.get(sessionKey) ?? 0) + 1, this.#options.getResetGeneration?.(sessionKey) ?? 0));
    const pending = [...this.#entries].filter(e => this.#session(e) === sessionKey);
    for (const e of pending) this.#cancel(e, runtimeError('ResetCancelledError'));
    await Promise.all(pending.map(e => e.done.promise));
  }

  shutdown(options: { interruptGraceMs: number; exitGraceMs: number }): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    bounded(options.interruptGraceMs, 5_000, 0, 60_000, 'interruptGraceMs');
    bounded(options.exitGraceMs, 15_000, 0, 60_000, 'exitGraceMs');
    this.#state = 'draining';
    this.#stopping.resolve();
    for (const wake of this.#delayWaiters) wake();
    this.#shutdown = this.#stop(options);
    return this.#shutdown;
  }

  async #stop(options: { interruptGraceMs: number; exitGraceMs: number }): Promise<void> {
    const entries = [...this.#entries];
    for (const e of entries) this.#cancel(e, runtimeError('TurnInterruptedError', 'runtime shutdown'));
    await this.#within(Promise.all(entries.map(e => e.done.promise)), options.interruptGraceMs);
    const owner = this.#owner;
    if (owner) {
      owner.intentional = true;
      // close resolves only on confirmed child exit. On failure retain owner and forbid respawn.
      const exited = await this.#within(owner.client.close({ graceMs: options.exitGraceMs }), options.exitGraceMs + 2_000);
      if (!exited || !owner.exited) {
        this.#state = 'unavailable';
        for (const e of entries) this.#finish(e, runtimeError('RuntimeUnavailableError', 'child exit not confirmed'), 'quarantined');
        throw runtimeError('RuntimeUnavailableError', 'child exit not confirmed');
      }
    }
    for (const e of entries) if (!e.settled) this.#finish(e, runtimeError('TurnInterruptedError'), owner ? 'process-exited' : 'not-started');
    await Promise.all(entries.map(e => e.done.promise));
    await this.#starting?.catch(() => undefined);
    await this.#recycle;
    this.#contexts.clear(); this.#lanes.clear(); this.#state = 'closed';
  }

  async #ready(): Promise<ProcessOwner> {
    if (!this.#admitting()) throw runtimeError('RuntimeUnavailableError', 'Codex runtime unavailable');
    if (this.#owner && !this.#owner.exited && this.#state === 'ready') return this.#owner;
    if (this.#starting) return this.#starting;
    const now = this.#clock.monotonicNow();
    if (now < this.#circuitUntil) { this.#state = 'circuit-open'; throw runtimeError('RuntimeUnavailableError', 'Codex runtime unavailable'); }
    if (this.#owner && !this.#owner.exited) throw runtimeError('RuntimeUnavailableError', 'previous child still owned');
    this.#starting = this.#spawn();
    try { return await this.#starting; } finally { this.#starting = undefined; }
  }

  async #spawn(): Promise<ProcessOwner> {
    this.#state = 'starting';
    await this.#delay(Math.max(0, this.#retryAt - this.#clock.monotonicNow()));
    if (!this.#admitting()) throw runtimeError('RuntimeUnavailableError');
    const generation = ++this.#generation;
    if (generation > 1) this.#restarts++;
    const client = this.#options.clientFactory?.(generation) ?? new AppServerClient(this.#options.client);
    const owner: ProcessOwner = { generation, client, off: () => {}, exited: false, intentional: false };
    this.#owner = owner;
    owner.off = client.subscribe(() => true, n => this.#notification(owner, n));
    void client.closed.then(() => this.#exit(owner));
    try {
      await client.start();
      if (owner !== this.#owner || owner.exited || !this.#admitting()) throw runtimeError('RuntimeUnavailableError');
      this.#state = 'ready'; return owner;
    } catch (error) {
      owner.intentional = this.#isStopping();
      void client.close({ graceMs: 0 }).catch(() => { this.#state = 'unavailable'; });
      throw error;
    }
  }

  #exit(owner: ProcessOwner): void {
    if (owner.exited) return;
    owner.exited = true; owner.off();
    if (owner !== this.#owner) { this.#stale++; return; }
    if (!owner.intentional && this.#state !== 'draining') {
      const now = this.#clock.monotonicNow();
      this.#crashes = this.#crashes.filter(t => now - t < 300_000); this.#crashes.push(now);
      this.#retryAt = now + Math.min(30_000, 1_000 * 2 ** Math.min(this.#crashes.length - 1, 5));
      if (this.#crashes.length >= 5) this.#circuitUntil = now + 60_000;
      this.#state = now < this.#circuitUntil ? 'circuit-open' : 'crashed';
    }
    for (const e of [...this.#entries]) if (e.generation === owner.generation) {
      e.terminal.resolve();
      this.#finish(e, e.cancelError ?? new AppServerExitedError(owner.client.exitInfo ?? { code: null, signal: null, stderrTail: '' }), 'process-exited');
    }
    for (const lane of new Set(this.#lanes.values())) {
      lane.quarantined = false;
      if (!lane.active) this.#pump(lane);
    }
    // An idle subscription is process-local. Only the host mapping can resume it after exit.
    for (const [key, lane] of this.#lanes) if (!lane.active && lane.queue.length === 0) this.#lanes.delete(key);
  }

  #pump(lane: Lane): void {
    if (lane.active || lane.quarantined || !this.#admitting()) return;
    const e = lane.queue.shift();
    if (!e) return;
    if (e.settled) { this.#pump(lane); return; }
    lane.active = e;
    void this.#drive(e).catch(error => {
      if (!e.settled) {
        if (e.controlWritten && !e.terminalStatus) this.#quarantine(e, error instanceof Error ? error : runtimeError('TurnFailedError'));
        else this.#finish(e, error instanceof Error ? error : runtimeError('TurnFailedError'), 'not-started');
      }
    });
  }

  async #drive(e: Entry): Promise<void> {
    const owner = await this.#race(e, this.#ready());
    if (e.settled) return;
    e.generation = owner.generation;
    this.#assertCurrent(e);
    const session = this.#session(e);
    const resolved = session && this.#options.resolveThreadId ? this.#options.resolveThreadId(session, e.resetGeneration) : undefined;
    const thread = session && this.#options.resolveThreadId ? resolved
      : (e.lane.resetGeneration === e.resetGeneration ? e.lane.threadId : undefined) ?? e.req.resumeThreadId;
    if (thread && !this.#bindLane(e, thread)) return;
    this.#assertCurrent(e);
    const params = { ...e.req.threadParams, approvalPolicy: 'never', ephemeral: false };
    e.controlWritten = true;
    let response: unknown;
    try {
      response = await this.#race(e, owner.client.request(thread ? 'thread/resume' : 'thread/start', thread ? { ...params, threadId: thread, config: {}, excludeTurns: true } : params));
    } catch (error) {
      // Explicit RPC rejection proves non-acceptance. Transport/timeout outcomes are ambiguous.
      if (!e.settled && error instanceof AppServerRpcError) { e.controlWritten = false; this.#finish(e, error, 'not-started'); }
      throw error;
    }
    this.#assertCurrent(e);
    const threadId = identifier(object(object(response).thread).id);
    if (!threadId || (thread && threadId !== thread)) throw runtimeError('TurnFailedError', 'invalid thread response');
    if (!this.#bindLane(e, threadId)) return;
    e.threadId = threadId;
    e.lane.threadId = threadId; e.lane.resetGeneration = e.resetGeneration;
    this.#assertCurrent(e);
    // This callback is only a CAS hook. Persistence and callback exception policy remain with host.
    if (session) e.req.onThread?.(threadId, e.resetGeneration);
    this.#assertCurrent(e);
    const turn = await this.#race(e, owner.client.request('turn/start', {
      threadId, input: [{ type: 'text', text: e.req.prompt, text_elements: [] }],
      cwd: e.req.turnParams.cwd, approvalPolicy: 'never', effort: e.req.turnParams.effort,
    }, { timeoutMs: 60_000, retry: false }));
    this.#assertCurrent(e);
    const turnId = identifier(object(object(turn).turn).id);
    if (!turnId) throw runtimeError('TurnFailedError', 'invalid turn response');
    e.turnId = turnId; e.accepted = true;
    this.#contexts.set(this.#contextKey(e), e.req.ctx);
    this.#timer(e, e.req.ceilingMs ?? this.#ceilingMs, () => this.#cancel(e, runtimeError('TurnCeilingError')));
    const buffered = e.buffer; e.buffer = [];
    for (const n of buffered) this.#deliver(e, n);
    await this.#race(e, e.terminal.promise);
    if (e.settled) return;
    await this.#cleanup(e, owner);
    if (e.settled) return;
    const error = e.cancelError ?? (e.terminalStatus === 'completed' ? undefined : runtimeError(e.terminalStatus === 'interrupted' ? 'TurnInterruptedError' : 'TurnFailedError', e.terminalError));
    this.#finish(e, error, 'terminal-confirmed');
  }

  #bindLane(e: Entry, threadId: string): boolean {
    const target = this.#lanes.get(threadId);
    if (target && target !== e.lane) {
      if (e.controlWritten) { this.#quarantine(e, runtimeError('ThreadQuarantinedError', 'thread ownership collision')); return false; }
      const old = e.lane;
      old.active = undefined;
      if (target.quarantined || (target.active && target.queue.length >= this.#maxQueued)) {
        this.#finish(e, runtimeError(target.quarantined ? 'ThreadQuarantinedError' : 'LaneOverflowError'), 'not-started');
        this.#pump(old); return false;
      }
      target.queue.push(e); target.queue.sort((a, b) => a.seq - b.seq); e.lane = target;
      this.#pump(old); this.#pump(target); return false;
    }
    this.#lanes.set(threadId, e.lane);
    return true;
  }

  #notification(owner: ProcessOwner, notification: RpcNotification): void {
    if (owner !== this.#owner || owner.exited) { this.#stale++; return; }
    for (const e of this.#entries) {
      if (e.generation !== owner.generation || e.settled || e.lane.active !== e) continue;
      if (!e.accepted) {
        if (e.buffer.length >= 10_000) this.#cancel(e, runtimeError('TurnFailedError', 'notification buffer overflow'));
        else e.buffer.push(notification);
      } else this.#deliver(e, notification);
    }
  }

  #deliver(e: Entry, notification: RpcNotification): void {
    if (e.settled || e.generation !== this.#owner?.generation) { this.#stale++; return; }
    const p = object(notification.params);
    const turnId = identifier(object(p.turn).id) ?? identifier(p.turnId);
    if (p.threadId !== e.threadId || turnId !== e.turnId) return;
    if (!this.#current(e) && !e.cancelError) this.#cancel(e, runtimeError('ResetCancelledError'));
    if (notification.method === 'turn/completed') {
      if (e.terminalStatus) return;
      const status = object(p.turn).status;
      e.terminalStatus = typeof status === 'string' ? status : 'failed';
      e.terminalError = typeof object(object(p.turn).error).message === 'string' ? capMessage(String(object(object(p.turn).error).message)) : undefined;
      this.#contexts.delete(this.#contextKey(e)); e.terminal.resolve();
    }
    // Cancellation/reset fences user-facing snapshots immediately; terminal proof still flows above.
    if (e.cancelError || !this.#current(e) || e.terminalStatus && notification.method !== 'turn/completed') return;
    if (notification.method === 'item/completed') {
      const item = object(p.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string' && typeof item.id === 'string') e.messages.set(item.id, item.text);
    }
    if (notification.method === 'error') {
      this.#cancel(e, runtimeError('TurnFailedError', typeof object(p.error).message === 'string' ? String(object(p.error).message) : 'turn failed'));
      return;
    }
    if (!e.events.push(notification)) this.#cancel(e, runtimeError('TurnFailedError', 'event buffer overflow'));
  }

  #cancel(e: Entry, error: Error): void {
    if (e.settled || e.cancelError) return;
    e.cancelError = error; e.events.end(true); this.#contexts.delete(this.#contextKey(e));
    if (e.lane.active !== e || !e.controlWritten) { this.#finish(e, error, 'not-started'); return; }
    if (!e.threadId || !e.turnId) { this.#quarantine(e, error); return; }
    if (e.terminalStatus) return;
    this.#timer(e, this.#confirmMs, () => { if (!e.terminalStatus && !e.settled) this.#quarantine(e, error); });
    const owner = this.#owner;
    if (owner && owner.generation === e.generation && !owner.exited) {
      void owner.client.request('turn/interrupt', { threadId: e.threadId, turnId: e.turnId }, { timeoutMs: this.#confirmMs }).catch(() => undefined);
    }
  }

  async #cleanup(e: Entry, owner: ProcessOwner): Promise<void> {
    if (owner.exited || e.settled) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.#race(e, owner.client.request('thread/unsubscribe', { threadId: e.threadId }, { timeoutMs: this.#confirmMs })); return; }
      catch { if (e.settled || owner.exited) return; }
    }
    this.#quarantine(e, runtimeError('ThreadQuarantinedError', 'unsubscribe unconfirmed'));
  }

  #quarantine(e: Entry, error: Error): void {
    if (e.settled) return;
    e.lane.quarantined = true;
    for (const queued of [...e.lane.queue]) this.#finish(queued, runtimeError('ThreadQuarantinedError'), 'not-started');
    this.#finish(e, error, 'quarantined');
    if (this.#state === 'draining' || this.#state === 'closed' || this.#recycle) return;
    this.#state = 'recycling'; this.#recycles++;
    for (const queued of [...this.#entries]) if (queued.lane.active !== queued) this.#finish(queued, runtimeError('RuntimeUnavailableError'), 'not-started');
    this.#recycle = this.#recover().finally(() => { this.#recycle = undefined; });
  }

  async #recover(): Promise<void> {
    const owner = this.#owner;
    if (!owner) return;
    const others = [...this.#entries].filter(e => e.generation === owner.generation);
    await this.#within(Promise.all(others.map(e => e.done.promise)), this.#drainMs, true);
    if (this.#isStopping()) return;
    for (const e of others) this.#cancel(e, runtimeError('AppServerExitedError', 'runtime recycle'));
    await this.#within(Promise.all(others.map(e => e.done.promise)), 5_000, true);
    if (this.#isStopping()) return;
    owner.intentional = true;
    const exited = await this.#within(owner.client.close({ graceMs: 15_000 }), 17_000, true);
    if (this.#isStopping()) return;
    if (!exited || !owner.exited) { this.#state = 'unavailable'; return; }
    for (const lane of new Set(this.#lanes.values())) lane.quarantined = false;
    this.#state = 'idle';
  }

  #finish(e: Entry, error: Error | undefined, termination: TurnOutcome['termination']): void {
    if (e.settled) return;
    if (!error && !this.#current(e)) error = runtimeError('ResetCancelledError');
    e.settled = true; e.stop.resolve(); e.terminal.resolve();
    for (const timer of e.timers) this.#clock.clearTimeout(timer);
    e.timers.clear(); e.removeAbort?.(); e.buffer = [];
    this.#contexts.delete(this.#contextKey(e)); this.#entries.delete(e);
    const index = e.lane.queue.indexOf(e); if (index >= 0) e.lane.queue.splice(index, 1);
    if (e.lane.active === e) e.lane.active = undefined;
    const cancelled = error && ['TurnInterruptedError', 'ResetCancelledError', 'TurnCeilingError'].includes(error.name);
    e.events.end(!!error);
    e.done.resolve({ status: error ? cancelled ? 'interrupted' : 'failed' : 'completed',
      generation: e.generation, threadId: e.threadId, turnId: e.turnId,
      text: error ? '' : [...e.messages.values()].join('\n\n'),
      error: error ? { class: error.name, message: capMessage(error.message) } : undefined, termination });
    this.#pump(e.lane);
  }

  #session(e: Entry): string { return e.req.sessionKey ?? (e.req.ctx.origin === 'chat' ? e.req.ctx.session.sessionKey : ''); }
  #resetGeneration(session: string): number { return Math.max(this.#reset.get(session) ?? 0, this.#options.getResetGeneration?.(session) ?? 0); }
  #current(e: Entry): boolean { return !this.#session(e) || this.#resetGeneration(this.#session(e)) === e.resetGeneration; }
  #assertCurrent(e: Entry): void {
    if (e.settled) throw runtimeError('TurnInterruptedError');
    if (!this.#current(e)) { this.#cancel(e, runtimeError('ResetCancelledError')); throw runtimeError('ResetCancelledError'); }
    if (e.cancelError) throw e.cancelError;
    if (!this.#admitting()) { this.#cancel(e, runtimeError('RuntimeUnavailableError')); throw runtimeError('RuntimeUnavailableError'); }
  }
  #admitting(): boolean { return !['recycling', 'draining', 'closed', 'unavailable'].includes(this.#state); }
  #isStopping(): boolean { return this.#state === 'draining' || this.#state === 'closed'; }
  #contextKey(e: Entry): string { return JSON.stringify([e.generation, e.threadId, e.turnId]); }
  async #race<T>(e: Entry, promise: Promise<T>): Promise<T> {
    return Promise.race([promise, e.stop.promise.then(() => { throw runtimeError('TurnInterruptedError'); })]);
  }
  #timer(e: Entry, ms: number, fn: () => void): void {
    const timer = this.#clock.setTimeout(() => { e.timers.delete(timer); if (!e.settled) fn(); }, ms); e.timers.add(timer);
  }
  async #within(promise: Promise<unknown>, ms: number, stopOnShutdown = false): Promise<boolean> {
    let timer: unknown;
    try { return await Promise.race([promise.then(() => true, () => false), new Promise<boolean>(resolve => { timer = this.#clock.setTimeout(() => resolve(false), ms); }), ...(stopOnShutdown ? [this.#stopping.promise.then(() => false)] : [])]); }
    finally { this.#clock.clearTimeout(timer); }
  }
  async #delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>(resolve => {
      const wake = () => { this.#clock.clearTimeout(timer); this.#delayWaiters.delete(wake); resolve(); };
      const timer = this.#clock.setTimeout(wake, ms); this.#delayWaiters.add(wake);
    });
  }
}

function freezeContext(ctx: TurnContext): Readonly<TurnContext> {
  return Object.freeze({ ...ctx, principal: Object.freeze({ ...ctx.principal }), session: Object.freeze({ ...ctx.session }),
    cron: ctx.cron ? Object.freeze({ ...ctx.cron }) : undefined,
    policy: Object.freeze({ ...ctx.policy, egressAllowlist: ctx.policy.egressAllowlist ? Object.freeze([...ctx.policy.egressAllowlist]) as unknown as string[] : undefined }),
    delivery: Object.freeze({ ...ctx.delivery }) });
}
