// SPDX-License-Identifier: Apache-2.0
import { sendCard } from './octo/api.js';
export async function show(channel: string): Promise<void> {
  await sendCard(channel);
}
