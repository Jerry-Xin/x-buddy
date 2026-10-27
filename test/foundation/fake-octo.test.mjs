// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { BUILTIN_ENDPOINTS, FakeOctoServer, jsonWithInt64 } from './lib/fake-octo.mjs';
import { FakeClock } from './lib/clock.mjs';
import { FaultPlan } from './lib/fault-plan.mjs';
import { ReferenceClient } from './lib/reference-client.mjs';
import { PacketType } from './lib/wukong-codec.mjs';

async function withServer(opts, fn) {
  const server = new FakeOctoServer(opts).addBot({ botToken: 'bf_fixture', robotId: 'u_bot', ownerUid: 'u_owner', ownerChannelId: 'u_owner' });
  await server.start();
  try { await fn(server); } finally { await server.stop(); }
}

const post = (server, path, body, token = 'bf_fixture') => globalThis.fetch(server.apiUrl + path, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

async function connect(server, extra = {}) {
  const reg = await (await post(server, '/v1/bot/register')).json();
  const client = await new ReferenceClient({ wsUrl: reg.ws_url, uid: reg.robot_id, token: reg.im_token, ...extra }).open();
  return { reg, client };
}

test('endpoint table links every built-in route to an R8 endpoint row', () => {
  for (const ep of BUILTIN_ENDPOINTS) assert.match(ep.ep, /^EP-\d{2}$/);
  assert.equal(new Set(BUILTIN_ENDPOINTS.map(e => e.name)).size, BUILTIN_ENDPOINTS.length);
});

test('register returns identity, loopback ws_url and api_url', async () => {
  await withServer({}, async (server) => {
    const res = await post(server, '/v1/bot/register', { agent_platform: 'x-buddy' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['api_url', 'im_token', 'owner_channel_id', 'owner_uid', 'robot_id', 'ws_url']);
    assert.equal(body.robot_id, 'u_bot');
    assert.equal(body.ws_url, server.wsUrl);
    assert.equal(server.requests('register')[0].body.agent_platform, 'x-buddy');
  });
});

test('REST fails closed: missing/invalid Bearer 401, unknown route 404, oversize 413', async () => {
  await withServer({}, async (server) => {
    assert.equal((await globalThis.fetch(server.apiUrl + '/v1/bot/heartbeat', { method: 'POST' })).status, 401);
    assert.equal((await post(server, '/v1/bot/heartbeat', {}, 'bf_wrong')).status, 401);
    assert.equal((await post(server, '/v1/bot/notARoute')).status, 404);
    assert.equal((await post(server, '/v1/bot/sendMessage', { blob: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.deepEqual(server.requests().map(r => [r.endpoint, r.auth, r.status]), [
      ['heartbeat', 'missing', 401], ['heartbeat', 'invalid', 401], [null, 'valid', 404], [null, 'missing', 413],
    ]);
    assert.equal(server.unhandled().length, 2);
  });
});

test('sendMessage answers with a bare int64 message_id above 2^53', async () => {
  await withServer({}, async (server) => {
    const res = await post(server, '/v1/bot/sendMessage', { channel_id: 'g1', channel_type: 2, payload: { type: 1, content: 'hi' }, client_msg_no: 'c1' });
    const text = await res.text();
    assert.match(text, /^\{"message_id":9007199254740993,"message_seq":1,"client_msg_no":"c1"\}$/);
    assert.notEqual(JSON.parse(text).message_id.toString(), '9007199254740993', 'naive JSON.parse loses precision');
    assert.equal(server.requests('sendMessage')[0].body.payload.content, 'hi');
  });
  assert.equal(jsonWithInt64({ message_id: '18446744073709551615', other: '1' }), '{"message_id":18446744073709551615,"other":"1"}');
});

test('api.forceStatus injects status per endpoint and count, with Retry-After for 429', async () => {
  const faults = new FaultPlan();
  faults.arm('api.forceStatus', { action: 'status', status: 429, retryAfter: 2, times: 2, match: { endpoint: 'sendMessage' } });
  await withServer({ faults }, async (server) => {
    const r1 = await post(server, '/v1/bot/sendMessage', { channel_id: 'g' });
    assert.equal(r1.status, 429);
    assert.equal(r1.headers.get('retry-after'), '2');
    assert.equal((await post(server, '/v1/bot/heartbeat')).status, 200);
    assert.equal((await post(server, '/v1/bot/sendMessage', { channel_id: 'g' })).status, 429);
    assert.equal((await post(server, '/v1/bot/sendMessage', { channel_id: 'g' })).status, 200);
    faults.assertExhausted();
  });
});

test('GET routes decode percent-encoded path params and serve seeded state', async () => {
  await withServer({}, async (server) => {
    server.setState('groupMd:g/1', { content: '# rules', version: 3 }).setState('user:u_alice', { uid: 'u_alice', name: 'Alice' });
    const get = (p) => globalThis.fetch(server.apiUrl + p, { headers: { authorization: 'Bearer bf_fixture' } });
    assert.equal((await get(`/v1/bot/groups/${encodeURIComponent('g/1')}/md`)).status, 404, 'encoded slash is a distinct key');
    server.setState(`groupMd:${encodeURIComponent('g/1')}`, { content: '# rules' });
    assert.equal((await (await get(`/v1/bot/groups/${encodeURIComponent('g/1')}/md`)).json()).content, '# rules');
    assert.equal((await (await get('/v1/bot/user/info?uid=u_alice')).json()).name, 'Alice');
    assert.equal((await get('/v1/bot/user/info?uid=u_nobody')).status, 404);
  });
});

test('custom routes take precedence and are recorded with their EP id', async () => {
  await withServer({}, async (server) => {
    server.route('POST', '/v1/bot/message/edit', ({ body }) => ({ body: { ok: true, echo: body.message_id } }), { name: 'messageEdit', ep: 'EP-07' });
    const res = await post(server, '/v1/bot/message/edit', { message_id: 'm1' });
    assert.deepEqual(await res.json(), { ok: true, echo: 'm1' });
    assert.equal(server.requests('messageEdit')[0].ep, 'EP-07');
  });
});

test('WS handshake derives a shared session and RECV round-trips with RECVACK', async () => {
  const clock = new FakeClock({ wallMs: Date.UTC(2026, 0, 1) });
  await withServer({ clock }, async (server) => {
    const { client } = await connect(server);
    await client.waitFor(() => client.authenticated, { label: 'CONNACK' });
    const connect0 = server.packets('CONNECT')[0];
    assert.equal(connect0.version, 4);
    assert.equal(connect0.clientKeyBytes, 32);
    assert.equal(connect0.authorised, true);
    const sent = server.push({ uid: 'u_bot', fromUID: 'u_alice', channelID: 'g1', channelType: 2,
      payload: { type: 1, content: 'hello 世界' }, setting: { streamOn: true } });
    await client.waitFor(() => client.messages.length === 1 && server.unacked().length === 0, { label: 'RECVACK' });
    assert.equal(client.messages[0].payload.content, 'hello 世界');
    assert.equal(client.messages[0].messageID, sent.messageID);
    assert.equal(client.messages[0].setting.streamOn, true);
    assert.deepEqual(server.packets('RECVACK').map(p => [p.messageID, p.known]), [[sent.messageID, true]]);
    client.close();
  });
});

test('CONNECT with an unregistered or wrong token is refused', async () => {
  await withServer({}, async (server) => {
    const client = await new ReferenceClient({ wsUrl: server.wsUrl, uid: 'u_bot', token: 'im_u_bot' }).open();
    await client.waitFor(() => client.packets.some(p => p.type === PacketType.CONNACK));
    assert.notEqual(client.packets[0].reasonCode, 1, 'no register call yet');
    assert.equal(client.authenticated, false);
    client.close();
    await post(server, '/v1/bot/register');
    const wrong = await new ReferenceClient({ wsUrl: server.wsUrl, uid: 'u_bot', token: 'im_other' }).open();
    await wrong.waitFor(() => wrong.packets.length > 0);
    assert.notEqual(wrong.packets[0].reasonCode, 1);
    wrong.close();
  });
});

test('unacked RECV is redelivered; a poison payload stays unacked', async () => {
  await withServer({}, async (server) => {
    const { client } = await connect(server, { autoAck: false });
    await client.waitFor(() => client.authenticated);
    server.push({ uid: 'u_bot', fromUID: 'u_a', channelID: 'c', rawPayload: Buffer.from('garbage') });
    await client.waitFor(() => client.messages.length === 1);
    assert.equal(client.messages[0].payload, null);
    assert.equal(server.unacked().length, 1);
    assert.equal(server.redeliver(), 1);
    await client.waitFor(() => client.messages.length === 2);
    assert.equal(client.messages[1].messageID, client.messages[0].messageID);
    client.close();
  });
});

test('transport.dropConnack suppresses CONNACK; overrideConnack drives negative handshakes', async () => {
  const faults = new FaultPlan().arm('transport.dropConnack', { action: 'drop' });
  await withServer({ faults }, async (server) => {
    const { client } = await connect(server);
    await delay(100);
    assert.equal(client.packets.length, 0);
    assert.equal(server.packets('CONNACK_DROPPED').length, 1);
    client.close();
    faults.assertExhausted();
    server.overrideConnack({ salt: 'tooshort', serverVersion: 4 });
    const short = await new ReferenceClient({ wsUrl: server.wsUrl, uid: 'u_bot', token: 'im_u_bot' }).open();
    await short.waitFor(() => short.closed);
    assert.equal(short.packets[0].salt, 'tooshort');
    assert.match(short.handshakeError.message, /salt too short/);
    assert.equal(short.authenticated, false);
    assert.equal(server.packets('CONNACK').at(-1).saltBytes, 8);
  });
});

test('kick sends DISCONNECT and closes; PING gets PONG unless disabled', async () => {
  await withServer({}, async (server) => {
    const { client } = await connect(server);
    await client.waitFor(() => client.authenticated);
    client.ping();
    await client.waitFor(() => client.packets.some(p => p.type === PacketType.PONG));
    server.setAutoPong(false);
    client.ping();
    await delay(50);
    assert.equal(client.packets.filter(p => p.type === PacketType.PONG).length, 1);
    server.kick('u_bot', { reasonCode: 1, reason: 'login elsewhere' });
    await client.waitFor(() => client.closed);
    assert.deepEqual(client.packets.filter(p => p.type === PacketType.DISCONNECT).map(p => p.reason), ['login elsewhere']);
  });
});

test('transport.disconnect aborts the socket right after a RECV is written', async () => {
  const faults = new FaultPlan().arm('transport.disconnect', { action: 'disconnect' });
  await withServer({ faults }, async (server) => {
    const { client } = await connect(server, { autoAck: false });
    await client.waitFor(() => client.authenticated);
    server.push({ uid: 'u_bot', fromUID: 'u_a', channelID: 'c', payload: { type: 1, content: 'x' } });
    await client.waitFor(() => client.closed);
    assert.equal(server.packets('ABORT').length, 1);
    assert.equal(server.unacked().length, 1);
    faults.assertExhausted();
  });
});

test('malformed framing from a client closes that session with a protocol error', async () => {
  await withServer({}, async (server) => {
    const { client } = await connect(server);
    await client.waitFor(() => client.authenticated);
    client.send(Buffer.from([0x60, 0x80, 0x80, 0x80, 0x80, 0x01]));
    await client.waitFor(() => client.closed);
    assert.match(server.packets('PROTOCOL_ERROR')[0].error, /exceeded 4 bytes/);
  });
});
