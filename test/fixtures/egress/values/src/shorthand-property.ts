// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const alias: any = api;
const holder = { alias };
const { alias: { sendMessage } } = holder;
export async function viaShorthand(channel: string): Promise<void> {
  await sendMessage(channel, 'shorthand');
}
