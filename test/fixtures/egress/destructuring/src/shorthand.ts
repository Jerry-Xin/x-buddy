// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const { sendMessage } = api;
export async function shorthand(channel: string): Promise<void> {
  await sendMessage(channel, 'a');
  await sendMessage(channel, 'b');
}
