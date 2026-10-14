// SPDX-License-Identifier: Apache-2.0
import * as api from './octo/api.js';
const copy = { ...api };
const wrapper = { inner: copy };
let held: any;
held = wrapper;
export async function spread(channel: string): Promise<void> {
  await held.inner.sendRichTextMessage(channel, []);
}
