// SPDX-License-Identifier: Apache-2.0
import * as api from '../octo/api.js';
declare const pick: string;
let erased: any;
erased = api;
export async function egress(channel: string): Promise<void> {
  const { sendMessage, sendTyping } = api;
  await sendTyping(channel);
  await sendMessage(channel, 'egress');
  await erased[pick](channel);
  const { ...all } = api;
  void all;
}
