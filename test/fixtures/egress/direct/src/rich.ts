// SPDX-License-Identifier: Apache-2.0
import { sendRichTextMessage } from './octo/api.js';
export async function rich(channel: string): Promise<void> {
  await sendRichTextMessage(channel, []);
}
