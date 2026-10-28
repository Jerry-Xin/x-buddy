// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { OctoApiClient, OctoApiError } from '../dist/transport/api-client.js';
import { FakeClock } from './foundation/lib/clock.mjs';

const base = 'https://fixture.example';
const reply = (body, status = 200, headers = {}) => new globalThis.Response(body, { status, headers });
const make = (fetch, clock = new FakeClock(), extra = {}) => ({
  clock, client: new OctoApiClient({ apiUrl: base, botToken: 'fixture-secret-value', clock, fetch, ...extra }),
});
const flush = async () => { await immediate(); };

test('DEV02 REST: all four methods, int64 and empty response', async () => {
  const seen = [];
  const { client, clock } = make(async (url, options) => {
    seen.push([url.href, options.method, options.body, options.redirect, options.headers.Authorization]);
    return options.method === 'DELETE' ? reply(null, 204) : reply('{"message_id":9007199254740993}');
  });
  for (const method of ['GET', 'POST', 'PUT']) {
    assert.equal((await client.request(method, '/v1/bot/fixture', method === 'GET' ? undefined : { a: 1 })).message_id, '9007199254740993');
  }
  assert.equal(await client.request('DELETE', '/v1/bot/fixture'), undefined);
  assert.deepEqual(seen.map(v => v[1]), ['GET', 'POST', 'PUT', 'DELETE']);
  assert.ok(seen.every(v => v[3] === 'error' && v[4] === 'Bearer fixture-secret-value'));
  assert.equal(clock.pendingCount(), 0);
});

test('DEV02 REST: reject URL escape, credentials and insecure endpoints before fetch', async () => {
  let calls = 0;
  const { client } = make(async () => { calls++; return reply('{}'); }, undefined, { apiUrl: base + '/prefix' });
  for (const path of ['//other.example/x', 'https://other.example', '/\\other.example', '/x#token', '/../escape', '/%2e%2e/escape']) {
    await assert.rejects(client.request('POST', path), e => e.sendOutcome === 'not-sent');
  }
  assert.equal(calls, 0);
  for (const apiUrl of ['http://fixture.example', 'https://user:pass@fixture.example', base + '/?secret=x']) {
    assert.throws(() => make(async () => reply('{}'), undefined, { apiUrl }));
  }
});

test('DEV02 REST: default 30s and hard 60s include caller signals', async () => {
  for (const [timeoutMs, budget] of [[undefined, 30_000], [900_000, 60_000]]) {
    const { client, clock } = make((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('network fixture-secret-value')), { once: true });
    }));
    const caller = new globalThis.AbortController();
    const pending = client.request('GET', '/v1/bot/fixture', undefined, { timeoutMs, signal: caller.signal });
    const rejected = assert.rejects(pending, e => e instanceof OctoApiError && e.sendOutcome === 'ambiguous' && !String(e).includes('fixture-secret-value'));
    clock.advance(budget - 1);
    assert.equal(clock.pendingCount(), 1);
    clock.advance(1);
    await rejected;
    assert.equal(clock.pendingCount(), 0);
  }
});

test('DEV02 REST: deadline covers stalled response body', async () => {
  let released = false;
  const { client, clock } = make(async (_url, opts) => reply(new globalThis.ReadableStream({
    start(controller) {
      opts.signal.addEventListener('abort', () => { released = true; controller.error(new Error('fixture stream aborted')); });
    },
  })));
  const pending = client.request('GET', '/v1/bot/fixture', undefined, { timeoutMs: 1000 });
  const rejected = assert.rejects(pending, /timed out/);
  await flush();
  clock.advance(1000);
  await rejected;
  assert.equal(released, true);
  assert.equal(clock.pendingCount(), 0);
});

test('DEV02 REST: 429 retries twice with identical body, never retries 503', async () => {
  const bodies = [];
  const { client, clock } = make(async (_url, opts) => { bodies.push(opts.body); return reply('{}', bodies.length < 3 ? 429 : 200, { 'retry-after': '2' }); });
  const pending = client.request('POST', '/v1/bot/fixture', { client_msg_no: 'immutable-key' });
  await flush(); clock.advance(2000); await flush(); clock.advance(2000);
  await pending;
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  let attempts = 0;
  const failed = make(async () => { attempts++; return reply('{}', 503); });
  await assert.rejects(failed.client.request('POST', '/v1/bot/fixture'), e => e.status === 503 && e.sendOutcome === 'ambiguous');
  assert.equal(attempts, 1);
});

test('DEV02 REST: cumulative 15s, per-delay 10s and two-retry ceilings', async () => {
  for (const [seconds, ticks, expected] of [['8', [8000], 2], ['11', [], 1], ['1', [1000, 1000], 3]]) {
    let calls = 0;
    const { client, clock } = make(async () => { calls++; return reply('{}', 429, { 'retry-after': seconds }); });
    const rejected = assert.rejects(client.request('POST', '/v1/bot/fixture'), e => e.status === 429);
    await flush();
    for (const ms of ticks) { clock.advance(ms); await flush(); }
    await rejected;
    assert.equal(calls, expected);
    assert.equal(clock.pendingCount(), 0);
  }
});

test('DEV02 REST: control endpoints opt out even when retry429=true', async () => {
  for (const name of ['heartbeat', 'typing', 'readReceipt', 'events/ack', 'events', 'ack']) {
    let calls = 0;
    const { client } = make(async () => { calls++; return reply('{}', 429, { 'retry-after': '0' }); });
    await assert.rejects(client.request('POST', '/v1/bot/' + name + '?cursor=1', {}, { retry429: true }), e => e.status === 429);
    assert.equal(calls, 1, name);
  }
});

test('DEV02 REST: abort before send and while sleeping prevents replay', async () => {
  let calls = 0;
  const { client, clock } = make(async () => { calls++; return reply('{}', 429, { 'retry-after': '5' }); });
  const caller = new globalThis.AbortController(); caller.abort('fixture-secret-value');
  await assert.rejects(client.request('POST', '/v1/bot/fixture', {}, { signal: caller.signal }), e => e.sendOutcome === 'not-sent');
  assert.equal(calls, 0);
  const controller = new globalThis.AbortController();
  const pending = client.request('POST', '/v1/bot/fixture', {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await flush(); controller.abort('fixture-secret-value'); await rejected;
  clock.advance(20_000); await flush();
  assert.equal(calls, 1);
  assert.equal(clock.pendingCount(), 0);
});

test('DEV02 REST: all errors and metadata scrub credentials and cap excerpts', async () => {
  const body = JSON.stringify({ code: 'fixture-secret-value', message: 'Bearer unrelated-secret Authorization: fixture-secret-value ' + 'x'.repeat(800) });
  const { client } = make(async () => reply(body, 403, { 'x-ratelimit-scope': 'Bearer another-secret', 'x-ratelimit-remaining': '2' }));
  await assert.rejects(client.request('PUT', '/v1/bot/fixture'), e => {
    assert.equal(e.status, 403); assert.equal(e.rateLimitRemaining, 2);
    assert.ok(e.bodyExcerpt.length <= 500);
    const outward = JSON.stringify(e) + String(e);
    for (const secret of ['fixture-secret-value', 'unrelated-secret', 'another-secret']) assert.ok(!outward.includes(secret));
    return true;
  });
  const malformed = make(async () => reply('fixture-secret-value'));
  await assert.rejects(malformed.client.request('GET', '/v1/bot/fixture'), e => !String(e).includes('fixture-secret-value') && /Invalid JSON/.test(e.message));
  const network = make(async () => { throw new Error('Bearer fixture-secret-value'); });
  await assert.rejects(network.client.request('GET', '/v1/bot/fixture'), e => e.sendOutcome === 'ambiguous' && !String(e).includes('fixture-secret-value'));
});

test('DEV02 REST: oversize response fails; redirect refusal has no retry', async () => {
  const large = make(async () => reply('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(large.client.request('GET', '/v1/bot/fixture'), /byte limit/);
  let attempts = 0;
  const redirect = make(async (_url, opts) => {
    attempts++; assert.equal(opts.redirect, 'error'); throw new Error('redirect rejected');
  });
  await assert.rejects(redirect.client.request('GET', '/v1/bot/fixture'), /Request failed/);
  assert.equal(attempts, 1);
});
