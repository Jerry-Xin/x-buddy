// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppServerExitedError,
  AppServerRpcError,
  AppServerTimeoutError,
  StderrTail,
  capMessage,
  controlRetryDelayMs,
  scrubSecrets,
} from '../../dist/app-server/errors.js';

test('RPC errors use the "<method> failed: <message> (code <code>)" format', () => {
  const err = new AppServerRpcError('thread/resume', { code: -32600, message: 'no rollout found for thread id X' });
  assert.equal(err.message, 'thread/resume failed: no rollout found for thread id X (code -32600)');
  assert.equal(err.code, -32600);
  assert.equal(err.method, 'thread/resume');
  // Existing stale-resume discrimination keeps matching.
  assert.match(err.message, /no rollout found/);
});

test('server error text is capped at 500 characters and scrubbed of secrets', () => {
  const err = new AppServerRpcError('turn/start', { code: -32603, message: `Bearer tok.en sk-abcdef123456 ${'z'.repeat(900)}` });
  assert.equal(err.rpcMessage.length, 500);
  assert.ok(!err.message.includes('tok.en'));
  assert.ok(!err.message.includes('sk-abcdef123456'));
  assert.equal(scrubSecrets('Authorization: Bearer abc'), 'Authorization: Bearer [redacted]');
  assert.equal(capMessage('short'), 'short');
});

test('exit errors carry code, signal and the stderr tail in the pinned format', () => {
  const err = new AppServerExitedError({ code: null, signal: 'SIGKILL', stderrTail: 'boom' });
  assert.equal(err.message, 'Codex app-server exited unexpectedly (code=null, signal=SIGKILL): boom');
  assert.equal(new AppServerTimeoutError('thread/start', 60000).message, 'thread/start timed out after 60000 ms');
});

test('control retry: -32001 backs off 100 ms to 1.6 s for five attempts; closing threads retry at 200 ms', () => {
  const overload = new AppServerRpcError('thread/start', { code: -32001, message: 'Server overloaded; retry later.' });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => controlRetryDelayMs(overload, n)), [100, 200, 400, 800, 1600, null]);
  const closing = new AppServerRpcError('thread/resume', { code: -32600, message: 'thread t1 is closing; retry thread/resume after the thread is closed' });
  assert.deepEqual([1, 5, 6].map(n => controlRetryDelayMs(closing, n)), [200, 200, null]);
  assert.equal(controlRetryDelayMs(new AppServerRpcError('m', { code: -32600, message: 'Not initialized' }), 1), null);
  assert.equal(controlRetryDelayMs(new AppServerTimeoutError('m', 1), 1), null, 'ambiguous acceptance is never retried');
  assert.equal(controlRetryDelayMs(new Error('x'), 1), null);
});

test('stderr tail keeps the last 2 KiB and scrubs before truncating', () => {
  const tail = new StderrTail();
  tail.push(Buffer.from('a'.repeat(5000)));
  tail.push(Buffer.from('key sk-live1234567890 and Bearer xyz\n'));
  const text = tail.toString();
  assert.ok(Buffer.byteLength(text) <= 2048);
  assert.ok(text.endsWith('key sk-[redacted] and Bearer [redacted]\n'));
  const multi = new StderrTail(4);
  multi.push(Buffer.from('ab世'));
  assert.ok(!multi.toString().includes('�'));
});

test('XB-T2: sanitizeErrorData handles cycles, depth, width and size without throwing (fictitious secrets)', async () => {
  const { sanitizeErrorData } = await import('../../dist/app-server/errors.js');
  const cyclic = { a: 'Bearer fakeBearerTok3n.abc', list: ['sk-FAKEtestKEY0000000000'] };
  cyclic.self = cyclic;
  cyclic.list.push(cyclic);
  const out = sanitizeErrorData(cyclic);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('fakeBearer') && !text.includes('sk-FAKE'), text);
  assert.equal(out.self, '[circular]');
  assert.equal(sanitizeErrorData(undefined), undefined);
  assert.equal(sanitizeErrorData(7), 7);
  assert.ok(JSON.stringify(sanitizeErrorData({ big: Array.from({ length: 100000 }, () => ({ x: 'y'.repeat(100) })) })).length <= 16 * 1024);
});
