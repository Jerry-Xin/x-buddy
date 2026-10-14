// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const prefix = 'send';
export async function viaTemplate(channel: string): Promise<void> {
  await api[`${prefix}Typing` as const](channel);
}
