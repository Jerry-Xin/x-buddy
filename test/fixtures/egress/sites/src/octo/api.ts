// SPDX-License-Identifier: Apache-2.0
export async function sendMessage(channel: string, text: string): Promise<void> { void channel; void text; }
export async function sendRichTextMessage(channel: string, blocks: unknown[]): Promise<void> { void channel; void blocks; }
export async function sendTyping(channel: string): Promise<void> { void channel; }
export async function registerBot(): Promise<{ robotId: string }> { return { robotId: 'robot' }; }
export async function getGroupMembers(group: string): Promise<string[]> { return [group]; }
export interface GroupMember { uid: string }
