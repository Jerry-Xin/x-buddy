// SPDX-License-Identifier: Apache-2.0
import * as a from './a/api.js';
import * as b from './b/api.js';
import { notify } from './c/api.js';
export async function routes(channel: string): Promise<void> {
  const box = { ...a, ...b };
  await box.dispatch(channel, 'one terminal');
  await a.sendMessage(channel, 'route a');
  await b.sendMessage(channel, 'distinct terminal');
}
export function either(flag: boolean): unknown {
  const chosen = flag ? a : b;
  return typeof chosen.sendMessage;
}
export function overloads(channel: string): void {
  notify(channel);
  notify(channel, 'text');
  notify.detail(channel);
}
