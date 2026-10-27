// SPDX-License-Identifier: Apache-2.0
/**
 * Wire shapes for the Codex App Server stdio protocol, limited to the subset
 * pinned by the approved design (XIN-2043 §3, R8 §3.3.6).
 *
 * Research pin: `@openai/codex` 0.142.3 (tag `rust-v0.142.3`). The pin is a
 * reference for fixtures, not an assumed live capability.
 */

export const PROTOCOL_PIN = '0.142.3';

/** Request ids may be integers or strings; `0` is a valid server request id. */
export type RequestId = number | string;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Client → server or server → client request. The wire omits `jsonrpc`. */
export interface RpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export type RpcResponse =
  | { id: RequestId; result: unknown }
  | { id: RequestId; error: RpcErrorObject };

export type InboundMessage =
  | { kind: 'request'; message: RpcRequest }
  | { kind: 'notification'; message: RpcNotification }
  | { kind: 'response'; message: RpcResponse };

/** Server request reply: exactly one of `result` or `error`. */
export type ServerRequestReply = { result: unknown } | { error: RpcErrorObject };

/** Delta notifications opted out at initialize so text comes only from completed snapshots. */
export const OPT_OUT_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
]);

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface InitializeResponse {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
  [key: string]: unknown;
}

export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_INVALID_PARAMS = -32602;
export const SERVER_OVERLOADED = -32001;
export const SERVER_REQUEST_REJECTED = -32000;

export function isRequestId(value: unknown): value is RequestId {
  return (typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'string';
}

/** Map key that keeps integer `1` and string `"1"` distinct. */
export function requestIdKey(id: RequestId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}
