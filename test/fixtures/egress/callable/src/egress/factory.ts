// SPDX-License-Identifier: Apache-2.0
import { registerBot, sendMessage } from '../octo/api.js';
export function makeSender(): typeof sendMessage {
  return sendMessage;
}
export function makeRegistrar(): typeof registerBot {
  return registerBot;
}
