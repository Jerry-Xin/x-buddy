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
// Projection/parameter coverage shares this existing omission-pinned suite.
import { readFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { URL } from 'node:url';
import { ExecEventProjector, notificationError, isTurnNotification } from '../../dist/app-server/projection.js';
import { normalizeProcessParams, normalizeTurnParams } from '../../dist/app-server/params.js';

test('pinned exec projection: literal recorded snapshots, IDs, plan reconciliation and total usage', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/exec-projection.json', import.meta.url)));
  const p = new ExecEventProjector();
  assert.deepEqual(fixture.notifications.flatMap(n => p.project(n)), fixture.expected);
  assert.deepEqual(p.project({ method: 'item/completed', params: { item: { id: 'late', type: 'agentMessage', text: 'late' } } }), []);
});

for (const method of ['warning', 'configWarning', 'deprecationNotice', 'model/rerouted']) {
  test(`pinned ${method} normalization and secret scrubbing`, () => {
    const p = new ExecEventProjector();
    const params = method === 'model/rerouted' ? { fromModel: 'a', toModel: 'b', reason: 'highRiskCyberActivity' }
      : { message: 'notice Bearer test-token', summary: 'notice Bearer test-token', details: 'detail sk-syntheticsecret' };
    const [event] = p.project({ method, params });
    assert.equal(event.type, 'item.completed'); assert.equal(event.item.type, 'error');
    assert.equal(event.item.message, method === 'model/rerouted' ? 'model rerouted: a -> b (HighRiskCyberActivity)'
      : method === 'warning' ? 'notice Bearer [redacted]' : 'notice Bearer [redacted] (detail sk-[redacted])');
  });
}

for (const willRetry of [true, false]) {
  test(`pinned error willRetry=${willRetry} remains fatal, additionalDetails retained`, () => {
    const p = new ExecEventProjector();
    const error = { message: 'authentication failed', additionalDetails: 'request rejected' };
    assert.deepEqual(p.project({ method: 'error', params: { error, willRetry } }), [{ type: 'error', message: 'authentication failed (request rejected)' }]);
    assert.deepEqual(p.project({ method: 'turn/completed', params: { turn: { status: 'failed', items: [], error: null } } }), [{ type: 'turn.failed', error: { message: 'authentication failed (request rejected)' } }]);
    const other = new ExecEventProjector();
    assert.deepEqual(other.project({ method: 'turn/completed', params: { turn: { status: 'failed', items: [], error } } }), [{ type: 'turn.failed', error: { message: 'authentication failed (request rejected)' } }]);
  });
}

test('pinned nullable fields and collab enum mapping; no arbitrary fields in projected items', () => {
  const p = new ExecEventProjector();
  const project = item => p.project({ method: 'item/completed', params: { item } })[0].item;
  assert.deepEqual(project({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'failed', arguments: null, result: null, error: { message: 'failed', raw: 'drop' } }), {
    id: 'item_0', type: 'mcp_tool_call', server: 's', tool: 't', arguments: null, result: null, error: { message: 'failed' }, status: 'failed',
  });
  assert.deepEqual(project({ type: 'collabAgentToolCall', id: 'c', tool: 'resumeAgent', senderThreadId: 't', receiverThreadIds: ['r'], agentsStates: { r: { status: 'pendingInit', message: null, extra: 'drop' } }, status: 'inProgress' }), {
    id: 'item_1', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 't', receiver_thread_ids: ['r'], prompt: null, agents_states: { r: { status: 'pending_init', message: null } }, status: 'in_progress',
  });
});

test('empty usage, warning correlation, strict turn fence and interrupted terminal', () => {
  const p = new ExecEventProjector();
  assert.deepEqual(p.project({ method: 'turn/completed', params: { turn: { status: 'completed', items: [] } } }), [{ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }]);
  assert.deepEqual(new ExecEventProjector().project({ method: 'turn/completed', params: { turn: { status: 'interrupted', items: [] } } }), []);
  for (const method of ['warning', 'configWarning', 'deprecationNotice']) assert.equal(isTurnNotification({ method, params: {} }, 't', 'u'), true);
  assert.equal(isTurnNotification({ method: 'warning', params: { threadId: 'other' } }, 't', 'u'), false);
  assert.equal(isTurnNotification({ method: 'item/completed', params: { threadId: 't', turnId: 'old' } }, 't', 'u'), false);
  assert.equal(notificationError({ message: 'e', additionalDetails: '' }), 'e');
});

test('pinned web-action round-trip quirk: camelCase open/find become other; search omits null fields', () => {
  for (const action of [{ type: 'openPage', url: 'https://example.com' }, { type: 'findInPage', url: null, pattern: 'q' }, { type: 'search', query: null, queries: ['q'] }]) {
    const event = new ExecEventProjector().project({ method: 'item/completed', params: { item: { type: 'webSearch', id: 'w', query: 'q', action } } })[0];
    assert.deepEqual(event.item.action, action.type === 'search' ? { type: 'search', queries: ['q'] } : { type: 'other' });
  }
});

test('exec parameter normalization: writable roots, forced never and exact text/cwd contract', () => {
  for (const sandboxMode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const params = normalizeTurnParams({ workingDirectory: '/w', sandboxMode, additionalDirectories: ['/extra'], model: 'm', modelReasoningEffort: 'high' });
    assert.deepEqual(params, { threadParams: { cwd: '/w', sandbox: sandboxMode, model: 'm', ...(sandboxMode === 'workspace-write' ? { runtimeWorkspaceRoots: ['/w', '/extra'] } : {}) }, turnParams: { cwd: '/w', effort: 'high' } });
  }
  assert.throws(() => normalizeTurnParams({}), /workingDirectory/);
});

test('process settings: env replacement, vendor PATH, ephemeral key login and no-key omission', () => {
  const result = normalizeProcessParams({ apiKey: 'synthetic-key', baseUrl: 'https://example.com', env: { CODEX_HOME: '/bot', PATH: '/base' } }, { webSearchMode: 'disabled', modelReasoningEffort: 'medium', networkAccessEnabled: false, approvalPolicy: 'on-request' }, { UNRELATED: 'drop' }, ['/vendor']);
  assert.deepEqual(result, { args: ['app-server', '--listen', 'stdio://', '-c', 'openai_base_url="https://example.com"', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'web_search="cached"', '-c', 'model_reasoning_effort="medium"', '-c', 'approval_policy="never"', '-c', 'cli_auth_credentials_store="ephemeral"'],
    env: { CODEX_HOME: '/bot', PATH: ['/vendor', '/base'].join(delimiter), CODEX_API_KEY: 'synthetic-key', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_sdk_ts' }, login: { type: 'apiKey', apiKey: 'synthetic-key' } });
  const noKey = normalizeProcessParams({}, { webSearchMode: 'live' }, { CODEX_HOME: '/bot', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'override' });
  assert.equal('login' in noKey, false); assert.equal(noKey.args.some(x => x.includes('credentials_store')), false);
  assert.equal(noKey.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'override'); assert.ok(noKey.args.includes('web_search="live"'));
});
