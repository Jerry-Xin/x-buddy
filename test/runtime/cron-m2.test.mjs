// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_BUDDY_CRON_TOOL_SPEC,
  CronAdmissionIssuer,
  CronControlServer,
  CronExecutor,
  CronScheduler,
  CronService,
  CronStore,
  deriveDeterministicEgressKey,
  OctoEgress,
  resolveCronConfig,
  runCronSubcommand,
  runDeterministicCronFixture,
  runStatusSubcommand,
  writeBotStatusSnapshot,
} from '../../dist/cron/index.js';
import { assertStartupOwnership, BotStartupOwnership } from '../../dist/runtime/bootstrap.js';
import { initializeSessionState } from '../../dist/runtime/session-state.js';
import { createAdapter } from '../../dist/host/db-adapter.js';
import { SessionStore } from '../../dist/host/session-store.js';

async function createCronHarness(t, configOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'x-buddy-cron-m2-'));
  const dataDir = join(root, 'data');
  const workingDir = join(root, 'workspace');
  const botId = 'cron-bot-1';

  const ownership = await BotStartupOwnership.acquire(dataDir, botId);
  const dbPath = join(dataDir, 'cc-octo.db');
  const adapter = createAdapter(dbPath);
  const sessionStore = new SessionStore(adapter);
  const initialized = await initializeSessionState(
    ownership,
    dataDir,
    botId,
    adapter,
    sessionStore,
    () => null,
  );

  let nowMs = Date.parse('2026-11-23T01:00:00Z');
  const timers = new Map();
  let nextTimerId = 1;
  const clock = {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
    set(ms) {
      nowMs = ms;
    },
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, dueAt: nowMs + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    timersCount() {
      return timers.size;
    },
  };

  let ownerUid = 'owner-1';
  const cronConfig = resolveCronConfig(
    {
      enabled: true,
      managers: ['mgr-cron-1'],
      defaultTimezone: 'Asia/Shanghai',
      maxJobsPerBot: 5,
      maxJobsPerConversation: 3,
      minIntervalMs: 60_000,
      ...configOverrides,
    },
    ['mgr-session-1'],
    true,
  );

  const issuer = new CronAdmissionIssuer(
    {
      botId,
      getOwnerUid: () => ownerUid,
      getRegisteredRobotId: () => botId,
      getIncarnationId: () => ownership.incarnationId,
      assertOwnershipHeld: () => assertStartupOwnership(ownership, dataDir, botId),
      getResetGeneration: (key) => initialized.state.generation(key),
      getRuntimeGeneration: () => 1,
    },
    cronConfig,
    clock,
  );

  const store = new CronStore(adapter, clock, {}, issuer, ownership.restartBinding);

  const wireSends = [];
  let egressFailure = null;
  const egress = new OctoEgress({
    apiUrl: 'https://octo.example.invalid',
    getToken: () => 'tok-test',
    botId: () => botId,
    keyMode: 'deterministic',
    assertLive: () => assertStartupOwnership(ownership, dataDir, botId),
    fetcher: async (url, init) => {
      if (egressFailure) {
        return new Response(JSON.stringify({ code: egressFailure.code ?? 500, msg: egressFailure.msg ?? 'err' }), {
          status: egressFailure.status ?? 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      wireSends.push({ url: String(url), body });
      return new Response(JSON.stringify({ code: 0, data: { message_id: `m-${wireSends.length}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const isolatedCalls = [];
  const sessionCalls = [];
  let isolatedHandler = async (input) => ({
    kind: 'ok',
    text: `Isolated reply for ${input.run.job_id}`,
    threadId: 'th-iso-1',
    turnId: 'tu-iso-1',
    model: input.model ?? 'gpt-5-codex',
  });
  let sessionHandler = async (input) => ({
    kind: 'ok',
    text: `Session reply for ${input.run.job_id}`,
    threadId: 'th-sess-1',
    turnId: 'tu-sess-1',
    model: input.model ?? 'gpt-5-codex',
  });

  const refs = {};
  const service = new CronService(store, cronConfig, issuer, clock, {
    onWake: () => refs.scheduler?.wake(),
    onCancelActiveRun: (jobId, reason) => refs.executor?.cancelJob(jobId, reason),
  });

  const executor = new CronExecutor({
    botId,
    botName: 'CodeBot',
    cwdBase: workingDir,
    store,
    config: cronConfig,
    issuer,
    clock,
    egress,
    getOwnerUid: () => ownerUid,
    executeIsolatedTurn: async (input) => {
      isolatedCalls.push(input);
      return await isolatedHandler(input);
    },
    executeSessionTurn: async (input) => {
      sessionCalls.push(input);
      return await sessionHandler(input);
    },
    onRunFinalized: () => refs.scheduler?.wake(),
  });
  refs.executor = executor;

  const scheduler = new CronScheduler({
    botId,
    dataDir,
    store,
    service,
    executor,
    config: cronConfig,
    issuer,
    clock,
    state: 'enabled',
    getIncarnationId: () => ownership.incarnationId,
  });
  refs.scheduler = scheduler;

  let stoppedLive = false;
  let cleaned = false;
  const stopLive = async () => {
    if (stoppedLive) return;
    stoppedLive = true;
    await scheduler.shutdown();
    initialized.state.endIncarnation();
    sessionStore.close();
    ownership.release();
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopLive();
    rmSync(root, { recursive: true, force: true });
  };
  t.after(cleanup);

  return {
    root,
    dataDir,
    workingDir,
    botId,
    ownership,
    adapter,
    sessionStore,
    persistence: initialized.state,
    clock,
    cronConfig,
    issuer,
    store,
    service,
    executor,
    scheduler,
    wireSends,
    isolatedCalls,
    sessionCalls,
    setIsolatedHandler(fn) {
      isolatedHandler = fn;
    },
    setSessionHandler(fn) {
      sessionHandler = fn;
    },
    setEgressFailure(err) {
      egressFailure = err;
    },
    setOwnerUid(uid) {
      ownerUid = uid;
    },
    stopLive,
    cleanup,
  };
}

test('M2 deterministic fixture, CLI control.sock (0600), offline fallback, and status.json v2', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'x-buddy-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const fixtureDataDir = join(root, 'fixture-bot-data');
  const fixtureRes = await runDeterministicCronFixture({
    dataDir: fixtureDataDir,
    botId: 'staging-bot',
  });
  assert.equal(fixtureRes.botId, 'staging-bot');
  assert.match(fixtureRes.createdJobId, /^j[23456789abcdefghjkmnpqrstvwxyz]{6}$/);
  assert.equal(fixtureRes.deliveredTexts.length, 1);
  assert.match(fixtureRes.deliveredTexts[0], /Verify staging fixture/);
  assert.equal(fixtureRes.statusSnapshot.schemaVersion, 2);
  assert.equal(fixtureRes.statusSnapshot.executor, 'app-server');
  assert.equal(fixtureRes.statusSnapshot.cron.state, 'enabled');
  assert.match(fixtureRes.runsOutput, /ok\/succeeded/);
  assert.equal(statSync(fixtureRes.statusPath).mode & 0o777, 0o600);

  // Test CLI over live control.sock and offline fallback
  const h = await createCronHarness(t);
  const controlServer = new CronControlServer({
    dataDir: h.dataDir,
    service: h.service,
    scheduler: h.scheduler,
    getOwnerUid: () => 'owner-1',
  });
  await controlServer.start();
  assert.equal(statSync(controlServer.socketPath).mode & 0o777, 0o600);

  const cliOut = [];
  const cliErr = [];
  const addCode = await runCronSubcommand(
    [
      '--data-dir',
      h.dataDir,
      '--bot',
      h.botId,
      '--channel',
      'group-1',
      '--channel-type',
      '2',
      'add',
      'every 5m',
      '--name',
      'Live Socket Job',
      '--',
      'Check service health\nand report summary',
    ],
    {
      stdout: (s) => cliOut.push(s),
      stderr: (s) => cliErr.push(s),
    },
  );
  assert.equal(addCode, 0, cliErr.join('\n'));
  assert.match(cliOut.at(-1) ?? '', /✓ Scheduled j[23456789abcdefghjkmnpqrstvwxyz]{6} "Live Socket Job"/);

  writeBotStatusSnapshot(h.dataDir, {
    schemaVersion: 2,
    botId: h.botId,
    pid: process.pid,
    updatedAt: h.clock.now(),
    state: 'running',
    executor: 'app-server',
    cron: h.scheduler.statusSummary(),
  });
  const statusOut = [];
  const statusCode = await runStatusSubcommand(['--data-dir', h.dataDir, '--bot', h.botId, '--json'], {
    stdout: (s) => statusOut.push(s),
    stderr: (s) => cliErr.push(s),
  });
  assert.equal(statusCode, 0);
  const parsedStatus = JSON.parse(statusOut[0]);
  assert.equal(parsedStatus.schemaVersion, 2);
  assert.equal(parsedStatus.cron.jobs, 1);

  // Close control.sock and release live lock (keeping dataDir on disk) to test offline CLI fallback
  await controlServer.close();
  await h.stopLive();

  const offlineOut = [];
  const offlineListCode = await runCronSubcommand(['--data-dir', h.dataDir, '--bot', h.botId, 'list'], {
    stdout: (s) => offlineOut.push(s),
    stderr: (s) => cliErr.push(s),
  });
  assert.equal(offlineListCode, 0);
  assert.match(offlineOut.at(-1) ?? '', /Live Socket Job/);
});

test('M2 parser, validation, quotas, minIntervalMs, secret refusal, and TurnContext-bound agent tool', async (t) => {
  const h = await createCronHarness(t, {
    maxJobsPerConversation: 2,
    maxJobsPerBot: 3,
    minIntervalMs: 60_000,
  });

  const groupCaller = {
    senderUid: 'mgr-cron-1',
    isOwner: false,
    isCronManager: true,
    isGroup: true,
    sessionKey: 'group:g-1',
    channelId: 'g-1',
    channelType: 2,
  };

  // 1. Sub-minute recurring interval rejected; sub-minute one-shot allowed
  const subMinRecurring = await h.service.executeSlashCommand('add "every 10s" -- prompt', groupCaller);
  assert.equal(subMinRecurring.isError, true);
  assert.match(subMinRecurring.reply, /Interval below minimum \(1m\)/);

  const subMinCron = await h.service.executeSlashCommand('add "cron */10 * * * * *" -- prompt', groupCaller);
  assert.equal(subMinCron.isError, true);
  assert.match(subMinCron.reply, /Interval below minimum \(1m\)/);

  // 2. Secret pattern in prompt/name rejected
  const dynamicSecret = 'ghp_' + 'A'.repeat(24);
  const secretAttempt = await h.service.executeSlashCommand(
    `add "every 5m" --name "SecretJob" -- Deploy with token ${dynamicSecret}`,
    groupCaller,
  );
  assert.equal(secretAttempt.isError, true);
  assert.match(secretAttempt.reply, /Prompt looks like it contains a secret/);

  // 3. Smart quotes + multiline `--` prompt preservation + quota enforcement
  const job1Res = await h.service.executeSlashCommand(
    'add “every 5m” --name “Morning Check” --model gpt-5-codex --effort high --timeout 300 -- Line 1 “keep smart quotes in prompt”\nLine 2',
    groupCaller,
  );
  assert.equal(job1Res.isError, false, job1Res.reply);
  const job1Id = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(job1Res.reply)?.[1];
  assert.ok(job1Id);
  const job1Def = h.store.definition({ targetSession: 'group:g-1' }, job1Id);
  assert.equal(job1Def.payload.kind, 'agentTurn');
  assert.equal(job1Def.payload.message, 'Line 1 “keep smart quotes in prompt”\nLine 2');
  assert.equal(job1Def.payload.model, 'gpt-5-codex');
  assert.equal(job1Def.payload.effort, 'high');
  assert.equal(job1Def.payload.timeoutSeconds, 300);

  const job2Res = await h.service.executeSlashCommand('remind "in 10s" -- Short reminder', groupCaller);
  assert.equal(job2Res.isError, false, job2Res.reply);

  // 3rd job in same conversation hits maxJobsPerConversation (2)
  const quotaConv = await h.service.executeSlashCommand('add "every 10m" -- Third job', groupCaller);
  assert.equal(quotaConv.isError, true);
  assert.match(quotaConv.reply, /Quota reached \(2 jobs per conversation\)/);

  // 4. TurnContext-bound agent tool (CODEX_BUDDY_CRON_TOOL_SPEC)
  assert.equal(CODEX_BUDDY_CRON_TOOL_SPEC.name, 'codex_buddy_cron');

  // Unauthorized member rejected
  const memberCtx = {
    incarnationId: h.ownership.incarnationId,
    origin: 'chat',
    principal: { uid: 'member-bob', role: 'member' },
    session: {
      sessionKey: 'group:g-2',
      resetGeneration: 0,
      channelId: 'g-2',
      channelType: 2,
    },
    policy: { tools: 'octo-standard' },
    delivery: { logicalOrigin: 'msg-1' },
  };
  const deniedTool = await h.service.executeToolCall({ action: 'list' }, memberCtx);
  assert.equal(deniedTool.isError, true);
  assert.match(deniedTool.text, /limited to the bot owner or managers/);

  // Recursive cron turn rejected
  const cronOriginCtx = {
    ...memberCtx,
    origin: 'cron',
    principal: { uid: 'owner-1', role: 'cron-creator' },
  };
  const recursiveTool = await h.service.executeToolCall({ action: 'list' }, cronOriginCtx);
  assert.equal(recursiveTool.isError, true);
  assert.match(recursiveTool.text, /disabled inside scheduled task turns/);

  // Authorized manager in group:g-2 creates job via tool; spoofed target fields ignored
  const managerCtx = {
    ...memberCtx,
    principal: { uid: 'mgr-cron-1', role: 'cron-manager' },
  };
  const toolAdd = await h.service.executeToolCall(
    {
      action: 'remind',
      schedule: 'in 5m',
      name: 'Tool Reminder',
      text: 'Ping team from tool',
      // Spoofed properties must be ignored in favor of TurnContext
      callerUid: 'spoofed-user',
      sessionKey: 'group:other',
      channelId: 'other-chan',
    },
    managerCtx,
  );
  assert.equal(toolAdd.isError, false, toolAdd.text);
  const toolJobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(toolAdd.text)?.[1];
  assert.ok(toolJobId);
  const toolJobRow = h.store.get({ targetSession: 'group:g-2' }, toolJobId);
  assert.equal(toolJobRow?.creator_uid, 'mgr-cron-1');
  assert.equal(toolJobRow?.target_session, 'group:g-2');
  assert.equal(toolJobRow?.target_channel_id, 'g-2');
});

test('M2 scheduler & executor: isolated agentTurn, reminder, NO_REPLY suppression, ContextNotes consumption, session mode, and authority revocation', async (t) => {
  const h = await createCronHarness(t);
  const ownerCaller = {
    senderUid: 'owner-1',
    isOwner: true,
    isCronManager: true,
    isGroup: true,
    sessionKey: 'group:eng',
    channelId: 'eng',
    channelType: 2,
  };

  // 1. Create an isolated agentTurn job
  const addIso = await h.service.executeSlashCommand(
    'add "every 1m" --name "Build Watcher" --model o4-mini --effort medium --timeout 120 -- Check CI status',
    ownerCaller,
  );
  const isoJobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(addIso.reply)?.[1];
  assert.ok(isoJobId);

  h.scheduler.start();
  h.clock.advance(60_000);
  h.scheduler.wake();
  for (let i = 0; i < 40 && h.wireSends.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(h.isolatedCalls.length, 1);
  const isoCall = h.isolatedCalls[0];
  assert.equal(isoCall.model, 'o4-mini');
  assert.equal(isoCall.effort, 'medium');
  assert.equal(isoCall.timeoutMs, 120_000);
  assert.match(isoCall.prompt, /\[scheduled task j[23456789abcdefghjkmnpqrstvwxyz]{6} "Build Watcher"\]/);
  assert.match(isoCall.prompt, /\[Unattended scheduled execution/);
  assert.ok(isoCall.cwd.endsWith(`cron-${isoJobId}`));
  assert.equal(existsSync(isoCall.cwd), true);
  assert.equal(lstatSync(isoCall.cwd).isSymbolicLink(), false);

  assert.equal(h.wireSends.length, 1);
  const expectedKey = deriveDeterministicEgressKey({
    botId: h.botId,
    channelType: 2,
    channelId: 'eng',
    kind: 'cron.result',
    originId: isoCall.run.run_id,
    ordinal: 0,
    segmentIndex: 0,
    revision: 0,
  });
  assert.equal(h.wireSends[0].body.client_msg_no, expectedKey);

  // Verify ContextNote was published and can be consumed by SessionTurnState
  const gen = h.persistence.generation('group:eng');
  const turnState = h.persistence.capture('group:eng', gen, () => {});
  const pendingNotes = turnState.pendingContextNotes(5, 4096);
  assert.equal(pendingNotes.length, 1);
  assert.match(pendingNotes[0].text, /Isolated reply for/);
  turnState.consumeContextNotes(
    pendingNotes.map((n) => n.id),
    'chat-thread-1',
    'chat-turn-1',
  );
  assert.equal(turnState.pendingContextNotes(5, 4096).length, 0);

  // 2. NO_REPLY silent suppression
  h.setIsolatedHandler(async () => ({
    kind: 'ok',
    text: 'NO_REPLY',
    threadId: 'th-iso-2',
    turnId: 'tu-iso-2',
  }));
  h.clock.advance(60_000);
  h.scheduler.wake();
  for (let i = 0; i < 40 && h.isolatedCalls.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.wireSends.length, 1); // No new message sent for NO_REPLY
  const runsAfterNoReply = h.store.listRuns({ targetSession: 'group:eng' }, isoJobId, { limit: 5 });
  const latestRun = runsAfterNoReply[0];
  assert.equal(latestRun.status, 'ok');
  assert.equal(latestRun.delivery_state, 'suppressed');
  assert.equal(latestRun.history_state, 'skipped_suppressed');

  // 3. Authority revocation at execution start -> skipped(authority_revoked)
  const mgrCaller = {
    ...ownerCaller,
    senderUid: 'mgr-cron-1',
    isOwner: false,
  };
  const addMgrJob = await h.service.executeSlashCommand('remind "in 1m" -- Manager reminder', mgrCaller);
  const mgrJobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(addMgrJob.reply)?.[1];
  assert.ok(mgrJobId);

  // Revoke mgr-cron-1 before fire by changing owner and removing from managers
  h.cronConfig.managers.splice(0, h.cronConfig.managers.length);
  h.clock.advance(60_000);
  h.scheduler.wake();
  await new Promise((r) => setTimeout(r, 40));
  const mgrRuns = h.store.listRuns({ allConversations: true }, mgrJobId, { limit: 5 });
  assert.equal(mgrRuns[0]?.status, 'skipped');
  assert.equal(mgrRuns[0]?.reason, 'authority_revoked');
});
