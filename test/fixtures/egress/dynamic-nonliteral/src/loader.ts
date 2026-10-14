// SPDX-License-Identifier: Apache-2.0
export async function load(specifier: string): Promise<unknown> {
  const mod: unknown = await import(specifier);
  return typeof mod;
}
