// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_SERVER_REQUEST_METHODS, execParityReply } from '../../dist/app-server/server-requests.js';

// Expected texts from codex-rs/exec/src/lib.rs handle_server_request at rust-v0.142.3.
const cases = [
  ['item/commandExecution/requestApproval', { threadId: 't1' }, 'command execution approval is not supported in exec mode for thread `t1`'],
  ['item/fileChange/requestApproval', { threadId: 't1' }, 'file change approval is not supported in exec mode for thread `t1`'],
  ['item/tool/requestUserInput', { threadId: 't1' }, 'request_user_input is not supported in exec mode for thread `t1`'],
  ['item/tool/call', { threadId: 't1' }, 'dynamic tool calls are not supported in exec mode for thread `t1`'],
  ['account/chatgptAuthTokens/refresh', {}, 'chatgpt auth token refresh is not supported in exec mode'],
  ['attestation/generate', {}, 'attestation generation is not supported in exec mode'],
  ['currentTime/read', {}, 'external current time is not supported in exec mode'],
  ['applyPatchApproval', { conversationId: 'c1' }, 'apply_patch approval is not supported in exec mode for thread `c1`'],
  ['execCommandApproval', { conversationId: 'c1' }, 'exec command approval is not supported in exec mode for thread `c1`'],
  ['item/permissions/requestApproval', { threadId: 't1' }, 'permissions approval is not supported in exec mode for thread `t1`'],
];

for (const [method, params, message] of cases) {
  test(`exec parity rejects ${method}`, () => {
    assert.deepEqual(execParityReply({ method, params }), { error: { code: -32000, message } });
  });
}

test('elicitation is cancelled, not declined or rejected', () => {
  assert.deepEqual(execParityReply({ method: 'mcpServer/elicitation/request', params: {} }), { result: { action: 'cancel', content: null, _meta: null } });
});

test('unknown and prototype-named methods fail closed', () => {
  for (const method of ['item/brandNew', 'constructor', '__proto__', 'toString']) {
    const reply = execParityReply({ method, params: {} });
    assert.equal(reply.error.code, -32000, method);
    assert.equal(reply.error.message, `${method} is not supported by this client`);
  }
});

test('a missing thread id is reported as unknown instead of throwing', () => {
  assert.match(execParityReply({ method: 'item/tool/call', params: null }).error.message, /thread `unknown`$/);
});

test('the parity table covers all eleven pinned server request methods', () => {
  assert.equal(KNOWN_SERVER_REQUEST_METHODS.length, 11);
});
