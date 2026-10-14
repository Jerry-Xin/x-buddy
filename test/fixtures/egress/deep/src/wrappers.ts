// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
interface Deep { outer: { inner: { ns: typeof api } } }
export function deep(x: Deep, k1: string): boolean {
  const y = x as unknown as Record<string, Record<string, unknown>>;
  return y.outer?.[k1] !== undefined;
}
export function list(x: { list: Array<typeof api> }, k2: string): boolean {
  return (x as unknown as Record<string, unknown>)[k2] !== undefined;
}
export function tuple(x: { pair: [string, typeof api] }, k3: string): boolean {
  return (x as unknown as Record<string, unknown>)[k3] !== undefined;
}
export function numberIndex(x: { [i: number]: typeof api }, k4: number): boolean {
  return x[k4] !== undefined;
}
export function literalKeys(x: { m: Record<'a' | 'b', typeof api> }, k5: string): boolean {
  return (x as unknown as Record<string, unknown>)[k5] !== undefined;
}
export function unionMember(x: { a: string } | { a: typeof api }, k6: string): boolean {
  return (x as unknown as Record<string, unknown>)[k6] !== undefined;
}
