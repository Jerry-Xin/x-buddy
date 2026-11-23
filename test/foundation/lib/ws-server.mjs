// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal RFC 6455 WebSocket server for fake endpoints, built on `node:http`
 * upgrade handling so the harness needs no third-party WebSocket package.
 * Server role only: client frames must be masked, server frames are unmasked.
 * Supports binary/text messages, fragmentation, ping/pong and close. Message
 * size is capped so a misbehaving client cannot exhaust test memory.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export class WsConnection extends EventEmitter {
  #socket; #maxBytes;
  #buf = Buffer.alloc(0);
  /** @type {Buffer[]} */
  #fragments = [];
  #fragOpcode = 0;
  #closed = false;
  #closeSent = false;

  constructor(socket, { maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES, request } = {}) {
    super();
    this.#socket = socket;
    this.#maxBytes = maxMessageBytes;
    this.request = request;
    socket.on('data', chunk => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006, ''));
    socket.on('error', () => this.#finish(1006, ''));
  }

  get open() { return !this.#closed && !this.#closeSent; }

  /** Send a binary message. */
  send(data) { this.#write(0x2, Buffer.from(data)); }
  sendText(text) { this.#write(0x1, Buffer.from(String(text), 'utf8')); }
  ping(data = Buffer.alloc(0)) { this.#write(0x9, Buffer.from(data)); }

  /** Write raw bytes to the TCP socket, bypassing framing (fault injection). */
  writeRaw(bytes) { if (!this.#closed) this.#socket.write(Buffer.from(bytes)); }

  close(code = 1000, reason = '') {
    if (this.#closed || this.#closeSent) return;
    const r = Buffer.from(reason, 'utf8');
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.#write(0x8, body);
    this.#closeSent = true;
    this.#socket.end();
  }

  /** Abrupt TCP teardown without a close frame. */
  terminate() {
    if (this.#closed) return;
    this.#socket.destroy();
    this.#finish(1006, '');
  }

  #write(opcode, payload) {
    if (this.#closed || this.#closeSent) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.#socket.write(Buffer.concat([header, payload]));
  }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const f = this.#parseFrame();
      if (!f) return;
      if (this.#closed) return;
      this.#onFrame(f);
    }
  }

  #parseFrame() {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    if ((b[0] & 0x70) !== 0) { this.#protocolError('reserved bits set'); return null; }
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.#maxBytes)) { this.#protocolError('frame too large', 1009); return null; }
      len = Number(big); off = 10;
    }
    if (!masked) { this.#protocolError('client frame not masked'); return null; }
    if (len > this.#maxBytes) { this.#protocolError('frame too large', 1009); return null; }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
    this.#buf = Buffer.from(b.subarray(off + 4 + len));
    return { fin, opcode, payload };
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) { this.#protocolError('invalid control frame'); return; }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.#closeSent) { this.close(code === 1005 ? 1000 : code); }
        this.#finish(code, payload.subarray(2).toString('utf8'));
      } else if (opcode === 0x9) { this.#write(0xa, payload); this.emit('ping', payload); }
      else if (opcode === 0xa) this.emit('pong', payload);
      else this.#protocolError('unknown control opcode');
      return;
    }
    if (opcode === 0x0) {
      if (this.#fragOpcode === 0) { this.#protocolError('unexpected continuation'); return; }
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (this.#fragOpcode !== 0) { this.#protocolError('interleaved data frame'); return; }
      this.#fragOpcode = opcode;
    } else { this.#protocolError('unknown data opcode'); return; }
    this.#fragments.push(payload);
    const total = this.#fragments.reduce((n, p) => n + p.length, 0);
    if (total > this.#maxBytes) { this.#protocolError('message too large', 1009); return; }
    if (!fin) return;
    const message = Buffer.concat(this.#fragments);
    const isBinary = this.#fragOpcode === 0x2;
    this.#fragments = [];
    this.#fragOpcode = 0;
    this.emit('message', message, isBinary);
  }

  #protocolError(reason, code = 1002) {
    this.emit('protocolError', reason);
    this.close(code, reason);
    this.#finish(code, reason);
  }

  #finish(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close', code, reason);
  }
}

/**
 * Attach a WebSocket endpoint at `path` to an existing `http.Server`.
 * `onConnection(conn, req)` receives each accepted connection.
 */
export function attachWebSocket(server, { path, onConnection, maxMessageBytes } = {}) {
  /** @type {Set<WsConnection>} */
  const connections = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'ws://fake.invalid');
    const key = req.headers['sec-websocket-key'];
    const reject = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (path && url.pathname !== path) return reject(404, 'Not Found');
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
      return reject(400, 'Bad Request');
    }
    socket.setNoDelay(true);
    socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', '',
    ].join('\r\n'));
    const conn = new WsConnection(socket, { maxMessageBytes, request: req });
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    onConnection?.(conn, req);
  });
  return {
    connections,
    closeAll() { for (const c of [...connections]) c.terminate(); },
  };
}
