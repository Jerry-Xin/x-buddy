// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let x: any;
let y: any;
x = y;
y = x;
y = api;
export async function cyclic(channel: string): Promise<void> {
  await x.sendTyping(channel);
}
