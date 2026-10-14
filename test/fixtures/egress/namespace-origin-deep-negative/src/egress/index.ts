// SPDX-License-Identifier: Apache-2.0
import * as api from '../octo/api.js';
export function egress(x: { a: typeof api }, table: Record<string, typeof api>, key: string): boolean {
  const view = x as unknown as Record<string, unknown>;
  const { ...rest } = x;
  return view[key] !== undefined && table[key] !== undefined && Reflect.get(x, key) !== undefined && rest !== undefined;
}
