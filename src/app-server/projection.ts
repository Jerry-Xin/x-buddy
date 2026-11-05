// SPDX-License-Identifier: Apache-2.0
// Port of the exec JSON projection at openai/codex e2b60462, processor.rs:140-590.
// The Rust wire has nullable/extra fields absent from the SDK declaration file.
import type { RpcNotification } from './protocol.js';
import { capMessage } from './errors.js';

export type ExecItem = { id: string; type: string; [key: string]: unknown };
export type ExecEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: ExecItem }
  | { type: 'error'; message: string }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'turn.completed'; usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number } };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => typeof v === 'object' && v !== null ? v as Obj : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const snake = (v: unknown): string => str(v).replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/** Error detail formatting is shared with the runtime's failure path. */
export function notificationError(value: unknown, fallback = 'turn failed'): string {
  const e = obj(value);
  const message = str(e.message) || fallback;
  return capMessage(message + (typeof e.additionalDetails === 'string' && e.additionalDetails ? ` (${e.additionalDetails})` : ''));
}

/** Correlation from exec/lib.rs:1278-1337, including process-wide warnings. */
export function isTurnNotification(n: RpcNotification, threadId: string, turnId: string): boolean {
  const p = obj(n.params);
  if (n.method === 'configWarning' || n.method === 'deprecationNotice') return true;
  if (n.method === 'warning') return p.threadId == null || p.threadId === threadId;
  return p.threadId === threadId && (p.turnId ?? obj(p.turn).id) === turnId;
}

/** One processor per SDK run: ID allocation, plan and usage never cross turns. */
export class ExecEventProjector {
  #next = 0;
  #started = new Map<string, string>();
  #plan?: ExecItem;
  #usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  #lastError?: string;
  #terminal = false;
  #id(): string { return `item_${this.#next++}`; }

  #item(value: unknown, started: boolean): ExecItem | undefined {
    const i = obj(value);
    const rawId = str(i.id);
    if (started && (i.type === 'agentMessage' || i.type === 'reasoning')) return;
    if (i.type === 'reasoning' && !array(i.summary).map(str).join('\n').trim()) return;
    if (!['agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabAgentToolCall'].includes(str(i.type))) return;
    let id: string;
    if (i.type === 'agentMessage' || i.type === 'reasoning') id = this.#id();
    else if (started) {
      id = this.#started.get(rawId) ?? this.#id(); this.#started.set(rawId, id);
    } else { id = this.#started.get(rawId) ?? this.#id(); this.#started.delete(rawId); }
    switch (i.type) {
      case 'agentMessage': return { id, type: 'agent_message', text: str(i.text) };
      case 'reasoning': return { id, type: 'reasoning', text: array(i.summary).map(str).join('\n') };
      case 'commandExecution': return { id, type: 'command_execution', command: str(i.command), aggregated_output: i.aggregatedOutput ?? '', exit_code: i.exitCode ?? null, status: snake(i.status) };
      case 'fileChange': return { id, type: 'file_change', changes: array(i.changes).map(v => {
        const c = obj(v); return { path: str(c.path), kind: str(obj(c.kind).type) || str(c.kind) };
      }), status: i.status === 'declined' ? 'failed' : snake(i.status) };
      case 'mcpToolCall': {
        const r = obj(i.result);
        return { id, type: 'mcp_tool_call', server: str(i.server), tool: str(i.tool), arguments: i.arguments ?? null,
          result: i.result == null ? null : { content: r.content, ...(r._meta == null ? {} : { _meta: r._meta }), structured_content: r.structuredContent ?? null },
          error: i.error == null ? null : { message: str(obj(i.error).message) }, status: snake(i.status) };
      }
      // The Rust flattened web item serializes a second id. JSON.parse retains rawId.
      case 'webSearch': {
        // Exec round-trips the camelCase protocol action through the snake_case
        // core enum. Only search survives; openPage/findInPage become Other.
        const action = obj(i.action);
        return { id: rawId, type: 'web_search', query: str(i.query), action: action.type === 'search'
          ? { type: 'search', ...(action.query == null ? {} : { query: action.query }), ...(action.queries == null ? {} : { queries: action.queries }) }
          : { type: 'other' } };
      }
      case 'collabAgentToolCall': return { id, type: 'collab_tool_call', tool: i.tool === 'resumeAgent' ? 'wait' : snake(i.tool),
        sender_thread_id: i.senderThreadId, receiver_thread_ids: i.receiverThreadIds, prompt: i.prompt ?? null,
        agents_states: Object.fromEntries(Object.entries(obj(i.agentsStates)).map(([key, state]) => [key, { status: snake(obj(state).status), message: obj(state).message ?? null }])), status: snake(i.status) };
    }
  }

  project(n: RpcNotification): ExecEvent[] {
    if (this.#terminal) return [];
    const p = obj(n.params);
    const warning = (message: string): ExecEvent[] => [{ type: 'item.completed', item: { id: this.#id(), type: 'error', message: capMessage(message) } }];
    switch (n.method) {
      case 'turn/started': return [{ type: 'turn.started' }];
      case 'item/started': case 'item/completed': {
        const item = this.#item(p.item, n.method === 'item/started');
        return item ? [{ type: n.method === 'item/started' ? 'item.started' : 'item.completed', item }] : [];
      }
      case 'error': {
        this.#lastError = notificationError(p.error); return [{ type: 'error', message: this.#lastError }];
      }
      case 'warning': return warning(str(p.message));
      case 'configWarning': case 'deprecationNotice': return warning(notificationError({ message: p.summary, additionalDetails: p.details }));
      case 'model/rerouted': return warning(`model rerouted: ${str(p.fromModel)} -> ${str(p.toModel)} (${str(p.reason).replace(/^./, c => c.toUpperCase())})`);
      case 'thread/tokenUsage/updated': {
        const t = obj(obj(p.tokenUsage).total);
        const count = (k: string) => typeof t[k] === 'number' ? t[k] as number : 0;
        this.#usage = { input_tokens: count('inputTokens'), cached_input_tokens: count('cachedInputTokens'), output_tokens: count('outputTokens'), reasoning_output_tokens: count('reasoningOutputTokens') };
        return [];
      }
      case 'turn/plan/updated': {
        const type = this.#plan ? 'item.updated' : 'item.started';
        this.#plan = { id: this.#plan?.id ?? this.#id(), type: 'todo_list', items: array(p.plan).map(v => ({ text: str(obj(v).step), completed: obj(v).status === 'completed' })) };
        return [{ type, item: this.#plan }];
      }
      case 'turn/completed': {
        const turn = obj(p.turn); const events: ExecEvent[] = [];
        if (this.#plan) { events.push({ type: 'item.completed', item: this.#plan }); this.#plan = undefined; }
        for (const raw of array(turn.items)) {
          if (!this.#started.has(str(obj(raw).id))) continue;
          const item = this.#item(raw, false); if (item) events.push({ type: 'item.completed', item });
        }
        if (turn.status === 'completed') events.push({ type: 'turn.completed', usage: { ...this.#usage } });
        else if (turn.status === 'failed') events.push({ type: 'turn.failed', error: { message: turn.error == null ? this.#lastError ?? 'turn failed' : notificationError(turn.error) } });
        else if (turn.status === 'interrupted') { this.#terminal = true; return events; }
        this.#terminal = turn.status !== 'inProgress';
        return events;
      }
      default: return [];
    }
  }
}
