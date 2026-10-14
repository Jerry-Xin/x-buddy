// SPDX-License-Identifier: Apache-2.0
import { relayed } from '../lib/relay.js';
export async function outside(channel: string): Promise<void> {
  await relayed(channel, 'outside src');
}
