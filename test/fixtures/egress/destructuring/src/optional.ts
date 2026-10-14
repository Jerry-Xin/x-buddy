// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const maybe: typeof api | undefined = Math.random() > 2 ? api : undefined;
export async function optional(channel: string): Promise<void> {
  await maybe?.sendMessage(channel, 'optional');
}
