// SPDX-License-Identifier: Apache-2.0
import { registerBot, getGroupMembers } from './octo/api.js';
import * as api from './octo/api.js';
export async function boot(): Promise<string[]> {
  await registerBot();
  const { getGroupMembers: members } = api;
  await members('x');
  return getGroupMembers('g');
}
