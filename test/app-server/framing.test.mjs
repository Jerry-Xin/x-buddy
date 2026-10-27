// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonlDecoder, classify, encodeFrame } from '../../dist/app-server/framing.js';
import { requestIdKey } from '../../dist/app-server/protocol.js';

const line = obj => Buffer.from(`${JSON.stringify(obj)}\n`);

test('decodes several frames from one chunk and skips blank and CRLF-terminated lines', () => {
  const decoder = new JsonlDecoder();
  const frames = decoder.push(Buffer.from('{"method":"a"}\r\n\n  \n{"id":1,"result":null}\n'));
  assert.deepEqual(frames, [
    { kind: 'notification', message: { method: 'a', params: undefined } },
    { kind: 'response', message: { id: 1, result: null } },
  ]);
  assert.equal(decoder.pendingBytes, 0);
});

test('accumulates partial lines, including a multi-byte character split across chunks', () => {
  const decoder = new JsonlDecoder();
  const bytes = line({ id: 2, result: { text: 'héllo 世界' } });
  const frames = [];
  for (let i = 0; i < bytes.length; i += 3) frames.push(...decoder.push(bytes.subarray(i, i + 3)));
  assert.deepEqual(frames, [{ kind: 'response', message: { id: 2, result: { text: 'héllo 世界' } } }]);
});

test('classifies server requests with id 0 and string ids by presence, not truthiness', () => {
  assert.deepEqual(classify({ id: 0, method: 'item/tool/call', params: {} }), { kind: 'request', message: { id: 0, method: 'item/tool/call', params: {} } });
  assert.deepEqual(classify({ id: 'abc', method: 'x' }).kind, 'request');
  assert.deepEqual(classify({ id: 0, result: false }), { kind: 'response', message: { id: 0, result: false } });
  assert.deepEqual(classify({ id: '0', error: { code: -32600, message: 'm' } }).kind, 'response');
});

test('reports malformed frames without throwing and keeps the id when it is valid', () => {
  assert.equal(classify([1]).kind, 'invalid');
  assert.equal(classify('x').kind, 'invalid');
  assert.equal(classify({ id: 1.5, result: 1 }).kind, 'invalid');
  assert.equal(classify({ id: null, result: 1 }).kind, 'invalid');
  assert.equal(classify({ method: 7 }).kind, 'invalid');
  assert.equal(classify({ id: 1, method: 'x', result: 1 }).kind, 'invalid');
  assert.deepEqual(classify({ id: 4, result: 1, error: { code: 1, message: 'x' } }), { kind: 'invalid', reason: 'shape', detail: 'response must carry exactly one of result/error', id: 4 });
  assert.equal(classify({ id: 5 }).id, 5);
  assert.equal(classify({ id: 6, error: { code: '1', message: 'x' } }).id, 6);
  const decoder = new JsonlDecoder();
  const [bad, good] = decoder.push(Buffer.from('{oops\n{"method":"ok"}\n'));
  assert.equal(bad.kind, 'invalid');
  assert.equal(bad.reason, 'json');
  assert.equal(good.kind, 'notification');
});

test('enforces the frame cap, discards the oversize line and resynchronises on the next newline', () => {
  const decoder = new JsonlDecoder({ maxFrameBytes: 16 });
  const frames = [
    ...decoder.push(Buffer.from('{"method":"aaaaaaaa')),
    ...decoder.push(Buffer.from('aaaaaaaaaaaaaaaaaaaa"}')),
  ];
  assert.deepEqual(frames, []);
  assert.equal(decoder.pendingBytes, 0, 'oversize bytes are not retained');
  const rest = decoder.push(Buffer.from('\n{"method":"b"}\n'));
  assert.deepEqual(rest.map(f => f.kind), ['oversize', 'notification']);
  assert.equal(rest[0].bytes, 41);
  assert.throws(() => new JsonlDecoder({ maxFrameBytes: 0 }), RangeError);
});

test('a frame exactly at the cap is accepted', () => {
  const body = '{"method":"abc"}';
  const decoder = new JsonlDecoder({ maxFrameBytes: Buffer.byteLength(body) });
  assert.equal(decoder.push(Buffer.from(`${body}\n`))[0].kind, 'notification');
});

test('end() reports a truncated trailing frame instead of parsing it', () => {
  const decoder = new JsonlDecoder();
  decoder.push(Buffer.from('{"id":1,"result":{}}'));
  const [frame] = decoder.end();
  assert.equal(frame.kind, 'invalid');
  assert.match(frame.detail, /truncated frame/);
  assert.deepEqual(decoder.end(), []);
});

test('encodeFrame writes one line and refuses a jsonrpc field', () => {
  assert.equal(encodeFrame({ id: 1, method: 'm', params: { s: 'a\nb' } }), '{"id":1,"method":"m","params":{"s":"a\\nb"}}\n');
  assert.throws(() => encodeFrame({ jsonrpc: '2.0', id: 1, method: 'm' }), /omit the jsonrpc/);
});

test('requestIdKey keeps integer and string ids distinct', () => {
  assert.notEqual(requestIdKey(1), requestIdKey('1'));
  assert.equal(requestIdKey(0), 'n:0');
});
