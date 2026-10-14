// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const slot: unique symbol = Symbol('slot');
const holder = { [slot]: api.sendMessage };
export async function viaSymbol(channel: string): Promise<void> {
  await holder[slot](channel, 'symbol');
}
