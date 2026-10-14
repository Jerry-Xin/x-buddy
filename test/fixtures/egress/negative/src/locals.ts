// SPDX-License-Identifier: Apache-2.0
const local = { sendMessage: (channel: string, text: string): void => { void channel; void text; }, sendTyping: (channel: string): void => { void channel; } };
declare const pick: string;
let erased: any;
erased = local;
export function locals(channel: string): void {
  erased.sendMessage(channel, 'local');
  local['sendMessage'](channel, 'element');
  (local as any)[pick](channel);
  const { ...copy } = local;
  void copy;
}
