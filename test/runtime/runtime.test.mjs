// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, tick, until, Peer, FaultPlan } from './helpers.mjs';

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
