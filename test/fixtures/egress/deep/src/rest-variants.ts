// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
export function restParam({ ...captured }: { a: typeof api }): boolean {
  return captured !== undefined;
}
export function restNested(x: { w: { a: typeof api } }): boolean {
  const { w: { ...inner } } = x as unknown as { w: Record<string, unknown> };
  return inner !== undefined;
}
