// SPDX-License-Identifier: Apache-2.0
/**
 * JSONL framing for the App Server stdio transport: one JSON object per line,
 * no `jsonrpc` field. Partial lines accumulate under a bounded frame cap.
 * Malformed input never throws out of the decoder; it is reported as a
 * classified frame so the caller can count it and fail affected work.
 */
import {
  type InboundMessage,
  type RequestId,
  type RpcErrorObject,
  isRequestId,
} from './protocol.js';

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type DecodedFrame =
  | InboundMessage
  | { kind: 'invalid'; reason: 'json' | 'shape'; detail: string; id?: RequestId }
  | { kind: 'oversize'; bytes: number };

const NEWLINE = 0x0a;

export class JsonlDecoder {
  readonly #maxFrameBytes: number;
  #chunks: Buffer[] = [];
  #pendingBytes = 0;
  /** Set while discarding the remainder of an oversize line. */
  #discarding = false;
  #discardedBytes = 0;

  constructor(options: { maxFrameBytes?: number } = {}) {
    const max = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError('maxFrameBytes must be a positive integer');
    this.#maxFrameBytes = max;
  }

  /** Bytes buffered for the current incomplete line. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  push(chunk: Buffer): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (this.#discarding) {
        this.#discardedBytes += piece.length;
      } else if (this.#pendingBytes + piece.length > this.#maxFrameBytes) {
        this.#discarding = true;
        this.#discardedBytes = this.#pendingBytes + piece.length;
        this.#chunks = [];
        this.#pendingBytes = 0;
      } else if (piece.length > 0) {
        this.#chunks.push(Buffer.from(piece));
        this.#pendingBytes += piece.length;
      }
      if (newline === -1) break;
      if (this.#discarding) {
        frames.push({ kind: 'oversize', bytes: this.#discardedBytes });
        this.#discarding = false;
        this.#discardedBytes = 0;
      } else {
        const line = Buffer.concat(this.#chunks, this.#pendingBytes);
        this.#chunks = [];
        this.#pendingBytes = 0;
        const frame = decodeLine(line);
        if (frame) frames.push(frame);
      }
      start = newline + 1;
    }
    return frames;
  }

  /**
   * Flush at end of stream. A trailing line without a newline is incomplete
   * and reported as invalid rather than parsed.
   */
  end(): DecodedFrame[] {
    if (this.#discarding) {
      const bytes = this.#discardedBytes;
      this.#discarding = false;
      this.#discardedBytes = 0;
      return [{ kind: 'oversize', bytes }];
    }
    if (this.#pendingBytes === 0) return [];
    const bytes = this.#pendingBytes;
    this.#chunks = [];
    this.#pendingBytes = 0;
    return [{ kind: 'invalid', reason: 'json', detail: `truncated frame at end of stream (${bytes} bytes)` }];
  }
}

function decodeLine(line: Buffer): DecodedFrame | null {
  let text = line.toString('utf8');
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (text.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The V8 parse message quotes the input, which may carry credentials; report only the size.
    return { kind: 'invalid', reason: 'json', detail: `frame is not valid JSON (${line.length} bytes)` };
  }
  return classify(value);
}

/** Classify a parsed value by presence and type checks, never truthiness. */
export function classify(value: unknown): DecodedFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'shape', detail: 'frame is not a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  const hasId = Object.hasOwn(obj, 'id');
  const hasMethod = Object.hasOwn(obj, 'method');
  const hasResult = Object.hasOwn(obj, 'result');
  const hasError = Object.hasOwn(obj, 'error');

  if (hasMethod) {
    if (typeof obj.method !== 'string') return { kind: 'invalid', reason: 'shape', detail: 'method is not a string' };
    if (hasResult || hasError) return { kind: 'invalid', reason: 'shape', detail: 'method frame carries result/error' };
    if (hasId) {
      if (!isRequestId(obj.id)) return { kind: 'invalid', reason: 'shape', detail: 'request id is not an integer or string' };
      return { kind: 'request', message: { id: obj.id, method: obj.method, params: obj.params } };
    }
    return { kind: 'notification', message: { method: obj.method, params: obj.params } };
  }

  if (!hasId || !isRequestId(obj.id)) return { kind: 'invalid', reason: 'shape', detail: 'response id is missing or invalid' };
  // The id is valid from here on, so a malformed response can still fail its own request.
  const id = obj.id;
  if (hasResult === hasError) return { kind: 'invalid', reason: 'shape', detail: 'response must carry exactly one of result/error', id };
  if (hasResult) return { kind: 'response', message: { id, result: obj.result } };
  const error = obj.error;
  if (!isRpcErrorObject(error)) return { kind: 'invalid', reason: 'shape', detail: 'error object is malformed', id };
  return { kind: 'response', message: { id, error } };
}

function isRpcErrorObject(value: unknown): value is RpcErrorObject {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.code === 'number' && Number.isInteger(e.code) && typeof e.message === 'string';
}

/** Encode one outbound frame. JSON.stringify never emits a raw newline. */
export function encodeFrame(message: object): string {
  if (Object.hasOwn(message, 'jsonrpc')) throw new TypeError('App Server frames omit the jsonrpc field');
  const text = JSON.stringify(message);
  if (text === undefined) throw new TypeError('frame is not JSON-serializable');
  return `${text}\n`;
}
