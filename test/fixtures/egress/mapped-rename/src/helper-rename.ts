// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type HelperOnly = { [K in 'registerBot' | 'getGroupMembers' as `use${Capitalize<K>}`]: (typeof api)[K] };
export async function helperRename(h: HelperOnly, key: string): Promise<boolean> {
  await h.useRegisterBot();
  const { ...all } = h;
  return Reflect.get(h, key) !== undefined && all !== undefined;
}
