// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
function identity<T>(value: T): T { return value; }
export async function viaIdentity(channel: string): Promise<void> {
  const typing = identity(api.sendTyping);
  await typing(channel);
}
