// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
interface Nest<T> { v: T; next?: Nest<T[]>; wide?: Nest<[T, T]> }
export function dynamicSelect(n: Nest<typeof api>, key: string): boolean {
  return (n as unknown as Record<string, unknown>)[key] !== undefined;
}
export function reflected(n: Nest<typeof api>, key: string): boolean {
  return Reflect.get(n, key) !== undefined;
}
export function restExtract(n: Nest<typeof api>): boolean {
  const { ...copy } = n;
  return copy !== undefined;
}
export async function literalSend(n: Nest<typeof api>): Promise<void> {
  await n.v.sendMessage('c', 't');
}
export async function literalHelper(n: Nest<typeof api>): Promise<void> {
  await n.v.registerBot();
}
export function farDynamic(n: Nest<typeof api>, key: string): boolean {
  const far = n.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next?.next;
  return (far as unknown as Record<string, unknown>)[key] !== undefined;
}
