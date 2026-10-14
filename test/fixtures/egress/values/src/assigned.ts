// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let alias: any;
alias = api;
const { sendMessage } = alias;
export async function assigned(channel: string): Promise<void> {
  await sendMessage(channel, 'a');
  await sendMessage(channel, 'b');
}
