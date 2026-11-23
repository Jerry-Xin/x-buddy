// SPDX-License-Identifier: Apache-2.0
/**
 * Scripted mock Responses API server (`POST /v1/responses`, SSE) for the
 * real-binary and deployed-stack layers (R8 §10.1 layer 3, §10.4).
 *
 * Each request consumes the next scripted reply. A reply is either a list of
 * SSE events `{event, data, delayMs?}` or an error `{status, body}`. The
 * default event list is a minimal placeholder; the event shapes the pinned
 * binary requires must be fixed by the real-binary job, not assumed here.
 *
 * Requests are recorded with the parsed JSON body. Authorization values are
 * never stored: only the scheme and a SHA-256 digest are kept, which is
 * enough for "no Authorization" / "Bearer <key>" assertions (SB-11).
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { LOOPBACK_HOST, loopbackUrl } from './fake-octo.mjs';
import { URL } from 'node:url';

export const DEFAULT_SSE_REPLY = Object.freeze([
  { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_fake', status: 'in_progress' } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'ok' } },
  { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_fake', status: 'completed' } } },
]);

export class MockResponsesServer {
  #http; #queue = []; #log = []; #port = 0; #fallback;

  /** @param {{ replies?: Array<object>, fallback?: object }} [opts] */
  constructor(opts = {}) {
    this.#queue = [...(opts.replies ?? [])];
    this.#fallback = opts.fallback ?? { events: DEFAULT_SSE_REPLY };
    this.#http = createServer((req, res) => { this.#handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(0, LOOPBACK_HOST, () => { this.#http.off('error', reject); resolve(); });
    });
    this.#port = this.#http.address().port;
    return this;
  }

  async stop() {
    this.#http.closeAllConnections?.();
    await new Promise(resolve => this.#http.close(() => resolve()));
  }

  /** Base URL to configure as the provider base (includes `/v1`). */
  get baseUrl() { return loopbackUrl('http', this.#port, '/v1'); }

  enqueue(reply) { this.#queue.push(reply); return this; }
  requests() { return this.#log.map(e => globalThis.structuredClone(e)); }

  async #handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed: raw.slice(0, 500) }; }
    const auth = req.headers.authorization;
    this.#log.push({
      seq: this.#log.length + 1, method: req.method, path: new URL(req.url ?? '/', 'http://fake.invalid').pathname, body,
      authorization: auth === undefined ? null : { scheme: String(auth).split(' ')[0], sha256: createHash('sha256').update(String(auth)).digest('hex') },
    });
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    }
    const reply = this.#queue.shift() ?? this.#fallback;
    if (reply.status !== undefined) {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(reply.body ?? { error: { message: 'scripted error' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const ev of reply.events) {
      if (ev.delayMs) await delay(ev.delayMs);
      if (ev.event) res.write(`event: ${ev.event}\n`);
      res.write(`data: ${typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)}\n\n`);
    }
    res.end();
  }
}
