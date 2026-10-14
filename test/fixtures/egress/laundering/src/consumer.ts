// SPDX-License-Identifier: Apache-2.0
import { bus, later, queue, registry, withSender } from './egress/registry.js';
export async function launder(channel: string): Promise<void> {
  await registry.get('send')?.(channel, 'map');
  await queue[0]?.(channel);
  await (await later)(channel, 'promise');
  bus.addEventListener('ready', (event) => { void (event as CustomEvent<(c: string) => Promise<void>>).detail(channel); });
  await withSender((send) => send(channel, 'injected'));
}
