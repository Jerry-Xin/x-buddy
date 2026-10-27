// SPDX-License-Identifier: Apache-2.0
/**
 * Exec-parity answers for server → client requests (XIN-2043 §3.5, R8 §3.3.6).
 * Message texts follow `codex-rs/exec/src/lib.rs` `handle_server_request` at
 * tag `rust-v0.142.3` (commit 35ba9c8c7031a4208a507a84472c6e49b4fa140f).
 * Every request gets an answer; unknown methods fail closed.
 */
import {
  type RpcRequest,
  type ServerRequestReply,
  SERVER_REQUEST_REJECTED,
} from './protocol.js';

type ThreadKey = 'threadId' | 'conversationId' | null;

const REJECTIONS: Readonly<Record<string, { text: string; threadKey: ThreadKey }>> = Object.freeze({
  'item/commandExecution/requestApproval': { text: 'command execution approval', threadKey: 'threadId' },
  'item/fileChange/requestApproval': { text: 'file change approval', threadKey: 'threadId' },
  'item/tool/requestUserInput': { text: 'request_user_input', threadKey: 'threadId' },
  'item/tool/call': { text: 'dynamic tool calls', threadKey: 'threadId' },
  'account/chatgptAuthTokens/refresh': { text: 'chatgpt auth token refresh', threadKey: null },
  'attestation/generate': { text: 'attestation generation', threadKey: null },
  'currentTime/read': { text: 'external current time', threadKey: null },
  applyPatchApproval: { text: 'apply_patch approval', threadKey: 'conversationId' },
  execCommandApproval: { text: 'exec command approval', threadKey: 'conversationId' },
  'item/permissions/requestApproval': { text: 'permissions approval', threadKey: 'threadId' },
});

export const ELICITATION_METHOD = 'mcpServer/elicitation/request';

/** Methods covered by the exec-parity table, elicitation included. */
export const KNOWN_SERVER_REQUEST_METHODS: readonly string[] = Object.freeze([
  ...Object.keys(REJECTIONS),
  ELICITATION_METHOD,
]);

function threadIdOf(params: unknown, key: Exclude<ThreadKey, null>): string {
  if (typeof params === 'object' && params !== null) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return 'unknown';
}

/** Pure exec-parity reply for one server request. */
export function execParityReply(request: Pick<RpcRequest, 'method' | 'params'>): ServerRequestReply {
  if (request.method === ELICITATION_METHOD) {
    return { result: { action: 'cancel', content: null, _meta: null } };
  }
  const rule = Object.hasOwn(REJECTIONS, request.method) ? REJECTIONS[request.method] : undefined;
  if (!rule) {
    return { error: { code: SERVER_REQUEST_REJECTED, message: `${request.method} is not supported by this client` } };
  }
  const verb = rule.text === 'dynamic tool calls' ? 'are' : 'is';
  const suffix = rule.threadKey === null ? '' : ` for thread \`${threadIdOf(request.params, rule.threadKey)}\``;
  return { error: { code: SERVER_REQUEST_REJECTED, message: `${rule.text} ${verb} not supported in exec mode${suffix}` } };
}

/** Async handler form accepted by `AppServerClient` (`onServerRequest`). */
export async function execParityServerRequestHandler(request: RpcRequest): Promise<ServerRequestReply> {
  return execParityReply(request);
}
