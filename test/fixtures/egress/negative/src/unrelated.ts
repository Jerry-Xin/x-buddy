// SPDX-License-Identifier: Apache-2.0
import * as other from './other.js';
declare const pick: string;
let erased: any;
erased = other;
const { inner: { sendTyping } } = { inner: other };
export async function unrelated(channel: string): Promise<void> {
  await erased.sendMessage(channel, 'unrelated');
  await other['sendMessage'](channel, 'element');
  await sendTyping(channel);
  await (other as any)[pick](channel);
  await Reflect.get(other, 'sendTyping')(channel);
  const { ...rest } = other;
  void rest;
}
