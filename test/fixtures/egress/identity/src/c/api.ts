// SPDX-License-Identifier: Apache-2.0
export function notify(channel: string): void;
export function notify(channel: string, text: string): void;
export function notify(channel: string, text?: string): void { void channel; void text; }
export namespace notify {
  export const label = 'notify';
  export function detail(channel: string): void { void channel; }
}
