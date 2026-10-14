// SPDX-License-Identifier: Apache-2.0
import { sendMessage } from './octo/api.js';
import * as api from './octo/api.js';
export async function sites(channel: string): Promise<void> {
  await sendMessage(channel, 'first');
  const { sendTyping } = api;
  await sendTyping(channel);
}
