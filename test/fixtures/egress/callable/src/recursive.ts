// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
function pick(n: number): typeof api.sendMessage | undefined {
  return n <= 0 ? api.sendMessage : pick(n - 1);
}
export async function viaRecursion(channel: string): Promise<void> {
  await pick(3)?.(channel, 'recursive');
}
