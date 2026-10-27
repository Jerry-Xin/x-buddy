// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockResponsesServer } from './lib/mock-responses.mjs';

async function withMock(opts, fn) {
  const mock = await new MockResponsesServer(opts).start();
  try { await fn(mock); } finally { await mock.stop(); }
}

const call = (mock, headers = {}) => globalThis.fetch(`${mock.baseUrl}/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'fixture', input: 'hi' }),
});

test('scripted SSE replies are served in order, then the fallback', async () => {
  await withMock({ replies: [{ events: [{ event: 'response.completed', data: { type: 'response.completed' } }] }, { status: 500, body: { error: { message: 'boom' } } }] }, async (mock) => {
    const first = await call(mock);
    assert.equal(first.headers.get('content-type'), 'text/event-stream');
    assert.equal(await first.text(), 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
    assert.equal((await call(mock)).status, 500);
    assert.match(await (await call(mock)).text(), /response\.created[\s\S]*response\.completed/);
  });
});

test('requests record bodies and an Authorization digest, never the credential', async () => {
  await withMock({}, async (mock) => {
    await (await call(mock)).text();
    await (await call(mock, { authorization: 'Bearer sk-fixture-not-a-secret' })).text();
    const [noAuth, withAuth] = mock.requests();
    assert.equal(noAuth.authorization, null);
    assert.equal(noAuth.body.model, 'fixture');
    assert.equal(withAuth.authorization.scheme, 'Bearer');
    assert.match(withAuth.authorization.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(mock.requests()).includes('sk-fixture'), false);
  });
});

test('unknown paths fail closed with 404', async () => {
  await withMock({}, async (mock) => {
    assert.equal((await globalThis.fetch(`${mock.baseUrl}/chat/completions`, { method: 'POST', body: '{}' })).status, 404);
  });
});
