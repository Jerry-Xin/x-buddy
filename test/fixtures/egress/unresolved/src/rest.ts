// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const { registerBot, ...rest } = api;
export async function viaRest(): Promise<void> {
  await registerBot();
  void rest;
}
