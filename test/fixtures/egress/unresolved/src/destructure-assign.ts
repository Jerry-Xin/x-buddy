// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let typing: any;
({ sendTyping: typing } = api);
export async function assignedPattern(channel: string): Promise<void> {
  await typing(channel);
}
