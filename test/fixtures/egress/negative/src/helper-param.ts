// SPDX-License-Identifier: Apache-2.0
import type * as api from './octo/api.js';
export async function readOnly(ns: typeof api): Promise<string[]> {
  return ns.getGroupMembers('g');
}
