// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
declare const key: string;
export function reflected(): boolean {
  return Reflect.get(api, key) !== undefined && Reflect.get(api, 'sendTyping') !== undefined;
}
