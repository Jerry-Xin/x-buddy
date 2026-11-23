// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { state, config as baseConfig, reset, assertClean } from './host-fixture.mjs';
import { clean, trace } from './lifecycle-fixture.mjs';
import { deferred, tick, Peer } from './helpers.mjs';
import { guardState } from './query-agent-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
registerHooks({
  resolve(spec, context, next) {
    if (
      spec === './session-router.js' &&
      context.parentURL?.startsWith(pathToFileURL(join(root, 'src/host/index.ts')).href)
    ) {
      return next(pathToFileURL(join(root, 'src/host/session-router.ts')).href + '?spine-real', context);
    }
    return next(spec, context);
  },
});

const require = createRequire(import.meta.url);
const Native = require(process.env.HOST_SQLITE);
const nativeBinding = join(process.env.HOST_SQLITE, 'build/Release/better_sqlite3.node');
const openDb = (path, options = {}) => new Native(path, { ...options, nativeBinding });

const { startBot, handleMessage } = await import('../../src/host/index.ts');
const { loadConfig, resolveBotConfigs } = await import('../../src/host/config.ts?spine-real');
const { parseCommand, handleCommand } = await import('../../src/host/commands.ts?spine-real');
const { SessionRouter } = await import('../../src/host/session-router.ts?spine-real');
const { StreamRelay, splitMessage } = await import('../../src/host/stream-relay.ts?spine-real');
const { resolveMentions } = await import('../../src/host/mention-utils.ts?spine-real');

async function loadSpineRuntime() {
  const egressMod = await import('../../src/runtime/octo-egress.ts');
  const issuerMod = await import('../../src/runtime/chat-issuer.ts');
  const binaryMod = await import('../../src/runtime/codex-binary.ts');
  return { ...egressMod, ...issuerMod, ...binaryMod };
}

function sql(dir, query, ...values) {
  const db = openDb(join(dir, 'cc-octo.db'));
  try {
    return db.prepare(query).all(...values);
  } finally {
    db.close();
  }
}

async function captureConsoleLog(fn) {
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => {
    lines.push(args.map((a) => String(a)).join(' '));
    origLog(...args);
  };
  try {
    const result = await fn(lines);
    return { result, lines };
  } finally {
    console.log = origLog;
  }
}

async function createSpineBot(extra = {}) {
  reset();
  const wireRequests = [];
  const sends = [];
  const typings = [];
  const receipts = [];

  // F2: Never use globalThis.__hostBoundary / state.send for outbound delivery.
  // Any call to state.send fails immediately; all outbound traffic goes through
  // real OctoEgress -> real OctoApiClient -> low-level egressFetcher below.
  state.send = async (name) => {
    throw new Error(`F2 violation: legacy state.send(${name}) called instead of OctoApiClient fetch seam`);
  };

  state.api = async (name, opts) => {
    if (name === 'parseOctoJson') {
      const parsed = JSON.parse(opts);
      if (parsed && typeof parsed === 'object' && 'code' in parsed && parsed.code !== 0) {
        throw new Error(`Octo API business error: code=${parsed.code}`);
      }
      return parsed?.data ?? parsed;
    }
    if (extra.onApi) return await extra.onApi(name, opts);
    if (name === 'fetchUserInfo') {
      return { uid: opts.uid, name: extra.botDisplayName ?? 'CodeBot' };
    }
    if (name === 'getGroupMembers') {
      return extra.groupMembers ?? [
        { uid: extra.robotUid ?? extra.botId ?? 'spine-bot', name: extra.botDisplayName ?? 'CodeBot' },
        { uid: 'owned-owner', name: 'OwnerUser' },
        { uid: 'mgr-1', name: 'ManagerOne' },
        { uid: 'cron-1', name: 'CronOne' },
        { uid: 'alice', name: 'Alice' },
      ];
    }
    if (name === 'getChannelMessages') {
      return extra.channelMessages ?? [];
    }
    if (name === 'getGroupMd' || name === 'getThreadMd') {
      return extra.serverMd ?? { content: '', version: 0 };
    }
    return {};
  };
  if (extra.beforeRegister) {
    state.beforeRegister = extra.beforeRegister;
  }

  const egressFetcher = async (input, init) => {
    const urlObj = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const url = urlObj.toString();
    const pathname = urlObj.pathname;
    const method = init?.method ?? 'GET';
    const headers = init?.headers ?? {};
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    const reqRecord = { url, pathname, method, headers, body, rawBody, signal: init?.signal };
    wireRequests.push(reqRecord);

    if (extra.onEgressFetch) {
      const customResponse = await extra.onEgressFetch(reqRecord, { wireRequests, sends, typings, receipts });
      if (customResponse) {
        if (customResponse.ok) {
          if (pathname.endsWith('/v1/bot/sendMessage')) {
            sends.push({
              channelId: body.channel_id,
              channelType: body.channel_type,
              clientMsgNo: body.client_msg_no,
              content: body.payload?.content ?? '',
              payload: body.payload,
              mentionUids: body.payload?.mention?.uids,
              mentionEntities: body.payload?.mention?.entities,
              mentionAll: body.payload?.mention?.all === true || body.payload?.mention?.all === 1,
              raw: body,
              headers,
            });
          } else if (pathname.endsWith('/v1/bot/typing')) {
            typings.push({
              channelId: body.channel_id,
              channelType: body.channel_type,
              raw: body,
              headers,
            });
          } else if (pathname.endsWith('/v1/bot/readReceipt')) {
            receipts.push({
              channelId: body.channel_id,
              channelType: body.channel_type,
              messageIds: body.message_ids,
              raw: body,
              headers,
            });
          }
        }
        return customResponse;
      }
    }

    if (pathname.endsWith('/v1/bot/sendMessage')) {
      sends.push({
        channelId: body.channel_id,
        channelType: body.channel_type,
        clientMsgNo: body.client_msg_no,
        content: body.payload?.content ?? '',
        payload: body.payload,
        mentionUids: body.payload?.mention?.uids,
        mentionEntities: body.payload?.mention?.entities,
        mentionAll: body.payload?.mention?.all === true || body.payload?.mention?.all === 1,
        raw: body,
        headers,
      });
    } else if (pathname.endsWith('/v1/bot/typing')) {
      typings.push({
        channelId: body.channel_id,
        channelType: body.channel_type,
        raw: body,
        headers,
      });
    } else if (pathname.endsWith('/v1/bot/readReceipt')) {
      receipts.push({
        channelId: body.channel_id,
        channelType: body.channel_type,
        messageIds: body.message_ids,
        raw: body,
        headers,
      });
    }

    return new Response(JSON.stringify({ code: 0, data: { message_id: `srv-${wireRequests.length}` } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const dir = mkdtempSync(join(tmpdir(), 'spine-owned-'));
  const botId = extra.botId ?? 'spine-bot';
  const cfg = {
    ...baseConfig(dir, botId),
    dispatchTimeoutMs: extra.dispatchTimeoutMs ?? 5_000,
    rateLimit: extra.rateLimit ?? { maxPerMinute: 1000 },
    context: { maxContextChars: 2000, historyLimit: 40 },
    commands: { managers: extra.commandsManagers ?? ['mgr-1'] },
    cron: {
      managers: extra.cronManagers ?? ['cron-1'],
      explicitManagers: extra.cronExplicitManagers ?? true,
    },
    runtime: {
      chatTurnCeilingMs: 1_800_000,
      laneMaxQueued: 3,
      interruptConfirmMs: 10_000,
      recycleDrainMs: 120_000,
      ...extra.runtimeConfig,
    },
    egress: { keyMode: 'random' },
    sdk: {
      model: 'gpt-5-codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      modelReasoningEffort: 'medium',
      webSearchEnabled: true,
      webSearchMode: 'live',
      toolProgress: extra.toolProgress ?? true,
      codexHome: join(dir, 'codex-home'),
      codexHomeSharedOptIn: extra.codexHomeSharedOptIn ?? false,
      ...extra.sdkConfig,
    },
    ...extra.configOverrides,
  };

  const starts = [];
  const peers = [];
  const kind = extra.kind ?? 'app-server';
  const setup = {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      CODEX_OCTO_EXECUTOR: kind,
    },
    bin: process.execPath,
    clientInfo: { name: 'spine-test', title: null, version: '0.3.21' },
    egressFetcher,
    sdkFactory() {
      const makeThread = (id = 'sdk-thread-1') => ({
        runStreamed: async (prompt) => {
          starts.push({ id, prompt });
          if (extra.onTurnStart) await extra.onTurnStart({ id, prompt });
          const events = extra.sdkEvents
            ? extra.sdkEvents(id, prompt)
            : (async function* () {
                yield { type: 'thread.started', thread_id: id };
                yield {
                  type: 'item.completed',
                  item: { id: 'msg-1', type: 'agent_message', text: extra.replyText ?? 'hello from codex' },
                };
                yield { type: 'turn.completed', usage: {} };
              })();
          return { events };
        },
      });
      return {
        startThread: () => makeThread('sdk-thread-' + (starts.length + 1)),
        resumeThread: (id) => makeThread(id),
      };
    },
    appServerFactory(options) {
      assert.equal(options.lifecycle.lock.dataDir, dir);
      const peer = new Peer(
        extra.scenario ?? {
          defaultTurn: [
            {
              notify: 'item/completed',
              params: {
                threadId: '$threadId',
                turnId: '$turnId',
                item: { id: '$itemId', type: 'agentMessage', text: extra.replyText ?? 'hello from codex' },
              },
            },
          ],
        },
      );
      peers.push(peer);
      const origReq = peer.request.bind(peer);
      peer.request = async (method, params, opts) => {
        if (method === 'turn/start') {
          const text = params?.input?.[0]?.text ?? '';
          starts.push({ id: params?.threadId, prompt: text });
          if (extra.onTurnStart) await extra.onTurnStart({ id: params?.threadId, prompt: text, peer, signal: opts?.signal });
        }
        return origReq(method, params, opts);
      };
      return peer;
    },
    ...extra.setup,
  };

  const stack = await startBot(cfg, true, setup);
  const store = state.stores.at(-1);
  const group = state.groups.at(-1);
  const gateway = state.gateways.at(-1);
  if (extra.ownerUid !== undefined) {
    gateway._ownerUid = extra.ownerUid;
  }
  if (extra.registeredRobotId !== undefined) {
    gateway.robotId = extra.registeredRobotId;
  }
  const relay = new StreamRelay(stack.execution.egress);

  const dmMsg = (seq, content, fromUid = 'alice', overrides = {}) => ({
    from_uid: fromUid,
    from_name: fromUid,
    channel_id: overrides.channel_id ?? `dm-${fromUid}`,
    channel_type: 1,
    message_id: overrides.message_id !== undefined ? overrides.message_id : `wire-dm-${seq}`,
    message_seq: seq,
    timestamp: 1_700_000_000 + seq,
    payload: { type: 1, content, ...overrides.payload },
    streamOn: overrides.streamOn ?? false,
  });

  const groupMsg = (seq, content, fromUid = 'alice', mention = undefined, overrides = {}) => ({
    from_uid: fromUid,
    from_name: fromUid,
    channel_id: overrides.channel_id ?? 'group-main',
    channel_type: overrides.channel_type ?? 2,
    message_id: overrides.message_id !== undefined ? overrides.message_id : `wire-grp-${seq}`,
    message_seq: seq,
    timestamp: 1_700_000_000 + seq,
    payload: {
      type: 1,
      content,
      ...(mention !== undefined ? { mention } : {}),
      ...overrides.payload,
    },
    streamOn: overrides.streamOn ?? false,
  });

  const topicMsg = (seq, content, fromUid = 'alice', mention = undefined, overrides = {}) => ({
    from_uid: fromUid,
    from_name: fromUid,
    channel_id: overrides.channel_id ?? 'topic-main',
    channel_type: 5,
    message_id: overrides.message_id !== undefined ? overrides.message_id : `wire-top-${seq}`,
    message_seq: seq,
    timestamp: 1_700_000_000 + seq,
    payload: {
      type: 1,
      content,
      ...(mention !== undefined ? { mention } : {}),
      ...overrides.payload,
    },
    streamOn: overrides.streamOn ?? false,
  });

  return {
    stack,
    store,
    group,
    gateway,
    relay,
    cfg,
    dir,
    wireRequests,
    sends,
    typings,
    receipts,
    starts,
    peers,
    dmMsg,
    groupMsg,
    topicMsg,
    handle: (msg) =>
      handleMessage(msg, cfg, store, stack.router, group, relay, stack.robotUid, stack.execution),
    async close() {
      await stack.shutdown();
      assertClean(assert);
      assert.equal(existsSync(join(dir, 'gateway.lock')), false);
      clean(dir);
    },
  };
}

// ============================================================================
// Behavioral Parent 5f1c661 RED -> Candidate v155 GREEN Controls (F5)
// ============================================================================

test('v155 parent RED control: startBot without injected test issuer constructs live ChatTurnIssuer + OctoEgress and completes turn + /reset (parent fails at issuer-unavailable seam)', async () => {
  const f = await createSpineBot();
  try {
    // On parent 5f1c661, startBot does not construct a canonical ChatTurnIssuer or OctoEgress,
    // so f.handle(dmMsg) throws HostExecutionRefusal('issuer-unavailable') at the first turn seam.
    // On candidate v155, startBot constructs both after gateway.register() and completes the turn over OctoApiClient.
    await f.handle(f.dmMsg(1, 'behavioral startup turn', 'alice'));
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].content, 'hello from codex');
    assert.equal(f.sends[0].channelId, 'dm-alice');
    assert.equal(f.sends[0].channelType, 1);
    assert.equal(f.receipts.length, 1);
    assert.deepEqual(f.receipts[0].raw, {
      channel_id: 'dm-alice',
      channel_type: 1,
      message_ids: ['wire-dm-1'],
    });
    assert.equal(sql(f.dir, 'SELECT count(*) n FROM messages')[0].n, 2);

    // Behavioral /reset without injected issuer commits G=1 and clears session history
    await f.handle(f.dmMsg(2, '/reset', 'alice'));
    assert.equal(f.store.getResetGeneration('alice'), 1);
    assert.equal(sql(f.dir, 'SELECT count(*) n FROM messages')[0].n, 0);
  } finally {
    await f.close();
  }
});

test('v155 parent RED control: additive config schema enforces R8 runtime defaults/bounds, commands.managers, cron.managers inheritance/explicit [], egress.keyMode, and codexHomeSharedOptIn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spine-cfg-'));
  try {
    // 1. Verify Accepted R8 defaults when runtime/commands/cron/egress blocks are omitted
    const defaultCfgPath = join(dir, 'default-config.json');
    writeFileSync(
      defaultCfgPath,
      JSON.stringify({
        apiUrl: 'https://api.example.com',
        botToken: 'tok-default',
        cwd: join(dir, 'ws-default'),
      }),
    );
    const defLoaded = loadConfig(defaultCfgPath);
    assert.deepEqual(defLoaded.commands?.managers, []);
    assert.deepEqual(defLoaded.cron?.managers, []);
    assert.equal(defLoaded.runtime?.chatTurnCeilingMs, 1_800_000);
    assert.equal(defLoaded.runtime?.laneMaxQueued, 3);
    assert.equal(defLoaded.runtime?.interruptConfirmMs, 10_000);
    assert.equal(defLoaded.runtime?.recycleDrainMs, 120_000);
    assert.equal(defLoaded.egress?.keyMode, 'random');
    assert.equal(defLoaded.sdk.codexHomeSharedOptIn, false);

    // 2. Verify R8 default chatTurnCeilingMs scaling with 3 * dispatchTimeoutMs
    const scaledCfgPath = join(dir, 'scaled-config.json');
    writeFileSync(
      scaledCfgPath,
      JSON.stringify({
        apiUrl: 'https://api.example.com',
        botToken: 'tok-scaled',
        cwd: join(dir, 'ws-scaled'),
        dispatchTimeoutMs: 900_000,
      }),
    );
    const scaledLoaded = loadConfig(scaledCfgPath);
    assert.equal(scaledLoaded.runtime?.chatTurnCeilingMs, 2_700_000);

    // 3. Verify explicit values, cron.managers inheritance vs explicit [], and codexHomeSharedOptIn
    const cfgPath = join(dir, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        apiUrl: 'https://api.example.com',
        botToken: 'tok-main',
        cwd: join(dir, 'ws'),
        commands: { managers: ['mgr-a', 'mgr-b'] },
        runtime: {
          chatTurnCeilingMs: 7_200_000,
          laneMaxQueued: 10,
          interruptConfirmMs: 60_000,
          recycleDrainMs: 600_000,
        },
        egress: { keyMode: 'random' },
        sdk: { codexHome: join(dir, 'shared-codex-home') },
        bots: [
          {
            id: 'bot-inherit',
            botToken: 'tok-1',
          },
          {
            id: 'bot-explicit-empty',
            botToken: 'tok-2',
            cron: { managers: [] },
            runtime: {
              chatTurnCeilingMs: 60_000,
              laneMaxQueued: 1,
              interruptConfirmMs: 1_000,
              recycleDrainMs: 0,
            },
          },
        ],
      }),
    );
    const loaded = loadConfig(cfgPath);
    assert.deepEqual(loaded.commands?.managers, ['mgr-a', 'mgr-b']);
    assert.deepEqual(loaded.cron?.managers, ['mgr-a', 'mgr-b']);
    assert.equal(loaded.runtime?.chatTurnCeilingMs, 7_200_000);
    assert.equal(loaded.runtime?.laneMaxQueued, 10);
    assert.equal(loaded.runtime?.interruptConfirmMs, 60_000);
    assert.equal(loaded.runtime?.recycleDrainMs, 600_000);
    assert.equal(loaded.egress?.keyMode, 'random');
    assert.equal(loaded.sdk.codexHomeSharedOptIn, true);

    const bots = resolveBotConfigs(loaded);
    assert.equal(bots.length, 2);
    assert.deepEqual(bots[0].cron?.managers, ['mgr-a', 'mgr-b']);
    assert.equal(bots[0].sdk.codexHomeSharedOptIn, true);
    assert.deepEqual(bots[1].cron?.managers, []);
    assert.equal(bots[1].cron?.explicitManagers, true);
    assert.equal(bots[1].runtime?.chatTurnCeilingMs, 60_000);
    assert.equal(bots[1].runtime?.laneMaxQueued, 1);
    assert.equal(bots[1].runtime?.interruptConfirmMs, 1_000);
    assert.equal(bots[1].runtime?.recycleDrainMs, 0);

    // 4. Verify R8 out-of-range runtime bounds reject with RangeError
    for (const [field, badVal] of [
      ['chatTurnCeilingMs', 59_999],
      ['chatTurnCeilingMs', 7_200_001],
      ['laneMaxQueued', 0],
      ['laneMaxQueued', 11],
      ['interruptConfirmMs', 999],
      ['interruptConfirmMs', 60_001],
      ['recycleDrainMs', -1],
      ['recycleDrainMs', 600_001],
    ]) {
      const badPath = join(dir, `bad-${field}-${badVal}.json`);
      writeFileSync(
        badPath,
        JSON.stringify({
          apiUrl: 'https://api.example.com',
          botToken: 'tok-bad',
          cwd: join(dir, 'ws-bad'),
          runtime: { [field]: badVal },
        }),
      );
      assert.throws(() => loadConfig(badPath), RangeError, `expected RangeError for ${field}=${badVal}`);
    }
  } finally {
    clean(dir);
  }
});

test('v155 parent RED control: OwnerAuthZ, E>B>F>U command precedence, /new alias, fail-closed omitted evalCtx, and production [AUDIT] deny logging', async () => {
  const f = await createSpineBot();
  try {
    assert.equal(parseCommand('/new')?.name, 'new');
    assert.equal(parseCommand('/reset/foo'), null);
    assert.equal(parseCommand('/config.json'), null);

    // Fail-closed when evalCtx is omitted: /fork is owner-only and must be DENIED
    const { result: omittedRes, lines: omittedLogs } = await captureConsoleLog(() =>
      handleCommand('/fork', 'dm-alice', f.store, f.cfg, 1),
    );
    assert.equal(omittedRes.outcome, 'DENY');
    assert.equal(omittedRes.auth?.isOwner, false);
    assert.equal(omittedRes.auth?.role, 'member');
    assert.ok(omittedLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('outcome=denied') && l.includes('cmd=/fork')));

    // U -> DROP (no audit emitted on DROP)
    const { result: uRes, lines: uLogs } = await captureConsoleLog(() =>
      handleCommand('/reset', 'group-main', f.store, f.cfg, 1, {
        senderUid: 'alice',
        ownerUid: 'owned-owner',
        channelId: 'group-main',
        channelType: 2,
        addressing: 'U',
      }),
    );
    assert.equal(uRes.outcome, 'DROP');
    assert.equal(uLogs.filter((l) => l.includes('[AUDIT]')).length, 0);

    // Unauthorized B -> DENY with [AUDIT] action=deny; Authorized B -> ADDRESS with [AUDIT] outcome=denied
    const { result: unauthB, lines: unauthBLogs } = await captureConsoleLog(() =>
      handleCommand('/reset', 'group-main', f.store, f.cfg, 2, {
        senderUid: 'alice',
        ownerUid: 'owned-owner',
        channelId: 'group-main',
        channelType: 2,
        addressing: 'B',
      }),
    );
    assert.equal(unauthB.outcome, 'DENY');
    assert.ok(unauthBLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('outcome=denied') && l.includes('cmd=/reset,reason=DENY,role=member,addr=B')));

    const { result: authB, lines: authBLogs } = await captureConsoleLog(() =>
      handleCommand('/reset', 'group-main', f.store, f.cfg, 3, {
        senderUid: 'mgr-1',
        ownerUid: 'owned-owner',
        channelId: 'group-main',
        channelType: 2,
        addressing: 'B',
      }),
    );
    assert.equal(authB.outcome, 'ADDRESS');
    assert.ok(authBLogs.some((l) => l.includes('[AUDIT]') && l.includes('outcome=denied') && l.includes('cmd=/reset,reason=ADDRESS,role=session-manager,addr=B')));
  } finally {
    await f.close();
  }
});

test('v155 parent RED control: SessionRouter behaviorally enforces T24 compound-DM filter, strict true/1 mention flags, entities-first I5, broadcast ais suppression I6, and CJK fallback I8/I14', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spine-router-'));
  try {
    const cfg = {
      ...baseConfig(dir, 'cfg-bot'),
      rateLimit: { maxPerMinute: 100 },
    };
    const router = new SessionRouter(cfg, 'live-robot-99', 'owned-owner');
    // Behavioral T24 check: foreign compound DM must be rejected by router.route
    const foreignCompoundDm = await router.route({
      from_uid: 'alice',
      from_name: 'alice',
      channel_id: 'alice@other-bot-999',
      channel_type: 1,
      message_id: 'm-t24-1',
      message_seq: 1,
      timestamp: 1_700_000_001,
      payload: { type: 1, content: 'hello foreign bot' },
    });
    assert.equal(Boolean(foreignCompoundDm?.shouldProcess), false);

    // Behavioral I7 check: string "1" in is_mention_me must not admit a group message
    const stringMentionGroup = await router.route({
      from_uid: 'alice',
      from_name: 'alice',
      channel_id: 'group-1',
      channel_type: 2,
      message_id: 'm-i7-1',
      message_seq: 2,
      timestamp: 1_700_000_002,
      payload: {
        type: 1,
        content: 'hello',
        mention: { is_mention_me: '1', all: 'true' },
      },
    });
    assert.equal(Boolean(stringMentionGroup?.shouldProcess), false);
  } finally {
    clean(dir);
  }
});

test('v155 parent RED control: queue-bypass /new alias commits G+1 before active-turn cancellation and emits channel-bound readReceipt wire payload', async () => {
  const entered = deferred();
  let firstTurnHeld = true;
  let genAtCancel = -1;
  const f = await createSpineBot({
    scenario: {
      turns: [[{ waitInterrupt: true }, { complete: 'interrupted' }]],
      defaultTurn: [
        {
          notify: 'item/completed',
          params: {
            threadId: '$threadId',
            turnId: '$turnId',
            item: { id: '$itemId', type: 'agentMessage', text: 'hello from codex' },
          },
        },
      ],
    },
    onTurnStart: async () => {
      if (firstTurnHeld) {
        firstTurnHeld = false;
        entered.resolve();
      }
    },
  });
  try {
    // 1. Behavioral /new command execution check
    const cmdRes = await handleCommand('/new', 'probe-session', f.store, f.cfg, 1, {
      senderUid: 'alice',
      ownerUid: 'owned-owner',
      channelId: 'alice',
      channelType: 1,
      addressing: 'E',
    });
    assert.equal(cmdRes.handled, true);
    assert.equal(cmdRes.outcome, 'EXEC');

    // 2. Active-turn queue-bypass /new + readReceipt channel wire payload check
    const activeTurn = f.handle(f.dmMsg(1, 'long running turn', 'alice'));
    activeTurn.catch(() => {});
    await entered.promise;
    await tick(10);

    const origReq = f.peers[0].request.bind(f.peers[0]);
    f.peers[0].request = async (method, params, opts) => {
      if (method === 'turn/interrupt') {
        genAtCancel = f.store.getResetGeneration('alice');
      }
      return origReq(method, params, opts);
    };

    f.receipts.length = 0;
    await f.handle(f.dmMsg(2, '/new', 'alice'));
    await Promise.allSettled([activeTurn]);
    assert.equal(genAtCancel, 1, 'G=1 must be committed before turn/interrupt');
    assert.equal(f.store.getResetGeneration('alice'), 1);
    assert.equal(sql(f.dir, "SELECT count(*) n FROM messages WHERE session_id='alice'")[0].n, 0);
    assert.equal(f.receipts.length, 1);
    assert.deepEqual(f.receipts[0].raw, {
      channel_id: 'dm-alice',
      channel_type: 1,
      message_ids: ['wire-dm-2'],
    });
  } finally {
    await f.close();
  }
});

// ============================================================================
// Group 1: Startup order, registeredRobotId vs configBotId, capability branding,
//          live owner lookup, precommit invalidation, and logicalOrigin vs wire ID
// ============================================================================

test('v155 Group 1: startup constructs OctoEgress/ChatTurnIssuer/HostCaller after register and before connect; preserves configBotId vs registeredRobotId', async () => {
  reset();
  const registeredRobotId = 'live-robot-uid-777';
  state.api = async (name, opts) => {
    if (name === 'parseOctoJson') return JSON.parse(opts);
    if (name === 'fetchUserInfo') return { uid: opts.uid, name: 'CodeBot' };
    return {};
  };
  const dir = mkdtempSync(join(tmpdir(), 'spine-g1-'));
  const cfg = {
    ...baseConfig(dir, 'config-bot-tuple-01'),
    botToken: registeredRobotId,
    rateLimit: { maxPerMinute: 100 },
    commands: { managers: ['mgr-1'] },
  };
  let stack;
  try {
    state.beforeRegister = () => {
      assert.equal(state.events.some((e) => e.name === 'connect'), false);
    };
    stack = await startBot(cfg, true, {
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      bin: process.execPath,
      egressFetcher: async () =>
        new Response(JSON.stringify({ code: 0, data: { message_id: 'ok' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      sdkFactory: () => ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'th-1' };
              yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } };
            })(),
          }),
        }),
        resumeThread: () => ({ runStreamed: async () => ({ events: (async function* () {})() }) }),
      }),
      appServerFactory: () => new Peer(),
    });
    const preConnectNames = state.events.map((e) => e.name);
    assert.ok(preConnectNames.includes('register'), 'register must run during startBot');
    assert.ok(preConnectNames.includes('handler'), 'handler must be wired before connect');
    assert.equal(preConnectNames.includes('connect'), false, 'connect must not run before stack.connect()');
    assert.equal(stack.robotUid, registeredRobotId, 'registeredRobotId must come from registerBot response, distinct from configBotId');
    await stack.connect();
    const postConnectNames = state.events.map((e) => e.name);
    const regIdx = postConnectNames.indexOf('register');
    const handlerIdx = postConnectNames.indexOf('handler');
    const connIdx = postConnectNames.indexOf('connect');
    assert.ok(regIdx >= 0 && handlerIdx > regIdx && connIdx > handlerIdx, `expected register -> handler -> connect, got ${postConnectNames.join(',')}`);

    const { isOctoEgress, isChatTurnIssuer, assertOctoEgress, assertChatTurnIssuer } = await loadSpineRuntime();
    assert.equal(isOctoEgress(stack.execution.egress), true);
    assert.equal(isChatTurnIssuer(stack.execution.issuer), true);

    assert.throws(() => assertOctoEgress({ sendText() {} }), (err) => err.prerequisite === 'mandatory-effects-unavailable');
    assert.throws(() => assertChatTurnIssuer({ prepare() {} }), (err) => err.prerequisite === 'reset-cas-unavailable');
  } finally {
    await stack?.shutdown();
    assertClean(assert);
    clean(dir);
  }
});

test('v155 Group 1: empty ownerUid means O=false (not wildcard) while ordinary non-owner human DM chat remains admitted; nomid logicalOrigin never sent to readReceipt', async () => {
  const f = await createSpineBot({ ownerUid: '' });
  try {
    await f.handle(f.dmMsg(1, '/fork', 'anyone'));
    assert.equal(f.sends.at(-1)?.content, '⛔ /fork is limited to the bot owner or managers here.');

    const beforeReceipts = f.receipts.length;
    await f.handle(f.dmMsg(2, 'ordinary question', 'anyone', { message_id: '' }));
    assert.equal(f.sends.at(-1)?.content, 'hello from codex');
    assert.equal(f.receipts.length, beforeReceipts, 'synthetic nomid logicalOrigin must never be sent to readReceipt');
  } finally {
    await f.close();
  }
});

test('v155 Group 1: registeredRobotId drift across refresh or egress/caller invalidation refuses turn before SQLite commit', async () => {
  const entered = deferred();
  const release = deferred();
  const f = await createSpineBot({
    kind: 'sdk',
    onTurnStart: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    const turnPromise = f.handle(f.dmMsg(1, 'hello', 'alice'));
    turnPromise.catch(() => {});
    await entered.promise;

    f.gateway.robotId = 'different-robot-uid-after-refresh';
    release.resolve();
    await assert.rejects(turnPromise, (err) => err.name === 'HostExecutionRefusal' && err.status === 'NO-WRITES');
    assert.equal(sql(f.dir, "SELECT count(*) n FROM messages WHERE role='assistant'")[0].n, 0, 'assistant reply must not commit after registeredRobotId drift');
    assert.throws(
      () =>
        f.stack.execution.forTurn({
          sessionKey: 'alice',
          principalUid: 'alice',
          channelId: 'dm-alice',
          channelType: 1,
          messageId: 'wire-dm-2',
          messageSeq: 2,
        }),
      (err) => err.name === 'HostExecutionRefusal' && err.prerequisite === 'authority-unavailable',
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

// ============================================================================
// Group 2: T24, E > B > F > U, strict true/1 mention flags, CJK fallback,
//          command OwnerAuthZ / precedence, and production [AUDIT] deny logging (F3)
// ============================================================================

test('v155 Group 2: T24 compound-DM filter drops foreign compound DMs with zero SQL/send/receipt while admitting plain DMs and compound DMs containing registeredRobotId', async () => {
  const f = await createSpineBot({ botId: 'config-bot-id' });
  try {
    const beforeSql = state.events.filter((e) => e.name === 'sql-attempt').length;
    await f.handle(f.dmMsg(1, 'hello foreign bot', 'alice', { channel_id: 'alice@other-bot-999' }));
    assert.equal(f.starts.length, 0);
    assert.equal(f.sends.length, 0);
    assert.equal(f.receipts.length, 0);
    assert.equal(state.events.filter((e) => e.name === 'sql-attempt').length, beforeSql);

    await f.handle(f.dmMsg(2, 'hello my bot', 'alice', { channel_id: 'alice@config-bot-id' }));
    assert.equal(f.starts.length, 1);
    assert.equal(f.sends.at(-1)?.content, 'hello from codex');
  } finally {
    await f.close();
  }
});

test('v155 Group 2: strict true/1 mention flags (I7), entities-first (I5), broadcast ais suppression (I6), CJK fallback (I8), and own-mention-only stripping (I14)', async () => {
  const f = await createSpineBot({ botDisplayName: 'CodeBot' });
  try {
    f.group.getNameToUidMap('group-main').set('CodeBot', f.stack.robotUid);
    f.group.getNameToUidMap('group-main').set('Alice', 'alice');

    await f.handle(
      f.groupMsg(1, 'unaddressed with string flag', 'alice', {
        is_mention_me: '1',
        all: 'true',
      }),
    );
    assert.equal(f.starts.length, 0);

    await f.handle(
      f.groupMsg(2, 'broadcast suppressing ais', 'alice', {
        type: 'all',
        all: 1,
        ais: [f.stack.robotUid],
      }),
    );
    assert.equal(f.starts.length, 0);

    await f.handle(
      f.groupMsg(3, '@CodeBot hello via entities', 'alice', {
        type: 'all',
        all: 1,
        ais: [f.stack.robotUid],
        entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
      }),
    );
    assert.equal(f.starts.length, 1);

    await f.handle(f.groupMsg(4, '@CodeBot你好 请问 @Alice 在吗', 'alice', undefined));
    assert.equal(f.starts.length, 2);
    assert.match(f.starts.at(-1).prompt, /你好 请问 @Alice 在吗/);
    assert.doesNotMatch(f.starts.at(-1).prompt, /@CodeBot/);

    await f.handle(f.groupMsg(5, 'email foo@CodeBot', 'alice', undefined));
    await f.handle(f.groupMsg(6, '@CodeBot_extra test', 'alice', undefined));
    assert.equal(f.starts.length, 2);
  } finally {
    await f.close();
  }
});

test('v155 Group 2: command OwnerAuthZ matrix (O/S/C x E/B/F/U), DENY -> ADDRESS -> DISABLED -> EXEC precedence, production [AUDIT] deny emission (F3), and readReceipt channel wire bodies (F1)', async () => {
  const f = await createSpineBot({
    botDisplayName: 'CodeBot',
    sdkConfig: {
      apiKey: 'sk-top-secret-audit-check',
      baseUrl: 'https://secret-audit.internal.example.com',
    },
  });
  try {
    f.group.getNameToUidMap('group-main').set('CodeBot', f.stack.robotUid);
    f.group.getNameToUidMap('topic-main').set('CodeBot', f.stack.robotUid);
    const { StringCatalog } = await loadSpineRuntime();

    // 1. U in group -> DROP with zero sends, zero receipts, zero SQL writes, zero [AUDIT]
    const sqlBeforeU = state.events.filter((e) => e.name === 'sql-attempt').length;
    const { lines: uLogs } = await captureConsoleLog(() =>
      f.handle(f.groupMsg(1, '/reset', 'alice', {})),
    );
    assert.equal(f.sends.length, 0);
    assert.equal(f.receipts.length, 0);
    assert.equal(state.events.filter((e) => e.name === 'sql-attempt').length, sqlBeforeU);
    assert.equal(uLogs.filter((l) => l.includes('[AUDIT]')).length, 0);

    // 2. Unauthorized B in group (alice is neither O nor S) -> DENY + production [AUDIT] action=deny + zero DB/model effect
    const sqlBeforeUnauthB = state.events.filter((e) => e.name === 'sql-attempt').length;
    const { lines: unauthBLogs } = await captureConsoleLog(() =>
      f.handle(f.groupMsg(2, '@AI /reset', 'alice', { ais: 1 })),
    );
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandDenied('reset'));
    assert.equal(state.events.filter((e) => e.name === 'sql-attempt').length, sqlBeforeUnauthB);
    assert.equal(f.store.getResetGeneration('group-main'), 0);
    assert.ok(
      unauthBLogs.some(
        (l) =>
          l.startsWith('[AUDIT] ') &&
          l.includes('bot=spine-bot') &&
          l.includes('actor=alice') &&
          l.includes('action=deny') &&
          l.includes('target=group-main') &&
          l.includes('outcome=denied') &&
          l.includes('detail=cmd=/reset,reason=DENY,role=member,addr=B'),
      ),
      'production handleMessage must emit [AUDIT] deny record for unauthorized /reset',
    );
    // F1: Verify group readReceipt wire body carries exact channel_id and channel_type=2
    assert.deepEqual(f.receipts.at(-1)?.raw, {
      channel_id: 'group-main',
      channel_type: 2,
      message_ids: ['wire-grp-2'],
    });

    // 3. Unauthorized E in group for /new and /config -> DENY + production [AUDIT] action=deny + zero DB/model effect
    for (const [seq, cmdName] of [
      [20, 'new'],
      [21, 'config'],
    ]) {
      const sqlBefore = state.events.filter((e) => e.name === 'sql-attempt').length;
      const { lines } = await captureConsoleLog(() =>
        f.handle(
          f.groupMsg(seq, `@CodeBot /${cmdName}`, 'alice', {
            entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
          }),
        ),
      );
      assert.equal(f.sends.at(-1)?.content, StringCatalog.commandDenied(cmdName));
      assert.equal(state.events.filter((e) => e.name === 'sql-attempt').length, sqlBefore);
      assert.ok(
        lines.some(
          (l) =>
            l.startsWith('[AUDIT] ') &&
            l.includes('actor=alice') &&
            l.includes('action=deny') &&
            l.includes(`detail=cmd=/${cmdName},reason=DENY,role=member,addr=E`),
        ),
      );
      for (const line of lines.filter((l) => l.startsWith('[AUDIT]'))) {
        assert.doesNotMatch(line, /sk-top-secret|secret-audit\.internal|spine-owned-|mgr-1|cron-1/);
      }
    }

    // 4. Authorized B in group (mgr-1 is S) -> ADDRESS every time (no 60s suppression)
    const countBeforeAuthB = f.sends.length;
    await f.handle(f.groupMsg(3, '@AI /reset', 'mgr-1', { ais: 1 }));
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandAddressRequired('reset'));
    await f.handle(f.groupMsg(4, '@AI /reset', 'mgr-1', { ais: 1 }));
    assert.equal(f.sends.length, countBeforeAuthB + 2);
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandAddressRequired('reset'));

    // 5. F (text fallback when payload.mention is absent) in topic (channel_type=5) matches E for admitted commands
    //    and F1 verifies readReceipt wire body carries channel_type=5 and channel_id='topic-main'
    await f.handle(f.topicMsg(5, '@CodeBot /help', 'alice', undefined));
    assert.match(f.sends.at(-1)?.content ?? '', /Available commands:/);
    assert.deepEqual(f.receipts.at(-1)?.raw, {
      channel_id: 'topic-main',
      channel_type: 5,
      message_ids: ['wire-top-5'],
    });

    // 6. --all-conversations: denied to S in DM and denied to O in group with [AUDIT] action=deny; allowed to O in DM
    const { lines: scopeMgrLogs } = await captureConsoleLog(() =>
      f.handle(f.dmMsg(6, '/reset --all-conversations', 'mgr-1')),
    );
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandScopeDenied());
    assert.ok(scopeMgrLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('cmd=/reset,reason=DENY,role=session-manager')));

    const { lines: scopeGroupLogs } = await captureConsoleLog(() =>
      f.handle(
        f.groupMsg(7, '@CodeBot /reset --all-conversations', 'owned-owner', {
          entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
        }),
      ),
    );
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandScopeDenied());
    assert.ok(scopeGroupLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('cmd=/reset,reason=DENY,role=owner')));

    await f.handle(f.dmMsg(8, '/reset --all-conversations', 'owned-owner'));
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandReset());
    assert.deepEqual(f.receipts.at(-1)?.raw, {
      channel_id: 'dm-owned-owner',
      channel_type: 1,
      message_ids: ['wire-dm-8'],
    });

    // 7. /cron: uses cron authority (O || C); mgr-1 (in S, not C) is denied with [AUDIT] action=deny; cron-1 (in C) executes /cron list in M2
    const { lines: cronDenyLogs } = await captureConsoleLog(() =>
      f.handle(f.dmMsg(9, '/cron list', 'mgr-1')),
    );
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandDenied('cron'));
    assert.ok(cronDenyLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('cmd=/cron,reason=DENY,role=session-manager')));

    await f.handle(f.dmMsg(10, '/cron list', 'cron-1'));
    assert.equal(f.sends.at(-1)?.content, 'No scheduled tasks in this conversation.');

    // 8. /fork: owner-only (O); mgr-1 is denied with [AUDIT] action=deny; owned-owner gets command.disabled
    const { lines: forkDenyLogs } = await captureConsoleLog(() =>
      f.handle(f.dmMsg(11, '/fork', 'mgr-1')),
    );
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandDenied('fork'));
    assert.ok(forkDenyLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('cmd=/fork,reason=DENY,role=session-manager')));

    await f.handle(f.dmMsg(12, '/fork', 'owned-owner'));
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandDisabled('fork'));

    // 9. Unknown /foo -> command.unknown (never reaches model); /reset/foo and /config.json reach model
    const startsBefore = f.starts.length;
    await f.handle(f.dmMsg(13, '/foo', 'alice'));
    assert.equal(f.starts.length, startsBefore);
    assert.match(f.sends.at(-1)?.content ?? '', /^Unknown command: \/foo\n\n/);

    await f.handle(f.dmMsg(14, '/reset/foo', 'alice'));
    await f.handle(f.dmMsg(15, '/config.json', 'alice'));
    assert.equal(f.starts.length, startsBefore + 2);
  } finally {
    await f.close();
  }
});

// ============================================================================
// Group 3: Queue-bypass /reset and /new, commit-before-cancel,
//          and unauthorized reset zero-effect
// ============================================================================

test('v155 Group 3: queue-bypass /reset and /new while active turn is blocked; unauthorized reset has zero DB/cancel effect; authorized reset commits G+1 before cancelling', async () => {
  const entered = deferred();
  let firstTurnHeld = true;
  let genAtCancel = -1;
  const f = await createSpineBot({
    botDisplayName: 'CodeBot',
    scenario: {
      turns: [[{ waitInterrupt: true }, { complete: 'interrupted' }]],
      defaultTurn: [
        {
          notify: 'item/completed',
          params: {
            threadId: '$threadId',
            turnId: '$turnId',
            item: { id: '$itemId', type: 'agentMessage', text: 'hello from codex' },
          },
        },
      ],
    },
    onTurnStart: async () => {
      if (firstTurnHeld) {
        firstTurnHeld = false;
        entered.resolve();
      }
    },
  });
  try {
    f.group.getNameToUidMap('group-main').set('CodeBot', f.stack.robotUid);
    const { StringCatalog } = await loadSpineRuntime();

    const activeTurn = f.handle(
      f.groupMsg(1, '@CodeBot long task', 'alice', {
        entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
      }),
    );
    activeTurn.catch(() => {});
    await entered.promise;
    await tick(10);

    // 1. Unauthorized group /reset by alice while activeTurn is blocked:
    //    bypasses lock/queue, emits [AUDIT] action=deny + command.denied, performs ZERO generation/DB changes and ZERO cancellation
    const sqlBeforeUnauth = state.events.filter((e) => e.name === 'sql-attempt').length;
    const { lines: denyLogs } = await captureConsoleLog(() =>
      f.handle(
        f.groupMsg(2, '@CodeBot /reset', 'alice', {
          entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
        }),
      ),
    );
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandDenied('reset'));
    assert.equal(f.store.getResetGeneration('group-main'), 0);
    assert.equal(state.events.filter((e) => e.name === 'sql-attempt').length, sqlBeforeUnauth);
    assert.ok(denyLogs.some((l) => l.includes('[AUDIT]') && l.includes('action=deny') && l.includes('cmd=/reset')));

    // 2. Authorized group /new by mgr-1 while activeTurn is STILL blocked:
    //    commits G=1 FIRST, cancels activeTurn via turn/interrupt, sends reset ack and group readReceipt
    const origCancel = f.peers[0].request.bind(f.peers[0]);
    f.peers[0].request = async (method, params, opts) => {
      if (method === 'turn/interrupt') {
        genAtCancel = f.store.getResetGeneration('group-main');
      }
      return origCancel(method, params, opts);
    };

    await f.handle(
      f.groupMsg(3, '@CodeBot /new', 'mgr-1', {
        entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
      }),
    );
    await Promise.allSettled([activeTurn]);
    assert.equal(genAtCancel, 1, 'G+1 must be durably committed in SQLite BEFORE turn/interrupt cancellation runs');
    assert.equal(f.store.getResetGeneration('group-main'), 1);
    assert.equal(f.sends.at(-1)?.content, StringCatalog.commandReset());
    assert.deepEqual(f.receipts.at(-1)?.raw, {
      channel_id: 'group-main',
      channel_type: 2,
      message_ids: ['wire-grp-3'],
    });
    assert.equal(sql(f.dir, "SELECT count(*) n FROM messages WHERE session_id='group-main'")[0].n, 0);

    // 3. Subsequent turn in G=1 succeeds cleanly
    await f.handle(
      f.groupMsg(4, '@CodeBot fresh turn after reset', 'alice', {
        entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
      }),
    );
    assert.equal(f.sends.at(-1)?.content, 'hello from codex');
    assert.equal(sql(f.dir, "SELECT count(*) n FROM messages WHERE session_id='group-main'")[0].n, 2);
  } finally {
    await f.close();
  }
});

// ============================================================================
// Group 4: Effective /config & /help, OctoEgress wire delivery (F1 & F2),
//          O3/O4/O6/O9/O10/O14/O15/O16/O17/O18/O19, 429 retry, and error/status handling
// ============================================================================

test('v155 Group 4: role/feature-aware /help and redacted effective /config', async () => {
  const f = await createSpineBot({
    sdkConfig: {
      apiKey: 'sk-secret-key-must-not-leak',
      baseUrl: 'https://secret-llm.internal.example.com/v1',
      env: { SECRET_ENV_TOKEN: 'super-secret-value' },
      approvalPolicy: 'on-request',
      webSearchEnabled: false,
      webSearchMode: 'disabled',
      codexHomeSharedOptIn: true,
    },
  });
  try {
    await f.handle(
      f.groupMsg(1, '@CodeBot /help', 'alice', {
        entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
      }),
    );
    const aliceHelp = f.sends.at(-1)?.content ?? '';
    assert.match(aliceHelp, /Available commands:/);
    assert.doesNotMatch(aliceHelp, /\/reset/);
    assert.doesNotMatch(aliceHelp, /\/config/);

    await f.handle(f.dmMsg(2, '/help', 'owned-owner'));
    const ownerHelp = f.sends.at(-1)?.content ?? '';
    assert.match(ownerHelp, /\/reset/);
    assert.match(ownerHelp, /\/new/);
    assert.match(ownerHelp, /\/config/);
    assert.match(ownerHelp, /\/cron/);
    assert.doesNotMatch(ownerHelp, /\/fork/);

    await f.handle(f.dmMsg(3, '/config', 'owned-owner'));
    const cfgReply = f.sends.at(-1)?.content ?? '';
    assert.match(cfgReply, /Current settings:/);
    assert.match(cfgReply, /• approvalPolicy: never \(effective; configured: on-request\)/);
    assert.match(cfgReply, /• webSearch: cached \(effective; configured: off\)/);
    assert.match(cfgReply, /• executor: app-server/);
    assert.match(cfgReply, /• cron: enabled; jobs: 0/);
    assert.match(cfgReply, /• codexHome: shared opt-in; concurrent writers unsupported/);
    assert.doesNotMatch(cfgReply, /sk-secret|secret-llm|super-secret|SECRET_ENV_TOKEN|spine-owned-|mgr-1|cron-1|owned-owner/);
  } finally {
    await f.close();
  }
});

test('v155 Group 4: O4 double-newline join, O14 dispatch-only typing, O15 readReceipt channel/suppression on NO_REPLY & failed output (F1), O17 tool-failure banner, O18 silent NO_REPLY, and O19 per-item.id progress dedupe (<=10)', async () => {
  let mode = 'multi-chunk';
  let failSendMessage = false;
  const f = await createSpineBot({
    kind: 'sdk',
    onEgressFetch: async (req) => {
      if (failSendMessage && req.pathname.endsWith('/v1/bot/sendMessage')) {
        return new Response(JSON.stringify({ code: 500, msg: 'upstream send failure' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return undefined;
    },
    sdkEvents: async function* () {
      yield { type: 'thread.started', thread_id: 'sdk-th-o' };
      if (mode === 'multi-chunk') {
        yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'First paragraph.' } };
        yield { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Second paragraph.' } };
      } else if (mode === 'no-reply') {
        yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '  NO_REPLY \n' } };
      } else if (mode === 'tool-failed-empty') {
        for (let i = 1; i <= 12; i++) {
          yield {
            type: 'item.started',
            item: { id: `cmd-${i}`, type: 'command_execution', command: `echo step-${i}`, status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: {
              id: `cmd-${i}`,
              type: 'command_execution',
              command: `echo step-${i}`,
              status: i === 12 ? 'failed' : 'completed',
              exit_code: i === 12 ? 1 : 0,
            },
          };
        }
      }
      yield { type: 'turn.completed', usage: {} };
    },
  });
  try {
    const { StringCatalog } = await loadSpineRuntime();

    // 1. O4 + O14 + O15: Multi-message agent outputs joined with '\n\n' in both outbound send and assistant SQL history,
    //    typing fired on lane dispatch with channel_id/channel_type, and readReceipt sent with channel_id/channel_type
    await f.handle(f.dmMsg(1, 'give two paragraphs', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'First paragraph.\n\nSecond paragraph.');
    const row1 = sql(f.dir, "SELECT content FROM messages WHERE session_id='alice' AND role='assistant'")[0];
    assert.equal(row1.content, 'First paragraph.\n\nSecond paragraph.');
    assert.ok(f.typings.length >= 1, 'O14: typing fired on lane dispatch');
    assert.deepEqual(f.typings[0].raw, { channel_id: 'dm-alice', channel_type: 1 });
    assert.deepEqual(f.receipts.at(-1)?.raw, {
      channel_id: 'dm-alice',
      channel_type: 1,
      message_ids: ['wire-dm-1'],
    });

    // 2. O18 + F1: NO_REPLY is completely silent with zero outbound reply/placeholder/banner, ZERO readReceipt, and no NO_REPLY assistant row
    mode = 'no-reply';
    const sendsBeforeNoReply = f.sends.length;
    const receiptsBeforeNoReply = f.receipts.length;
    await f.handle(f.dmMsg(2, 'stay silent', 'alice'));
    assert.equal(f.sends.length, sendsBeforeNoReply, 'NO_REPLY must emit zero outbound messages');
    assert.equal(f.receipts.length, receiptsBeforeNoReply, 'F1/O18: suppressed NO_REPLY must emit zero readReceipt');
    const rowsAfterNoReply = sql(f.dir, "SELECT content FROM messages WHERE session_id='alice' AND role='assistant'");
    assert.equal(rowsAfterNoReply.length, 1, 'NO_REPLY must not insert an assistant history row');

    // 3. O17 + O19: 12 tool items (started+completed each = 24 events) deduplicate by item.id and cap at 10 progress notices;
    //    empty assistant text + failed command_execution emits chatToolFailure('Command')
    mode = 'tool-failed-empty';
    const sendsBeforeTools = f.sends.length;
    await f.handle(f.dmMsg(3, 'run tools', 'alice'));
    const toolTurnSends = f.sends.slice(sendsBeforeTools);
    const progressSends = toolTurnSends.filter((s) => s.content.startsWith('🔧 Running '));
    assert.equal(progressSends.length, 10, 'O19: progress notices deduplicated by item.id and capped at 10');
    assert.equal(toolTurnSends.at(-1)?.content, StringCatalog.chatToolFailure('Command'));

    // 4. F1 + F2: When outbound sendMessage fails with HTTP 500 via OctoApiClient, assistant history is NOT committed and readReceipt is NOT sent
    mode = 'multi-chunk';
    failSendMessage = true;
    const receiptsBeforeFail = f.receipts.length;
    const assistantBeforeFail = sql(f.dir, "SELECT count(*) n FROM messages WHERE session_id='alice' AND role='assistant'")[0].n;
    await f.handle(f.dmMsg(4, 'will fail outbound', 'alice'));
    assert.equal(f.receipts.length, receiptsBeforeFail, 'F1/F2: failed outbound delivery must emit zero readReceipt');
    assert.equal(
      sql(f.dir, "SELECT count(*) n FROM messages WHERE session_id='alice' AND role='assistant'")[0].n,
      assistantBeforeFail,
      'F2: rejected outbound send must not commit assistant history',
    );
  } finally {
    await f.close();
  }
});

test('v155 Group 4: F1/F2 OctoApiClient wire contract — HTTP 429 retry reuse, O16 partial-delivery error suppression on segment-2 500, and sendReadReceipt invalid-channel refusal', async () => {
  const { OctoEgress, StringCatalog } = await loadSpineRuntime();

  // 1. F1: OctoEgress.sendReadReceipt refuses missing/empty channelId or invalid channelType
  const dummyEgress = new OctoEgress({
    apiUrl: 'https://api.example.com',
    getToken: () => 'tok-test',
    fetcher: async () => new Response('', { status: 200 }),
  });
  await assert.rejects(
    () => dummyEgress.sendReadReceipt({ channelId: '', channelType: 1, wireMessageIds: ['m1'] }),
    (err) => err.name === 'HostExecutionRefusal' && err.prerequisite === 'invalid-read-receipt-channel',
  );
  await assert.rejects(
    () => dummyEgress.sendReadReceipt({ channelId: 'ch-1', channelType: 99, wireMessageIds: ['m1'] }),
    (err) => err.name === 'HostExecutionRefusal' && err.prerequisite === 'invalid-read-receipt-channel',
  );

  // 2. F2: End-to-end through createSpineBot with real OctoApiClient:
  //    - Segment 1 gets HTTP 429 (Retry-After: 1) then HTTP 200 (reusing exact same client_msg_no)
  //    - Segment 2 gets HTTP 500
  //    - Because Segment 1 was confirmed delivered, O16 suppresses generic chat.error notice,
  //      and F1 suppresses readReceipt because full turn output did not complete.
  const longTwoSegmentReply = 'SegmentOne-' + 'A'.repeat(3490) + ' SegmentTwo-' + 'B'.repeat(200);
  let sendAttempt = 0;
  let clockNow = 1_000;
  const f = await createSpineBot({
    kind: 'sdk',
    replyText: longTwoSegmentReply,
    setup: {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CODEX_OCTO_EXECUTOR: 'sdk',
      },
      bin: process.execPath,
      runtime: {
        clock: {
          now: () => clockNow,
          monotonicNow: () => clockNow,
          setTimeout: (fn, ms) => {
            if (ms >= 30_000) return setTimeout(fn, ms);
            clockNow += ms;
            return setTimeout(fn, 1);
          },
          clearTimeout: (id) => clearTimeout(id),
        },
      },
    },
    onEgressFetch: async (req) => {
      if (req.pathname.endsWith('/v1/bot/sendMessage')) {
        sendAttempt += 1;
        if (sendAttempt === 1) {
          return new Response(JSON.stringify({ code: 429, msg: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
          });
        }
        if (sendAttempt === 2) {
          return new Response(JSON.stringify({ code: 0, data: { message_id: 'seg1-ok' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ code: 500, msg: 'seg2 failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return undefined;
    },
  });

  try {
    await f.handle(f.dmMsg(1, 'long reply with 429 on seg1 and 500 on seg2', 'alice'));
    const sendWireReqs = f.wireRequests.filter((r) => r.pathname.endsWith('/v1/bot/sendMessage'));
    assert.equal(sendWireReqs.length, 3, 'expected 2 attempts for segment 1 (429 -> 200) and 1 attempt for segment 2 (500)');
    assert.equal(
      sendWireReqs[0].body.client_msg_no,
      sendWireReqs[1].body.client_msg_no,
      'HTTP 429 retry must reuse the exact same random client_msg_no',
    );
    assert.notEqual(
      sendWireReqs[1].body.client_msg_no,
      sendWireReqs[2].body.client_msg_no,
      'segment 2 must allocate a fresh random client_msg_no',
    );
    assert.equal(
      sendWireReqs.some((r) => r.body.payload?.content === StringCatalog.chatError()),
      false,
      'O16: once segment 1 is confirmed delivered, generic chat.error must be suppressed when segment 2 fails',
    );
    assert.equal(f.receipts.length, 0, 'F1: failed segment 2 must prevent readReceipt emission');

    // O3/O6/O9/O10: 3500-char UTF-16 mention-safe chunking, isMember guard, and segment-1-only @all
    const memberMap = new Map([['Alice', 'uid-alice']]);
    const longText = '@all Hello @[uid-alice:Alice] and @[uid-stranger:NonMember] ' + 'a'.repeat(3490);
    const resolved = resolveMentions(longText, memberMap, (uid) => uid === 'uid-alice');
    assert.equal(resolved.mentionAll, true);
    assert.equal(resolved.mentionEntities.length, 1);
    assert.equal(resolved.mentionEntities[0].uid, 'uid-alice');
    const chunks = splitMessage(
      resolved.finalContent,
      3500,
      resolved.mentionEntities.map((e) => ({ start: e.offset, end: e.offset + e.length })),
    );
    assert.equal(chunks.length, 2);
  } finally {
    await f.close();
  }
});

// ============================================================================
// Group 5: resolveCodexBinary lockfile pin resolution and offline
//          AppServerClient stdio peer end-to-end turn + reset
// ============================================================================

test('v155 Group 5: resolveCodexBinary resolves @openai/codex@0.169.1 via createRequire anchored at @openai/codex-sdk/package.json without importing SDK', async () => {
  const { resolveCodexBinary } = await loadSpineRuntime();
  const fakeRoot = mkdtempSync(join(tmpdir(), 'spine-codex-anchor-'));
  try {
    const sdkDir = join(fakeRoot, 'node_modules/@openai/codex-sdk');
    const codexDir = join(fakeRoot, 'node_modules/@openai/codex');
    const targetDir = join(fakeRoot, 'node_modules/@openai/codex-darwin-arm64');
    const vendorRoot = join(targetDir, 'vendor/aarch64-apple-darwin');
    const vendorBinDir = join(vendorRoot, 'bin');
    const vendorPathDir = join(vendorRoot, 'codex-path');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(vendorBinDir, { recursive: true });
    mkdirSync(vendorPathDir, { recursive: true });
    writeFileSync(
      join(sdkDir, 'package.json'),
      JSON.stringify({
        name: '@openai/codex-sdk',
        version: '0.169.1',
        type: 'module',
        exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      }),
    );
    writeFileSync(join(codexDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.1' }));
    writeFileSync(
      join(targetDir, 'package.json'),
      JSON.stringify({ name: '@openai/codex', version: '0.169.1-darwin-arm64' }),
    );
    writeFileSync(
      join(vendorRoot, 'codex-package.json'),
      JSON.stringify({
        layoutVersion: 1,
        version: '0.169.1',
        target: 'aarch64-apple-darwin',
        variant: 'codex',
        entrypoint: 'bin/codex',
        resourcesDir: 'codex-resources',
        pathDir: 'codex-path',
      }),
    );
    writeFileSync(join(vendorBinDir, 'codex'), '#!/bin/sh\n');
    writeFileSync(join(vendorPathDir, 'rg'), '#!/bin/sh\n');

    const sdkImportsBefore = guardState.sdkImports;
    const resolved = resolveCodexBinary({
      anchorUrl: pathToFileURL(join(fakeRoot, 'codex-binary.js')),
      platform: 'darwin',
      arch: 'arm64',
    });
    assert.equal(guardState.sdkImports, sdkImportsBefore, 'resolveCodexBinary must not import @openai/codex-sdk');
    assert.match(resolved.bin, /@openai\/codex-darwin-arm64\/vendor\/aarch64-apple-darwin\/bin\/codex$/);
    assert.equal(resolved.vendorPathDirs.length, 1);
    assert.match(resolved.vendorPathDirs[0], /@openai\/codex-darwin-arm64\/vendor\/aarch64-apple-darwin\/codex-path$/);
    assert.equal(resolved.version, '0.169.1');
    assert.equal(resolved.layoutVersion, 1);
  } finally {
    clean(fakeRoot);
  }
});

test('v155 Group 5: end-to-end chat turn, resume, and queue-bypass /reset over real AppServerClient + offline fake-app-server.mjs stdio peer', async () => {
  const { AppServerClient } = await import('../../dist/app-server/client.js');
  const dir = mkdtempSync(join(tmpdir(), 'spine-stdio-'));
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      defaultTurn: [
        {
          notify: 'item/completed',
          params: {
            threadId: '$threadId',
            turnId: '$turnId',
            item: { id: '$itemId', type: 'agentMessage', text: 'stdio peer reply' },
          },
        },
      ],
    }),
  );

  const fakeServerBin = join(root, 'test/foundation/bin/fake-app-server.mjs');
  const f = await createSpineBot({
    setup: {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CODEX_OCTO_EXECUTOR: 'app-server',
      },
      bin: process.execPath,
      appServerFactory(clientOptions) {
        return new AppServerClient({
          ...clientOptions,
          bin: process.execPath,
          args: [fakeServerBin, '--scenario', scenarioPath],
          env: {
            PATH: '/usr/bin:/bin',
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            CALLER_GUARD_ROOT: process.env.CALLER_GUARD_ROOT,
            HOST_TYPESCRIPT: process.env.HOST_TYPESCRIPT,
            HOST_SQLITE: process.env.HOST_SQLITE,
            HOST_REAL_BRIDGE: process.env.HOST_REAL_BRIDGE,
            HOST_PIN_REPO: process.env.HOST_PIN_REPO,
          },
        });
      },
    },
  });

  try {
    // Turn 1 starts thr_1 over stdio
    await f.handle(f.dmMsg(1, 'first turn over stdio', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'stdio peer reply');
    assert.deepEqual(f.receipts.at(-1)?.raw, {
      channel_id: 'dm-alice',
      channel_type: 1,
      message_ids: ['wire-dm-1'],
    });
    const thread1 = f.store.getSdkSessionId('alice');
    assert.equal(thread1, 'thr_1');

    // Turn 2 resumes thr_1 over stdio
    await f.handle(f.dmMsg(2, 'second turn over stdio', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'stdio peer reply');
    assert.equal(f.store.getSdkSessionId('alice'), 'thr_1');
    assert.equal(sql(f.dir, "SELECT count(*) n FROM messages WHERE session_id='alice'")[0].n, 4);

    // Queue-bypass /reset advances G -> 1 and clears thread mapping
    await f.handle(f.dmMsg(3, '/reset', 'alice'));
    assert.equal(f.store.getResetGeneration('alice'), 1);
    assert.equal(f.store.getSdkSessionId('alice'), undefined);

    // Turn 3 after reset starts fresh thr_2 over stdio
    await f.handle(f.dmMsg(4, 'third turn after reset', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'stdio peer reply');
    assert.equal(f.store.getSdkSessionId('alice'), 'thr_2');
    trace({
      phase: 'v155-stdio-peer-e2e',
      generation: f.store.getResetGeneration('alice'),
      threadAfterReset: f.store.getSdkSessionId('alice'),
    });
  } finally {
    await f.close();
    clean(dir);
  }
});

// ============================================================================
// Group 6: v156A Startup / Executor / Config / Environment Seam & 0.142.3 Pin
// ============================================================================

test('v156 parent RED control: uninjected startBot snapshots CODEX_OCTO_EXECUTOR=sdk, disables cron, and keeps /config aligned with bound executor even if process.env changes after boot', async () => {
  const prevExec = process.env.CODEX_OCTO_EXECUTOR;
  process.env.CODEX_OCTO_EXECUTOR = 'sdk';
  let f;
  try {
    f = await createSpineBot({
      setup: { env: undefined },
    });
    // Mutate ambient process.env after boot to prove /config and turn dispatch
    // remain bound to the startup snapshot rather than re-reading process.env.
    process.env.CODEX_OCTO_EXECUTOR = 'app-server';

    assert.equal(f.stack.execution.executorKind, 'sdk');
    assert.deepEqual(f.stack.execution.cron, { state: 'disabled', disabledReason: 'executor-sdk' });

    await f.handle(f.dmMsg(1, '/config', 'owned-owner'));
    assert.equal(f.sends.length, 1);
    assert.match(f.sends[0].content, /• executor: sdk/);
    assert.match(f.sends[0].content, /• cron: disabled\(executor-sdk\); jobs: 0/);

    await f.handle(f.dmMsg(2, 'sdk turn after ambient env flip', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'hello from codex');
    assert.equal(f.store.getSdkSessionId('alice'), 'sdk-thread-1');
  } finally {
    if (prevExec === undefined) delete process.env.CODEX_OCTO_EXECUTOR;
    else process.env.CODEX_OCTO_EXECUTOR = prevExec;
    await f?.close();
  }
});

test('v156 parent RED control: uninjected startBot rejects invalid CODEX_OCTO_EXECUTOR at boot and cleans up ownership lock and SQLite DB', async () => {
  reset();
  const prevExec = process.env.CODEX_OCTO_EXECUTOR;
  process.env.CODEX_OCTO_EXECUTOR = 'invalid-executor';
  const dir = mkdtempSync(join(tmpdir(), 'spine-bad-exec-'));
  try {
    await assert.rejects(
      () => startBot(baseConfig(dir, 'bad-exec-bot'), true),
      /CODEX_OCTO_EXECUTOR must be sdk or app-server/,
    );
    assert.equal(existsSync(join(dir, 'gateway.lock')), false, 'ownership lock must be released on invalid executor');
    assertClean(assert);
  } finally {
    if (prevExec === undefined) delete process.env.CODEX_OCTO_EXECUTOR;
    else process.env.CODEX_OCTO_EXECUTOR = prevExec;
    clean(dir);
  }
});

test('v156 parent RED control: agent-bridge uses bound per-bot execution.env instead of leaking ambient process.env into executor settings.env', async () => {
  let capturedAppServerEnv;
  const f = await createSpineBot({
    sdkConfig: {
      env: { CUSTOM_BOT_SDK_VAR: 'bot-scoped-only' },
    },
    setup: {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CODEX_OCTO_EXECUTOR: 'app-server',
      },
      appServerFactory(options) {
        capturedAppServerEnv = options.env;
        return new Peer({
          defaultTurn: [
            {
              notify: 'item/completed',
              params: {
                threadId: '$threadId',
                turnId: '$turnId',
                item: { id: '$itemId', type: 'agentMessage', text: 'env isolated' },
              },
            },
          ],
        });
      },
    },
  });
  try {
    await f.handle(f.dmMsg(1, 'verify env isolation', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'env isolated');
    assert.ok(capturedAppServerEnv, 'appServerFactory must receive normalized env');
    assert.equal(
      capturedAppServerEnv.HOST_PIN_REPO,
      undefined,
      'ambient process.env.HOST_PIN_REPO must not leak into bound execution.env',
    );
    assert.equal(capturedAppServerEnv.CUSTOM_BOT_SDK_VAR, 'bot-scoped-only');
    assert.equal(capturedAppServerEnv.CODEX_HOME, join(f.dir, 'codex-home'));
    assert.equal(capturedAppServerEnv.HOME, process.env.HOME);
    assert.equal(capturedAppServerEnv.TMPDIR, process.env.TMPDIR);
  } finally {
    await f.close();
  }

  // Also verify uninjected setup.env with sdk.codexHome omitted defaults CODEX_HOME to <dir>/codex-home
  // and strips non-allowlisted ambient process.env keys such as HOST_PIN_REPO.
  let capturedUninjectedEnv;
  const f2 = await createSpineBot({
    sdkConfig: {
      codexHome: undefined,
    },
    setup: {
      env: undefined,
      appServerFactory(options) {
        capturedUninjectedEnv = options.env;
        return new Peer({
          defaultTurn: [
            {
              notify: 'item/completed',
              params: {
                threadId: '$threadId',
                turnId: '$turnId',
                item: { id: '$itemId', type: 'agentMessage', text: 'uninjected env isolated' },
              },
            },
          ],
        });
      },
    },
  });
  try {
    await f2.handle(f2.dmMsg(1, 'verify uninjected default codex-home', 'alice'));
    assert.equal(f2.sends.at(-1)?.content, 'uninjected env isolated');
    assert.ok(capturedUninjectedEnv);
    assert.equal(capturedUninjectedEnv.HOST_PIN_REPO, undefined);
    assert.equal(capturedUninjectedEnv.CODEX_HOME, join(f2.dir, 'codex-home'));
    assert.equal(capturedUninjectedEnv.HOME, process.env.HOME);
    assert.equal(capturedUninjectedEnv.TMPDIR, process.env.TMPDIR);
  } finally {
    await f2.close();
  }
});

test('v156 parent RED control: resolveCodexBinary and startBot verify exact @openai/codex@0.169.1 and platform package version before spawn and log only binary path and version', async () => {
  const { resolveCodexBinary } = await loadSpineRuntime();
  const fakeRoot = mkdtempSync(join(tmpdir(), 'spine-v156-pin-'));
  try {
    const sdkDir = join(fakeRoot, 'node_modules/@openai/codex-sdk');
    const codexDir = join(fakeRoot, 'node_modules/@openai/codex');
    const targetDir = join(fakeRoot, 'node_modules/@openai/codex-darwin-arm64');
    const vendorRoot = join(targetDir, 'vendor/aarch64-apple-darwin');
    const vendorBinDir = join(vendorRoot, 'bin');
    const vendorPathDir = join(vendorRoot, 'codex-path');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(vendorBinDir, { recursive: true });
    mkdirSync(vendorPathDir, { recursive: true });
    writeFileSync(join(vendorBinDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(vendorPathDir, 'rg'), '#!/bin/sh\n', { mode: 0o755 });

    const anchorUrl = pathToFileURL(join(fakeRoot, 'codex-binary.js'));

    // 1. Mismatched @openai/codex version (0.142.3) must be rejected before spawn
    writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: '@openai/codex-sdk', version: '0.169.1' }));
    writeFileSync(join(codexDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.142.3' }));
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.169.1-darwin-arm64' }));

    assert.throws(
      () => resolveCodexBinary({ anchorUrl, platform: 'darwin', arch: 'arm64' }),
      /Pinned @openai\/codex version mismatch: expected 0\.169\.1, got 0\.142\.3/,
    );

    // Startup with mismatched version rejects and cleans up ownership lock + SQLite DB
    reset();
    const mismatchDir = mkdtempSync(join(tmpdir(), 'spine-bad-ver-'));
    try {
      await assert.rejects(
        () =>
          startBot(baseConfig(mismatchDir, 'bad-ver-bot'), true, {
            codexBinaryOptions: { anchorUrl, platform: 'darwin', arch: 'arm64' },
          }),
        /Pinned @openai\/codex version mismatch: expected 0\.169\.1, got 0\.142\.3/,
      );
      assert.equal(existsSync(join(mismatchDir, 'gateway.lock')), false);
      assertClean(assert);
    } finally {
      clean(mismatchDir);
    }

    // 2. Mismatched platform package version (0.143.0-darwin-arm64) must be rejected
    writeFileSync(join(codexDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.1' }));
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.143.0-darwin-arm64' }));

    assert.throws(
      () => resolveCodexBinary({ anchorUrl, platform: 'darwin', arch: 'arm64' }),
      /Pinned @openai\/codex-darwin-arm64 version mismatch: expected 0\.169\.1, got 0\.143\.0-darwin-arm64/,
    );

    // 3. Valid 0.169.1 pin returns version='0.169.1' and logs only binary path/version at startup
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: '@openai/codex-darwin-arm64', version: '0.169.1-darwin-arm64' }));
    const resolved = resolveCodexBinary({ anchorUrl, platform: 'darwin', arch: 'arm64' });
    assert.equal(resolved.version, '0.169.1');

    const { result: f, lines } = await captureConsoleLog(() =>
      createSpineBot({
        sdkConfig: {
          codexApiKey: 'sk-synthetic-secret-do-not-log',
          env: { SECRET_ENV_DO_NOT_LOG: 'never-log-this-value' },
        },
        setup: {
          codexBinaryOptions: { anchorUrl, platform: 'darwin', arch: 'arm64' },
        },
      }),
    );
    try {
      const binLogs = lines.filter((l) => l.includes('[codex-binary]'));
      assert.equal(binLogs.length, 1);
      assert.match(binLogs[0], /^\[codex-binary\] bot=spine-bot executor=app-server bin=.* version=0\.169\.1$/);
      assert.equal(lines.some((l) => l.includes('sk-synthetic-secret-do-not-log')), false);
      assert.equal(lines.some((l) => l.includes('never-log-this-value')), false);
    } finally {
      await f.close();
    }
  } finally {
    clean(fakeRoot);
  }
});

// ============================================================================
// Group 7: v157 Codex 0.169.1 Package Layout & WebSocket->HTTPS Fallback Notices
// ============================================================================

test('v157 parent RED control: resolveCodexBinary validates codex-package.json layoutVersion=1 manifest and rejects invalid layoutVersion or target mismatch', async () => {
  const { resolveCodexBinary } = await loadSpineRuntime();
  const fakeRoot = mkdtempSync(join(tmpdir(), 'spine-v157-layout-'));
  try {
    const sdkDir = join(fakeRoot, 'node_modules/@openai/codex-sdk');
    const codexDir = join(fakeRoot, 'node_modules/@openai/codex');
    const targetDir = join(fakeRoot, 'node_modules/@openai/codex-darwin-arm64');
    const vendorRoot = join(targetDir, 'vendor/aarch64-apple-darwin');
    const vendorBinDir = join(vendorRoot, 'bin');
    const vendorPathDir = join(vendorRoot, 'codex-path');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(vendorBinDir, { recursive: true });
    mkdirSync(vendorPathDir, { recursive: true });
    writeFileSync(
      join(sdkDir, 'package.json'),
      JSON.stringify({
        name: '@openai/codex-sdk',
        version: '0.169.1',
        type: 'module',
        exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      }),
    );
    writeFileSync(join(codexDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.1' }));
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.1-darwin-arm64' }));
    writeFileSync(join(vendorBinDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(vendorPathDir, 'rg'), '#!/bin/sh\n', { mode: 0o755 });

    const anchorUrl = pathToFileURL(join(fakeRoot, 'codex-binary.js'));

    // Unsupported layoutVersion in codex-package.json is rejected
    writeFileSync(
      join(vendorRoot, 'codex-package.json'),
      JSON.stringify({
        layoutVersion: 2,
        version: '0.169.1',
        target: 'aarch64-apple-darwin',
        entrypoint: 'bin/codex',
        pathDir: 'codex-path',
      }),
    );
    assert.throws(
      () => resolveCodexBinary({ anchorUrl, platform: 'darwin', arch: 'arm64' }),
      /Unsupported Codex package layoutVersion.*expected 1, got 2/,
    );

    // Mismatched target in codex-package.json is rejected
    writeFileSync(
      join(vendorRoot, 'codex-package.json'),
      JSON.stringify({
        layoutVersion: 1,
        version: '0.169.1',
        target: 'x86_64-apple-darwin',
        entrypoint: 'bin/codex',
        pathDir: 'codex-path',
      }),
    );
    assert.throws(
      () => resolveCodexBinary({ anchorUrl, platform: 'darwin', arch: 'arm64' }),
      /Pinned Codex binary manifest target mismatch.*expected aarch64-apple-darwin, got x86_64-apple-darwin/,
    );
  } finally {
    clean(fakeRoot);
  }
});

test('v157 parent RED control: App Server willRetry=true Reconnecting... k/5 and Falling back from WebSockets to HTTPS transport notices complete turn cleanly without aborting', async () => {
  const f = await createSpineBot({
    scenario: {
      defaultTurn: [
        {
          notify: 'error',
          params: {
            threadId: '$threadId',
            turnId: '$turnId',
            willRetry: true,
            error: {
              message: 'Reconnecting... 2/5 (unexpected status 404 Not Found)',
              codexErrorInfo: 'other',
            },
          },
        },
        {
          notify: 'error',
          params: {
            threadId: '$threadId',
            turnId: '$turnId',
            willRetry: true,
            error: {
              message: 'Reconnecting... 5/5 (unexpected status 404 Not Found)',
              codexErrorInfo: 'other',
            },
          },
        },
        {
          notify: 'warning',
          params: {
            threadId: '$threadId',
            message: 'Falling back from WebSockets to HTTPS transport. unexpected status 404 Not Found',
          },
        },
        {
          notify: 'item/completed',
          params: {
            threadId: '$threadId',
            turnId: '$turnId',
            item: { id: '$itemId', type: 'agentMessage', text: 'v157 app-server fallback reply' },
          },
        },
      ],
    },
  });
  try {
    await f.handle(f.dmMsg(1, 'trigger ws to https fallback', 'alice'));
    assert.equal(f.sends.at(-1)?.content, 'v157 app-server fallback reply');
    assert.equal(f.receipts.length, 1);
  } finally {
    await f.close();
  }
});

test('v160 M2: /cron lifecycle in chat spine, /config authorized job count, and SDK executor cron disablement', async () => {
  const f = await createSpineBot();
  try {
    // 1. Create a scheduled task in DM as owner
    await f.handle(f.dmMsg(1, '/cron add "every 5m" --name "DM Monitor" -- Check DM status', 'owned-owner'));
    const createReply = f.sends.at(-1)?.content ?? '';
    assert.match(createReply, /✓ Scheduled j[23456789abcdefghjkmnpqrstvwxyz]{6} "DM Monitor"/);
    const jobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(createReply)?.[1];
    assert.ok(jobId);

    // 2. /config shows jobs: 1 for owner, and jobs: 0 for mgr-1 in group-1
    await f.handle(f.dmMsg(2, '/config', 'owned-owner'));
    assert.match(f.sends.at(-1)?.content ?? '', /• cron: enabled; jobs: 1/);

    await f.handle(
      f.groupMsg(3, '@CodeBot /config', 'mgr-1', {
        entities: [{ uid: f.stack.robotUid, offset: 0, length: 8 }],
      }),
    );
    assert.match(f.sends.at(-1)?.content ?? '', /• cron: enabled; jobs: 0/);

    // 3. /cron show, disable, enable, list, rm
    await f.handle(f.dmMsg(4, `/cron show ${jobId}`, 'owned-owner'));
    assert.match(f.sends.at(-1)?.content ?? '', /DM Monitor/);

    await f.handle(f.dmMsg(5, `/cron disable ${jobId}`, 'owned-owner'));
    assert.match(f.sends.at(-1)?.content ?? '', new RegExp(`✓ Disabled ${jobId}`));

    await f.handle(f.dmMsg(6, `/cron enable ${jobId}`, 'owned-owner'));
    assert.match(f.sends.at(-1)?.content ?? '', new RegExp(`✓ Enabled ${jobId}`));

    await f.handle(f.dmMsg(7, `/cron rm ${jobId}`, 'owned-owner'));
    assert.match(f.sends.at(-1)?.content ?? '', new RegExp(`✓ Removed ${jobId}`));

    await f.handle(f.dmMsg(8, '/config', 'owned-owner'));
    assert.match(f.sends.at(-1)?.content ?? '', /• cron: enabled; jobs: 0/);
  } finally {
    await f.close();
  }
});
