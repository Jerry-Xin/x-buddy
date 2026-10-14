// SPDX-License-Identifier: Apache-2.0
import { makeRegistrar } from './egress/factory.js';
import type * as api from './octo/api.js';
export async function readOnly(ns: typeof api): Promise<string[]> {
  return ns.getGroupMembers('g');
}
export async function registrar(): Promise<{ robotId: string }> {
  const register = makeRegistrar();
  return register();
}
