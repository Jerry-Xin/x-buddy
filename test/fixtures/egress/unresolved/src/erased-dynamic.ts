// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
declare const pick: string;
let erased: any;
erased = api;
const { [pick]: got } = erased;
export async function erasedDynamic(): Promise<void> {
  await got();
  await erased[pick]();
}
