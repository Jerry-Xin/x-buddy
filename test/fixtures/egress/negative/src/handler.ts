// SPDX-License-Identifier: Apache-2.0
import { egress } from './egress/index.js';
export async function reply(channel: string): Promise<void> {
  await egress(channel);
}
