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
    this.data = error.data;
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
