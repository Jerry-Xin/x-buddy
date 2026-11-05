// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, tick, until, Peer, FaultPlan } from './helpers.mjs';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { state as hostState, config as hostConfig, reset as resetHost, assertClean } from './host-fixture.mjs';
import { clean, trace } from './lifecycle-fixture.mjs';
import { guardState } from './query-agent-harness.mjs';
import { createQueryExecutor, HostExecutionRefusal } from '../../dist/runtime/executor.js';
import { AppServerClient } from '../../dist/app-server/client.js';
import { AppServerRpcError, AppServerTimeoutError } from '../../dist/app-server/errors.js';

const { startBot, handleMessage } = await import('../../src/host/index.ts');
const { queryAgent, createQueryAgent } = await import('../../src/host/agent-bridge.ts');
const require = createRequire(import.meta.url);
const Sqlite = require(process.env.HOST_SQLITE);
const collect = async stream => { const values = []; for await (const value of stream) values.push(value); return values; };
const noWrites = prerequisite => error => error.name === 'HostExecutionRefusal' && error.status === 'NO-WRITES' && (!prerequisite || error.prerequisite === prerequisite);
const peerBin = fileURLToPath(new URL('../foundation/bin/fake-app-server.mjs', import.meta.url));

function callerSetup(dir, kind = 'app-server', extra = {}) {
  const generations = new Map(); const starts = []; const issued = []; const clients = [];
  let missing; let sdkCalls = 0;
  const setup = {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: join(dir, 'private-codex'), CODEX_OCTO_EXECUTOR: kind },
    bin: process.execPath, clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.142.3' },
    issuer: { prepare(input, scope) {
      const generation = generations.get(input.sessionKey) ?? 0;
      const ready = Object.fromEntries(['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects'].map(key => [key, key !== missing]));
      const turn = { laneKey: 'new:' + input.sessionKey, sessionKey: input.sessionKey, laneDeadlineMs: Date.now() + 10_000,
        ctx: { incarnationId: scope.incarnationId, origin: 'chat', principal: { uid: input.principalUid, role: 'member' },
          session: { sessionKey: input.sessionKey, resetGeneration: generation, channelId: input.channelId, channelType: input.channelType },
          policy: { tools: 'none' }, delivery: { logicalOrigin: input.messageId } } };
      issued.push(turn);
      return { request: turn, ready, assertCurrent() { assert.equal(generations.get(input.sessionKey) ?? 0, generation, 'revoked fixture permit'); } };
    } },
    runtime: { getResetGeneration: key => generations.get(key) ?? 0 },
    sdkFactory: () => { sdkCalls++; const thread = (id = 'sdk-thread') => ({ runStreamed: async prompt => ({ events: (async function* () {
      starts.push({ kind: 'sdk', id, prompt }); yield { type: 'thread.started', thread_id: id };
      yield { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'sdk reply' } }; yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
    })() }) }); return { startThread: () => thread(), resumeThread: id => thread(id) }; },
    appServerFactory: (options, generation) => {
      assert.equal(options.lifecycle, hostState.gateways.at(-1).testOwnership.lifecycle, 'same canonical lifecycle');
      starts.push({ kind: 'app-server', generation });
      const client = new AppServerClient({ ...options, args: [peerBin] }); clients.push(client); return client;
    },
    ...extra,
  };
  return { setup, generations, starts, issued, clients, sdkCalls: () => sdkCalls, missing: value => { missing = value; } };
}
const input = (sessionKey = 's', uid = 'member') => ({ sessionKey, principalUid: uid, channelId: 'channel', channelType: 1, messageId: 'message:' + sessionKey, messageSeq: 1 });

test('v147 guard: installed SDK, spawn, API and credential reads refuse before effects', async () => {
  await assert.rejects(import('@openai/codex-sdk'), /installed SDK import/);
  const cp = await import('node:child_process'); assert.throws(() => cp.spawn('codex', []), /constructor\/spawn/);
  assert.throws(() => fetch('https://owned.invalid'), /network\/API/);
  assert.throws(() => readFileSync(join(process.env.HOME, 'auth.json')), /credential read/);
  assert.equal(guardState.sdkImports, 1); assert.equal(guardState.network, 1); assert.equal(guardState.credentials, 1);
  assert.throws(() => createQueryExecutor({ env: { CODEX_OCTO_EXECUTOR: 'sdk' }, appServer: () => assert.fail('no fallback') }), noWrites('sdk-constructor-unavailable'));
});

test('v147 actual queryAgent default and actual handleMessage refuse missing issuer before writes', async () => {
  await assert.rejects(collect(queryAgent('inert', { sdk: {}, cwd: join(process.env.HOME, 'must-not-exist') })), noWrites('issuer-unavailable'));
  assert.equal(existsSync(join(process.env.HOME, 'must-not-exist')), false);
  let touched = 0; const deny = new Proxy({}, { get() { touched++; throw Error('write boundary reached'); } });
  await assert.rejects(handleMessage({}, {}, deny, deny, deny, deny, 'b'), noWrites('issuer-unavailable'));
  assert.equal(touched, 0);
});

for (const kind of ['sdk','app-server']) {
  test(`v147 actual startBot constructor-bound ${kind} caller, SDK rollback policy, owned SQL/lifecycle cleanup`, async () => {
    resetHost(); const dir = mkdtempSync(join(tmpdir(), 'caller-owned-')); const f = callerSetup(dir, kind); let stack;
    try {
      stack = await startBot(hostConfig(dir), true, f.setup);
      assert.deepEqual(stack.execution.cron, kind === 'sdk' ? { state: 'disabled', disabledReason: 'executor-sdk' } : { state: 'available' });
      const query = stack.execution.forTurn(input()); const callbacks = [];
      assert.deepEqual(await collect(query('hello', hostConfig(dir), undefined, undefined, { onSessionId: id => callbacks.push(id) })), [kind === 'sdk' ? 'sdk reply' : 'ok']);
      assert.equal(callbacks.length, 1); assert.equal(f.sdkCalls(), kind === 'sdk' ? 1 : 0);
      const inode = statSync(join(dir, 'cc-octo.db')).ino;
      await stack.shutdown(); assertClean(assert); assert.equal(existsSync(join(dir, 'gateway.lock')), false);
      assert.throws(() => stack.execution.forTurn(input()), noWrites('caller-stopped'));
      const db = new Sqlite(join(dir, 'cc-octo.db')); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); db.close();
      assert.equal(statSync(join(dir, 'cc-octo.db')).ino, inode);
      trace({ phase: 'caller-cleanup', kind, inode, clients: f.clients.map(c => ({ pid: c.pid, state: c.state, exit: c.exitInfo })), leaseAbsent: !existsSync(join(dir, 'gateway.lock')), integrity: 'ok' });
    } finally { if (stack) await stack.shutdown(); clean(dir); }
  });
}

for (const prerequisite of ['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects']) {
  test(`v147 missing ${prerequisite} stays typed NO-WRITES before caller effects`, async () => {
    resetHost(); const dir = mkdtempSync(join(tmpdir(), 'caller-owned-')); const f = callerSetup(dir); let stack;
    try {
      stack = await startBot(hostConfig(dir), true, f.setup); f.missing(prerequisite);
      const before = hostState.events.length;
      assert.throws(() => stack.execution.forTurn(input()), noWrites(prerequisite));
      assert.equal(hostState.events.length, before); assert.equal(f.starts.length, 0);
    } finally { if (stack) await stack.shutdown(); clean(dir); }
  });
}

test('v147 per-turn binding is immutable and independent; reset/late SDK events do not write history', async () => {
  resetHost(); const dir = mkdtempSync(join(tmpdir(), 'caller-owned-')); const f = callerSetup(dir, 'sdk'); let stack;
  try {
    stack = await startBot(hostConfig(dir), true, f.setup);
    const a = stack.execution.forTurn(input('a', 'alice')), b = stack.execution.forTurn(input('b', 'bob'));
    f.issued[0].ctx.principal.uid = 'mutated';
    assert.deepEqual(await collect(b('second', hostConfig(dir))), ['sdk reply']);
    f.generations.set('a', 1);
    await assert.rejects(collect(a('first', hostConfig(dir))), noWrites('permit-not-current'));
    assert.equal(f.sdkCalls(), 1, 'revoked first binding cannot construct SDK or borrow second binding');
  } finally { if (stack) await stack.shutdown(); clean(dir); }
});

test('v147 malformed turn envelopes refuse before issuer or write effects', async () => {
  resetHost(); const dir = mkdtempSync(join(tmpdir(), 'caller-owned-')); const f = callerSetup(dir); let stack;
  try {
    stack = await startBot(hostConfig(dir), true, f.setup); const before = hostState.events.length;
    for (const patch of [{ sessionKey: '' }, { principalUid: '' }, { channelId: '' }, { messageId: '' }, { channelType: 4 }, { messageSeq: -1 }]) {
      assert.throws(() => stack.execution.forTurn({ ...input(), ...patch }), noWrites('proof-missing'));
    }
    assert.equal(f.issued.length, 0); assert.equal(f.starts.length, 0); assert.equal(hostState.events.length, before);
  } finally { if (stack) await stack.shutdown(); clean(dir); }
});

test('v147 actual bridge rejects late SDK snapshots after reset; no partial text or callback resurrection', async () => {
  resetHost(); const dir = mkdtempSync(join(tmpdir(), 'caller-owned-')); const f = callerSetup(dir, 'sdk'); let stack;
  f.setup.sdkFactory = () => ({ startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'synthetic-thread' };
    f.generations.set('s', 1);
    yield { type: 'item.started', item: { id: 'late-command', type: 'command_execution', command: 'inert --private', aggregated_output: '', status: 'in_progress' } };
    yield { type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'must not persist' } };
  })() }) }) });
  try {
    stack = await startBot(hostConfig(dir), true, f.setup); const callbacks = [], text = [], progress = [];
    const query = stack.execution.forTurn(input());
    await assert.rejects(async () => { for await (const value of query('inert', hostConfig(dir), undefined, (...args) => progress.push(args), { onSessionId: id => callbacks.push(id) })) text.push(value); }, noWrites('permit-not-current'));
    assert.deepEqual(text, []); assert.deepEqual(callbacks, ['synthetic-thread']); assert.deepEqual(progress, []);
  } finally { if (stack) await stack.shutdown(); clean(dir); }
});

test('v147 ambiguous turn acceptance fails once, retains terminal/exit proof and never selects SDK', async () => {
  let starts = 0, fallback = 0;
  const f = fixture({ makePeer: () => { const peer = new Peer(); const actual = peer.request.bind(peer);
    peer.request = (method, params, opts) => { if (method === 'turn/start') { starts++; return Promise.reject(new AppServerTimeoutError(method, 1)); } return actual(method, params, opts); };
    return peer; } });
  try {
    const executor = createQueryExecutor({ env: {}, sdkFactory: () => { fallback++; assert.fail('fallback forbidden'); }, appServer: () => ({ runtime: f.runtime, request: request(), assertCurrent() {} }) });
    const run = await executor.startThread({ workingDirectory: join(process.env.HOME, 'inert') }).runStreamed('inert');
    await assert.rejects(collect(run.events), /timed out/); assert.equal(starts, 1); assert.equal(fallback, 0);
  } finally { await f.close(); }
});

test('v147 two native client generations close before DB; DB-close failure retains same owner for ordinary retry', async () => {
  resetHost(); const dir = mkdtempSync(join(tmpdir(), 'caller-owned-')); const f = callerSetup(dir); let stack;
  try {
    stack = await startBot(hostConfig(dir), true, f.setup);
    await collect(stack.execution.forTurn(input('a'))('first', hostConfig(dir)));
    await f.clients[0].close({ graceMs: 0 });
    await collect(stack.execution.forTurn(input('b'))('second', hostConfig(dir)));
    assert.equal(f.clients.length, 2);
    const lease = readFileSync(join(dir, 'gateway.lock')); const inode = statSync(join(dir, 'cc-octo.db')).ino;
    hostState.hook = name => { if (name === 'db-close') { assert.ok(f.clients.every(c => c.state === 'closed')); assert.equal(JSON.parse(readFileSync(join(dir, 'app-server-child.json'))).state, 'exited'); } };
    hostState.fail = 'db-close'; await assert.rejects(stack.shutdown(), /db-close/);
    assert.deepEqual(readFileSync(join(dir, 'gateway.lock')), lease); assert.equal(hostState.dbs.size, 1);
    hostState.fail = ''; await stack.shutdown(); assertClean(assert); assert.equal(existsSync(join(dir, 'gateway.lock')), false);
    trace({ phase: 'caller-generation-retry', inode, clients: f.clients.map(c => ({ pid: c.pid, state: c.state, exit: c.exitInfo })), dbs: hostState.dbs.size, leaseAbsent: true });
  } finally { hostState.fail = ''; hostState.hook = null; if (stack) await stack.shutdown(); clean(dir); }
});

const { AbortController } = globalThis;

const wait = [{ waitInterrupt: true }];
const terminal = (threadId, turnId, status = 'completed') => ({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });

test('lazy singleton readiness; completed snapshots and strict thread/turn params; always unsubscribes', async () => {
  const f = fixture(); assert.equal(f.peers.length, 0);
  await Promise.all([f.runtime.ensureReady(), f.runtime.ensureReady()]); assert.equal(f.peers.length, 1);
  const h = f.runtime.openTurn(request()); const out = await h.done;
  assert.equal(out.status, 'completed'); assert.equal(out.text, 'ok'); assert.equal(out.termination, 'terminal-confirmed');
  assert.equal(f.runtime.stats().contexts, 0);
  assert.deepEqual(f.peer().requests.filter(r => !['initialize'].includes(r.method)).map(r => r.method), ['thread/start', 'turn/start', 'thread/unsubscribe']);
  assert.deepEqual(f.peer().server.requests('turn/start')[0].params, { threadId: 'thr_1', input: [{ type: 'text', text: 'hello 世界', text_elements: [] }], cwd: '/tmp/runtime-fixture', effort: 'low', approvalPolicy: 'never' });
  await f.close(); assert.equal(f.clock.pendingCount(), 0);
});

test('failed and interrupted terminal statuses never return a successful partial answer', async () => {
  for (const status of ['failed', 'interrupted']) {
    const f = fixture({ scenario: { defaultTurn: [{ complete: status }] } });
    const out = await f.runtime.openTurn(request()).done;
    assert.equal(out.status, status); assert.equal(out.text, ''); assert.equal(out.error.class, status === 'failed' ? 'TurnFailedError' : 'TurnInterruptedError');
    await f.close();
  }
});

test('terminal before turn/start response is buffered and bound to immutable host authority before replay', async () => {
  const f = fixture(); await f.runtime.ensureReady(); f.peer().holds.add('turn/start');
  const req = request(); const h = f.runtime.openTurn(req);
  req.ctx.session.resetGeneration = 99;
  await until(() => f.peer().held.size > 0);
  let done = false; void h.done.then(() => { done = true; }); await tick(); assert.equal(done, false);
  f.peer().release('turn/start'); assert.equal((await h.done).status, 'completed');
  await f.close();
});

test('same-session FIFO rekeys first-turn lane; fresh mapping resolved at dispatch; sentinel resume', async () => {
  let mapping;
  const f = fixture({ scenario: { turns: [wait] }, options: { resolveThreadId: () => mapping } });
  const a = f.runtime.openTurn(request('a', { onThread: id => { mapping = id; } }));
  const b = f.runtime.openTurn(request('a'));
  await until(() => f.peer()?.server.requests('turn/start').length === 1);
  await a.cancel(); const out = await b.done;
  assert.equal(out.threadId, 'thr_1'); assert.equal(out.status, 'completed');
  assert.equal(f.peer().server.requests('thread/start').length, 1);
  const resume = f.peer().server.requests('thread/resume')[0].params;
  assert.deepEqual(resume.config, {}); assert.equal(resume.excludeTurns, true); assert.equal(resume.approvalPolicy, 'never');
  await f.close();
});

test('different threads run concurrently; at most three queued and deadline/abort entries never send RPC', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } });
  const a = f.runtime.openTurn(request('a')); const other = f.runtime.openTurn(request('b'));
  await until(() => f.runtime.stats().activeTurns === 2);
  const deadline = f.runtime.openTurn(request('a', { laneDeadlineMs: f.clock.now() + 20 }));
  const abort = new AbortController(); const aborted = f.runtime.openTurn(request('a', { signal: abort.signal }));
  const third = f.runtime.openTurn(request('a')); const overflow = f.runtime.openTurn(request('a'));
  assert.equal((await overflow.done).error.class, 'LaneOverflowError');
  f.clock.advance(20); abort.abort();
  assert.equal((await deadline.done).error.class, 'LaneDeadlineError'); assert.equal((await aborted.done).error.class, 'TurnInterruptedError');
  await third.cancel(); assert.equal(f.peer().server.requests('turn/start').length, 2);
  await Promise.all([a.cancel(), other.cancel()]); await f.close();
});

test('dropped interrupt response does not delay matching terminal; late completion cannot complete a new turn', async () => {
  const faults = new FaultPlan().arm('runtime.dropInterruptResponse', { action: 'drop' });
  const f = fixture({ faults, scenario: { defaultTurn: wait } });
  const a = f.runtime.openTurn(request()); await until(() => f.runtime.stats().activeTurns === 1);
  const out = await a.cancel(); assert.equal(out.termination, 'terminal-confirmed');
  const b = f.runtime.openTurn(request()); await until(() => f.peer().server.requests('turn/start').length === 2);
  let finished = false; void b.done.then(() => { finished = true; });
  f.peer().inject(terminal(out.threadId, out.turnId)); await tick(); assert.equal(finished, false);
  await b.cancel(); await f.close();
});

test('interrupt acknowledgement is not termination; dropped terminal quarantines and fails all waiters', async () => {
  const faults = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
  const f = fixture({ faults, scenario: { defaultTurn: wait } });
  const a = f.runtime.openTurn(request()); await until(() => f.runtime.stats().activeTurns === 1);
  const queued = f.runtime.openTurn(request()); const cancelled = a.cancel(); await tick();
  assert.equal(f.peer().server.requests('turn/start').length, 1); assert.equal(f.runtime.isThreadBusy('thr_1'), true);
  f.clock.advance(999); await tick(); assert.equal(f.peer().closeCount, 0);
  f.clock.advance(1); assert.equal((await cancelled).termination, 'quarantined');
  assert.equal((await queued.done).error.class, 'ThreadQuarantinedError');
  await tick(); assert.equal(f.runtime.stats().state, 'idle');
  await f.close();
});

test('unsubscribe retries exactly once; failure quarantines before subsequent resume', async () => {
  const faults = new FaultPlan().arm('runtime.failUnsubscribe', { action: 'throw', times: 2 });
  const f = fixture({ faults }); const out = await f.runtime.openTurn(request()).done;
  assert.equal(out.error.class, 'ThreadQuarantinedError'); assert.equal(out.termination, 'quarantined');
  assert.equal(f.peer().server.requests('thread/unsubscribe').length, 2);
  await tick(); assert.equal(f.peer().closeCount, 1); await f.close();
});

test('stale generation notification after recycle is dropped; new generation is independent', async () => {
  const faults = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
  const f = fixture({ faults, scenario: { turns: [wait] } });
  const a = f.runtime.openTurn(request()); await until(() => f.runtime.stats().activeTurns === 1);
  const old = f.peer(); const cancellation = a.cancel(); await tick(); f.clock.advance(1_000); await cancellation; await tick();
  const b = f.runtime.openTurn(request('b')); await until(() => f.peers.length === 2 && f.runtime.stats().activeTurns === 1);
  old.inject(terminal('thr_1', 'turn_1'), true); await tick(); assert.equal(f.runtime.stats().staleGenerationEvents, 1);
  assert.equal(f.runtime.stats().activeTurns, 1); await b.cancel(); await f.close();
});

test('reset during delayed first thread response fences mapping callback and turn/start; next generation waits for recycle', async () => {
  const f = fixture(); await f.runtime.ensureReady(); const old = f.peer(); old.holds.add('thread/start'); let callbacks = 0;
  const a = f.runtime.openTurn(request('a', { onThread: () => { callbacks++; } }));
  await until(() => old.held.size > 0);
  await f.runtime.cancelSession('a'); old.release('thread/start'); await tick();
  assert.equal((await a.done).error.class, 'ResetCancelledError'); assert.equal(callbacks, 0); assert.equal(old.server.requests('turn/start').length, 0);
  const next = request('a'); next.ctx.session.resetGeneration = 1;
  assert.equal((await f.runtime.openTurn(next).done).status, 'completed'); await f.close();
});

test('host generation already incremented is not incremented twice; queued old and active work are reset-cancelled', async () => {
  let gen = 0;
  const f = fixture({ scenario: { turns: [wait] }, options: { getResetGeneration: () => gen } });
  const a = f.runtime.openTurn(request()); const b = f.runtime.openTurn(request());
  await until(() => f.runtime.stats().activeTurns === 1); gen = 1; await f.runtime.cancelSession('a');
  assert.equal((await a.done).error.class, 'ResetCancelledError'); assert.equal((await b.done).error.class, 'ResetCancelledError');
  const next = request(); next.ctx.session.resetGeneration = 1;
  assert.equal((await f.runtime.openTurn(next).done).status, 'completed');
  assert.equal(f.peer().server.requests('thread/start').length, 2); await f.close();
});

test('abort during readiness removes admission without RPC and without killing shared readiness', async () => {
  const f = fixture({ makePeer: () => { const p = new Peer(); p.holds.add('initialize'); return p; } });
  const signal = new AbortController(); const h = f.runtime.openTurn(request('a', { signal: signal.signal }));
  await until(() => f.peer()?.held.size > 0); signal.abort();
  assert.equal((await h.done).termination, 'not-started'); f.peer().release('initialize'); await tick();
  assert.equal(f.peer().server.requests('thread/start').length, 0); await f.close();
});

test('ceiling starts at accepted turn/start and interrupts through terminal confirmation', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } });
  const h = f.runtime.openTurn(request('a', { ceilingMs: 10_000 }));
  await until(() => f.runtime.stats().activeTurns === 1); f.clock.advance(9_999); await tick();
  assert.equal(f.peer().server.requests('turn/interrupt').length, 0);
  f.clock.advance(1); const out = await h.done; assert.equal(out.error.class, 'TurnCeilingError'); assert.equal(out.termination, 'terminal-confirmed'); await f.close();
});

test('shutdown bypasses recycle drain with two sibling threads; all consumers settle and timers clear', async () => {
  const faults = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
  const f = fixture({ faults, scenario: { defaultTurn: wait }, options: { recycleDrainMs: 120_000 } });
  const a = f.runtime.openTurn(request('a')); const b = f.runtime.openTurn(request('b')); const c = f.runtime.openTurn(request('c'));
  await until(() => f.runtime.stats().activeTurns === 3); const cancel = a.cancel(); await tick(); f.clock.advance(1_000); await cancel;
  assert.equal(f.runtime.stats().state, 'recycling');
  await f.close(); assert.equal((await b.done).status, 'interrupted'); assert.equal((await c.done).status, 'interrupted'); assert.equal(f.clock.pendingCount(), 0);
});

test('crash midturn fails without replay; backoff uses monotonic clock; five crashes open 60s circuit', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } });
  for (let i = 0; i < 5; i++) {
    const h = f.runtime.openTurn(request(`a${i}`));
    if (i) { await tick(); const oldCount = f.peers.length; f.clock.jumpWall(-1_000_000); f.clock.advance(1_000 * 2 ** (i - 1) - 1); await tick(); assert.equal(f.peers.length, oldCount); f.clock.advance(1); }
    await until(() => f.runtime.stats().activeTurns === 1);
    f.peer().server.exit({ signal: 'SIGKILL' });
    const out = await h.done; assert.equal(out.error.class, 'AppServerExitedError'); assert.equal(out.termination, 'process-exited');
    assert.equal(f.peer().server.requests('turn/start').length, 1);
  }
  assert.equal(f.runtime.stats().state, 'circuit-open');
  assert.equal((await f.runtime.openTurn(request('denied')).done).error.class, 'RuntimeUnavailableError');
  f.clock.advance(59_999); await assert.rejects(f.runtime.ensureReady(), /unavailable/);
  f.clock.advance(1); await f.runtime.ensureReady(); assert.equal(f.peers.length, 6); await f.close();
});

test('unconfirmed process exit retains ownership and prohibits a replacement child', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } });
  const h = f.runtime.openTurn(request()); await until(() => f.runtime.stats().activeTurns === 1);
  const peer = f.peer(); peer.closeBlocked = true;
  const stop = f.runtime.shutdown({ interruptGraceMs: 0, exitGraceMs: 0 });
  const rejected = assert.rejects(stop, /child exit not confirmed/); await tick(); f.clock.advance(2_000); await rejected;
  assert.equal(f.runtime.stats().state, 'unavailable'); await assert.rejects(f.runtime.ensureReady(), /unavailable/); assert.equal(f.peers.length, 1);
  peer.server.exit({ code: 0 }); await tick(); await h.done; assert.equal(peer.state, 'closed');
});

test('invalid nonfinite bounds fail; isolated cron lanes do not share destination lane or mapping callback', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } }); let mappings = 0;
  const r = request(); r.sessionKey = undefined; r.ctx.origin = 'cron'; r.onThread = () => { mappings++; };
  const a = f.runtime.openTurn({ ...r, laneKey: 'new:cron:run1' }); const b = f.runtime.openTurn({ ...r, laneKey: 'new:cron:run2' });
  await until(() => f.runtime.stats().activeTurns === 2); assert.equal(mappings, 0);
  assert.equal((await f.runtime.openTurn(request('nan', { ceilingMs: NaN })).done).error.class, 'RuntimeUnavailableError');
  await Promise.all([a.cancel(), b.cancel()]); await f.close();
});

test('one consumer; generator abandonment cancels the single driver and never starts a duplicate', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } }); const generator = f.runtime.runTurn(request());
  assert.equal((await generator.next()).value.method, 'turn/started');
  await generator.return(); assert.equal(f.peer().server.requests('turn/start').length, 1);
  assert.equal(f.peer().server.requests('turn/interrupt').length, 1); assert.equal(f.runtime.stats().contexts, 0); await f.close();
});

test('external reset generation fences completed snapshots even before the host cancellation call arrives', async () => {
  let generation = 0;
  const f = fixture({ scenario: { defaultTurn: wait }, options: { getResetGeneration: () => generation } });
  const h = f.runtime.openTurn(request()); await until(() => f.runtime.stats().activeTurns === 1);
  generation = 1;
  f.peer().inject({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'late', type: 'agentMessage', text: 'must not publish' } } });
  const out = await h.done; assert.equal(out.error.class, 'ResetCancelledError'); assert.equal(out.text, ''); await f.close();
});

test('current host mapping overrides stale captured resumeThreadId when work dispatches', async () => {
  const f = fixture({ options: { resolveThreadId: () => undefined } });
  const h = f.runtime.openTurn(request('a', { resumeThreadId: 'retired-thread' }));
  assert.equal((await h.done).status, 'completed'); assert.equal(f.peer().server.requests('thread/resume').length, 0); await f.close();
});

test('cancellation during ambiguous turn/start cannot release the lane or emit a delayed result', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } }); await f.runtime.ensureReady(); f.peer().holds.add('turn/start');
  const h = f.runtime.openTurn(request()); await until(() => f.peer().held.size > 0);
  const old = f.peer(); const out = await h.cancel(); assert.equal(out.termination, 'quarantined');
  old.release('turn/start'); await tick(); assert.equal(f.runtime.stats().contexts, 0); assert.equal(old.state, 'closed'); await f.close();
});

test('event overflow interrupts instead of pausing stdout or growing an unbounded queue', async () => {
  const f = fixture({ scenario: { defaultTurn: wait } });
  const h = f.runtime.openTurn(request()); await until(() => f.runtime.stats().activeTurns === 1);
  for (let i = 0; i < 10_001; i++) f.peer().inject({ method: 'item/started', params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: `i${i}`, type: 'agentMessage' } } });
  const out = await h.done; assert.equal(out.error.class, 'TurnFailedError'); assert.match(out.error.message, /buffer overflow/);
  assert.equal(f.peer().server.requests('turn/interrupt').length, 1); await f.close();
});

test('shutdown while initialization is delayed closes the owned child before readiness can publish', async () => {
  const f = fixture({ makePeer: () => { const p = new Peer(); p.holds.add('initialize'); return p; } });
  const h = f.runtime.openTurn(request()); await until(() => f.peer()?.held.size > 0);
  await f.close(); assert.equal((await h.done).termination, 'not-started'); assert.equal(f.peer().server.requests('thread/start').length, 0);
});

test('recycle lets two sibling turns drain, interrupts remaining turns after the bound, then confirms exit', async () => {
  const faults = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
  const f = fixture({ faults, scenario: { defaultTurn: wait }, options: { recycleDrainMs: 2_000 } });
  const a = f.runtime.openTurn(request('a')); const b = f.runtime.openTurn(request('b')); const c = f.runtime.openTurn(request('c'));
  await until(() => f.runtime.stats().activeTurns === 3);
  const cancel = a.cancel(); await tick(); f.clock.advance(1_000); await cancel;
  const denied = await f.runtime.openTurn(request('d')).done; assert.equal(denied.error.class, 'RuntimeUnavailableError');
  f.clock.advance(1_999); await tick(); assert.equal(f.peer().closeCount, 0); assert.equal(f.runtime.stats().activeTurns, 2);
  f.clock.advance(1); await tick(); assert.equal((await b.done).error.class, 'AppServerExitedError'); assert.equal((await c.done).error.class, 'AppServerExitedError');
  assert.equal(f.peer().closeCount, 1); await f.close();
});

test('armed mid-turn kill fault is consumed and produces process-exited outcome without replay', async () => {
  const faults = new FaultPlan().arm('runtime.killChild', { action: 'kill', skip: 1 });
  const f = fixture({ faults, scenario: { defaultTurn: [{ notify: 'item/started', params: { threadId: '$threadId', turnId: '$turnId', item: { id: '$itemId', type: 'agentMessage' } } }, { complete: 'completed' }] } });
  const out = await f.runtime.openTurn(request()).done; assert.equal(out.error.class, 'AppServerExitedError'); assert.equal(out.termination, 'process-exited');
  assert.equal(f.peer().server.requests('turn/start').length, 1); await f.close();
});

for (const heldReplacement of [false, true]) {
  test(`crash retires recycle without changing replacement readiness or admission (held=${heldReplacement})`, async () => {
    const faults = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
    const f = fixture({ faults, options: { recycleDrainMs: 120_000 },
      makePeer: generation => {
        const p = new Peer({ defaultTurn: wait }, { faults });
        if (generation === 2 && heldReplacement) p.holds.add('initialize');
        return p;
      } });
    try {
      const a = f.runtime.openTurn(request('a')); const b = f.runtime.openTurn(request('b'));
      await until(() => f.runtime.stats().activeTurns === 2);
      const old = f.peer(); const cancel = a.cancel(); await tick();
      f.clock.advance(1_000); await cancel;
      assert.equal(f.runtime.stats().state, 'recycling');
      let replacement;
      old.closed.then(() => {
        f.clock.advance(1_000);
        replacement = f.runtime.openTurn(request('next'));
      });
      old.server.exit({ signal: 'SIGKILL' }); await tick();
      assert.equal((await b.done).termination, 'process-exited');
      assert.equal(f.peers.length, 2); assert.equal(f.runtime.stats().generation, 2);
      assert.equal(old.closeCount, 0, 'retired recovery must not close an already exited owner');
      assert.equal(f.runtime.stats().state, heldReplacement ? 'starting' : 'ready');
      if (heldReplacement) { f.peer().release('initialize'); await tick(); }
      await until(() => f.runtime.stats().activeTurns === 1);
      const successor = f.runtime.openTurn(request('after'));
      await until(() => f.runtime.stats().activeTurns === 2, 'replacement accepts another lane');
      // Reused wire IDs, late snapshots and terminal events from the retired owner stay fenced.
      old.inject({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'late', type: 'agentMessage', text: 'retired' } } }, true);
      old.inject(terminal('thr_1', 'turn_1'), true); await tick();
      assert.equal(f.runtime.stats().activeTurns, 2); assert.equal(f.runtime.stats().state, 'ready');
      assert.equal(f.runtime.stats().staleGenerationEvents, 2);
      assert.equal((await replacement.cancel()).text, ''); await successor.cancel();
      // The new generation can independently recycle after the old recovery has retired.
      faults.arm('runtime.dropTurnCompleted', { action: 'drop' });
      const again = f.runtime.openTurn(request('again')); await until(() => f.runtime.stats().activeTurns === 1);
      const cancelled = again.cancel(); await tick(); f.clock.advance(1_000); await cancelled; await tick();
      assert.equal(f.peer().closeCount, 1); assert.equal(f.runtime.stats().state, 'idle');
      assert.equal(f.runtime.stats().recycles, 2);
      await f.runtime.ensureReady(); assert.equal(f.runtime.stats().generation, 3);
    } finally { await f.close(); }
    assert.equal(f.clock.pendingCount(), 0);
  });
}

test('crash during recycle preserves backoff and does not close or admit a live predecessor', async () => {
  const faults = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
  const f = fixture({ faults, scenario: { defaultTurn: wait }, options: { recycleDrainMs: 120_000 } });
  try {
    const a = f.runtime.openTurn(request('a')); const sibling = f.runtime.openTurn(request('b'));
    await until(() => f.runtime.stats().activeTurns === 2);
    const old = f.peer(); const cancel = a.cancel(); await tick(); f.clock.advance(1_000); await cancel;
    assert.equal((await f.runtime.openTurn(request('denied')).done).error.class, 'RuntimeUnavailableError');
    old.server.exit({ signal: 'SIGKILL' }); await tick(); await sibling.done;
    assert.equal(f.runtime.stats().state, 'crashed'); assert.equal(old.closeCount, 0);
    const next = f.runtime.openTurn(request('next')); await tick();
    f.clock.advance(999); await tick(); assert.equal(f.peers.length, 1);
    f.clock.advance(1); await until(() => f.runtime.stats().activeTurns === 1);
    assert.equal(f.runtime.stats().state, 'ready'); await next.cancel();
  } finally { await f.close(); }
});
