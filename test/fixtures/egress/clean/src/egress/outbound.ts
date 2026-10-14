// SPDX-License-Identifier: Apache-2.0
import { sendMessage, sendRichTextMessage, sendTyping } from '../octo/api.js';
export async function deliver(channel: string, text: string): Promise<void> {
  await sendTyping(channel);
  await sendMessage(channel, text);
  await sendRichTextMessage(channel, [text]);
}
