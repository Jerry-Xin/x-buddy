// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let chosen: any;
chosen = Math.random() > 2 ? api : undefined;
export async function conditional(channel: string): Promise<void> {
  await chosen?.sendTyping(channel);
}
