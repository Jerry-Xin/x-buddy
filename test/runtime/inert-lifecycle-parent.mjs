// SPDX-License-Identifier: Apache-2.0
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { BotChildLifecycle } from '../../dist/runtime/child-lifecycle.js';
import { AppServerClient } from '../../dist/app-server/client.js';
const lock = new BotOwnershipLock(process.argv[2]).acquire();
const lifecycle = new BotChildLifecycle(lock, 'owned-test-bot');
const client = new AppServerClient({ bin: process.execPath,
  args: [new URL('./inert-lifecycle-child.mjs', import.meta.url).pathname, process.argv[3]],
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, lifecycle,
  clientInfo: { name: 'inert-test', version: '0', title: null } });
await client.start();
process.send({ ready: true, child: client.pid });
process.on('message', async message => {
  if (message === 'close') {
    await client.close({ graceMs: 40_000 });
    process.send({ closed: true });
  }
  if (message === 'release') { lock.release(); process.disconnect(); }
});
