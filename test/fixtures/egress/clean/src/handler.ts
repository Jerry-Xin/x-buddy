// SPDX-License-Identifier: Apache-2.0
import { deliver } from './egress/outbound.js';
import type { GroupMember } from './octo/api.js';
export async function reply(channel: string, member: GroupMember): Promise<void> {
  await deliver(channel, member.uid);
}
