// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Upper = { [K in keyof typeof api as Uppercase<K>]: (typeof api)[K] };
export async function upper(u: Upper): Promise<void> {
  await u.SENDTYPING('c');
}
