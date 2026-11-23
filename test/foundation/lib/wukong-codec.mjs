// SPDX-License-Identifier: Apache-2.0
/**
 * Test-side WuKongIM wire codec and crypto used by the fake Octo server and the
 * wire goldens. Newly authored from the protocol as implemented by the
 * specification sources pinned in `docs/test-foundation/source-pins.json`
 * (A `src/octo/socket.ts` and B `src/socket.ts`); no source bytes are copied.
 *
 * The codec plays the *server* role (decodes CONNECT/RECVACK/PING, encodes
 * CONNACK/RECV/PONG/DISCONNECT) and also exposes the client encoders so tests
 * can drive the fake server without product code. It uses only `node:crypto`.
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';

export const PacketType = Object.freeze({
  CONNECT: 1, CONNACK: 2, SEND: 3, SENDACK: 4, RECV: 5, RECVACK: 6, PING: 7, PONG: 8, DISCONNECT: 9,
});
export const PROTO_VERSION = 4;
export const MAX_VARLEN_BYTES = 4;
export const MAX_ASSEMBLY_BYTES = 1024 * 1024;
export const CONNACK_REASON = Object.freeze({ KICKED: 0, SUCCESS: 1 });

// ─── primitives ─────────────────────────────────────────────────────────────

export class WireWriter {
  /** @type {number[]} */
  #bytes = [];
  byte(v) { assertUint(v, 0xff, 'byte'); this.#bytes.push(v); return this; }
  int16(v) { assertUint(v, 0xffff, 'int16'); this.#bytes.push((v >> 8) & 0xff, v & 0xff); return this; }
  int32(v) { assertUint(v, 0xffffffff, 'int32'); this.#bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; }
  /** @param {bigint|string|number} v unsigned 64-bit */
  int64(v) {
    const n = BigInt(v);
    if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError('int64 out of range');
    for (let shift = 56n; shift >= 0n; shift -= 8n) this.#bytes.push(Number((n >> shift) & 0xffn));
    return this;
  }
  string(s) {
    const enc = Buffer.from(s ?? '', 'utf8');
    this.int16(enc.length);
    for (const b of enc) this.#bytes.push(b);
    return this;
  }
  raw(bytes) { for (const b of bytes) this.#bytes.push(b & 0xff); return this; }
  toBuffer() { return Buffer.from(this.#bytes); }
}

export class WireReader {
  #buf; #off = 0;
  /** @param {Uint8Array} buf */
  constructor(buf) { this.#buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength); }
  #need(n) {
    if (this.#off + n > this.#buf.length) throw new RangeError(`wire: out-of-bounds read (need ${n} at ${this.#off}, have ${this.#buf.length})`);
  }
  byte() { this.#need(1); return this.#buf[this.#off++]; }
  int16() { this.#need(2); const v = this.#buf.readUInt16BE(this.#off); this.#off += 2; return v; }
  int32() { this.#need(4); const v = this.#buf.readUInt32BE(this.#off); this.#off += 4; return v; }
  int64() { this.#need(8); const v = this.#buf.readBigUInt64BE(this.#off); this.#off += 8; return v; }
  string() {
    const len = this.int16();
    if (len === 0) return '';
    this.#need(len);
    const s = this.#buf.toString('utf8', this.#off, this.#off + len);
    this.#off += len;
    return s;
  }
  remaining() { const r = this.#buf.subarray(this.#off); this.#off = this.#buf.length; return Buffer.from(r); }
  get offset() { return this.#off; }
  get done() { return this.#off === this.#buf.length; }
}

export function encodeVarLength(len) {
  if (!Number.isSafeInteger(len) || len < 0) throw new RangeError('length must be a non-negative integer');
  if (len === 0) return [0];
  const out = [];
  while (len > 0) {
    let digit = len % 0x80;
    len = Math.floor(len / 0x80);
    if (len > 0) digit |= 0x80;
    out.push(digit);
  }
  if (out.length > MAX_VARLEN_BYTES) throw new RangeError('length exceeds 4-byte variable-length cap');
  return out;
}

function frame(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | (flags & 0x0f)]), Buffer.from(encodeVarLength(body.length)), body]);
}

// ─── packets ────────────────────────────────────────────────────────────────

/** Client CONNECT (what product code sends). */
export function encodeConnect({ version = PROTO_VERSION, deviceFlag = 0, deviceID, uid, token, clientTimestamp, clientKey }) {
  const body = new WireWriter().byte(version).byte(deviceFlag).string(deviceID).string(uid).string(token)
    .int64(BigInt(clientTimestamp)).string(clientKey).toBuffer();
  return frame(PacketType.CONNECT, 0, body);
}

/**
 * Server CONNACK. When `serverVersion` is given the header flag bit 0 is set and
 * the version byte is written; `nodeId` is written only for serverVersion >= 4.
 */
export function encodeConnack({ serverVersion, timeDiff = 0n, reasonCode, serverKey = '', salt = '', nodeId = 0n }) {
  const w = new WireWriter();
  const hasVersion = serverVersion !== undefined;
  if (hasVersion) w.byte(serverVersion);
  w.int64(BigInt(timeDiff)).byte(reasonCode).string(serverKey).string(salt);
  if (hasVersion && serverVersion >= 4) w.int64(BigInt(nodeId));
  return frame(PacketType.CONNACK, hasVersion ? 0x01 : 0, w.toBuffer());
}

/** RECV setting byte: receipt bit 7, topic bit 3, streamOn bit 1. */
export function encodeSetting({ receiptEnabled = false, topic = false, streamOn = false } = {}) {
  return (receiptEnabled ? 0x80 : 0) | (topic ? 0x08 : 0) | (streamOn ? 0x02 : 0);
}

export function decodeSetting(v) {
  return { receiptEnabled: ((v >> 7) & 1) === 1, topic: ((v >> 3) & 1) === 1, streamOn: ((v >> 1) & 1) === 1 };
}

/**
 * Server RECV. `payload` is the already-encrypted ASCII base64 body.
 * `serverVersion` controls the `expire` field (written when >= 3).
 */
export function encodeRecv({
  serverVersion = PROTO_VERSION, noPersist = false, reddot = false, setting = {}, msgKey = '', fromUID, channelID,
  channelType, expire = 0, clientMsgNo = '', messageID, messageSeq, timestamp, topic = '', payload,
}) {
  const settingByte = encodeSetting(setting);
  const w = new WireWriter().byte(settingByte).string(msgKey).string(fromUID).string(channelID).byte(channelType);
  if (serverVersion >= 3) w.int32(expire);
  w.string(clientMsgNo).int64(BigInt(messageID)).int32(messageSeq).int32(timestamp);
  if (decodeSetting(settingByte).topic) w.string(topic);
  w.raw(payload);
  return frame(PacketType.RECV, (noPersist ? 0x01 : 0) | (reddot ? 0x02 : 0), w.toBuffer());
}

export function encodeRecvack({ messageID, messageSeq }) {
  return frame(PacketType.RECVACK, 0, new WireWriter().int64(BigInt(messageID)).int32(messageSeq).toBuffer());
}

export function encodeDisconnect({ reasonCode = 0, reason = '' }) {
  return frame(PacketType.DISCONNECT, 0, new WireWriter().byte(reasonCode).string(reason).toBuffer());
}

export const encodePing = () => Buffer.from([PacketType.PING << 4]);
export const encodePong = () => Buffer.from([PacketType.PONG << 4]);

/**
 * Decode one complete frame (header + body). `serverVersion` is the version
 * negotiated for the connection; it drives version-dependent fields.
 */
export function decodePacket(bytes, { serverVersion = PROTO_VERSION } = {}) {
  const buf = Buffer.from(bytes);
  if (buf.length === 0) throw new RangeError('empty frame');
  const header = buf[0];
  const type = header >> 4;
  const flags = header & 0x0f;
  if (type === PacketType.PING || type === PacketType.PONG) return { type, flags };
  const { length, used } = readVarLength(buf, 1);
  if (used === 0) throw new RangeError('truncated variable length');
  const body = buf.subarray(1 + used);
  if (body.length !== length) throw new RangeError(`frame length mismatch: declared ${length}, have ${body.length}`);
  const r = new WireReader(body);
  let out;
  switch (type) {
    case PacketType.CONNECT:
      out = { type, flags, version: r.byte(), deviceFlag: r.byte(), deviceID: r.string(), uid: r.string(), token: r.string(),
        clientTimestamp: r.int64(), clientKey: r.string() };
      break;
    case PacketType.CONNACK: {
      const hasVersion = (flags & 0x01) === 1;
      const version = hasVersion ? r.byte() : 0;
      out = { type, flags, serverVersion: hasVersion ? version : undefined, timeDiff: r.int64(), reasonCode: r.byte(),
        serverKey: r.string(), salt: r.string() };
      if (version >= 4) out.nodeId = r.int64();
      break;
    }
    case PacketType.RECV: {
      const settingByte = r.byte();
      const setting = decodeSetting(settingByte);
      out = { type, flags, noPersist: (flags & 1) === 1, reddot: ((flags >> 1) & 1) === 1, setting, msgKey: r.string(),
        fromUID: r.string(), channelID: r.string(), channelType: r.byte() };
      if (serverVersion >= 3) out.expire = r.int32();
      out.clientMsgNo = r.string();
      out.messageID = r.int64().toString();
      out.messageSeq = r.int32();
      out.timestamp = r.int32();
      if (setting.topic) out.topic = r.string();
      out.payload = r.remaining();
      break;
    }
    case PacketType.RECVACK:
      out = { type, flags, messageID: r.int64().toString(), messageSeq: r.int32() };
      break;
    case PacketType.DISCONNECT:
      out = { type, flags, reasonCode: r.byte(), reason: r.string() };
      break;
    default:
      throw new RangeError(`unsupported packet type ${type}`);
  }
  if (!r.done) throw new RangeError(`trailing bytes in packet type ${type}`);
  return out;
}

/**
 * Read an MQTT-style variable length at `start`. Returns `{length, used}` with
 * `used === 0` when more bytes are needed. Throws past the 4-byte cap.
 */
export function readVarLength(buf, start) {
  let length = 0;
  let multiplier = 1;
  for (let i = 0; ; i++) {
    if (i >= MAX_VARLEN_BYTES) throw new RangeError('variable-length encoding exceeded 4 bytes');
    if (start + i >= buf.length) return { length: 0, used: 0 };
    const digit = buf[start + i];
    length += (digit & 0x7f) * multiplier;
    multiplier *= 128;
    if ((digit & 0x80) === 0) return { length, used: i + 1 };
  }
}

/**
 * Sticky-packet assembler with the same bounds as the product client: a 1 MiB
 * assembly cap and a 4-byte variable-length cap. `push` returns complete frames.
 */
export class FrameAssembler {
  #buf = Buffer.alloc(0);
  #cap;
  constructor({ capBytes = MAX_ASSEMBLY_BYTES } = {}) { this.#cap = capBytes; }
  /** @param {Uint8Array} chunk @returns {Buffer[]} */
  push(chunk) {
    this.#buf = Buffer.concat([this.#buf, Buffer.from(chunk)]);
    if (this.#buf.length > this.#cap) {
      this.#buf = Buffer.alloc(0);
      throw new RangeError(`assembly buffer exceeded ${this.#cap} bytes`);
    }
    const frames = [];
    let off = 0;
    while (off < this.#buf.length) {
      const type = this.#buf[off] >> 4;
      if (type === PacketType.PING || type === PacketType.PONG) { frames.push(this.#buf.subarray(off, off + 1)); off += 1; continue; }
      const { length, used } = readVarLength(this.#buf, off + 1);
      if (used === 0) break;
      const total = 1 + used + length;
      if (off + total > this.#buf.length) break;
      frames.push(Buffer.from(this.#buf.subarray(off, off + total)));
      off += total;
    }
    this.#buf = Buffer.from(this.#buf.subarray(off));
    return frames;
  }
  get buffered() { return this.#buf.length; }
}

// ─── crypto ─────────────────────────────────────────────────────────────────

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * Deterministic X25519 key pair from a 32-byte seed (the seed is the private
 * scalar before clamping, matching `curve25519-js` `generateKeyPair(seed)`).
 */
export function x25519KeyPair(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new RangeError('X25519 seed must be 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, s]), format: 'der', type: 'pkcs8' });
  const publicRaw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
  return { privateKey, publicKey: Buffer.from(publicRaw) };
}

/** X25519 shared secret between our private key and a peer's raw 32-byte public key. */
export function x25519Shared(privateKey, peerPublicRaw) {
  const raw = Buffer.from(peerPublicRaw);
  if (raw.length !== 32) throw new RangeError('X25519 public key must be 32 bytes');
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
  return diffieHellman({ privateKey, publicKey });
}

/**
 * Session AES parameters: key = first 16 chars of hex MD5(base64(shared));
 * IV = first 16 UTF-8 bytes of the CONNACK salt. Salt shorter than 16 bytes
 * is rejected, as the product client must reject it.
 */
export function deriveAesParams(sharedSecret, salt) {
  const saltBytes = Buffer.from(salt ?? '', 'utf8');
  if (saltBytes.length < 16) throw new RangeError(`salt too short: ${saltBytes.length} bytes, need >= 16`);
  const md5hex = createHash('md5').update(Buffer.from(sharedSecret).toString('base64'), 'utf8').digest('hex');
  return { key: Buffer.from(md5hex.slice(0, 16), 'latin1'), iv: Buffer.from(saltBytes.subarray(0, 16)) };
}

/** Encrypt a RECV payload: ASCII base64 of AES-128-CBC/PKCS7 ciphertext. */
export function encryptPayload(plaintext, { key, iv }) {
  const c = createCipheriv('aes-128-cbc', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, typeof plaintext === 'string' ? 'utf8' : undefined)), c.final()]);
  return Buffer.from(ct.toString('base64'), 'latin1');
}

/** Inverse of `encryptPayload`; returns the UTF-8 plaintext. */
export function decryptPayload(payload, { key, iv }) {
  const ct = Buffer.from(Buffer.from(payload).toString('latin1'), 'base64');
  const d = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

function assertUint(v, max, name) {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} out of range: ${v}`);
}
