// SPDX-License-Identifier: Apache-2.0
// Negative-path tests that do not depend on any fake App Server logic. Each
// child is a tiny inline script that answers `initialize`, then writes exact
// literal bytes for the next request. These prove client behavior on the
// given bytes only; they are not evidence of real 0.142.3 server behavior.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient } from '../../dist/app-server/client.js';
import { AppServerExitedError, AppServerProtocolError } from '../../dist/app-server/errors.js';

// argv[1]: JSON array of output templates, one per non-initialize request; `$ID` is the request id as JSON.
// argv[2]: 'stay' keeps running after the script is exhausted, 'exit' exits 0 after flushing it.
// Every frame the child receives without a `method` (a client reply) is echoed back as `raw/seen`.
const SCRIPT = `
const outputs = JSON.parse(process.argv[1]);
const after = process.argv[2];
let buf = '';
let n = 0;
const out = (text, cb) => process.stdout.write(text, cb);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') { out(JSON.stringify({ id: msg.id, result: {} }) + '\\n'); continue; }
    if (!Object.hasOwn(msg, 'method')) { out(JSON.stringify({ method: 'raw/seen', params: msg }) + '\\n'); continue; }
    if (!Object.hasOwn(msg, 'id')) continue;
    const text = (outputs[n++] ?? '').split('$ID').join(JSON.stringify(msg.id));
    out(text, () => { if (after === 'exit' && n >= outputs.length) process.exit(0); });
  }
});
process.stdin.on('end', () => process.stdout.write('', () => process.exit(0)));
`;

const live = new Set();
afterEach(async () => {
  const clients = [...live];
  live.clear();
  await Promise.all(clients.map(c => c.close({ graceMs: 0 })));
});

async function raw(outputs, { after = 'stay', ...extra } = {}) {
  const events = [];
  const client = new AppServerClient({
    bin: process.execPath,
    args: ['--input-type=module', '-e', SCRIPT, JSON.stringify(outputs), after],
    env: { PATH: process.env.PATH ?? '' },
    clientInfo: { name: 'raw', title: null, version: '0' },
    onProtocolEvent: e => events.push(e),
    ...extra,
  });
  live.add(client);
  await client.start();
  return { client, events };
}

test('a duplicate response for the same id settles the request once and reports the duplicate as unmatched', async () => {
  const { client, events } = await raw(['{"id":$ID,"result":1}\n{"id":$ID,"result":2}\n', '{"id":$ID,"result":"next"}\n']);
  assert.equal(await client.request('a'), 1);
  assert.equal(await client.request('b'), 'next');
  assert.deepEqual(events.map(e => e.type), ['unmatched-response']);
  assert.equal(client.pendingRequests, 0);
});

test('an oversize line followed by a newline and a valid response does not resolve the request (no fail-open on resync)', async () => {
  const big = `{"id":$ID,"result":"${'x'.repeat(600)}"}\n{"id":$ID,"result":"ok"}\n`;
  const { client, events } = await raw([big], { maxFrameBytes: 256 });
  const err = await client.request('a').catch(e => e);
  assert.ok(err instanceof AppServerProtocolError, String(err));
  await client.closed;
  assert.equal(events[0].type, 'oversize-frame');
  assert.ok(events[0].bytes > 256);
  assert.equal(client.state, 'closed');
});

test('a truncated final frame at EOF rejects the pending request as an exit and is reported, not parsed', async () => {
  const { client, events } = await raw(['{"id":$ID,"res'], { after: 'exit' });
  const err = await client.request('a', undefined, { timeoutMs: 0 }).catch(e => e);
  assert.ok(err instanceof AppServerExitedError, String(err));
  assert.equal(err.code, 0);
  assert.equal(events[0].type, 'invalid-frame');
  assert.match(events[0].detail, /truncated frame/);
});

test('a response whose id has the wrong type never settles the request; exit then rejects it', async () => {
  const { client, events } = await raw(['{"id":"1","result":{}}\n'], { after: 'exit' });
  const err = await client.request('a', undefined, { timeoutMs: 0 }).catch(e => e);
  assert.ok(err instanceof AppServerExitedError);
  assert.deepEqual(events.map(e => [e.type, e.id]), [['unmatched-response', '1']]);
});

test('server requests reusing id 0 are each answered once, with the same id', async () => {
  const twice = '{"id":0,"method":"item/tool/call","params":{"threadId":"t"}}\n{"id":0,"method":"currentTime/read","params":{}}\n';
  const { client } = await raw([twice]);
  const seen = [];
  client.subscribe(n => n.method === 'raw/seen', n => seen.push(n.params));
  client.request('a', undefined, { timeoutMs: 0 }).catch(() => {});
  for (let i = 0; i < 400 && seen.length < 2; i++) await delay(5);
  assert.deepEqual(seen, [
    { id: 0, error: { code: -32000, message: 'dynamic tool calls are not supported in exec mode for thread `t`' } },
    { id: 0, error: { code: -32000, message: 'external current time is not supported in exec mode' } },
  ]);
});

test('an error response with a malformed error object fails only its own request', async () => {
  const { client, events } = await raw(['{"id":$ID,"error":{"code":"x","message":1}}\n', '{"id":$ID,"result":true}\n']);
  await assert.rejects(client.request('a'), AppServerProtocolError);
  assert.equal(await client.request('b'), true);
  assert.equal(events[0].type, 'invalid-frame');
});

test('known gap: a frame with a valid id and a non-string method is reported but not answered', async () => {
  const { client, events } = await raw(['{"id":7,"method":42}\n{"id":$ID,"result":null}\n']);
  const seen = [];
  client.subscribe(n => n.method === 'raw/seen', n => seen.push(n.params));
  assert.equal(await client.request('a'), null);
  assert.deepEqual(events.map(e => e.type), ['invalid-frame']);
  assert.deepEqual(seen, [], 'no reply is sent today; tracked in the follow-up ledger');
});

// Fictitious credential-shaped strings only; never real credentials.
const FAKE_KEY = 'sk-FAKEtestKEY0000000000';
const FAKE_BEARER = 'fakeBearerTok3n.abc';

test('R1: malformed stdout carrying credential-shaped text never reaches protocol event details', async () => {
  const junk = [
    `${FAKE_KEY} not json\n`,
    `{"id":$ID,"result": ${FAKE_KEY}}\n`,
    `Authorization: Bearer ${FAKE_BEARER}\n`,
    `{"note":"Bearer ${FAKE_BEARER}" "${FAKE_KEY}"}\n`,
    'sk-FAKE12\n',
    '{"id":$ID,"result":"ok"}\n',
  ].join('');
  const { client, events } = await raw([junk]);
  assert.equal(await client.request('a'), 'ok');
  const invalid = events.filter(e => e.type === 'invalid-frame');
  assert.equal(invalid.length, 5);
  const serialized = JSON.stringify(events);
  // V8 quotes a short window of the input, so check prefixes, not only whole tokens.
  for (const fragment of ['sk-FAKE', 'Bearer fak', 'fakeBearer']) assert.ok(!serialized.includes(fragment), `${fragment} leaked: ${serialized}`);
});

test('R2: a throwing onExit is contained; pending requests and closed settle exactly once', async () => {
  const uncaught = [];
  const onUncaught = err => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    let exitCalls = 0;
    const { client, events } = await raw(['{"id":$ID,"res'], {
      after: 'exit',
      onExit: () => {
        exitCalls++;
        throw new Error(`onExit exploded ${FAKE_KEY}`);
      },
    });
    let settled = 0;
    const err = await client.request('a', undefined, { timeoutMs: 0 }).then(
      () => assert.fail('must not resolve'),
      e => {
        settled++;
        return e;
      },
    );
    assert.ok(err instanceof AppServerExitedError, String(err));
    await client.closed;
    await delay(50);
    assert.equal(settled, 1);
    assert.equal(exitCalls, 1);
    assert.equal(client.state, 'closed');
    assert.deepEqual(uncaught, []);
    const callbackErrors = events.filter(e => e.type === 'callback-error');
    assert.equal(callbackErrors.length, 1);
    assert.equal(callbackErrors[0].callback, 'onExit');
    assert.ok(!JSON.stringify(events).includes('sk-FAKE'));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});
