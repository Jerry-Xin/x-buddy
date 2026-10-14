// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
export async function viaBind(channel: string): Promise<void> {
  const bound = api.sendTyping.bind(null);
  await bound(channel);
}
