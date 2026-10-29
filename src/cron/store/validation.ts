// SPDX-License-Identifier: Apache-2.0
import { cron, every, timestamp, validateAt, validateTimezone } from '../schedule/engine.js';
import type { ScheduleInput, StoredSchedule, Payload, ExecMode, StoreScope } from './types.js';

export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a plain object');
}
export function keys(value: unknown, allowed: readonly string[]): void {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unknown or immutable field');
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError('Expected nonempty text without NUL');
}
export function bool(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
}
export function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^j[a-km-np-z2-9]{6}$/.test(value)) throw new TypeError('Invalid job ID');
}
export function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Expected positive safe generation');
  return value;
}
export function scopeSql(scope: StoreScope): { sql: string; args: unknown[] } {
  object(scope);
  if ('allConversations' in scope) {
    keys(scope, ['allConversations']);
    if (scope.allConversations !== true) throw new TypeError('Invalid scope');
    return { sql: '1=1', args: [] };
  }
  keys(scope, ['targetSession']); text(scope.targetSession);
  return { sql: 'target_session=?', args: [scope.targetSession] };
}
export function page(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('Invalid page bound');
  return value;
}
export function schedule(input: ScheduleInput, zone: string, jobId: string, now: number, checkAtWindow: boolean): StoredSchedule {
  object(input);
  if (input.kind === 'at') {
    keys(input, ['kind', 'atMs']); timestamp(input.atMs);
    if (checkAtWindow) validateAt(input.atMs, now);
    return { kind: 'at', atMs: input.atMs };
  }
  if (input.kind === 'every') {
    keys(input, ['kind', 'everyMs', 'anchorMs']);
    const normalized = every(input.everyMs, input.anchorMs);
    return normalized as StoredSchedule;
  }
  if (input.kind === 'cron') {
    keys(input, ['kind', 'expr', 'tz', 'staggerMs', 'exact']);
    if (input.exact !== undefined) bool(input.exact);
    if (validateTimezone(input.tz) !== zone) throw new TypeError('Schedule and job timezone differ');
    const result = cron(input.expr, zone, jobId, input.staggerMs, input.exact);
    if (result.kind !== 'cron') throw new TypeError('Expected cron');
    return { kind: 'cron', expr: result.expr, tz: result.tz, staggerMs: result.staggerMs };
  }
  throw new TypeError('Invalid schedule kind');
}
export function payload(input: Payload, mode: ExecMode): Payload {
  object(input);
  if (!['session', 'isolated'].includes(mode)) throw new TypeError('Invalid execution mode');
  if (input.kind === 'reminder') {
    keys(input, ['kind', 'text']); text(input.text);
    if (Array.from(input.text).length > 4000) throw new RangeError('Payload exceeds 4000 characters');
    return { kind: 'reminder', text: input.text };
  }
  if (input.kind !== 'agentTurn') throw new TypeError('Invalid payload kind');
  keys(input, ['kind', 'message', 'model', 'effort', 'timeoutSeconds']); text(input.message);
  if (Array.from(input.message).length > 4000) throw new RangeError('Payload exceeds 4000 characters');
  if (mode === 'session' && (input.model !== undefined || input.effort !== undefined)) throw new TypeError('Session mode cannot override model or effort');
  if (input.model !== undefined) text(input.model);
  if (input.effort !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.effort)) throw new TypeError('Invalid effort');
  if (input.timeoutSeconds !== undefined) page(input.timeoutSeconds, 10, 7200);
  return { ...input };
}
export function delivery(value: unknown): asserts value is 'announce' | 'none' {
  if (value !== 'announce' && value !== 'none') throw new TypeError('Invalid delivery mode');
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
