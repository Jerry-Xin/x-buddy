// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  FrameAssembler, MAX_ASSEMBLY_BYTES, PacketType, decodePacket, decryptPayload, deriveAesParams, encodeConnack, encodeRecv,
  encodeVarLength, encryptPayload, readVarLength, x25519KeyPair, x25519Shared,
} from './lib/wukong-codec.mjs';
import { render } from './goldens/gen-wire-goldens.mjs';
import { URL } from 'node:url';

const golden = JSON.parse(readFileSync(new URL('./goldens/wire.v1.json', import.meta.url), 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');

test('golden regenerates byte-for-byte', () => {
  assert.equal(render(), readFileSync(new URL('./goldens/wire.v1.json', import.meta.url), 'utf8'));
});

test('X25519 matches the RFC 7748 §6.1 vectors', () => {
  const v = golden.knownAnswer.rfc7748;
  const alice = x25519KeyPair(hex(v.alicePrivateHex));
  const bob = x25519KeyPair(hex(v.bobPrivateHex));
  assert.equal(alice.publicKey.toString('hex'), v.alicePublicHex);
  assert.equal(bob.publicKey.toString('hex'), v.bobPublicHex);
  assert.equal(x25519Shared(alice.privateKey, bob.publicKey).toString('hex'), v.sharedHex);
  assert.equal(x25519Shared(bob.privateKey, alice.publicKey).toString('hex'), v.sharedHex);
});

test('AES-128-CBC and MD5 primitives match published vectors', () => {
  assert.equal(golden.knownAnswer.sp80038aCbcBlock1.observedHex, golden.knownAnswer.sp80038aCbcBlock1.ciphertextHex);
  assert.equal(createHash('md5').update(golden.knownAnswer.rfc1321.input).digest('hex'), golden.knownAnswer.rfc1321.md5Hex);
});

test('session key is hex MD5(base64(shared))[0..16] and IV is salt[0..16] bytes', () => {
  const s = golden.session;
  const shared = hex(s.sharedHex);
  assert.equal(shared.toString('base64'), s.sharedBase64);
  const p = deriveAesParams(shared, s.salt);
  assert.equal(p.key.toString('latin1'), createHash('md5').update(s.sharedBase64).digest('hex').slice(0, 16));
  assert.equal(p.iv.toString('latin1'), s.salt.slice(0, 16));
  assert.equal(decryptPayload(Buffer.from(s.payloadAscii, 'latin1'), p), s.plaintext);
  assert.equal(encryptPayload(s.plaintext, p).toString('latin1'), s.payloadAscii);
});

test('salt shorter than 16 UTF-8 bytes is rejected (multibyte counted by bytes)', () => {
  const shared = Buffer.alloc(32, 1);
  assert.throws(() => deriveAesParams(shared, 'short'), /salt too short/);
  assert.throws(() => deriveAesParams(shared, ''), /salt too short/);
  assert.doesNotThrow(() => deriveAesParams(shared, '界界界界界界'));
  assert.equal(deriveAesParams(shared, '界界界界界界').iv.length, 16);
});

test('variable-length boundaries match the golden and cap at 4 bytes', () => {
  for (const v of golden.varlen) {
    assert.equal(Buffer.from(encodeVarLength(v.value)).toString('hex'), v.hex, String(v.value));
    assert.deepEqual(readVarLength(hex(v.hex), 0), { length: v.value, used: v.hex.length / 2 });
  }
  assert.throws(() => encodeVarLength(268435456), /4-byte/);
  assert.throws(() => readVarLength(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x01]), 0), /exceeded 4 bytes/);
  assert.deepEqual(readVarLength(Buffer.from([0x80, 0x80]), 0), { length: 0, used: 0 });
});

test('every golden packet decodes back to its input fields', () => {
  const p = golden.packets;
  const connect = decodePacket(hex(p.connect.hex));
  assert.equal(connect.type, PacketType.CONNECT);
  assert.equal(connect.version, 4);
  assert.equal(connect.deviceFlag, 0);
  assert.ok(connect.deviceID.endsWith('W'));
  assert.equal(connect.clientKey, p.connect.input.clientKey);
  assert.equal(connect.clientTimestamp, 1767225600000n);

  const ack4 = decodePacket(hex(p.connackV4.hex));
  assert.equal(hex(p.connackV4.hex)[0] & 0x01, 1);
  assert.equal(ack4.serverVersion, 4);
  assert.equal(ack4.nodeId, 7n);
  assert.equal(ack4.salt, p.connackV4.input.salt);
  const ack0 = decodePacket(hex(p.connackNoVersion.hex));
  assert.equal(ack0.serverVersion, undefined);
  assert.equal('nodeId' in ack0, false);
  assert.equal(decodePacket(hex(p.connackKicked.hex)).reasonCode, 0);

  const recv = decodePacket(hex(p.recvV4Topic.hex), { serverVersion: 4 });
  assert.deepEqual(recv.setting, { receiptEnabled: true, topic: true, streamOn: true });
  assert.equal(recv.messageID, '9007199254740993');
  assert.equal(recv.messageSeq, 42);
  assert.equal(recv.topic, 'topic-1');
  assert.equal(recv.expire, 0);
  assert.equal(recv.payload.toString('latin1'), p.recvV4Topic.payloadAscii);

  assert.deepEqual(decodePacket(hex(p.recvack.hex)), { type: PacketType.RECVACK, flags: 0, messageID: '9007199254740993', messageSeq: 42 });
  assert.equal(p.ping.hex, '70');
  assert.equal(p.pong.hex, '80');
  assert.deepEqual(decodePacket(hex(p.disconnect.hex)), { type: PacketType.DISCONNECT, flags: 0, reasonCode: 1, reason: 'kicked' });
});

test('RECV expire field is present only for serverVersion >= 3', () => {
  const base = { fromUID: 'a', channelID: 'c', channelType: 1, messageID: 1n, messageSeq: 1, timestamp: 1, payload: Buffer.from('x') };
  const v2 = encodeRecv({ ...base, serverVersion: 2 });
  const v3 = encodeRecv({ ...base, serverVersion: 3 });
  assert.equal(v3.length - v2.length, 4);
  assert.equal(decodePacket(v2, { serverVersion: 2 }).expire, undefined);
  assert.equal(decodePacket(v3, { serverVersion: 3 }).expire, 0);
});

test('setting byte bits: receipt 7, topic 3, streamOn 1', () => {
  assert.deepEqual(golden.settings.map(s => s.byte), [0x00, 0x80, 0x08, 0x02]);
});

test('negative vectors are rejected, never partially decoded', () => {
  for (const n of golden.negative) {
    assert.equal(n.observed, 'error', n.name);
    assert.throws(() => decodePacket(hex(n.hex)), RangeError, n.name);
  }
  assert.throws(() => decodePacket(Buffer.concat([encodeConnack({ reasonCode: 1, salt: 'x'.repeat(16) }), Buffer.from([0])])), /length mismatch/);
});

test('FrameAssembler splits sticky packets and reassembles fragments', () => {
  const a = new FrameAssembler();
  const one = hex(golden.packets.recvack.hex);
  const two = Buffer.concat([one, hex('80'), one]);
  assert.equal(a.push(two.subarray(0, 5)).length, 0);
  const frames = a.push(two.subarray(5));
  assert.deepEqual(frames.map(f => f.toString('hex')), [one.toString('hex'), '80', one.toString('hex')]);
  assert.equal(a.buffered, 0);
});

test('FrameAssembler enforces the 1 MiB cap and the varint cap', () => {
  const a = new FrameAssembler();
  const header = Buffer.from([0x50, ...encodeVarLength(MAX_ASSEMBLY_BYTES)]);
  assert.equal(a.push(header).length, 0);
  assert.throws(() => a.push(Buffer.alloc(MAX_ASSEMBLY_BYTES)), /exceeded/);
  assert.equal(a.buffered, 0);
  assert.throws(() => new FrameAssembler().push(Buffer.from([0x50, 0x80, 0x80, 0x80, 0x80, 0x80])), /exceeded 4 bytes/);
});
