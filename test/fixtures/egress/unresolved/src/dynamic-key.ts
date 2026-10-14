// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
declare const pick: string;
export async function dynamicKey(): Promise<void> {
  await (api as any)[pick]();
}
