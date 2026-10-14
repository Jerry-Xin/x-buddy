// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Unwrap<T> = T extends { inner: infer U } ? U : never;
type Leaf = Unwrap<{ inner: Pick<typeof api, 'registerBot'> }>;
type Layer<T extends unknown[]> = T['length'] extends 20 ? Leaf : { next: Layer<[...T, unknown]> };
export function lateRest(x: Layer<[]>): boolean {
  const { ...rest } = x as unknown as Record<string, unknown>;
  return rest !== undefined;
}
export function lateDynamic(x: Layer<[]>, key: string): boolean {
  return (x as unknown as Record<string, unknown>)[key] !== undefined;
}
