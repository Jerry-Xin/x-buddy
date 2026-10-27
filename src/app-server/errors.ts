// SPDX-License-Identifier: Apache-2.0
/**
 * Error classes and exact message formats from XIN-2043 §5.7 / R8 §3.3.6.
 * Messages from the server are capped at 500 characters and scrubbed of
 * bearer tokens and `sk-` keys; the stderr tail is capped at 2 KiB.
 */
import {
  type RpcErrorObject,
  JSONRPC_INVALID_REQUEST,
  SERVER_OVERLOADED,
} from './protocol.js';

export const MAX_ERROR_MESSAGE_CHARS = 500;
export const STDERR_TAIL_BYTES = 2 * 1024;

const BEARER = /Bearer\s+[^\s"']+/gi;
const SK_KEY = /sk-[A-Za-z0-9_-]{4,}/g;

export function scrubSecrets(text: string): string {
  return text.replace(BEARER, 'Bearer [redacted]').replace(SK_KEY, 'sk-[redacted]');
}

export function capMessage(text: string, max = MAX_ERROR_MESSAGE_CHARS): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length <= max ? scrubbed : scrubbed.slice(0, max);
}

const DATA_MAX_DEPTH = 8;
const DATA_MAX_ENTRIES = 64;
const DATA_MAX_BYTES = 8 * 1024;

/**
 * Bounded, scrubbed copy of server-supplied error `data`. Every string (keys
 * included) is scrubbed and capped; depth, entries per container and total
 * size are bounded; cycles become `[circular]`. Callers never see raw data.
 */
export function sanitizeErrorData(value: unknown): unknown {
  let budget = DATA_MAX_BYTES;
  const seen = new WeakSet<object>();
  const take = (text: string): string => {
    const capped = capMessage(text, Math.max(0, Math.min(MAX_ERROR_MESSAGE_CHARS, budget)));
    budget -= capped.length + 2;
    return capped;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (budget <= 0) return '[truncated]';
    if (typeof v === 'string') return take(v);
    if (v === null || typeof v === 'number' || typeof v === 'boolean') {
      budget -= 8;
      return v;
    }
    if (typeof v !== 'object') return undefined;
    if (seen.has(v)) return '[circular]';
    if (depth >= DATA_MAX_DEPTH) return '[truncated]';
    seen.add(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v.slice(0, DATA_MAX_ENTRIES)) {
        if (budget <= 0) break;
        out.push(walk(item, depth + 1));
      }
      if (v.length > out.length) out.push('[truncated]');
      return out;
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v);
    let kept = 0;
    for (const [key, item] of entries.slice(0, DATA_MAX_ENTRIES)) {
      if (budget <= 0) break;
      out[take(key)] = walk(item, depth + 1);
      kept++;
    }
    if (entries.length > kept) out['[truncated]'] = true;
    return out;
  };
  return value === undefined ? undefined : walk(value, 0);
}

/** `${method} failed: ${message} (code ${code})`, matching app-server-client. */
export class AppServerRpcError extends Error {
  override readonly name = 'AppServerRpcError';
  readonly method: string;
  readonly code: number;
  readonly rpcMessage: string;
  readonly data: unknown;

  constructor(method: string, error: RpcErrorObject) {
    const rpcMessage = capMessage(error.message);
    super(`${method} failed: ${rpcMessage} (code ${error.code})`);
    this.method = method;
    this.code = error.code;
    this.rpcMessage = rpcMessage;
    this.data = sanitizeErrorData(error.data);
  }
}

/** The process is not usable: not started, failed, closing or closed. */
export class AppServerUnavailableError extends Error {
  override readonly name = 'AppServerUnavailableError';
  readonly reason: string;
  constructor(reason: string) {
    super(`Codex app-server is unavailable: ${reason}`);
    this.reason = reason;
  }
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  stderrTail: string;
}

/** Process exit while work was pending. */
export class AppServerExitedError extends Error {
  override readonly name = 'AppServerExitedError';
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
  constructor(info: ExitInfo) {
    super(`Codex app-server exited unexpectedly (code=${info.code}, signal=${info.signal}): ${info.stderrTail}`);
    this.code = info.code;
    this.signal = info.signal;
    this.stderrTail = info.stderrTail;
  }
}

/** Control RPC exceeded its deadline. Acceptance is ambiguous: never replayed. */
export class AppServerTimeoutError extends Error {
  override readonly name = 'AppServerTimeoutError';
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs} ms`);
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** Transport-level protocol violation (oversize frame, broken stdin, spawn error). */
export class AppServerProtocolError extends Error {
  override readonly name = 'AppServerProtocolError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(capMessage(message), options);
  }
}

/**
 * Bounded control retry for rejections that prove the request was not
 * accepted (§5.7). Returns the delay before the next attempt, or null.
 * `attempt` is the 1-based number of the attempt that just failed.
 */
export function controlRetryDelayMs(err: unknown, attempt: number): number | null {
  if (!(err instanceof AppServerRpcError) || attempt < 1 || attempt > 5) return null;
  if (err.code === SERVER_OVERLOADED) return 100 * 2 ** (attempt - 1);
  if (err.code === JSONRPC_INVALID_REQUEST && /^thread \S+ is closing/.test(err.rpcMessage)) return 200;
  return null;
}

/** Keeps the last bytes of stderr; scrubbing happens before truncation. */
export class StderrTail {
  readonly #windowBytes: number;
  readonly #tailBytes: number;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(tailBytes = STDERR_TAIL_BYTES) {
    this.#tailBytes = tailBytes;
    this.#windowBytes = tailBytes * 4;
  }

  push(chunk: Buffer): void {
    const next = Buffer.concat([this.#buffer, chunk]);
    this.#buffer = next.length > this.#windowBytes ? next.subarray(next.length - this.#windowBytes) : next;
  }

  toString(): string {
    const scrubbed = Buffer.from(scrubSecrets(this.#buffer.toString('utf8')), 'utf8');
    const tail = scrubbed.length > this.#tailBytes ? scrubbed.subarray(scrubbed.length - this.#tailBytes) : scrubbed;
    // Drop a partial leading UTF-8 sequence created by byte truncation.
    return tail.toString('utf8').replace(/^�+/, '');
  }
}
