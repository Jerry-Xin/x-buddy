// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const helpers = { registerBot: api.registerBot, getGroupMembers: api.getGroupMembers };
declare const key: string;
export function helperOnly(): boolean {
  const { ...copy } = helpers;
  return Reflect.get(helpers, key) !== undefined && copy !== undefined;
}
