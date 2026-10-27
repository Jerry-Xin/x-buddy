// SPDX-License-Identifier: Apache-2.0
/**
 * Fake Octo server: REST (`/v1/bot/*`) and WuKongIM WebSocket on one loopback
 * listener. It is a scripted, recording peer for layer-2 tests (R8 §10.1); it
 * models wire shapes only and asserts nothing about live Octo behaviour, which
 * stays with the real-Octo spikes.
 *
 * Design rules:
 *  - Fail closed: unknown routes answer 404 and are recorded as `unhandled`;
 *    bad Bearer tokens answer 401; oversize bodies answer 413.
 *  - Every request and WS packet is recorded in order with a sequence number.
 *  - Faults come from an injected `FaultPlan` (`api.forceStatus`,
 *    `transport.dropConnack`, `transport.disconnect`).
 *  - Time comes from an injected `Clock` (`now()` only).
 */
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { attachWebSocket } from './ws-server.mjs';
import { NO_FAULTS } from './fault-plan.mjs';
import {
  CONNACK_REASON, FrameAssembler, PROTO_VERSION, PacketType, decodePacket, deriveAesParams, encodeConnack,
  encodeDisconnect, encodePong, encodeRecv, encryptPayload, x25519KeyPair, x25519Shared,
} from './wukong-codec.mjs';
import { URL } from 'node:url';

export const LOOPBACK_HOST = '127.0.0.1';
export const MAX_REST_BODY_BYTES = 1024 * 1024;

/** Build a loopback URL without embedding a literal endpoint in source. */
export function loopbackUrl(scheme, port, path = '') {
  return `${scheme}://${LOOPBACK_HOST}:${port}${path}`;
}

/**
 * Built-in endpoint table (A's REST surface at the pin). `name` is the stable
 * endpoint key used by `api.forceStatus` and by recorded requests; `ep` links
 * the R8 endpoint inventory row.
 */
export const BUILTIN_ENDPOINTS = Object.freeze([
  { name: 'register', ep: 'EP-01', method: 'POST', pattern: '/v1/bot/register' },
  { name: 'heartbeat', ep: 'EP-02', method: 'POST', pattern: '/v1/bot/heartbeat' },
  { name: 'sendMessage', ep: 'EP-03', method: 'POST', pattern: '/v1/bot/sendMessage' },
  { name: 'typing', ep: 'EP-09', method: 'POST', pattern: '/v1/bot/typing' },
  { name: 'readReceipt', ep: 'EP-10', method: 'POST', pattern: '/v1/bot/readReceipt' },
  { name: 'messagesSync', ep: 'EP-11', method: 'POST', pattern: '/v1/bot/messages/sync' },
  { name: 'groupMembers', ep: 'EP-13', method: 'GET', pattern: '/v1/bot/groups/:groupNo/members' },
  { name: 'mentionPref', ep: 'EP-14', method: 'GET', pattern: '/v1/bot/groups/:groupNo/mention_pref' },
  { name: 'groupMdGet', ep: 'EP-15', method: 'GET', pattern: '/v1/bot/groups/:groupNo/md' },
  { name: 'threadMdGet', ep: 'EP-16', method: 'GET', pattern: '/v1/bot/groups/:groupNo/threads/:shortId/md' },
  { name: 'userInfo', ep: 'EP-19', method: 'GET', pattern: '/v1/bot/user/info' },
  { name: 'uploadCredentials', ep: 'EP-21', method: 'GET', pattern: '/v1/bot/upload/credentials' },
].map(Object.freeze));

/** Serialise JSON with chosen keys emitted as bare (possibly > 2^53) integers. */
export function jsonWithInt64(value, int64Keys = ['message_id']) {
  const marker = '__fake_octo_int64__:';
  const text = JSON.stringify(value, (k, v) => (int64Keys.includes(k) && typeof v === 'string' && /^\d+$/.test(v) ? marker + v : v));
  return text.replace(/"__fake_octo_int64__:(\d+)"/g, '$1');
}

export class FakeOctoServer {
  #http; #ws; #faults; #clock; #bots = new Map(); #routes = []; #log = []; #seq = 0;
  #sessions = new Set(); #messageId; #channelSeq = new Map(); #serverSeed; #saltFor; #connackOverride = null;
  #autoPong = true; #state = new Map(); #port = 0;

  /**
   * @param {object} [opts]
   * @param {import('./fault-plan.mjs').FaultPlan} [opts.faults]
   * @param {{ now(): number }} [opts.clock]
   * @param {Uint8Array} [opts.serverKeySeed] deterministic 32-byte X25519 seed
   * @param {(n: number) => string} [opts.saltFor] salt per connection index
   * @param {bigint} [opts.firstMessageId] defaults above 2^53 to exercise int64 handling
   */
  constructor(opts = {}) {
    this.#faults = opts.faults ?? NO_FAULTS;
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#serverSeed = opts.serverKeySeed ? Buffer.from(opts.serverKeySeed) : null;
    this.#saltFor = opts.saltFor ?? (() => randomBytes(8).toString('hex'));
    this.#messageId = opts.firstMessageId ?? 9_007_199_254_740_993n;
    for (const ep of BUILTIN_ENDPOINTS) this.#routes.push({ ...ep, regex: compilePattern(ep.pattern), handler: (ctx) => this.#builtin(ep.name, ctx) });
    this.#http = createServer((req, res) => { this.#onRequest(req, res).catch(err => this.#fail(res, err)); });
    this.#ws = attachWebSocket(this.#http, { path: '/ws', onConnection: (conn) => this.#onWs(conn) });
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  async start() {
    await new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(0, LOOPBACK_HOST, () => { this.#http.off('error', reject); resolve(); });
    });
    this.#port = this.#http.address().port;
    return this;
  }

  async stop() {
    this.#ws.closeAll();
    this.#http.closeAllConnections?.();
    await new Promise(resolve => this.#http.close(() => resolve()));
  }

  get apiUrl() { return loopbackUrl('http', this.#port); }
  get wsUrl() { return loopbackUrl('ws', this.#port, '/ws'); }

  // ─── configuration ──────────────────────────────────────────────────────

  /**
   * Register a bot identity. `botToken` authenticates REST; `imToken` is what
   * register returns and what CONNECT must present.
   */
  addBot({ botToken, robotId, imToken = `im_${robotId}`, ownerUid = '', ownerChannelId = '' }) {
    if (!botToken || !robotId) throw new TypeError('botToken and robotId are required');
    this.#bots.set(botToken, { botToken, robotId, imToken, ownerUid, ownerChannelId, registrations: 0 });
    return this;
  }

  /** Add or override a route. Handler receives `{method, path, params, query, body, bot}` and returns `{status, body | text}`. */
  route(method, pattern, handler, { name = `${method} ${pattern}`, ep = null } = {}) {
    this.#routes.unshift({ name, ep, method, pattern, regex: compilePattern(pattern), handler });
    return this;
  }

  /** Seed per-key state read by built-in handlers (`history:<channel>`, `members:<group>`, `groupMd:<group>`, `user:<uid>` …). */
  setState(key, value) { this.#state.set(key, value); return this; }

  /** Override the next CONNACK(s) (reason code, salt, server version) for negative tests. */
  overrideConnack(fields) { this.#connackOverride = fields ? { ...fields } : null; return this; }

  /** Stop answering PINGs (heartbeat-timeout scenarios). */
  setAutoPong(enabled) { this.#autoPong = Boolean(enabled); return this; }

  // ─── inspection ─────────────────────────────────────────────────────────

  /** Ordered record of REST requests and WS packets. */
  log() { return this.#log.map(e => globalThis.structuredClone(e)); }
  requests(name) { return this.log().filter(e => e.kind === 'rest' && (name === undefined || e.endpoint === name)); }
  unhandled() { return this.log().filter(e => e.kind === 'rest' && e.endpoint === null); }
  packets(type) { return this.log().filter(e => e.kind === 'ws' && (type === undefined || e.packet === type)); }
  sessions() { return [...this.#sessions].map(s => ({ id: s.id, uid: s.uid, authenticated: s.authenticated, open: s.conn.open })); }

  /** Messages pushed but never acknowledged (per session). */
  unacked() {
    const out = [];
    for (const s of this.#sessions) for (const [id, m] of s.pending) out.push({ session: s.id, messageID: id, messageSeq: m.messageSeq });
    return out;
  }

  // ─── WS driving ─────────────────────────────────────────────────────────

  /**
   * Push one RECV to every authenticated session of `uid` (default: all).
   * `payload` is a JSON-serialisable object encrypted with each session key;
   * `rawPayload` sends bytes as-is (poison / decrypt-failure cases).
   */
  push({ uid, fromUID, channelID, channelType = 1, payload, rawPayload, setting, topic, clientMsgNo = '', messageID, timestamp, noPersist, reddot }) {
    const targets = [...this.#sessions].filter(s => s.authenticated && s.conn.open && (uid === undefined || s.uid === uid));
    if (targets.length === 0) throw new Error(`no authenticated session for ${uid ?? 'any uid'}`);
    const id = messageID !== undefined ? BigInt(messageID) : this.#messageId++;
    const seq = (this.#channelSeq.get(channelID) ?? 0) + 1;
    this.#channelSeq.set(channelID, seq);
    const ts = timestamp ?? Math.floor(this.#clock.now() / 1000);
    for (const s of targets) {
      const body = rawPayload !== undefined ? Buffer.from(rawPayload) : encryptPayload(JSON.stringify(payload), s.aes);
      const frame = encodeRecv({ serverVersion: s.serverVersion, setting, topic, fromUID, channelID, channelType, clientMsgNo,
        messageID: id, messageSeq: seq, timestamp: ts, payload: body, noPersist, reddot });
      s.pending.set(id.toString(), { messageSeq: seq, frame });
      this.#record({ kind: 'ws', dir: 'out', session: s.id, packet: 'RECV', messageID: id.toString(), messageSeq: seq });
      s.conn.send(frame);
      const d = this.#faults.hit('transport.disconnect');
      if (d) this.#abort(s, d.action);
    }
    return { messageID: id.toString(), messageSeq: seq };
  }

  /** Re-send every unacknowledged RECV (server redelivery). */
  redeliver() {
    let n = 0;
    for (const s of this.#sessions) {
      if (!s.conn.open) continue;
      for (const [id, m] of s.pending) { this.#record({ kind: 'ws', dir: 'out', session: s.id, packet: 'RECV', messageID: id, messageSeq: m.messageSeq, redelivery: true }); s.conn.send(m.frame); n++; }
    }
    return n;
  }

  /** Send DISCONNECT (kick) to sessions of `uid`, then close them. */
  kick(uid, { reasonCode = 0, reason = 'kicked' } = {}) {
    for (const s of this.#sessions) {
      if (uid !== undefined && s.uid !== uid) continue;
      this.#record({ kind: 'ws', dir: 'out', session: s.id, packet: 'DISCONNECT', reasonCode });
      s.conn.send(encodeDisconnect({ reasonCode, reason }));
      s.conn.close(1000, 'kick');
    }
  }

  /** Abruptly drop sessions (no DISCONNECT, no close frame). */
  dropConnections(uid) {
    for (const s of this.#sessions) if (uid === undefined || s.uid === uid) this.#abort(s, 'drop');
  }

  /** Write arbitrary bytes inside a binary WS message (framing / bounds attacks). */
  sendRawPacket(uid, bytes) {
    for (const s of this.#sessions) if (uid === undefined || s.uid === uid) s.conn.send(Buffer.from(bytes));
  }

  // ─── internals: WS ─────────────────────────────────────────────────────

  #onWs(conn) {
    const s = { id: ++this.#seq, conn, uid: null, authenticated: false, aes: null, serverVersion: PROTO_VERSION,
      assembler: new FrameAssembler(), pending: new Map(), index: this.#sessions.size };
    this.#sessions.add(s);
    this.#record({ kind: 'ws', dir: 'event', session: s.id, packet: 'OPEN' });
    conn.on('message', (data) => {
      let frames;
      try { frames = s.assembler.push(data); } catch (err) { this.#protocolClose(s, err); return; }
      for (const f of frames) {
        try { this.#onPacket(s, f); } catch (err) { this.#protocolClose(s, err); return; }
      }
    });
    conn.on('close', (code) => this.#record({ kind: 'ws', dir: 'event', session: s.id, packet: 'CLOSE', code }));
  }

  #onPacket(s, frame) {
    const pkt = decodePacket(frame, { serverVersion: s.serverVersion });
    switch (pkt.type) {
      case PacketType.CONNECT: return this.#onConnect(s, pkt);
      case PacketType.PING:
        this.#record({ kind: 'ws', dir: 'in', session: s.id, packet: 'PING' });
        if (this.#autoPong) { s.conn.send(encodePong()); this.#record({ kind: 'ws', dir: 'out', session: s.id, packet: 'PONG' }); }
        return;
      case PacketType.RECVACK: {
        const known = s.pending.delete(pkt.messageID);
        this.#record({ kind: 'ws', dir: 'in', session: s.id, packet: 'RECVACK', messageID: pkt.messageID, messageSeq: pkt.messageSeq, known });
        return;
      }
      default:
        this.#record({ kind: 'ws', dir: 'in', session: s.id, packet: `TYPE_${pkt.type}` });
    }
  }

  #onConnect(s, pkt) {
    const bot = [...this.#bots.values()].find(b => b.robotId === pkt.uid);
    const authorised = Boolean(bot && bot.imToken === pkt.token && bot.registrations > 0);
    this.#record({ kind: 'ws', dir: 'in', session: s.id, packet: 'CONNECT', uid: pkt.uid, version: pkt.version,
      deviceFlag: pkt.deviceFlag, deviceID: pkt.deviceID, clientKeyBytes: Buffer.from(pkt.clientKey, 'base64').length, authorised });
    if (this.#faults.hit('transport.dropConnack')) { this.#record({ kind: 'ws', dir: 'fault', session: s.id, packet: 'CONNACK_DROPPED' }); return; }
    const o = this.#connackOverride ?? {};
    const serverVersion = 'serverVersion' in o ? o.serverVersion : PROTO_VERSION;
    const reasonCode = o.reasonCode ?? (authorised ? CONNACK_REASON.SUCCESS : 2);
    const salt = o.salt ?? this.#saltFor(s.index);
    const seed = this.#serverSeed ?? randomBytes(32);
    const kp = x25519KeyPair(seed);
    s.serverVersion = serverVersion ?? 0;
    if (reasonCode === CONNACK_REASON.SUCCESS) {
      s.uid = pkt.uid;
      const shared = x25519Shared(kp.privateKey, Buffer.from(pkt.clientKey, 'base64'));
      try { s.aes = deriveAesParams(shared, salt); s.authenticated = true; } catch { s.aes = null; s.authenticated = false; }
    }
    s.conn.send(encodeConnack({ serverVersion, reasonCode, serverKey: kp.publicKey.toString('base64'), salt }));
    this.#record({ kind: 'ws', dir: 'out', session: s.id, packet: 'CONNACK', reasonCode, serverVersion: serverVersion ?? null,
      saltBytes: Buffer.byteLength(salt, 'utf8') });
  }

  #protocolClose(s, err) {
    this.#record({ kind: 'ws', dir: 'event', session: s.id, packet: 'PROTOCOL_ERROR', error: String(err.message ?? err) });
    s.conn.close(1002, 'protocol error');
  }

  #abort(s, how) {
    this.#record({ kind: 'ws', dir: 'fault', session: s.id, packet: 'ABORT', how });
    s.conn.terminate();
  }

  // ─── internals: REST ───────────────────────────────────────────────────

  async #onRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://fake.invalid');
    const body = await readBody(req);
    const entry = { kind: 'rest', seq: 0, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      endpoint: null, ep: null, auth: 'missing', body: null, status: 0 };
    if (body === null) { entry.status = 413; this.#record(entry); return send(res, 413, { error: 'payload too large' }); }
    entry.body = parseJsonOrText(body);
    const route = this.#routes.find(r => r.method === req.method && r.regex.test(url.pathname));
    const auth = String(req.headers.authorization ?? '');
    const bot = auth.startsWith('Bearer ') ? this.#bots.get(auth.slice(7)) : undefined;
    entry.auth = !auth ? 'missing' : bot ? 'valid' : 'invalid';
    if (!route) { entry.status = 404; this.#record(entry); return send(res, 404, { error: 'not found' }); }
    entry.endpoint = route.name; entry.ep = route.ep;
    if (!bot) { entry.status = 401; this.#record(entry); return send(res, 401, { error: 'unauthorized' }); }
    const forced = this.#faults.hit('api.forceStatus', { endpoint: route.name });
    if (forced) {
      entry.status = forced.status; entry.fault = 'api.forceStatus'; this.#record(entry);
      const headers = forced.status === 429 && forced.retryAfter !== undefined ? { 'retry-after': String(forced.retryAfter) } : {};
      return send(res, forced.status, { error: 'forced fault', status: forced.status }, headers);
    }
    const params = route.regex.exec(url.pathname).groups ?? {};
    const out = await route.handler({ method: req.method, path: url.pathname, params, query: entry.query, body: entry.body, bot, server: this });
    entry.status = out.status ?? 200;
    this.#record(entry);
    if (out.text !== undefined) return sendText(res, entry.status, out.text, out.headers);
    return send(res, entry.status, out.body ?? {}, out.headers);
  }

  #builtin(name, { body, params, query, bot }) {
    switch (name) {
      case 'register':
        bot.registrations++;
        return { body: { robot_id: bot.robotId, im_token: bot.imToken, ws_url: this.wsUrl, api_url: this.apiUrl,
          owner_uid: bot.ownerUid, owner_channel_id: bot.ownerChannelId } };
      case 'heartbeat': case 'typing': case 'readReceipt':
        return { body: {} };
      case 'sendMessage': {
        const channel = body && typeof body === 'object' ? String(body.channel_id ?? '') : '';
        const seq = (this.#channelSeq.get(channel) ?? 0) + 1;
        this.#channelSeq.set(channel, seq);
        const id = (this.#messageId++).toString();
        return { text: jsonWithInt64({ message_id: id, message_seq: seq, client_msg_no: body?.client_msg_no ?? '' }) };
      }
      case 'messagesSync':
        return { text: jsonWithInt64({ messages: this.#state.get(`history:${body?.channel_id}`) ?? [] }) };
      case 'groupMembers':
        return { body: this.#state.get(`members:${params.groupNo}`) ?? { members: [] } };
      case 'mentionPref':
        return { body: this.#state.get(`mentionPref:${params.groupNo}`) ?? {} };
      case 'groupMdGet':
        return stateOr404(this.#state.get(`groupMd:${params.groupNo}`));
      case 'threadMdGet':
        return stateOr404(this.#state.get(`threadMd:${params.groupNo}/${params.shortId}`));
      case 'userInfo':
        return stateOr404(this.#state.get(`user:${query.uid}`));
      case 'uploadCredentials':
        return stateOr404(this.#state.get('uploadCredentials'));
      default:
        return { status: 500, body: { error: `no builtin ${name}` } };
    }
  }

  #fail(res, err) {
    this.#record({ kind: 'rest', endpoint: null, status: 500, error: String(err?.message ?? err) });
    if (!res.headersSent) send(res, 500, { error: 'fake server error' });
  }

  #record(entry) {
    entry.seq = ++this.#seq;
    entry.at = this.#clock.now();
    this.#log.push(entry);
  }
}

function compilePattern(pattern) {
  const src = pattern.split('/').map(seg => (seg.startsWith(':') ? `(?<${seg.slice(1)}>[^/]+)` : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${src}$`);
}

function stateOr404(v) { return v === undefined ? { status: 404, body: { error: 'not found' } } : { body: v }; }

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_REST_BODY_BYTES) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonOrText(text) {
  if (text === '') return null;
  try { return JSON.parse(text); } catch { return { unparsed: text.slice(0, 500) }; }
}

function send(res, status, body, headers = {}) {
  sendText(res, status, JSON.stringify(body), headers);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}
