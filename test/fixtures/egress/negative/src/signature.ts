// SPDX-License-Identifier: Apache-2.0
export async function sendMessage(channel: string, text: string): Promise<void> { void channel; void text; }
export async function useLocal(): Promise<void> {
  await sendMessage('c', 't');
}
