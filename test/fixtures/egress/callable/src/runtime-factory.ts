// SPDX-License-Identifier: Apache-2.0
import { makeSender } from './egress/factory.js';
export async function viaFactory(channel: string): Promise<void> {
  const send = makeSender();
  await send(channel, 'factory');
}
