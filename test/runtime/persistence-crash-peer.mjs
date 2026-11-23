// SPDX-License-Identifier: Apache-2.0
// Directly owned inert subprocess: crash only its own PID at a SQL boundary.
import { state, config } from './host-fixture.mjs';
import './completion-fixture.mjs';
const { startBot } = await import('../../src/host/index.ts');
const [directory, phase] = process.argv.slice(2);
if (!directory?.startsWith(process.env.TMPDIR + '/') || !['before','inside','after'].includes(phase)) throw Error('unlisted crash fixture');
const setup = { env: { CODEX_OCTO_EXECUTOR: 'sdk' }, bin: process.execPath, clientInfo: { name: 'inert-crash', title: null, version: '0' },
  sdkFactory: () => { throw Error('no execution in crash fixture'); },
  issuer: { prepare(input, scope) { return { ready: Object.fromEntries(['authority','creator-target','reset','permit','runtime','lane','deadline','mandatory-effects'].map(k => [k, true])),
    assertCurrent() {}, request: { sessionKey: input.sessionKey, laneKey: input.sessionKey, laneDeadlineMs: Date.now() + 10_000,
      ctx: { incarnationId: scope.incarnationId, origin: 'chat', principal: { uid: input.principalUid, role: 'member' },
        session: { sessionKey: input.sessionKey, resetGeneration: 0, channelId: input.channelId, channelType: 1 },
        policy: { tools: 'none' }, delivery: { logicalOrigin: input.messageId } } } }; } } };
const bot = await startBot(config(directory), true, setup), store = state.stores.at(-1);
store.getOrCreate('member', 'channel-member', 1); store.appendUser('member', 'before crash'); store.setSdkSessionId('member', 'old-thread');
if (phase === 'before') process.kill(process.pid, 'SIGKILL');
let incremented = false;
state.hook = (name, event) => {
  if (name === 'sql-result' && event.sql?.startsWith('INSERT INTO session_generations')) {
    incremented = true; if (phase === 'inside') process.kill(process.pid, 'SIGKILL');
  }
  if (incremented && name === 'transaction-committed' && phase === 'after') process.kill(process.pid, 'SIGKILL');
};
await bot.execution.resetSession({ sessionKey: 'member', principalUid: 'member', channelId: 'channel-member', channelType: 1, messageId: 'reset-9', messageSeq: 9 });
throw Error('crash fence was not reached');
