// SPDX-License-Identifier: Apache-2.0
import { holder } from './holder.js';
export async function use(channel: string): Promise<void> {
  await holder.sendTyping(channel);
}
