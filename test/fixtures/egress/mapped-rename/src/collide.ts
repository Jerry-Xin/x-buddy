// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type Collide = { [K in keyof typeof api as 'same']: (typeof api)[K] };
export function collide(c: Collide): unknown {
  const picked = c.same;
  return typeof picked;
}
