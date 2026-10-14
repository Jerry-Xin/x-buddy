// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let first: any;
let second: any;
second ??= api;
first ||= second;
export async function logical(channel: string): Promise<void> {
  await first.sendTyping(channel);
}
