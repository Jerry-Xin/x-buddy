// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { FakeAppServer } from '../foundation/lib/fake-app-server.mjs';
import { FakeClock } from '../foundation/lib/clock.mjs';
import { FaultPlan } from '../foundation/lib/fault-plan.mjs';
import { AppServerExitedError, AppServerRpcError } from '../../dist/app-server/errors.js';
import { execParityServerRequestHandler } from '../../dist/app-server/server-requests.js';
import { BotCodexRuntime } from '../../dist/runtime/runtime.js';

export { FakeClock, FaultPlan };
export const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
export async function until(predicate, label = 'condition') {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail(`did not reach ${label}`);
}
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
export function request(sessionKey = 'a', extra = {}) {
  return {
    laneKey: `new:${sessionKey}`, sessionKey, prompt: 'hello 世界',
    ctx: { incarnationId: 'test-incarnation', origin: 'chat', principal: { uid: 'u1', role: 'member' },
      session: { sessionKey, resetGeneration: 0, channelId: 'c1', channelType: 1 },
      policy: { tools: 'none' }, delivery: { logicalOrigin: `message:${sessionKey}` } },
    threadParams: { cwd: '/tmp/runtime-fixture', sandbox: 'read-only' },
    turnParams: { cwd: '/tmp/runtime-fixture', effort: 'low' }, ...extra,
  };
}

/** Test-only RPC adapter to the existing fake. It never substitutes protocol facts. */
export class Peer {
  state = 'idle'; pid = undefined; exitInfo = undefined;
  listeners = new Set(); retiredListeners = [];
  pending = new Map(); sequence = 0; busy = new Set(); steering = [];
  held = new Map(); holds = new Set(); requests = [];
  closeCount = 0; closeBlocked = false;
  constructor(scenario = {}, { clock, faults } = {}) {
    this.server = new FakeAppServer(scenario, { clock: clock?.asClock(), faults });
    this.closedDeferred = deferred(); this.closed = this.closedDeferred.promise;
    this.server.pipeOutput(line => this.receive(JSON.parse(line)));
    this.server.on('exit', (code, signal) => {
      this.state = 'closed'; this.exitInfo = { code: code ?? null, signal: signal ?? null, stderrTail: '' };
      for (const p of this.pending.values()) p.reject(new AppServerExitedError(this.exitInfo));
      this.pending.clear(); this.busy.clear(); this.closedDeferred.resolve();
    });
  }
  async start() {
    this.state = 'starting'; await this.request('initialize', {});
    this.server.receive(JSON.stringify({ method: 'initialized' }) + '\n'); this.state = 'ready'; return {};
  }
  subscribe(filter, fn) {
    const listener = { filter, fn }; this.listeners.add(listener); this.retiredListeners.push(listener);
    return () => this.listeners.delete(listener);
  }
  request(method, params = {}, _options) {
    void _options;
    const id = ++this.sequence; this.requests.push({ method, params });
    if (method === 'turn/start' && this.busy.has(params.threadId)) this.steering.push(params.threadId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.server.receive(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  receive(m) {
    if (!m.method) {
      const pending = this.pending.get(m.id); if (!pending) return;
      if (this.holds.has(pending.method)) { this.held.set(m.id, m); return; }
      this.pending.delete(m.id);
      if (m.error) pending.reject(new AppServerRpcError(pending.method, m.error)); else pending.resolve(m.result);
    } else if (Object.hasOwn(m, 'id')) {
      void execParityServerRequestHandler(m).then(reply => this.server.receive(JSON.stringify({ id: m.id, ...reply }) + '\n'));
    } else {
      if (m.method === 'turn/started') this.busy.add(m.params.threadId);
      if (m.method === 'turn/completed') this.busy.delete(m.params.threadId);
      this.inject(m);
    }
  }
  inject(m, stale = false) {
    for (const l of stale ? this.retiredListeners : this.listeners) if (l.filter(m)) l.fn(m);
  }
  release(method) {
    this.holds.delete(method);
    for (const [id, m] of [...this.held]) if (this.pending.get(id)?.method === method) { this.held.delete(id); this.receive(m); }
  }
  async close() {
    this.closeCount++;
    if (!this.closeBlocked) this.server.exit({ code: 0, reason: 'test-close' });
    await this.closed;
  }
}

export function fixture({ scenario = {}, faults = new FaultPlan(), clock = new FakeClock(), options = {}, makePeer } = {}) {
  const peers = [];
  const runtime = new BotCodexRuntime({ client: { bin: 'unused', args: [], clientInfo: { name: 'test', title: null, version: '0' } },
    clock: clock.asClock(), interruptConfirmMs: 1_000, recycleDrainMs: 0,
    clientFactory: generation => {
      const peer = makePeer?.(generation) ?? new Peer(scenario, { clock, faults }); peers.push(peer); return peer;
    }, ...options });
  return { runtime, clock, faults, peers, peer: () => peers.at(-1),
    async close() {
      await runtime.shutdown({ interruptGraceMs: 0, exitGraceMs: 0 });
      for (const p of peers) { assert.deepEqual(p.steering, [], 'no turn/start while fake reports an active thread'); assert.equal(p.state, 'closed'); }
      faults.assertExhausted();
    } };
}
