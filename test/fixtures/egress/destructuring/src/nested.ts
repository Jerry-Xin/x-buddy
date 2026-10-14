// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const { outer: { sendMessage } } = { outer: api };
export async function nested(channel: string): Promise<void> {
  await sendMessage(channel, 'nested');
}
