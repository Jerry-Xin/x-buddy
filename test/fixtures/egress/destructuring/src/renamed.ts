// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const { sendMessage: post } = api;
export async function renamed(channel: string): Promise<void> {
  await post(channel, 'a');
  await post(channel, 'b');
}
