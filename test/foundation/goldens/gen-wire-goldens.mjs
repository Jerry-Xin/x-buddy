// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic generator for `wire.v1.json` (wire / AES / framing goldens).
 *
 *   node test/foundation/goldens/gen-wire-goldens.mjs           # print to stdout
 *   node test/foundation/goldens/gen-wire-goldens.mjs --write   # rewrite the golden
 *
 * Inputs are fixed seeds, salts and timestamps, so output is byte-stable on
 * every Node version. Layouts follow the specification sources pinned in
 * docs/test-foundation/source-pins.json. Public known-answer vectors
 * (RFC 7748, NIST SP 800-38A, RFC 1321) are included so the crypto
 * primitives are checked against independent values, not only against the
 * harness itself.
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import {
  PROTO_VERSION, decodePacket, deriveAesParams, encodeConnack, encodeConnect, encodeDisconnect, encodePing, encodePong,
  encodeRecv, encodeRecvack, encodeSetting, encodeVarLength, encryptPayload, x25519KeyPair, x25519Shared,
} from '../lib/wukong-codec.mjs';

export const GOLDEN_PATH = fileURLToPath(new URL('./wire.v1.json', import.meta.url));

const hex = (b) => Buffer.from(b).toString('hex');
const seed = (byte) => Buffer.alloc(32, byte);

export function generate() {
  const client = x25519KeyPair(seed(0x11));
  const server = x25519KeyPair(seed(0x22));
  const shared = x25519Shared(server.privateKey, client.publicKey);
  const salt = 'abcdef0123456789salt';
  const aes = deriveAesParams(shared, salt);
  const plaintext = JSON.stringify({ type: 1, content: 'hello, 世界', mention: { uids: ['u_bot'] } });
  const payload = encryptPayload(plaintext, aes);

  const varlen = [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455].map(n => ({ value: n, hex: hex(encodeVarLength(n)) }));

  const connect = { version: PROTO_VERSION, deviceFlag: 0, deviceID: '0123456789abcdef0123456789abcdefW', uid: 'u_bot',
    token: 'im_token_fixture', clientTimestamp: 1767225600000, clientKey: client.publicKey.toString('base64') };
  const connackV4 = { serverVersion: 4, timeDiff: 0n, reasonCode: 1, serverKey: server.publicKey.toString('base64'), salt, nodeId: 7n };
  const connackNoVersion = { timeDiff: 0n, reasonCode: 1, serverKey: server.publicKey.toString('base64'), salt };
  const recv = { serverVersion: 4, setting: { receiptEnabled: true, topic: true, streamOn: true }, msgKey: '', fromUID: 'u_alice',
    channelID: 'g_room', channelType: 2, expire: 0, clientMsgNo: 'cmn-1', messageID: 9007199254740993n, messageSeq: 42,
    timestamp: 1767225600, topic: 'topic-1', payload };

  const packets = {
    connect: { input: stringify(connect), hex: hex(encodeConnect(connect)) },
    connackV4: { input: stringify(connackV4), hex: hex(encodeConnack(connackV4)) },
    connackNoVersion: { input: stringify(connackNoVersion), hex: hex(encodeConnack(connackNoVersion)) },
    connackKicked: { input: { serverVersion: 4, reasonCode: 0 }, hex: hex(encodeConnack({ serverVersion: 4, reasonCode: 0 })) },
    recvV4Topic: { input: stringify({ ...recv, payload: undefined }), payloadAscii: payload.toString('latin1'), hex: hex(encodeRecv(recv)) },
    recvack: { input: { messageID: '9007199254740993', messageSeq: 42 }, hex: hex(encodeRecvack({ messageID: 9007199254740993n, messageSeq: 42 })) },
    ping: { hex: hex(encodePing()) },
    pong: { hex: hex(encodePong()) },
    disconnect: { input: { reasonCode: 1, reason: 'kicked' }, hex: hex(encodeDisconnect({ reasonCode: 1, reason: 'kicked' })) },
  };

  const settings = [
    { flags: {}, byte: encodeSetting({}) },
    { flags: { receiptEnabled: true }, byte: encodeSetting({ receiptEnabled: true }) },
    { flags: { topic: true }, byte: encodeSetting({ topic: true }) },
    { flags: { streamOn: true }, byte: encodeSetting({ streamOn: true }) },
  ];

  const negative = [
    { name: 'varlen-5-bytes', hex: '5080808080' + '01', expect: 'error' },
    { name: 'truncated-recvack', hex: hex(encodeRecvack({ messageID: 1n, messageSeq: 1 })).slice(0, -2), expect: 'error' },
    { name: 'length-mismatch', hex: '6003' + '000000', expect: 'error' },
    { name: 'oversized-string-length', hex: '9003' + '00ffff', expect: 'error' },
  ];
  for (const n of negative) {
    try { decodePacket(Buffer.from(n.hex, 'hex')); n.observed = 'decoded'; } catch { n.observed = 'error'; }
  }

  return {
    schemaVersion: 1,
    description: 'WuKongIM wire, framing and session-crypto goldens for the fake Octo server and transport locks (R8 T1-T6, P1/P2).',
    specSources: ['A-socket', 'B-socket'],
    knownAnswer: knownAnswerVectors(),
    session: {
      clientSeedHex: hex(seed(0x11)), serverSeedHex: hex(seed(0x22)),
      clientPublicHex: hex(client.publicKey), serverPublicHex: hex(server.publicKey), sharedHex: hex(shared),
      sharedBase64: shared.toString('base64'), salt, aesKeyAscii: aes.key.toString('latin1'), aesIvAscii: aes.iv.toString('latin1'),
      plaintext, payloadAscii: payload.toString('latin1'),
    },
    varlen, settings, packets, negative,
  };
}

/** Independent public test vectors; values are fixed text, not computed here. */
export function knownAnswerVectors() {
  const sp80038a = { keyHex: '2b7e151628aed2a6abf7158809cf4f3c', ivHex: '000102030405060708090a0b0c0d0e0f',
    plaintextHex: '6bc1bee22e409f96e93d7e117393172a', ciphertextHex: '7649abac8119b246cee98e9b12e9197d' };
  const c = createCipheriv('aes-128-cbc', Buffer.from(sp80038a.keyHex, 'hex'), Buffer.from(sp80038a.ivHex, 'hex')).setAutoPadding(false);
  const observed = hex(Buffer.concat([c.update(Buffer.from(sp80038a.plaintextHex, 'hex')), c.final()]));
  return {
    rfc7748: {
      alicePrivateHex: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
      alicePublicHex: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
      bobPrivateHex: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
      bobPublicHex: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
      sharedHex: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
    },
    sp80038aCbcBlock1: { ...sp80038a, observedHex: observed },
    rfc1321: { input: 'abc', md5Hex: '900150983cd24fb0d6963f7d28e17f72', observedHex: createHash('md5').update('abc').digest('hex') },
  };
}

function stringify(o) {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function render() { return JSON.stringify(generate(), null, 2) + '\n'; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render();
  if (process.argv.includes('--write')) { writeFileSync(GOLDEN_PATH, text); console.log(`wrote ${GOLDEN_PATH}`); }
  else process.stdout.write(text);
}
