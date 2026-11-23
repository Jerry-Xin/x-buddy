// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/channel-id.ts; changes: spdx-header, change-notice, import-path.
import { TOPIC_CHANNEL_SEPARATOR } from '../octo/types.js';

/** Group APIs address the parent group; conversation state keeps the full topic ID. */
export function parentGroupNo(channelId: string): string {
  return channelId.split(TOPIC_CHANNEL_SEPARATOR, 1)[0];
}
