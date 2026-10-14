// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Early<T extends unknown[]> = T['length'] extends 5 ? typeof api : { next: Early<[...T, unknown]> };
export function earlyRest(x: Early<[]>): boolean {
  const { ...rest } = x as unknown as Record<string, unknown>;
  return rest !== undefined;
}
type ImportLayer<T extends unknown[]> = T['length'] extends 5 ? typeof import('./octo/api.js') : { next: ImportLayer<[...T, unknown]> };
export function importRest(x: ImportLayer<[]>): boolean {
  const { ...rest } = x as unknown as Record<string, unknown>;
  return rest !== undefined;
}
