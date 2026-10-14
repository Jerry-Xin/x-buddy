// SPDX-License-Identifier: Apache-2.0
import { sendMessage } from './octo/api.js';
export async function named(channel: string): Promise<void> {
  await sendMessage(channel, 'one');
  await sendMessage(channel, 'two');
}
