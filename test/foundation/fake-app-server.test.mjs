// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { FakeAppServer, RPC_ERRORS, idKey } from './lib/fake-app-server.mjs';
import { FakeClock } from './lib/clock.mjs';
import { FaultPlan } from './lib/fault-plan.mjs';

/** Tiny JSONL peer used only to drive the fake in tests. */
function peer(stdin, stdout) {
  let buf = '';
  let nextId = 1;
  const messages = [];
  const waiters = [];
  stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      messages.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const waitFor = (pred) => {
    const hit = messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise(resolve => waiters.push({ pred, resolve }));
  };
  return {
    messages,
    write: (obj) => stdin.write(JSON.stringify(obj) + '\n'),
    request(method, params = {}) {
      const id = nextId++;
      stdin.write(JSON.stringify({ id, method, params }) + '\n');
      return waitFor(m => m.id === id && !('method' in m));
    },
    notify: (method, params = {}) => stdin.write(JSON.stringify({ method, params }) + '\n'),
    waitFor,
    waitNotification: (method, pred = () => true) => waitFor(m => m.method === method && !('id' in m) && pred(m)),
  };
}

async function ready(scenario = {}, opts = {}) {
  const server = new FakeAppServer(scenario, opts);
  const { stdin, stdout } = server.streams();
  const p = peer(stdin, stdout);
  await p.request('initialize', { clientInfo: { name: 'test', version: '0' } });
  p.notify('initialized');
  return { server, p };
}

test('requests before initialize get -32600 Not initialized; a second initialize gets Already initialized', async () => {
  const server = new FakeAppServer();
  const { stdin, stdout } = server.streams();
  const p = peer(stdin, stdout);
  const early = await p.request('thread/start', {});
  assert.deepEqual(early.error, { code: RPC_ERRORS.INVALID_REQUEST, message: 'Not initialized' });
  assert.ok((await p.request('initialize')).result);
  const again = await p.request('initialize');
  assert.deepEqual(again.error, { code: -32600, message: 'Already initialized' });
});

test('wire objects omit jsonrpc and unknown methods are rejected', async () => {
  const { p } = await ready();
  const res = await p.request('thread/fork', {});
  assert.equal(res.error.code, RPC_ERRORS.METHOD_NOT_FOUND);
  assert.ok(p.messages.every(m => !('jsonrpc' in m)));
});

test('default turn emits started, item snapshots and completed in order; requests are recorded', async () => {
  const { server, p } = await ready();
  const thread = (await p.request('thread/start', { cwd: '/w', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })).result.thread;
  await p.waitNotification('thread/started');
  const turn = (await p.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hi', text_elements: [] }], cwd: '/w', approvalPolicy: 'never', effort: 'medium' })).result.turn;
  const done = await p.waitNotification('turn/completed');
  assert.deepEqual(done.params, { threadId: thread.id, turn: { id: turn.id, status: 'completed' } });
  const methods = p.messages.filter(m => m.method && !('id' in m)).map(m => m.method);
  assert.deepEqual(methods, ['thread/started', 'turn/started', 'item/started', 'item/completed', 'turn/completed']);
  assert.deepEqual(Object.keys(server.requests('turn/start')[0].params).sort(), ['approvalPolicy', 'cwd', 'effort', 'input', 'threadId']);
});

test('server request ids start at 0, are typed, and duplicate or unknown replies are flagged', async () => {
  const scenario = { turns: [[
    { request: 'item/commandExecution/requestApproval', params: { threadId: '$threadId', turnId: '$turnId', itemId: 'cmd_1' } },
    { notify: 'serverRequest/resolved', params: { threadId: '$threadId', requestId: 0 } },
    { notify: 'item/completed', params: { threadId: '$threadId', turnId: '$turnId', item: { id: 'cmd_1', type: 'commandExecution', status: 'failed' } } },
    { complete: 'completed' },
  ]] };
  const { server, p } = await ready(scenario);
  const thread = (await p.request('thread/start', {})).result.thread;
  await p.request('turn/start', { threadId: thread.id });
  const req = await p.waitFor(m => m.method === 'item/commandExecution/requestApproval' && 'id' in m);
  assert.equal(req.id, 0);
  p.write({ id: '0', error: { code: -32000, message: 'wrong id type' } });
  p.write({ id: 0, error: { code: -32000, message: `commandExecution approval is not supported in exec mode for thread \`${thread.id}\`` } });
  p.write({ id: 0, error: { code: -32000, message: 'duplicate' } });
  await p.waitNotification('turn/completed');
  const kinds = server.anomalies().map(a => a.kind);
  assert.deepEqual(kinds, ['unknown-response-id', 'duplicate-response']);
  assert.notEqual(idKey(0), idKey('0'));
  const order = p.messages.filter(m => m.method).map(m => m.method).slice(-4);
  assert.deepEqual(order, ['item/commandExecution/requestApproval', 'serverRequest/resolved', 'item/completed', 'turn/completed']);
});

test('turn/interrupt answers {} and completes a hung turn as interrupted', async () => {
  const { p } = await ready({ turns: [[{ waitInterrupt: true }]] });
  const thread = (await p.request('thread/start', {})).result.thread;
  const turn = (await p.request('turn/start', { threadId: thread.id })).result.turn;
  await p.waitNotification('turn/started');
  assert.deepEqual((await p.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })).result, {});
  const done = await p.waitNotification('turn/completed');
  assert.equal(done.params.turn.status, 'interrupted');
});

test('delays use the injected clock, so a scripted 4 s turn completes only after advance', async () => {
  const clock = new FakeClock();
  const { p } = await ready({ turns: [[{ delayMs: 4000, notify: 'item/completed', params: { item: { id: 'i', type: 'agentMessage', text: 'late' } } }]] }, { clock });
  const thread = (await p.request('thread/start', {})).result.thread;
  await p.request('turn/start', { threadId: thread.id });
  await p.waitNotification('turn/started');
  assert.equal(clock.pendingCount(), 1);
  assert.equal(p.messages.some(m => m.method === 'turn/completed'), false);
  clock.advance(4000);
  const done = await p.waitNotification('turn/completed');
  assert.equal(done.params.turn.status, 'completed');
});

test('runtime faults: dropped interrupt response, dropped turn/completed, failed unsubscribe, killed child', async () => {
  const faults = new FaultPlan()
    .arm('runtime.dropInterruptResponse', { action: 'drop' })
    .arm('runtime.failUnsubscribe', { action: 'throw' });
  const { server, p } = await ready({ turns: [[{ waitInterrupt: true }]] }, { faults });
  const thread = (await p.request('thread/start', {})).result.thread;
  const turn = (await p.request('turn/start', { threadId: thread.id })).result.turn;
  p.write({ id: 99, method: 'turn/interrupt', params: { threadId: thread.id, turnId: turn.id } });
  await p.waitNotification('turn/completed');
  assert.equal(p.messages.some(m => m.id === 99), false, 'interrupt response suppressed');
  assert.equal((await p.request('thread/unsubscribe', { threadId: thread.id })).error.code, RPC_ERRORS.SERVER);
  faults.assertExhausted();
  assert.equal(server.log().filter(e => e.dir === 'fault').length, 1);

  const f2 = new FaultPlan().arm('runtime.dropTurnCompleted', { action: 'drop' });
  const r2 = await ready({}, { faults: f2 });
  const t2 = (await r2.p.request('thread/start', {})).result.thread;
  await r2.p.request('turn/start', { threadId: t2.id });
  await r2.p.waitNotification('item/completed');
  await new Promise(r => globalThis.setImmediate(r));
  assert.equal(r2.p.messages.some(m => m.method === 'turn/completed'), false);
  f2.assertExhausted();

  const f3 = new FaultPlan().arm('runtime.killChild', { action: 'kill' });
  const r3 = await ready({}, { faults: f3 });
  const exited = new Promise(resolve => r3.server.once('exit', (code, signal) => resolve(signal)));
  const t3 = (await r3.p.request('thread/start', {})).result.thread;
  await r3.p.request('turn/start', { threadId: t3.id });
  assert.equal(await exited, 'SIGKILL');
  assert.equal(r3.p.messages.some(m => m.method === 'item/started'), false);
});

test('malformed lines get -32700 and do not stop the reader', async () => {
  const { server, p } = await ready();
  server.receive('not json\n');
  server.receive('{broken\n');
  p.write('a JSON string, not an object');
  const parse = await p.waitFor(m => m.error?.code === RPC_ERRORS.PARSE);
  assert.equal(parse.id, null);
  await p.waitFor(m => m.error?.code === RPC_ERRORS.INVALID_REQUEST);
  assert.ok((await p.request('thread/start', {})).result.thread.id);
  assert.equal(server.anomalies().filter(a => a.kind === 'parse-error').length, 2);
});

test('subprocess entry: rejects unknown arguments, serves a scenario file and exits 0 on stdin EOF', async () => {
  const bin = fileURLToPath(new URL('./bin/fake-app-server.mjs', import.meta.url));
  const bad = spawn(process.execPath, [bin, '--session-source', 'exec'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  bad.stderr.on('data', c => { stderr += c; });
  const badCode = await new Promise(resolve => bad.on('exit', resolve));
  assert.notEqual(badCode, 0);
  assert.match(stderr, /unexpected argument/);

  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-fake-as-'));
  try {
    const file = join(dir, 'scenario.json');
    writeFileSync(file, JSON.stringify({ methods: { 'initialize': { userAgent: 'scenario-file' } } }));
    const child = spawn(process.execPath, [bin, '--scenario', file], { stdio: ['pipe', 'pipe', 'inherit'] });
    const p = peer(child.stdin, child.stdout);
    assert.equal((await p.request('initialize')).result.userAgent, 'scenario-file');
    const exit = new Promise(resolve => child.on('exit', resolve));
    child.stdin.end();
    assert.equal(await exit, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
