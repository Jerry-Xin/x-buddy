// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let key = 'registerBot';
key = 'sendMessage';
export async function mutable(): Promise<void> {
  await api[key as 'registerBot']();
}
