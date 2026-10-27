// SPDX-License-Identifier: Apache-2.0
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from '../../dist/app-server/client.js';
import {
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
  AppServerUnavailableError,
} from '../../dist/app-server/errors.js';
import { OPT_OUT_NOTIFICATION_METHODS } from '../../dist/app-server/protocol.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const CLIENT_INFO = { name: 'codex_sdk_ts', title: null, version: '0.1.0' };

// Every spawned fake is closed even when an assertion fails, so a failing test cannot hang the runner.
const live = new Set();
afterEach(async () => {
  const clients = [...live];
  live.clear();
  await Promise.all(clients.map(c => c.close({ graceMs: 0 })));
});

function makeClient(scenario = 'default', extra = {}) {
  const events = [];
  const exits = [];
  const client = new AppServerClient({
    bin: process.execPath,
    args: [FAKE, scenario],
    env: { PATH: process.env.PATH ?? '' },
    clientInfo: CLIENT_INFO,
    onProtocolEvent: e => events.push(e),
    onExit: info => exits.push(info),
    ...extra,
  });
  live.add(client);
  return { client, events, exits };
}

async function started(scenario, extra) {
  const ctx = makeClient(scenario, extra);
  await ctx.client.start();
  return ctx;
}

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('handshake sends initialize with experimentalApi and the four opted-out delta methods, then initialized', async () => {
  const { client } = makeClient();
  assert.equal(client.state, 'idle');
  const init = await client.start();
  assert.equal(client.state, 'ready');
  assert.equal(init.codexHome, '/fake/codex-home');
  assert.deepEqual(await client.request('test/initializeParams'), {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [...OPT_OUT_NOTIFICATION_METHODS] },
  });
  const received = await client.request('test/received');
  assert.deepEqual(received.map(m => m.method), ['initialize', 'initialized', 'test/initializeParams']);
  assert.ok(received.every(m => !Object.hasOwn(m, 'jsonrpc')), 'frames omit jsonrpc');
  assert.ok(!Object.hasOwn(received[1], 'id'), 'initialized is a notification');
  await assert.rejects(client.start(), AppServerUnavailableError);
  await client.close({ graceMs: 1000 });
  assert.equal(client.state, 'closed');
  assert.equal(client.exitInfo.code, 0);
});

test('requests are refused before the handshake completes', async () => {
  const { client } = makeClient();
  await assert.rejects(client.request('test/echo', {}), AppServerUnavailableError);
  assert.throws(() => client.notify('x'), AppServerUnavailableError);
  await client.close({ graceMs: 0 });
});

test('concurrent requests correlate by id regardless of response order', async () => {
  const { client } = await started();
  const slow = client.request('test/later', { delayMs: 50 });
  const fast = await Promise.all([1, 2, 3].map(n => client.request('test/echo', { n })));
  assert.deepEqual(fast, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(await slow, { late: true });
  assert.equal(client.pendingRequests, 0);
  await client.close({ graceMs: 1000 });
});

test('RPC errors reject with the pinned message format', async () => {
  const { client } = await started();
  const err = await client.request('thread/resume', { threadId: 'T1' }).catch(e => e);
  assert.ok(err instanceof AppServerRpcError);
  assert.equal(err.message, 'thread/resume failed: no rollout found for thread id T1 (code -32600)');
  await assert.rejects(client.request('no/such'), /no\/such failed: Invalid request: unknown variant `no\/such` \(code -32600\)/);
  await client.close({ graceMs: 1000 });
});

test('partial and byte-split frames, CRLF, blank and junk lines are handled without crashing the reader', async () => {
  const { client, events } = await started();
  assert.deepEqual(await client.request('test/split', { text: 'héllo 世界', chunk: 3 }), { text: 'héllo 世界' });
  const notes = [];
  client.subscribe(n => n.method === 'test/n', n => notes.push(n.params.i));
  assert.deepEqual(await client.request('test/batch'), { ok: true });
  assert.deepEqual(notes, [1, 2]);
  assert.deepEqual(events.map(e => e.type), ['invalid-frame', 'invalid-frame', 'unmatched-response']);
  assert.equal(events[2].id, 'stray');
  await client.close({ graceMs: 1000 });
});

test('notifications fan out through filters; a throwing listener is contained', async () => {
  const { client, events } = await started();
  const turn = [];
  const all = [];
  client.subscribe(() => {
    throw new Error('listener bug');
  }, () => {});
  const off = client.subscribe(n => n.params?.threadId === 't1', n => turn.push(n.method));
  client.subscribe(() => true, n => all.push(n.method));
  await client.request('test/notify', {
    notifications: [
      { method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } },
      { method: 'warning', params: { message: 'w' } },
      { method: 'item/completed', params: { threadId: 't2' } },
    ],
  });
  assert.deepEqual(turn, ['turn/started']);
  assert.deepEqual(all, ['turn/started', 'warning', 'item/completed']);
  assert.equal(events.filter(e => e.type === 'listener-error').length, 3);
  off();
  await client.request('test/notify', { notifications: [{ method: 'turn/completed', params: { threadId: 't1' } }] });
  assert.deepEqual(turn, ['turn/started']);
  await client.close({ graceMs: 1000 });
});

test('server requests with id 0 and string ids get the exec-parity answer echoed with the same id', async () => {
  const { client } = await started();
  const zero = await client.request('test/serverRequest', { id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'th' } });
  assert.deepEqual(zero, { id: 0, error: { code: -32000, message: 'command execution approval is not supported in exec mode for thread `th`' } });
  const str = await client.request('test/serverRequest', { id: 'req-7', method: 'mcpServer/elicitation/request', params: {} });
  assert.deepEqual(str, { id: 'req-7', result: { action: 'cancel', content: null, _meta: null } });
  const unknown = await client.request('test/serverRequest', { id: 9, method: 'item/brandNew', params: {} });
  assert.equal(unknown.error.code, -32000);
  await client.close({ graceMs: 1000 });
});

test('server request handler failures, invalid replies and hangs are still answered exactly once', async () => {
  let mode = 'throw';
  const { client, events } = await started('default', {
    serverRequestDeadlineMs: 50,
    onServerRequest: async () => {
      if (mode === 'throw') throw new Error('handler exploded');
      if (mode === 'invalid') return { nope: true };
      if (mode === 'undefined-result') return { result: undefined };
      return new Promise(() => {});
    },
  });
  const thrown = await client.request('test/serverRequest', { id: 1, method: 'item/tool/call', params: {} });
  assert.deepEqual(thrown.error, { code: -32000, message: 'item/tool/call failed in the client' });
  mode = 'invalid';
  const invalid = await client.request('test/serverRequest', { id: 2, method: 'item/tool/call', params: {} });
  assert.match(invalid.error.message, /invalid reply/);
  mode = 'undefined-result';
  assert.deepEqual(await client.request('test/serverRequest', { id: 3, method: 'x', params: {} }), { id: 3, result: null });
  mode = 'hang';
  const hung = await client.request('test/serverRequest', { id: 4, method: 'currentTime/read', params: {} });
  assert.match(hung.error.message, /not answered by the client in time/);
  assert.deepEqual(events.map(e => e.type), ['server-request-error', 'server-request-timeout']);
  const replies = (await client.request('test/received')).filter(m => m.id === 4 && !m.method);
  assert.equal(replies.length, 1);
  await client.close({ graceMs: 1000 });
});

test('control RPC timeout rejects without replay and a late response is classified, not matched', async () => {
  const { client, events } = await started('default', { requestTimeoutMs: 30 });
  const err = await client.request('test/later', { delayMs: 120 }).catch(e => e);
  assert.ok(err instanceof AppServerTimeoutError);
  assert.equal(err.message, 'test/later timed out after 30 ms');
  await delay(150);
  assert.deepEqual(events.map(e => [e.type, e.method]), [['late-response', 'test/later']]);
  const sent = (await client.request('test/received', undefined, { timeoutMs: 0 })).filter(m => m.method === 'test/later');
  assert.equal(sent.length, 1, 'no replay after an ambiguous timeout');
  await client.close({ graceMs: 1000 });
});

test('a response with a mismatched id type does not resolve the request', async () => {
  const { client, events } = await started('default', { requestTimeoutMs: 50 });
  await assert.rejects(client.request('test/wrongIdType'), AppServerTimeoutError);
  assert.equal(events[0].type, 'unmatched-response');
  await client.close({ graceMs: 1000 });
});

test('a malformed response fails its own request only', async () => {
  const { client, events } = await started();
  await assert.rejects(client.request('test/malformed'), err => err instanceof AppServerProtocolError && /malformed response/.test(err.message));
  assert.equal(events[0].type, 'invalid-frame');
  assert.deepEqual(await client.request('test/echo', { still: 'ok' }), { still: 'ok' });
  await client.close({ graceMs: 1000 });
});

test('bounded retry: -32001 and closing-thread rejections retry only when asked', async () => {
  const { client } = await started();
  await assert.rejects(client.request('test/overload', { times: 1 }), /code -32001/);
  assert.deepEqual(await client.request('test/overload', { times: 3 }, { retry: true }), { attempts: 4 });
  assert.deepEqual(await client.request('test/closing', { times: 2, threadId: 't9' }, { retry: true }), { attempts: 3 });
  await client.close({ graceMs: 1000 });
});

test('retry budget is exhausted after five retries and the last rejection surfaces', async () => {
  const { client } = await started();
  const err = await client.request('test/overload', { times: 100 }, { retry: true }).catch(e => e);
  assert.ok(err instanceof AppServerRpcError);
  assert.equal(err.code, -32001);
  const attempts = (await client.request('test/received')).filter(m => m.method === 'test/overload');
  assert.equal(attempts.length, 6);
  await client.close({ graceMs: 1000 });
});

test('unexpected exit rejects every pending request with the exit code and scrubbed stderr tail', async () => {
  const { client, exits } = await started();
  const hanging = client.request('test/never', undefined, { timeoutMs: 0 });
  const exiting = client.request('test/exit', { code: 7, stderr: 'panic: Bearer s3cr3t\n' });
  for (const p of [hanging, exiting]) {
    const err = await p.catch(e => e);
    assert.ok(err instanceof AppServerExitedError);
    assert.equal(err.code, 7);
    assert.equal(err.message, 'Codex app-server exited unexpectedly (code=7, signal=null): panic: Bearer [redacted]\n');
  }
  await client.closed;
  assert.equal(client.state, 'closed');
  assert.equal(exits.length, 1);
  await assert.rejects(client.request('test/echo'), AppServerExitedError);
});

test('SIGKILL of the server mid-request rejects with the signal', async () => {
  const { client } = await started();
  const err = await client.request('test/kill').catch(e => e);
  assert.ok(err instanceof AppServerExitedError);
  assert.equal(err.signal, 'SIGKILL');
  assert.equal(err.code, null);
});

test('oversize frame fails closed: pending requests reject and the child is terminated', async () => {
  const { client, events } = await started('default', { maxFrameBytes: 1024 });
  const pending = client.request('test/never', undefined, { timeoutMs: 0 });
  const err = await client.request('test/oversize', { bytes: 4096 }).catch(e => e);
  assert.ok(err instanceof AppServerProtocolError);
  assert.match(err.message, /exceeded 1024 bytes/);
  await assert.rejects(pending, AppServerProtocolError);
  await client.closed;
  assert.equal(events[0].type, 'oversize-frame');
  assert.ok(!isAlive(client.pid));
});

test('spawn failure (ENOENT) rejects start and closes', async () => {
  const client = new AppServerClient({ bin: '/nonexistent/codex', args: ['app-server'], clientInfo: CLIENT_INFO });
  await assert.rejects(client.start(), err => err instanceof AppServerProtocolError && /ENOENT/.test(err.message));
  await client.closed;
  assert.equal(client.state, 'closed');
});

test('a child that crashes before initialize rejects start with a scrubbed tail', async () => {
  const { client } = makeClient('crash-on-start');
  const err = await client.start().catch(e => e);
  assert.ok(err instanceof AppServerExitedError);
  assert.equal(err.code, 3);
  assert.ok(err.stderrTail.includes('Bearer [redacted]'));
  assert.ok(!err.stderrTail.includes('sk-secret'));
});

test('initialize timeout and initialize error both fail start and kill the child', async () => {
  const slow = makeClient('no-init-response', { initializeTimeoutMs: 50 });
  await assert.rejects(slow.client.start(), AppServerTimeoutError);
  await slow.client.closed;
  assert.ok(!isAlive(slow.client.pid));
  const bad = makeClient('init-error');
  await assert.rejects(bad.client.start(), /initialize failed: Invalid request: bad clientInfo \(code -32600\)/);
  await bad.client.closed;
  assert.equal(bad.client.state, 'closed');
});

test('close() ends stdin; a server that ignores EOF is SIGKILLed after the grace period', async () => {
  const { client } = await started('ignore-eof');
  const pending = client.request('test/never', undefined, { timeoutMs: 0 });
  const t0 = Date.now();
  await client.close({ graceMs: 100 });
  assert.ok(Date.now() - t0 >= 90);
  assert.equal(client.exitInfo.signal, 'SIGKILL');
  await assert.rejects(pending, err => err instanceof AppServerUnavailableError && /closed/.test(err.message));
  assert.ok(!isAlive(client.pid));
  await client.close({ graceMs: 0 });
});

test('graceful close on stdin EOF exits 0 without a kill and leaves no child', async () => {
  const { client } = await started();
  await client.close({ graceMs: 5000 });
  assert.deepEqual([client.exitInfo.code, client.exitInfo.signal], [0, null]);
  assert.ok(!isAlive(client.pid));
});
