// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
interface Tree { ns: typeof api; child?: Tree; children: Tree[] }
interface A { b: B; label: string }
interface B { a?: A; deeper: { ns: typeof api } }
interface Box<T> { v: T; self?: Box<T> }
export function tree(t: Tree, k1: string): boolean {
  return (t as unknown as Record<string, unknown>)[k1] !== undefined;
}
export function mutual(a: A, k2: string): boolean {
  return (a as unknown as Record<string, unknown>)[k2] !== undefined;
}
export function boxed(b: Box<typeof api>, k3: string): boolean {
  return (b as unknown as Record<string, unknown>)[k3] !== undefined;
}
