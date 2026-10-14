// SPDX-License-Identifier: Apache-2.0
import { sendMessage } from '../octo/api.js';
export async function bypass(channel: string): Promise<void> { await sendMessage(channel, 'not egress'); }
