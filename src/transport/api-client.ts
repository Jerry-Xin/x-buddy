// SPDX-License-Identifier: Apache-2.0
import { isAllowedApiUrl } from '../host/url-policy.js';
import { parseOctoJson } from '../octo/api.js';
import { systemClock, wait, type Clock } from './clock.js';

export type SendOutcome = 'not-sent' | 'ambiguous';
export class OctoApiError extends Error {
  readonly name = 'OctoApiError';
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    readonly sendOutcome: SendOutcome,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly rateLimitScope?: string,
    readonly rateLimitRemaining?: number,
  ) { super(`Octo request failed (${status}): ${bodyExcerpt}`); }
}

export interface RequestOptions {
  timeoutMs?: number;
  retry429?: boolean;
  signal?: AbortSignal;
}

const NO_RETRY = /\/(?:heartbeat|typing|readReceipt|events?|ack)(?:\/|$)/i;
const RESPONSE_LIMIT = 1024 * 1024;

/** Trusted endpoint client. No redirects and no replay except bounded HTTP 429. */
export class OctoApiClient {
  private readonly base: URL;
  private readonly clock: Clock;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: {
    apiUrl: string; botToken: string; clock?: Clock; fetch?: typeof fetch;
  }) {
    this.base = new URL(options.apiUrl);
    if (!isAllowedApiUrl(options.apiUrl) || this.base.username || this.base.password
      || this.base.search || this.base.hash || !options.botToken || /[\r\n]/.test(options.botToken)) {
      throw new Error('Invalid Octo endpoint or credential');
    }
    this.clock = options.clock ?? systemClock;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private scrub(value: string): string {
    return value.split(this.options.botToken).join('[redacted]')
      .replace(/Bearer\s+[^\s"',}<>]+/gi, 'Bearer [redacted]')
      .replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"',}<>]+/gi, '$1[redacted]')
      .slice(0, 500);
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string,
    body?: unknown, options: RequestOptions = {}): Promise<T> {
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || !path.startsWith('/')
      || path.startsWith('//') || /[\\#\r\n]/.test(path)) {
      throw new OctoApiError(0, 'Invalid request path or method', 'not-sent');
    }
    // Concatenation retains the deployment's trusted API prefix. The origin is
    // checked again after URL normalization, including encoded dot segments.
    const prefix = this.base.pathname.replace(/\/+$/, '');
    const url = new URL(`${this.base.origin}${prefix}${path}`);
    if (url.origin !== this.base.origin || url.username || url.password
      || (prefix && !url.pathname.startsWith(`${prefix}/`))) {
      throw new OctoApiError(0, 'Request escapes configured endpoint', 'not-sent');
    }
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new OctoApiError(0, 'Invalid request timeout', 'not-sent');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = this.clock.setTimeout(abort, Math.min(timeout, 60_000));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let invoked = false;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new OctoApiError(0, 'Request cancelled or timed out', invoked ? 'ambiguous' : 'not-sent'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const run = async (): Promise<T> => {
      let waited = 0;
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) throw new OctoApiError(0, 'Request cancelled or timed out', invoked ? 'ambiguous' : 'not-sent');
        // Serialize before setting invoked: invalid/circular payloads sent no bytes.
        const payload = body === undefined ? undefined : JSON.stringify(body);
        invoked = true;
        const response = await this.fetcher(url, {
          method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.botToken}` },
          body: payload, redirect: 'error', signal: controller.signal,
        });
        let text = '';
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const cancelRead = () => { void reader.cancel().catch(() => {}); };
          controller.signal.addEventListener('abort', cancelRead, { once: true });
          if (controller.signal.aborted) cancelRead();
          let bytes = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > RESPONSE_LIMIT) {
                void reader.cancel().catch(() => {});
                throw new OctoApiError(response.status, 'Response exceeds byte limit', 'ambiguous');
              }
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            controller.signal.removeEventListener('abort', cancelRead);
            reader.releaseLock();
          }
        }
        if (controller.signal.aborted) throw new OctoApiError(0, 'Request cancelled or timed out', 'ambiguous');
        if (response.ok) {
          if (!text) return undefined as T;
          try { return parseOctoJson<T>(text); }
          catch { throw new OctoApiError(response.status, 'Invalid JSON response', 'ambiguous'); }
        }
        const retryHeader = response.headers.get('retry-after');
        let retryAfter: number | undefined;
        if (retryHeader !== null) {
          const seconds = Number(retryHeader);
          const ms = retryHeader.trim() && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - this.clock.now();
          if (Number.isFinite(ms)) retryAfter = Math.max(0, ms);
        }
        const delay = retryAfter ?? 1000;
        if (response.status === 429 && options.retry429 !== false && !NO_RETRY.test(url.pathname)
          && attempt < 2 && delay <= 10_000 && waited + delay <= 15_000) {
          waited += delay;
          await wait(this.clock, delay, controller.signal);
          continue;
        }
        let code: string | undefined;
        try {
          const value: unknown = JSON.parse(text);
          if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') code = this.scrub(value.code);
        } catch { /* A non-JSON HTTP error is still an HTTP error. */ }
        const remaining = response.headers.get('x-ratelimit-remaining');
        const scope = response.headers.get('x-ratelimit-scope');
        throw new OctoApiError(response.status, this.scrub(text) || 'HTTP rejection', 'ambiguous', code,
          retryAfter, scope === null ? undefined : this.scrub(scope),
          remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : undefined);
      }
    };
    try { return await Promise.race([run(), cancelled]); }
    catch (error) {
      if (error instanceof OctoApiError) throw error;
      throw new OctoApiError(0, controller.signal.aborted ? 'Request cancelled or timed out' : 'Request failed', invoked ? 'ambiguous' : 'not-sent');
    } finally {
      this.clock.clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
