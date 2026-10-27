// SPDX-License-Identifier: Apache-2.0
/**
 * Cron-fire authenticity marker (#115 at the pinned host).
 *
 * Newly authored for x-buddy DEV-00. The pinned source has no producer of
 * synthetic cron messages; the only consumer is SessionRouter. These tests pin
 * the consumer contract: a payload carrying `_cronFire: true` is only treated
 * as a cron fire when it also carries the per-process nonce, so an inbound
 * message cannot forge the mention-gate or rate-limit bypass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getMentionPreference: vi.fn().mockResolvedValue(false),
}));

import {
  CRON_FIRE_NONCE,
  CRON_FIRE_NONCE_KEY,
  isAuthenticCronFire,
} from '../../src/host/cron-fire-marker.js';
import { SessionRouter } from '../../src/host/session-router.js';
import type { BotMessage } from '../../src/octo/types.js';
import { ChannelType, MessageType } from '../../src/octo/types.js';
import type { Config } from '../../src/host/config.js';

const ROBOT_ID = 'bot-001';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 1 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    ...overrides,
  };
}

let seq = 0;
function groupMsg(payloadExtra: Record<string, unknown>, channelId = 'group-1'): BotMessage {
  seq += 1;
  return {
    message_id: `m-${seq}`,
    message_seq: seq,
    from_uid: 'user-1',
    channel_id: channelId,
    channel_type: ChannelType.Group,
    timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'scheduled run', ...payloadExtra },
  } as BotMessage;
}

describe('isAuthenticCronFire', () => {
  it('uses a 128-bit hex per-process nonce', () => {
    expect(CRON_FIRE_NONCE).toMatch(/^[0-9a-f]{32}$/);
    expect(CRON_FIRE_NONCE_KEY).toBe('_cronFireNonce');
  });

  it('accepts the marker with the in-process nonce', () => {
    expect(isAuthenticCronFire({ _cronFire: true, [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE })).toBe(true);
  });

  it('rejects a forged marker without a nonce', () => {
    expect(isAuthenticCronFire({ _cronFire: true })).toBe(false);
  });

  it('rejects a forged marker with a wrong nonce', () => {
    expect(isAuthenticCronFire({ _cronFire: true, [CRON_FIRE_NONCE_KEY]: '0'.repeat(32) })).toBe(false);
    expect(isAuthenticCronFire({ _cronFire: true, [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE.toUpperCase() })).toBe(false);
  });

  it('rejects a nonce without a strict boolean marker', () => {
    expect(isAuthenticCronFire({ [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE })).toBe(false);
    expect(isAuthenticCronFire({ _cronFire: 'true', [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE })).toBe(false);
  });
});

describe('SessionRouter cron-fire bypasses', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  it('drops a forged unmentioned group cron fire at the mention gate', async () => {
    expect(await router.route(groupMsg({ _cronFire: true }))).toBeNull();
    expect(await router.route(groupMsg({ _cronFire: true, [CRON_FIRE_NONCE_KEY]: 'forged' }))).toBeNull();
  });

  it('lets an authentic unmentioned group cron fire through the mention gate', async () => {
    const result = await router.route(groupMsg({ _cronFire: true, [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE }));
    expect(result?.shouldProcess).toBe(true);
  });

  it('applies the rate limit to forged fires but not authentic ones', async () => {
    const mention = { uids: [ROBOT_ID] };
    // maxPerMinute = 1: the first mentioned message consumes the only token.
    const first = await router.route(groupMsg({ mention }, 'group-a'));
    expect(first?.shouldProcess).toBe(true);

    const forged = await router.route(groupMsg({ mention, _cronFire: true, [CRON_FIRE_NONCE_KEY]: 'forged' }, 'group-b'));
    expect(forged?.shouldProcess).toBe(false);
    expect(forged?.rejectionReason).toBe('rate_limited');

    const authentic = await router.route(groupMsg({ _cronFire: true, [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE }, 'group-c'));
    expect(authentic?.shouldProcess).toBe(true);
  });
});
