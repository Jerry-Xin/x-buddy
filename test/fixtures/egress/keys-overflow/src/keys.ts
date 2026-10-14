// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
type L = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Big = { [K in `${L}${L}`]: typeof api.sendMessage };
export async function overflow(big: Big): Promise<void> {
  await big.ab('c', 'widened key domain');
}
