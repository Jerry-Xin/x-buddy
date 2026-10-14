// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
export async function viaNamespace(channel: string): Promise<void> {
  await api.sendMessage(channel, 'dot');
  await api['sendTyping'](channel);
  await api.registerBot();
}
