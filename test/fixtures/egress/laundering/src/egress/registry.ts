// SPDX-License-Identifier: Apache-2.0
import { sendMessage, sendTyping } from '../octo/api.js';
export const registry = new Map<string, typeof sendMessage>();
registry.set('send', sendMessage);
export const queue: Array<typeof sendTyping> = [];
queue.push(sendTyping);
export const later = Promise.resolve(sendMessage);
export const bus = new EventTarget();
bus.dispatchEvent(new CustomEvent('ready', { detail: sendTyping }));
export function withSender(callback: (send: typeof sendMessage) => Promise<void>): Promise<void> {
  return callback(sendMessage);
}
