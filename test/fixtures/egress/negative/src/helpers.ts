// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
let alias: any;
alias = api;
const { registerBot, getGroupMembers } = alias;
const key = 'getGroupMembers' as const;
const { inner: { registerBot: register } } = { inner: api };
export async function helpers(): Promise<void> {
  await registerBot();
  await getGroupMembers('g');
  await alias['registerBot']();
  await api[key]('g');
  await register();
  await alias.getGroupMembers('g');
}
