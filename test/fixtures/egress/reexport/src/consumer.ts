// SPDX-License-Identifier: Apache-2.0
import { sendMessage } from './barrel.js';
import { send } from './barrel2.js';
import * as star from './star.js';
import { ns } from './ns-barrel.js';
import { apiNs } from './local-barrel.js';
import { getGroupMembers } from './read-barrel.js';
export async function consume(channel: string): Promise<void> {
  await sendMessage(channel, 'first hop');
  await send(channel, 'second hop');
  await star.sendTyping(channel);
  await ns.sendRichTextMessage(channel, []);
  const { sendTyping } = apiNs;
  await sendTyping(channel);
  await getGroupMembers('group');
}
