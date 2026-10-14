// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Nested = Readonly<Pick<Omit<typeof api, 'sendTyping'>, 'sendMessage' | 'registerBot'>>;
export async function nestedPick(n: Nested): Promise<void> {
  await n.sendMessage('c', 'nested pick');
  await n.registerBot();
}
