// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from '../../dist/app-server/client.js';
import { BotCodexRuntime } from '../../dist/runtime/runtime.js';
import { request } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../foundation/bin/fake-app-server.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function eventually(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('process condition not reached within 1s');
}
function bot(t, scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x2560-runtime-'));
  const file = join(dir, 'scenario.json'); writeFileSync(file, JSON.stringify(scenario));
  const clients = []; const notifications = [];
  const config = { bin: process.execPath, args: [BIN, '--scenario', file],
    env: { PATH: process.env.PATH ?? '' }, clientInfo: { name: 'runtime-test', title: null, version: '0' } };
  const runtime = new BotCodexRuntime({ client: config, clientFactory: () => {
    const client = new AppServerClient(config); clients.push(client);
    client.subscribe(() => true, n => notifications.push(n)); return client;
  } });
  t.after(async () => {
    try {
      await runtime.shutdown({ interruptGraceMs: 1_000, exitGraceMs: 1_000 });
      for (const client of clients) { await client.closed; assert.equal(alive(client.pid), false, `child ${client.pid} exited`); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return { runtime, clients, notifications };
}

test('real client + foundation subprocess: lazy startup, completed result, confirmed exit and zero leftover PID', async t => {
  const b = bot(t); assert.equal(b.clients.length, 0);
  const out = await b.runtime.openTurn(request()).done;
  assert.equal(out.text, 'ok'); assert.equal(out.status, 'completed'); assert.equal(b.clients.length, 1);
  const pid = b.clients[0].pid; assert.equal(alive(pid), true);
  await b.runtime.shutdown({ interruptGraceMs: 1_000, exitGraceMs: 1_000 });
  assert.equal(b.clients[0].exitInfo.code, 0); assert.equal(alive(pid), false);
});

test('real two-bot process isolation; cancelling one does not interrupt or close the other', async t => {
  const a = bot(t, { defaultTurn: [{ waitInterrupt: true }] });
  const b = bot(t, { defaultTurn: [{ waitInterrupt: true }] });
  const ah = a.runtime.openTurn(request()); const bh = b.runtime.openTurn(request());
  await eventually(() => a.runtime.stats().activeTurns === 1 && b.runtime.stats().activeTurns === 1);
  assert.notEqual(a.clients[0].pid, b.clients[0].pid);
  assert.equal((await ah.cancel()).status, 'interrupted');
  await a.runtime.shutdown({ interruptGraceMs: 1_000, exitGraceMs: 1_000 });
  assert.equal(alive(b.clients[0].pid), true); assert.equal(b.runtime.stats().activeTurns, 1);
  assert.equal(b.notifications.filter(n => n.method === 'turn/completed').length, 0);
  assert.equal((await bh.cancel()).status, 'interrupted');
});

test('real child crash midturn fails once, no replay, no surviving PID', async t => {
  const b = bot(t, { faults: [{ point: 'runtime.killChild', action: 'kill', skip: 1 }],
    defaultTurn: [{ notify: 'item/started', params: { threadId: '$threadId', turnId: '$turnId', item: { id: '$itemId', type: 'agentMessage', text: '' } } }, { waitInterrupt: true }] });
  const h = b.runtime.openTurn(request()); let settlements = 0; void h.done.then(() => { settlements++; });
  const out = await h.done;
  assert.equal(out.status, 'failed'); assert.equal(out.error.class, 'AppServerExitedError'); assert.equal(out.termination, 'process-exited');
  assert.equal(b.clients.length, 1); assert.equal(settlements, 1); assert.equal(b.clients[0].exitInfo.signal, 'SIGKILL');
  assert.equal(b.notifications.filter(n => n.method === 'turn/started').length, 1); assert.equal(alive(b.clients[0].pid), false);
});

test('real shutdown cancels active and queued results before resolving, with no leaked child', async t => {
  const b = bot(t, { defaultTurn: [{ waitInterrupt: true }] });
  const a = b.runtime.openTurn(request('a')); const queued = b.runtime.openTurn(request('a')); const other = b.runtime.openTurn(request('b'));
  await eventually(() => b.runtime.stats().activeTurns === 2);
  await b.runtime.shutdown({ interruptGraceMs: 1_000, exitGraceMs: 1_000 });
  const outcomes = await Promise.all([a.done, queued.done, other.done]);
  assert.ok(outcomes.every(o => o.status === 'interrupted')); assert.equal(outcomes[1].termination, 'not-started');
  assert.equal(b.runtime.stats().contexts, 0); assert.equal(b.runtime.stats().state, 'closed');
  assert.equal(alive(b.clients[0].pid), false);
});

test('real dropped interrupt reply still finishes by matching terminal, never waits for 60s RPC timeout', async t => {
  const b = bot(t, { faults: [{ point: 'runtime.dropInterruptResponse', action: 'drop' }], defaultTurn: [{ waitInterrupt: true }] });
  const h = b.runtime.openTurn(request()); await eventually(() => b.runtime.stats().activeTurns === 1);
  const out = await h.cancel(); assert.equal(out.status, 'interrupted'); assert.equal(out.termination, 'terminal-confirmed');
  await b.runtime.shutdown({ interruptGraceMs: 0, exitGraceMs: 1_000 }); assert.equal(alive(b.clients[0].pid), false);
});
