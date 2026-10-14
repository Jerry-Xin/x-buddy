// SPDX-License-Identifier: Apache-2.0
import type { Box } from './shape.js';
export function viaAmbient(x: Box, key: string): void {
  const view = x as unknown as Record<string, { sendMessage: () => void }>;
  view[key]?.sendMessage();
}
