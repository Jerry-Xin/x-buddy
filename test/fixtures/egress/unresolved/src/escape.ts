// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const holder: Record<string, unknown> = {};
export function leak(): unknown {
  holder.ns = api;
  console.log(api);
  const boxed = [api];
  void boxed;
  return api;
}
