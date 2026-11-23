// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal WuKongIM reference client used to test the fake Octo server itself
 * and as an independent oracle for later transport tests. It is not product
 * code and implements no reconnect/liveness policy. Uses Node's built-in
 * WebSocket (Node >= 22) and the harness codec.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONNACK_REASON, FrameAssembler, PacketType, decodePacket, decryptPayload, deriveAesParams, encodeConnect, encodePing,
  encodeRecvack, x25519KeyPair, x25519Shared,
} from './wukong-codec.mjs';

export class ReferenceClient {
  #ws; #assembler = new FrameAssembler(); #kp; #aes = null; #serverVersion = 0;
  /** @type {Array<object>} */ packets = [];
  /** @type {Array<object>} */ messages = [];
  closed = false;
  /** @type {Error | null} */ handshakeError = null;

  /** @param {{ wsUrl: string, uid: string, token: string, seed?: Uint8Array, autoAck?: boolean, deviceID?: string }} opts */
  constructor(opts) {
    this.opts = { autoAck: true, ...opts };
    this.#kp = x25519KeyPair(opts.seed ?? randomBytes(32));
  }

  /** Open the socket and send CONNECT. Resolves once the socket is open. */
  async open() {
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') throw new Error('global WebSocket unavailable; Node >= 22 required');
    this.#ws = new WS(this.opts.wsUrl);
    this.#ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    });
    this.#ws.addEventListener('message', ev => this.#onData(Buffer.from(ev.data)));
    this.#ws.addEventListener('close', () => { this.closed = true; });
    this.send(encodeConnect({ deviceID: this.opts.deviceID ?? 'refclientW', uid: this.opts.uid, token: this.opts.token,
      clientTimestamp: Date.now(), clientKey: this.#kp.publicKey.toString('base64') }));
    return this;
  }

  send(bytes) { this.#ws.send(Buffer.from(bytes)); }
  ping() { this.send(encodePing()); }
  ack(messageID, messageSeq) { this.send(encodeRecvack({ messageID, messageSeq })); }
  close() { this.#ws?.close(); }

  get authenticated() { return this.#aes !== null; }

  /** Poll until `predicate()` is truthy (bounded real-time wait for socket I/O). */
  async waitFor(predicate, { timeoutMs = 2000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await delay(5);
    }
  }

  #onData(chunk) {
    for (const frame of this.#assembler.push(chunk)) {
      const pkt = decodePacket(frame, { serverVersion: this.#serverVersion });
      this.packets.push(pkt);
      if (pkt.type === PacketType.CONNACK) {
        this.#serverVersion = pkt.serverVersion ?? 0;
        if (pkt.reasonCode === CONNACK_REASON.SUCCESS) {
          try {
            const shared = x25519Shared(this.#kp.privateKey, Buffer.from(pkt.serverKey, 'base64'));
            this.#aes = deriveAesParams(shared, pkt.salt);
          } catch (err) {
            this.handshakeError = err;
            this.close();
          }
        }
      } else if (pkt.type === PacketType.RECV) {
        let decoded;
        try { decoded = JSON.parse(decryptPayload(pkt.payload, this.#aes)); } catch { decoded = null; }
        this.messages.push({ messageID: pkt.messageID, messageSeq: pkt.messageSeq, fromUID: pkt.fromUID, channelID: pkt.channelID,
          channelType: pkt.channelType, setting: pkt.setting, payload: decoded });
        if (decoded !== null && this.opts.autoAck) this.ack(pkt.messageID, pkt.messageSeq);
      }
    }
  }
}
