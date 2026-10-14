// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const key = 'sendTyping' as const;
const { [key]: typing } = api;
export async function computed(channel: string): Promise<void> {
  await typing(channel);
  await api[key](channel);
}
