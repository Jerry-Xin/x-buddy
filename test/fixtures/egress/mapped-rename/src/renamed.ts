// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Renamed = { [K in keyof typeof api as `x${K}`]: (typeof api)[K] };
export async function literalRename(r: Renamed): Promise<void> {
  await r.xsendMessage('c', 'renamed literal');
}
export function dynamicRename(r: Renamed, key: string): boolean {
  return (r as unknown as Record<string, unknown>)[key] !== undefined;
}
export function restRename(r: Renamed): boolean {
  const { ...all } = r;
  return all !== undefined;
}
