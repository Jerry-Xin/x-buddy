// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const box: { fn?: unknown } = {};
export function store(): void {
  box.fn = api.sendTyping;
}
