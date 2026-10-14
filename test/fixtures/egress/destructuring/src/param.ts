// SPDX-License-Identifier: Apache-2.0
import type * as api from './octo/api.js';
export async function typed({ sendTyping }: typeof api, channel: string): Promise<void> {
  await sendTyping(channel);
}
