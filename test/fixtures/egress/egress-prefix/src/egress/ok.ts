// SPDX-License-Identifier: Apache-2.0
import { sendMessage } from '../octo/api.js';
export async function ok(channel: string): Promise<void> { await sendMessage(channel, 'authorized'); }
