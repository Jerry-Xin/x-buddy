// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Leaf = Pick<typeof api, 'registerBot'>;
type Layer<T extends unknown[]> = T['length'] extends 20 ? Leaf : { next: Layer<[...T, unknown]> };
export function lateRest(x: Layer<[]>): boolean {
  const { ...rest } = x as unknown as Record<string, unknown>;
  return rest !== undefined;
}
export function lateDynamic(x: Layer<[]>, key: string): boolean {
  return (x as unknown as Record<string, unknown>)[key] !== undefined;
}
export async function lateLiteral(x: Layer<[]>): Promise<void> {
  await x.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.next.registerBot();
}
