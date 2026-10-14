// SPDX-License-Identifier: Apache-2.0
import { sendTyping as typing } from './octo/api.js';
export async function renamed(channel: string): Promise<void> {
  await typing(channel);
}
