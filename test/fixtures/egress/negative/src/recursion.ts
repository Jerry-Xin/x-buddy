// SPDX-License-Identifier: Apache-2.0
export function ping(n: number): number { return n > 0 ? pong(n - 1) : 0; }
export function pong(n: number): number { return n > 0 ? ping(n - 1) : 1; }
