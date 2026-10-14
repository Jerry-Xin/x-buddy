// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const erased = api as unknown as Record<string, any>;
const again: any = erased;
const { sendMessage: send } = again;
export async function chain(channel: string): Promise<void> {
  await send(channel, 'assertion chain');
}
