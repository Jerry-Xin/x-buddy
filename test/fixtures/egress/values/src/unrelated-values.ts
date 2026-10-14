// SPDX-License-Identifier: Apache-2.0
let local: any;
local = { sendMessage: (): undefined => undefined };
export function unrelated(): void {
  local.sendMessage();
}
