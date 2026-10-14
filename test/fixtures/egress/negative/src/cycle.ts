// SPDX-License-Identifier: Apache-2.0
let holder: any;
holder = { ...holder, read(): number { return 1; } };
const { read } = holder;
export const value: number = read();
