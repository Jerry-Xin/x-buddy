// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { FakeClock } from './foundation/lib/clock.mjs';
import { FakeOctoServer } from './foundation/lib/fake-octo.mjs';
import { FaultPlan } from './foundation/lib/fault-plan.mjs';
import { OctoApiClient, OctoApiError } from '../dist/transport/api-client.js';
import { BotOwnershipLock } from '../dist/transport/ownership-lock.js';
import { OctoTransport } from '../dist/transport/transport.js';

const reg = { robot_id: 'u_bot', im_token: 'im_fixture', ws_url: 'wss://fixture.example', owner_uid: 'u_owner', owner_channel_id: 'c_owner' };
const message = (from = 'u_alice', event) => ({ message_id: '9007199254740993', from_uid: from,
  channel_id: 'g_fixture', channel_type: 2, payload: { type: 1, content: 'hello', ...(event ? { event: { type: event } } : {}) } });
const flush = async () => { await immediate(); };

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-dev02-transport-'));
  const lock = new BotOwnershipLock(dir).acquire();
  const clock = new FakeClock({ monotonicMs: 0 });
  const requests = [], sockets = [];
  const api = options.api ?? { async request(method, path, body, opts) {
    requests.push({ method, path, body, opts });
    return path.includes('register') ? { ...reg } : undefined;
  } };
  const factory = callbacks => {
    const driver = { callbacks, closed: false, connects: 0,
      connect() { this.connects++; if (options.connect !== false) callbacks.onConnected(); },
      async disconnectAndWait() { this.closed = true; },
    };
    sockets.push(driver); return driver;
  };
  let transport;
  t.after(async () => { await transport?.stop(); lock.release(); rmSync(dir, { recursive: true, force: true }); });
  transport = new OctoTransport({ lock, api, clock, random: () => 0, socketFactory: factory, ...options });
  transport.onInbound(() => {});
  return { transport, lock, clock, requests, sockets };
}

test('DEV02 transport: lock and handler precede REST; metadata and owner identity', async t => {
  const fixture = setup(t);
  await fixture.transport.start();
  assert.equal(fixture.transport.isConnected(), true);
  assert.equal(fixture.transport.metrics.reconnects, 0);
  assert.deepEqual(fixture.transport.identity, { botUid: 'u_bot', ownerUid: 'u_owner', ownerChannelId: 'c_owner' });
  assert.deepEqual(fixture.requests[0].body, { agent_platform: 'codex-channel-octo', agent_version: '0.1.0', plugin_version: '0.1.0' });
  await fixture.transport.stop(); fixture.lock.assertHeld();
  assert.equal(fixture.clock.pendingCount(), 0);
  const unheld = new OctoTransport({ lock: fixture.lock, api: { request: async () => reg } });
  await assert.rejects(unheld.start(), /handler/);
  unheld.onInbound(() => {}); fixture.lock.release();
  await assert.rejects(unheld.start(), /ownership/);
});

test('DEV02 transport: 15s CONNACK deadline closes and schedules backoff with null fired handle', async t => {
  const { transport, clock, sockets } = setup(t, { connect: false });
  const rejected = assert.rejects(transport.start(), /15s deadline/);
  await flush(); clock.advance(14_999);
  assert.equal(sockets[0].closed, false);
  clock.advance(1); await rejected;
  assert.equal(sockets[0].closed, true);
  assert.equal(transport.hasPendingReconnect(), true);
  clock.advance(2250); await flush();
  assert.equal(sockets.length, 2);
  assert.equal(transport.hasPendingReconnect(), false);
  sockets[1].callbacks.onConnected();
  assert.equal(transport.isConnected(), true);
});

test('DEV02 transport: repeated kicks honor 60s refresh cooldown and recover <=10s after end', async t => {
  const { transport, clock, sockets, requests } = setup(t);
  await transport.start();
  sockets[0].callbacks.onError(new Error('Kicked'));
  sockets[0].callbacks.onDisconnected();
  assert.equal(sockets[0].closed, true);
  clock.advance(5000); await flush();
  assert.equal(transport.isConnected(), true);
  const refreshes = () => requests.filter(r => r.path.includes('force_refresh')).length;
  assert.equal(refreshes(), 1);
  sockets[1].callbacks.onError(new Error('Kicked'));
  clock.advance(5000); await flush();
  assert.equal(refreshes(), 1);
  // Last refresh was t=5000, cooldown ends t=65000, deferred delay=5000.
  clock.jumpWall(-3_600_000);
  clock.advance(59_999); await flush(); assert.equal(refreshes(), 1);
  clock.advance(1); await flush();
  assert.equal(refreshes(), 2);
  assert.equal(transport.isConnected(), true);
  assert.equal(transport.metrics.reconnects, 2);
});

test('DEV02 transport: failed registration retries within 60s and preserves empty owner', async t => {
  let calls = 0;
  const fixture = setup(t, { api: { async request(_method, path) {
    if (!path.includes('register')) return;
    calls++; if (calls === 1) throw new OctoApiError(503, 'fixture', 'ambiguous');
    return { ...reg, owner_uid: '', owner_channel_id: '' };
  } } });
  await assert.rejects(fixture.transport.start(), /registration/);
  assert.equal(fixture.transport.hasPendingReconnect(), true);
  fixture.clock.advance(5000); await flush();
  assert.equal(calls, 2);
  assert.equal(fixture.transport.isConnected(), true);
  assert.equal(fixture.transport.identity.ownerUid, '');
});

test('DEV02 transport: heartbeat 429 changes only its counter, 5xx never tears WS down', async t => {
  let status = 503, heartbeats = 0;
  const { transport, clock, sockets } = setup(t, { api: { async request(_method, path, _body, opts) {
    if (path.includes('register')) return { ...reg };
    assert.equal(opts.retry429, false); heartbeats++;
    if (status !== 200) throw new OctoApiError(status, 'fixture', 'ambiguous');
  } } });
  await transport.start(); clock.advance(30_000); await flush();
  assert.equal(transport.metrics.heartbeatFailureStreak, 1);
  status = 429;
  for (let i = 0; i < 4; i++) { clock.advance(30_000); await flush(); }
  assert.equal(transport.metrics.heartbeat429Count, 4);
  assert.equal(transport.metrics.heartbeatFailures, 1);
  assert.equal(transport.metrics.heartbeatFailureStreak, 1);
  assert.equal(sockets.length, 1); assert.equal(sockets[0].closed, false);
  assert.equal(transport.isConnected(), true);
  status = 200; clock.advance(30_000); await flush();
  assert.equal(transport.metrics.heartbeatFailureStreak, 0);
  assert.equal(heartbeats, 6);
});

test('DEV02 transport: stop during registration rejects startup and fences late result', async t => {
  let complete;
  const { transport, sockets, clock } = setup(t, { api: { request: () => new Promise(resolve => { complete = resolve; }) } });
  const rejected = assert.rejects(transport.start(), /stopped/);
  transport.stopIntake();
  complete({ ...reg });
  await transport.stop(); await rejected;
  assert.equal(sockets.length, 0);
  clock.advance(120_000); await flush(); assert.equal(sockets.length, 0);
  assert.equal(clock.pendingCount(), 0);
});

test('DEV02 transport: heartbeat is single flight and late completion after stop changes no counters', async t => {
  let finish, calls = 0;
  const { transport, clock } = setup(t, { api: { async request(_method, path) {
    if (path.includes('register')) return { ...reg };
    calls++; return new Promise((_resolve, reject) => { finish = () => reject(new OctoApiError(503, 'fixture', 'ambiguous')); });
  } } });
  await transport.start(); clock.advance(30_000); await flush();
  clock.advance(90_000); await flush(); assert.equal(calls, 1);
  transport.stopIntake(); finish(); await transport.stop();
  assert.equal(transport.metrics.heartbeatFailures, 0);
});

test('DEV02 transport: watchdog revives a stranded state but never races an owned retry', async t => {
  const { transport, clock, sockets } = setup(t);
  await transport.start();
  sockets[0].callbacks.onDisconnected();
  const count = sockets.length;
  // Fault injection: simulate an unforeseen path losing its deferred handle.
  // Existing timers and callbacks remain production implementations.
  clock.clearTimeout(transport.pending); transport.pending = null;
  clock.advance(60_000); await flush();
  assert.equal(transport.metrics.watchdogFires, 1);
  assert.equal(sockets.length, count + 1);
  clock.advance(60_000); await flush();
  assert.equal(transport.metrics.watchdogFires, 1);
  transport.stopIntake(); clock.advance(120_000); await flush();
  assert.equal(sockets.length, count + 1);
});

test('DEV02 transport: stop during refresh, stale callbacks and deferred retry cannot revive', async t => {
  let complete, calls = 0;
  const { transport, clock, sockets } = setup(t, { api: { async request(_method, path) {
    if (!path.includes('register')) return;
    calls++; if (calls === 1) return { ...reg };
    return new Promise(resolve => { complete = resolve; });
  } } });
  await transport.start(); sockets[0].callbacks.onError(new Error('kick'));
  clock.advance(5000); await flush();
  transport.stopIntake(); complete({ ...reg }); await transport.stop();
  sockets[0].callbacks.onConnected(); sockets[0].callbacks.onMessage(message());
  clock.advance(240_000); await flush();
  assert.equal(sockets.length, 1); assert.equal(calls, 2);
  assert.equal(transport.state, 'stopped'); assert.equal(clock.pendingCount(), 0);
});

test('DEV02 transport: URL policy covers initial registration, refresh and override', async t => {
  const insecure = ['ws', '://', '192.168.1.2'].join('');
  assert.throws(() => setup(t, { wsUrl: insecure }), /insecure/);
  for (const field of ['ws_url', 'robot_id', 'im_token', 'owner_uid']) {
    const invalid = field === 'ws_url' ? insecure : undefined;
    const fixture = setup(t, { api: { request: async () => ({ ...reg, [field]: invalid }) } });
    await assert.rejects(fixture.transport.start(), /registration/);
    assert.equal(fixture.sockets.length, 0);
  }
  let calls = 0;
  const fixture = setup(t, { api: { async request(_method, path) {
    if (!path.includes('register')) return;
    return { ...reg, ws_url: ++calls === 1 ? reg.ws_url : insecure };
  } } });
  await fixture.transport.start(); fixture.sockets[0].callbacks.onError(new Error('kick'));
  fixture.clock.advance(5000); await flush();
  assert.equal(fixture.sockets.length, 1);
  assert.equal(fixture.transport.hasPendingReconnect(), true);
});

test('DEV02 transport: inbound containment, self-echo and stopIntake before drain', async t => {
  const { transport, sockets } = setup(t);
  let seen = 0;
  transport.onInbound(() => { seen++; throw new Error('consumer failed'); });
  await transport.start();
  const peer = sockets[0].callbacks;
  peer.onMessage(message('u_bot')); assert.equal(seen, 0);
  peer.onMessage(message()); peer.onMessage(message('u_bot', 'mention_pref_updated'));
  assert.equal(seen, 2); assert.equal(transport.metrics.handlerFailures, 2);
  transport.stopIntake(); assert.equal(sockets[0].closed, true);
  peer.onMessage(message()); assert.equal(seen, 2);
});

async function until(fn, label) {
  const end = Date.now() + 3000;
  while (!fn()) { if (Date.now() > end) assert.fail(label); await delay(5); }
}

test('DEV02 transport: real WKSocket + fake Octo register, encrypted RECV/int64 ACK and kick', async t => {
  const server = new FakeOctoServer().addBot({ botToken: 'bf_fixture', robotId: 'u_bot', ownerUid: 'u_owner', ownerChannelId: 'u_owner' });
  await server.start();
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-dev02-wire-'));
  const lock = new BotOwnershipLock(dir).acquire();
  const clock = new FakeClock();
  const api = new OctoApiClient({ apiUrl: server.apiUrl, botToken: 'bf_fixture', clock });
  const transport = new OctoTransport({ lock, api, clock, random: () => 0 });
  const seen = [];
  transport.onInbound(msg => { seen.push(msg); throw new Error('consumer fixture'); });
  t.after(async () => { await transport.stop(); await server.stop(); lock.release(); rmSync(dir, { recursive: true, force: true }); });
  await transport.start();
  assert.equal(server.requests('register')[0].body.plugin_version, '0.1.0');
  const pushed = server.push({ uid: 'u_bot', fromUID: 'u_alice', channelID: 'g1', channelType: 2, payload: { type: 1, content: 'hello 世界' } });
  await until(() => seen.length === 1 && server.unacked().length === 0, 'wire RECVACK');
  assert.equal(seen[0].message_id, pushed.messageID);
  assert.equal(seen[0].payload.content, 'hello 世界');
  assert.equal(transport.metrics.handlerFailures, 1);
  server.kick('u_bot', { reasonCode: 1, reason: 'fixture kick' });
  await until(() => transport.hasPendingReconnect(), 'kick hands off');
  clock.advance(5000); await until(() => transport.isConnected(), 'refresh reconnect');
  assert.equal(server.requests('register').length, 2);
  transport.stopIntake();
  const acked = server.packets('RECVACK').length;
  server.push({ uid: 'u_bot', fromUID: 'u_alice', channelID: 'g1', channelType: 2, payload: { type: 1, content: 'during drain' } });
  await delay(20); assert.equal(server.packets('RECVACK').length, acked);
});

test('DEV02 transport: real rejected CONNACK closes old WS; stalled CONNACK hits 15s deadline', async t => {
  for (const mode of ['reject', 'stall']) {
    const faults = new FaultPlan();
    if (mode === 'stall') faults.arm('transport.dropConnack', { action: 'drop' });
    const server = new FakeOctoServer({ faults }).addBot({ botToken: 'bf_fixture', robotId: 'u_bot', ownerUid: '', ownerChannelId: '' });
    await server.start();
    if (mode === 'reject') server.overrideConnack({ reasonCode: 3 });
    const dir = mkdtempSync(join(tmpdir(), 'x-buddy-dev02-connack-'));
    const lock = new BotOwnershipLock(dir).acquire(), clock = new FakeClock();
    const api = new OctoApiClient({ apiUrl: server.apiUrl, botToken: 'bf_fixture', clock });
    const transport = new OctoTransport({ lock, api, clock, random: () => 0 });
    transport.onInbound(() => {});
    t.after(async () => { await transport.stop(); await server.stop(); lock.release(); rmSync(dir, { recursive: true, force: true }); });
    const rejected = assert.rejects(transport.start(), /connection failed|registration/);
    if (mode === 'stall') {
      await until(() => server.packets('CONNACK_DROPPED').length === 1, 'stall fixture active');
      clock.advance(15_000);
    }
    await rejected;
    await until(() => server.packets('CLOSE').length === 1, 'rejected/stalled WS closed');
    assert.equal(transport.hasPendingReconnect(), true);
    assert.equal(server.sessions().filter(s => s.open).length, 0);
    await transport.stop();
  }
});

test('DEV02 transport: real encrypted peer rapid closes refresh across socket generations and honor cooldown', async t => {
  const server = new FakeOctoServer().addBot({ botToken: 'bf_fixture', robotId: 'u_bot', ownerUid: '', ownerChannelId: '' });
  await server.start();
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-dev02-rapid-'));
  const lock = new BotOwnershipLock(dir).acquire(), clock = new FakeClock();
  const client = new OctoApiClient({ apiUrl: server.apiUrl, botToken: 'bf_fixture', clock });
  const paths = [], seen = [];
  const transport = new OctoTransport({ lock, clock, random: () => 0, api: {
    request(...args) { paths.push(args[1]); return client.request(...args); },
  } });
  transport.onInbound(msg => seen.push(msg));
  t.after(async () => { await transport.stop(); await server.stop(); lock.release(); rmSync(dir, { recursive: true, force: true }); });
  const registrations = () => paths.filter(path => path.includes('/register'));
  const refreshes = () => registrations().filter(path => path.includes('force_refresh'));
  async function receive() {
    const count = seen.length;
    const pushed = server.push({ uid: 'u_bot', fromUID: 'u_alice', channelID: 'g1', channelType: 2,
      payload: { type: 1, content: 'encrypted recovery fixture' } });
    await until(() => seen.length === count + 1 && server.unacked().length === 0, 'encrypted RECV/ACK after reconnect');
    assert.equal(seen.at(-1).message_id, pushed.messageID);
    assert.equal(seen.at(-1).payload.content, 'encrypted recovery fixture');
  }
  async function dropAndReconnect(ms) {
    server.dropConnections('u_bot');
    await until(() => transport.hasPendingReconnect(), 'abrupt post-CONNACK close hands off');
    clock.advance(ms);
    await until(() => transport.isConnected(), 'rapid-close recovery');
    await receive();
  }
  await transport.start(); await receive();
  await dropAndReconnect(2250);
  await dropAndReconnect(4500);
  assert.equal(refreshes().length, 0, 'two rapid closes use ordinary registration');
  await dropAndReconnect(5000);
  assert.equal(refreshes().length, 1, 'third rapid close forces credential refresh');
  assert.equal(registrations().length, 4);
  const firstRefresh = clock.monotonicNow();
  await dropAndReconnect(9000);
  await dropAndReconnect(18000);
  server.dropConnections('u_bot');
  await until(() => transport.hasPendingReconnect(), 'second rapid-close threshold');
  clock.advance(5000); await flush();
  assert.equal(transport.state, 'reconnecting');
  assert.equal(refreshes().length, 1);
  assert.equal(registrations().length, 6, 'cooldown must not fall back to ordinary registration');
  clock.jumpWall(3_600_000);
  clock.advance(firstRefresh + 60_000 - clock.monotonicNow()); await flush();
  assert.equal(refreshes().length, 1, 'wall jump cannot bypass monotonic cooldown');
  clock.advance(4999); await flush();
  assert.equal(refreshes().length, 1);
  clock.advance(1);
  await until(() => transport.isConnected(), 'deferred refresh after cooldown');
  assert.equal(refreshes().length, 2);
  assert.equal(registrations().length, 7);
  await receive();
  assert.equal(server.packets('CONNACK').length, 7);
});

test('DEV02 transport: rapid-close streak uses monotonic post-CONNACK duration and resets at 5s', async t => {
  const { transport, clock, sockets, requests } = setup(t);
  const refreshes = () => requests.filter(r => r.path.includes('force_refresh')).length;
  async function closeAndRetry(ms) {
    sockets.at(-1).callbacks.onDisconnected();
    clock.advance(ms); await flush();
    assert.equal(transport.isConnected(), true);
  }
  await transport.start();
  // Initial CONNACK is at monotonic zero, which is a valid timestamp.
  clock.jumpWall(3_600_000);
  await closeAndRetry(2250);
  clock.jumpWall(-7_200_000);
  await closeAndRetry(4500);
  clock.advance(5000);
  await closeAndRetry(9000);
  assert.equal(refreshes(), 0, 'a connection lasting exactly 5s breaks the streak');
  await closeAndRetry(18000);
  assert.equal(refreshes(), 0);
  await closeAndRetry(36000);
  assert.equal(refreshes(), 0);
  await closeAndRetry(5000);
  assert.equal(refreshes(), 1, 'three new rapid closes trigger refresh');
});

test('DEV02 transport: pre-CONNACK failures and stale generation callbacks cannot supply rapid closes', async t => {
  const { transport, clock, sockets, requests } = setup(t, { connect: false });
  const rejected = assert.rejects(transport.start(), /15s deadline/);
  await flush();
  for (const retry of [2250, 4500, 9000]) {
    sockets.at(-1).callbacks.onDisconnected();
    clock.advance(retry); await flush();
  }
  await rejected;
  assert.equal(requests.some(r => r.path.includes('force_refresh')), false);
  sockets.at(-1).callbacks.onConnected();
  sockets.at(-1).callbacks.onDisconnected();
  // A retired generation cannot reconnect itself or add more closes.
  for (let i = 0; i < 4; i++) {
    sockets[0].callbacks.onConnected();
    sockets[0].callbacks.onDisconnected();
    sockets[0].callbacks.onError(new Error('stale fixture'));
  }
  clock.advance(18000); await flush();
  assert.equal(requests.some(r => r.path.includes('force_refresh')), false);
  assert.equal(sockets.length, 5);
});

test('DEV02 transport: stop fences refresh queued by rapid closes and late registration results', async t => {
  for (const stopDuringRequest of [false, true]) {
    let finish, calls = 0;
    const { transport, clock, sockets } = setup(t, { api: { async request(_method, path) {
      if (!path.includes('register')) return;
      calls++;
      if (path.includes('force_refresh')) return new Promise(resolve => { finish = resolve; });
      return { ...reg };
    } } });
    await transport.start();
    for (const retry of [2250, 4500]) {
      sockets.at(-1).callbacks.onDisconnected();
      clock.advance(retry); await flush();
    }
    sockets.at(-1).callbacks.onDisconnected();
    if (stopDuringRequest) {
      clock.advance(5000); await flush();
      assert.equal(calls, 4);
      assert.equal(typeof finish, 'function');
    }
    transport.stopIntake();
    finish?.({ ...reg }); await transport.stop();
    for (const { callbacks } of sockets) {
      callbacks.onConnected(); callbacks.onDisconnected(); callbacks.onError(new Error('late fixture'));
    }
    clock.advance(240_000); await flush();
    assert.equal(calls, stopDuringRequest ? 4 : 3);
    assert.equal(sockets.length, 3);
    assert.equal(transport.state, 'stopped');
    assert.equal(clock.pendingCount(), 0);
  }
});
