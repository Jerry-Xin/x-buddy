// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
import { fromB } from './b.js';
export const fromA = { api };
export async function useCycle(channel: string): Promise<void> {
  await fromB.inner.api.sendTyping(channel);
}
