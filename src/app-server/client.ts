// SPDX-License-Identifier: Apache-2.0
/**
 * AppServerClient: one `codex app-server` child process over stdio JSONL.
 * Owns spawn, the initialize handshake, request-id correlation, notification
 * fan-out, server-request answers and exit handling (XIN-2043 §5.1–5.2,
 * R8 §3.3.6). Respawn, lanes, generations and turn driving belong to the
 * runtime (DEV-04), not to this module.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  type ClientInfo,
  type InitializeParams,
  type InitializeResponse,
  type RequestId,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
  type ServerRequestReply,
  OPT_OUT_NOTIFICATION_METHODS,
  SERVER_REQUEST_REJECTED,
  requestIdKey,
} from './protocol.js';
import { type DecodedFrame, DEFAULT_MAX_FRAME_BYTES, JsonlDecoder, encodeFrame } from './framing.js';
import {
  type ExitInfo,
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
  AppServerUnavailableError,
  StderrTail,
  capMessage,
  controlRetryDelayMs,
} from './errors.js';
import { execParityServerRequestHandler } from './server-requests.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
export const DEFAULT_SERVER_REQUEST_DEADLINE_MS = 5_000;
/** How long to wait for stdio to close after the child has exited. */
const EXIT_FLUSH_MS = 2_000;

export type ClientState = 'idle' | 'starting' | 'ready' | 'closing' | 'closed';

export type ServerRequestHandler = (request: RpcRequest) => Promise<ServerRequestReply>;

/** Diagnostics; counted by the caller, never fatal to the reader on their own. */
export type ProtocolEvent =
  | { type: 'invalid-frame'; reason: 'json' | 'shape'; detail: string; id?: RequestId }
  | { type: 'oversize-frame'; bytes: number }
  | { type: 'unmatched-response'; id: RequestId }
  | { type: 'late-response'; id: RequestId; method: string }
  | { type: 'listener-error'; method: string; detail: string }
  | { type: 'server-request-timeout'; id: RequestId; method: string }
  | { type: 'server-request-error'; id: RequestId; method: string; detail: string }
  | { type: 'stdin-error'; detail: string }
  | { type: 'callback-error'; callback: 'onExit'; detail: string };

export interface AppServerClientOptions {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clientInfo: ClientInfo;
  /** Defaults to true; experimental fields are rejected without it. */
  experimentalApi?: boolean;
  /** Defaults to the four delta methods. */
  optOutNotificationMethods?: readonly string[];
  /** Defaults to the exec-parity handler. */
  onServerRequest?: ServerRequestHandler;
  onExit?: (info: ExitInfo) => void;
  onProtocolEvent?: (event: ProtocolEvent) => void;
  /** Control RPC ceiling; 0 disables it for a request. Default 60 s. */
  requestTimeoutMs?: number;
  /** initialize deadline. Default 10 s. */
  initializeTimeoutMs?: number;
  /** Host deadline for answering a server request. Default 5 s. */
  serverRequestDeadlineMs?: number;
  maxFrameBytes?: number;
}

export interface RequestOptions {
  /** Overrides the control RPC ceiling; 0 means no ceiling. */
  timeoutMs?: number;
  /** Retry only rejections that prove non-acceptance (§5.7). Default false. */
  retry?: boolean;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

type Listener = { filter: (n: RpcNotification) => boolean; fn: (n: RpcNotification) => void };

export class AppServerClient {
  readonly #options: AppServerClientOptions;
  #state: ClientState = 'idle';
  #child?: ChildProcessWithoutNullStreams;
  #decoder: JsonlDecoder;
  #stderr = new StderrTail();
  #nextId = 1;
  #pending = new Map<string, Pending>();
  /** Ids whose callers already gave up; a later response is late, not unmatched. */
  #abandoned = new Map<string, string>();
  #listeners = new Set<Listener>();
  #exitInfo?: ExitInfo;
  #closed: Promise<void>;
  #resolveClosed!: () => void;
  #fatal?: Error;
  #exitFlushTimer?: NodeJS.Timeout;
  #killTimer?: NodeJS.Timeout;

  constructor(options: AppServerClientOptions) {
    this.#options = options;
    this.#decoder = new JsonlDecoder({ maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES });
    this.#closed = new Promise(resolve => {
      this.#resolveClosed = resolve;
    });
  }

  get state(): ClientState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#exitInfo;
  }

  get pendingRequests(): number {
    return this.#pending.size;
  }

  /** Resolves once the child has exited and every pending request settled. */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /** Spawn, send `initialize`, then the `initialized` notification. */
  async start(): Promise<InitializeResponse> {
    if (this.#state !== 'idle') throw new AppServerUnavailableError(`start() called in state ${this.#state}`);
    this.#state = 'starting';
    const opts = this.#options;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.#finalize({ code: null, signal: null, stderrTail: '' }, new AppServerProtocolError(`failed to spawn ${opts.bin}: ${(err as Error).message}`, { cause: err }));
      throw this.#fatal;
    }
    this.#child = child;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', err => {
        const code = (err as NodeJS.ErrnoException).code ?? err.message;
        const failure = new AppServerProtocolError(`failed to spawn ${opts.bin}: ${code}`, { cause: err });
        reject(failure);
        this.#finalize({ code: null, signal: null, stderrTail: this.#stderr.toString() }, failure);
      });
    });
    // Never pause stdout: a client that stops reading stalls the whole server.
    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.#stderr.push(chunk));
    child.stdin.on('error', err => this.#emit({ type: 'stdin-error', detail: capMessage(err.message) }));
    child.once('exit', () => {
      this.#exitFlushTimer = setTimeout(() => this.#onClose(child.exitCode, child.signalCode), EXIT_FLUSH_MS);
      this.#exitFlushTimer.unref();
    });
    child.once('close', (code, signal) => this.#onClose(code, signal));

    await spawned;
    const params: InitializeParams = {
      clientInfo: opts.clientInfo,
      capabilities: {
        experimentalApi: opts.experimentalApi ?? true,
        requestAttestation: false,
        optOutNotificationMethods: [...(opts.optOutNotificationMethods ?? OPT_OUT_NOTIFICATION_METHODS)],
      },
    };
    let response: InitializeResponse;
    try {
      response = await this.#send<InitializeResponse>('initialize', params, opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
    } catch (err) {
      this.#abort(err as Error);
      throw err;
    }
    if (this.#state !== 'starting') throw this.#fatal ?? new AppServerUnavailableError(`state ${this.#state}`);
    this.#write({ method: 'initialized' });
    this.#state = 'ready';
    return response;
  }

  /** Send a client request. Resolves with `result`, rejects with a classified error. */
  async request<R = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<R> {
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    for (let attempt = 1; ; attempt++) {
      if (this.#state !== 'ready') throw this.#fatal ?? new AppServerUnavailableError(`state ${this.#state}`);
      try {
        return await this.#send<R>(method, params, timeoutMs);
      } catch (err) {
        const delay = options.retry ? controlRetryDelayMs(err, attempt) : null;
        if (delay === null) throw err;
        await this.#sleep(delay);
      }
    }
  }

  /** Send a client notification. */
  notify(method: string, params?: unknown): void {
    if (this.#state !== 'ready') throw this.#fatal ?? new AppServerUnavailableError(`state ${this.#state}`);
    this.#write(params === undefined ? { method } : { method, params });
  }

  /** Register a notification listener; returns the unsubscribe function. */
  subscribe(filter: (n: RpcNotification) => boolean, fn: (n: RpcNotification) => void): () => void {
    const listener: Listener = { filter, fn };
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Graceful close: end stdin (the server drains and exits), then SIGKILL
   * after `graceMs`. Pending requests settle when the process exits.
   */
  async close(options: { graceMs: number }): Promise<void> {
    if (this.#state === 'closed') return this.#closed;
    if (this.#state === 'idle') {
      this.#finalize({ code: null, signal: null, stderrTail: '' }, new AppServerUnavailableError('closed'));
      return this.#closed;
    }
    if (this.#state !== 'closing') {
      this.#state = 'closing';
      this.#child?.stdin.end();
      this.#killTimer = setTimeout(() => this.#child?.kill('SIGKILL'), Math.max(0, options.graceMs));
      this.#killTimer.unref();
    }
    return this.#closed;
  }

  #send<R>(method: string, params: unknown, timeoutMs: number): Promise<R> {
    const id = this.#nextId++;
    const key = requestIdKey(id);
    return new Promise<R>((resolve, reject) => {
      const pending: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(key);
          this.#abandoned.set(key, method);
          reject(new AppServerTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.#pending.set(key, pending);
      try {
        this.#write(params === undefined ? { id, method } : { id, method, params });
      } catch (err) {
        this.#pending.delete(key);
        if (pending.timer) clearTimeout(pending.timer);
        reject(err as Error);
      }
    });
  }

  #write(message: object): void {
    const stdin = this.#child?.stdin;
    if (!stdin || !stdin.writable || stdin.writableEnded) throw this.#fatal ?? new AppServerUnavailableError('stdin is not writable');
    stdin.write(encodeFrame(message));
  }

  #onStdout(chunk: Buffer): void {
    for (const frame of this.#decoder.push(chunk)) this.#onFrame(frame);
  }

  #onFrame(frame: DecodedFrame): void {
    switch (frame.kind) {
      case 'response':
        this.#onResponse(frame.message);
        return;
      case 'notification':
        this.#onNotification(frame.message);
        return;
      case 'request':
        this.#onServerRequest(frame.message);
        return;
      case 'invalid': {
        this.#emit({ type: 'invalid-frame', reason: frame.reason, detail: frame.detail, ...(frame.id === undefined ? {} : { id: frame.id }) });
        if (frame.id !== undefined) this.#settle(frame.id, p => p.reject(new AppServerProtocolError(`${p.method} returned a malformed response: ${frame.detail}`)));
        return;
      }
      case 'oversize':
        // A dropped frame cannot be attributed; continuing would silently lose data.
        this.#emit({ type: 'oversize-frame', bytes: frame.bytes });
        this.#abort(new AppServerProtocolError(`frame exceeded ${this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES} bytes`));
        return;
    }
  }

  #onResponse(response: RpcResponse): void {
    const matched = this.#settle(response.id, p => {
      if ('error' in response) p.reject(new AppServerRpcError(p.method, response.error));
      else p.resolve(response.result);
    });
    if (matched) return;
    const key = requestIdKey(response.id);
    const method = this.#abandoned.get(key);
    if (method !== undefined) {
      this.#abandoned.delete(key);
      this.#emit({ type: 'late-response', id: response.id, method });
    } else {
      this.#emit({ type: 'unmatched-response', id: response.id });
    }
  }

  #settle(id: RequestId, fn: (p: Pending) => void): boolean {
    const key = requestIdKey(id);
    const pending = this.#pending.get(key);
    if (!pending) return false;
    this.#pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    fn(pending);
    return true;
  }

  #onNotification(notification: RpcNotification): void {
    for (const listener of [...this.#listeners]) {
      try {
        if (listener.filter(notification)) listener.fn(notification);
      } catch (err) {
        this.#emit({ type: 'listener-error', method: notification.method, detail: capMessage(String((err as Error)?.message ?? err)) });
      }
    }
  }

  #onServerRequest(request: RpcRequest): void {
    const handler = this.#options.onServerRequest ?? execParityServerRequestHandler;
    const deadlineMs = this.#options.serverRequestDeadlineMs ?? DEFAULT_SERVER_REQUEST_DEADLINE_MS;
    let answered = false;
    const answer = (reply: ServerRequestReply) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      const frame = 'error' in reply ? { id: request.id, error: reply.error } : { id: request.id, result: reply.result ?? null };
      try {
        this.#write(frame);
      } catch {
        // Process is gone; the exit path settles everything else.
      }
    };
    // An unanswered server request blocks the turn forever, so the host deadline always answers.
    const timer = setTimeout(() => {
      this.#emit({ type: 'server-request-timeout', id: request.id, method: request.method });
      answer({ error: { code: SERVER_REQUEST_REJECTED, message: `${request.method} was not answered by the client in time` } });
    }, deadlineMs);
    timer.unref();
    let result: Promise<ServerRequestReply>;
    try {
      result = Promise.resolve(handler(request));
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      reply => answer(isReply(reply) ? reply : { error: { code: SERVER_REQUEST_REJECTED, message: `${request.method} handler returned an invalid reply` } }),
      err => {
        this.#emit({ type: 'server-request-error', id: request.id, method: request.method, detail: capMessage(String((err as Error)?.message ?? err)) });
        answer({ error: { code: SERVER_REQUEST_REJECTED, message: `${request.method} failed in the client` } });
      },
    );
  }

  /** Fail closed: reject everything pending and terminate the child. */
  #abort(err: Error): void {
    if (this.#state === 'closed') return;
    this.#fatal ??= err;
    this.#state = 'closing';
    this.#rejectAll(err);
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill('SIGKILL');
    } else if (!child) {
      this.#finalize({ code: null, signal: null, stderrTail: this.#stderr.toString() }, err);
    }
  }

  #onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#state === 'closed') return;
    for (const frame of this.#decoder.end()) this.#onFrame(frame);
    const info: ExitInfo = { code, signal, stderrTail: this.#stderr.toString() };
    const intended = this.#state === 'closing';
    const err = this.#fatal ?? (intended ? new AppServerUnavailableError('closed') : new AppServerExitedError(info));
    this.#finalize(info, err);
  }

  #finalize(info: ExitInfo, err: Error): void {
    if (this.#state === 'closed') return;
    this.#fatal ??= err;
    this.#state = 'closed';
    this.#exitInfo = info;
    if (this.#exitFlushTimer) clearTimeout(this.#exitFlushTimer);
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#rejectAll(this.#fatal);
    this.#listeners.clear();
    try {
      this.#options.onExit?.(info);
    } catch (callbackErr) {
      // A host callback must not become an uncaught exception from a child-process event.
      this.#emit({ type: 'callback-error', callback: 'onExit', detail: String((callbackErr as Error)?.message ?? callbackErr) });
    } finally {
      this.#resolveClosed();
    }
  }

  #rejectAll(err: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      void this.#closed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Single outward boundary for diagnostics: every string field is scrubbed and capped here. */
  #emit(event: ProtocolEvent): void {
    try {
      this.#options.onProtocolEvent?.(scrubEvent(event));
    } catch {
      // Diagnostics must never break the reader.
    }
  }
}

function scrubEvent(event: ProtocolEvent): ProtocolEvent {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) out[key] = key !== 'type' && typeof value === 'string' ? capMessage(value) : value;
  return out as ProtocolEvent;
}

function isReply(value: unknown): value is ServerRequestReply {
  if (typeof value !== 'object' || value === null) return false;
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasResult === hasError) return false;
  if (hasResult) return true;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code: unknown }).code === 'number' && typeof (error as { message: unknown }).message === 'string';
}
