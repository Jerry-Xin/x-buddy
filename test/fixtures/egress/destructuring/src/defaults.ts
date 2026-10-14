// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Send = (channel: string, text: string) => Promise<void>;
export async function withDefault(channel: string, options: { send?: Send } = {}): Promise<void> {
  const { send = api.sendMessage } = options;
  await send(channel, 'default');
}
