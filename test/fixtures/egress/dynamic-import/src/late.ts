// SPDX-License-Identifier: Apache-2.0
export async function late(): Promise<{ robotId: string }> {
  const mod = await import('./octo/api.js');
  return mod.registerBot();
}
