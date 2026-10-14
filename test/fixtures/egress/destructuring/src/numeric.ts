// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const table = { 2: api.sendTyping, 3: api.registerBot };
export async function numeric(channel: string): Promise<void> {
  await table[2](channel);
  await table['3']();
}
