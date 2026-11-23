// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeOctoServer } from '../foundation/lib/fake-octo.mjs';
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
  const job1Def = h.store.definition({ targetSession: 'g-1' }, job1Id);
  assert.equal(job1Def.target.sessionKey, 'g-1');
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
  const toolJobRow = h.store.get({ targetSession: 'g-2' }, toolJobId);
  assert.equal(toolJobRow?.creator_uid, 'mgr-cron-1');
  assert.equal(toolJobRow?.target_session, 'g-2');
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

  // Verify ContextNote was published under canonical group sessionKey ('eng') and can be consumed by SessionTurnState
  const gen = h.persistence.generation('eng');
  const turnState = h.persistence.capture('eng', gen, () => {});
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
  const runsAfterNoReply = h.store.listRuns({ targetSession: 'eng' }, isoJobId, { limit: 5 });
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

function runCliChild(nodeArgs, envOverrides = {}, timeoutMs = 15_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, nodeArgs, {
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(
        new Error(
          `CLI child timed out after ${timeoutMs}ms: ${nodeArgs.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`,
        ),
      );
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

test('M2 process-level compiled CLI start: symlink entrypoint, failure propagation, persistent host, second-process exclusion, authenticated CLI control, autonomous due execution/history without chat, and SIGTERM cleanup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'x-buddy-cli-start-proc-'));
  const realCliPath = fileURLToPath(new URL('../../dist/cron/cli.js', import.meta.url));
  const symlinkDir = join(root, 'symlink-bin');
  mkdirSync(symlinkDir, { recursive: true });
  const symlinkCliPath = join(symlinkDir, 'codex-channel-octo');
  symlinkSync(realCliPath, symlinkCliPath);

  const octo = new FakeOctoServer().addBot({
    botToken: 'bf_proc_test',
    robotId: 'u_proc_bot',
    ownerUid: 'u_proc_owner',
    ownerChannelId: 'u_proc_owner',
  });
  let hostProc = null;

  t.after(async () => {
    if (hostProc && hostProc.exitCode === null && hostProc.signalCode === null) {
      hostProc.kill('SIGKILL');
      await new Promise((r) => hostProc.once('close', r));
    }
    await octo.stop().catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  // 1. Failure propagation: missing config must fail closed with non-zero exit code (not exit 0)
  const emptyHome = join(root, 'empty-home');
  mkdirSync(emptyHome, { recursive: true });
  const failedStart = await runCliChild([symlinkCliPath, 'start'], {
    HOME: emptyHome,
    CODEX_OCTO_CONFIG: '',
  });
  assert.equal(failedStart.code, 1, `Expected exit code 1 on missing config, got ${failedStart.code}`);
  assert.match(failedStart.stderr, /Missing required config: apiUrl/);

  // 2. Start fake loopback Octo server so host runs completely offline
  await octo.start();

  const homeDir = join(root, 'home');
  const baseCfgDir = join(homeDir, '.codex-channel-octo');
  const botId = 'proc-bot';
  const botDir = join(baseCfgDir, botId);
  const botDataDir = join(botDir, 'data');
  const botWorkspaceDir = join(botDir, 'workspace');
  const botCodexHomeDir = join(botDir, 'codex-home');
  mkdirSync(botDataDir, { recursive: true, mode: 0o700 });
  chmodSync(botDataDir, 0o700);
  mkdirSync(botWorkspaceDir, { recursive: true, mode: 0o700 });
  chmodSync(botWorkspaceDir, 0o700);
  mkdirSync(botCodexHomeDir, { recursive: true, mode: 0o700 });
  chmodSync(botCodexHomeDir, 0o700);

  const globalConfigPath = join(baseCfgDir, 'config.json');
  writeFileSync(
    globalConfigPath,
    JSON.stringify(
      {
        apiUrl: octo.apiUrl,
        bots: [{ id: botId }],
        cron: {
          enabled: true,
          defaultTimezone: 'Asia/Shanghai',
          minIntervalMs: 1_000,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(botDir, 'config.json'),
    JSON.stringify(
      {
        botToken: 'bf_proc_test',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // 3. Offline CLI add before host starts (local-only without --channel/--session)
  const offlineAdd = await runCliChild(
    [
      symlinkCliPath,
      'cron',
      '--bot',
      botId,
      'remind',
      'in 1s',
      '--delivery',
      'none',
      '--name',
      'Offline Created Local Task',
      '--',
      'Offline created autonomous task',
    ],
    {
      HOME: homeDir,
      CODEX_OCTO_CONFIG: globalConfigPath,
    },
  );
  assert.equal(offlineAdd.code, 0, `Offline add failed: ${offlineAdd.stderr}`);
  const offlineJobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(offlineAdd.stdout)?.[1];
  assert.ok(offlineJobId, `Expected offline job id in: ${offlineAdd.stdout}`);

  // 4. Spawn compiled `node dist/cron/cli.js start` via symlink and verify persistent host + control.sock
  const childEnv = {
    ...process.env,
    HOME: homeDir,
    CODEX_OCTO_CONFIG: globalConfigPath,
  };
  hostProc = spawn(process.execPath, [symlinkCliPath, 'start'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hostStdout = '';
  let hostStderr = '';
  hostProc.stdout.setEncoding('utf8');
  hostProc.stderr.setEncoding('utf8');
  hostProc.stdout.on('data', (chunk) => {
    hostStdout += chunk;
  });
  hostProc.stderr.on('data', (chunk) => {
    hostStderr += chunk;
  });

  const sockPath = join(botDataDir, 'control.sock');
  const statusJsonPath = join(botDataDir, 'status.json');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (hostProc.exitCode !== null) {
      assert.fail(
        `Host process exited prematurely with code ${hostProc.exitCode}\nstdout=${hostStdout}\nstderr=${hostStderr}`,
      );
    }
    if (existsSync(sockPath) && existsSync(statusJsonPath) && hostStdout.includes('Ready — 1 bot(s) running')) {
      break;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(hostProc.exitCode, null, 'Host process must remain running as a persistent daemon');
  assert.ok(existsSync(sockPath), 'control.sock must be created by running host');
  assert.equal(statSync(sockPath).mode & 0o777, 0o600, 'control.sock must have 0600 permissions');
  assert.ok(existsSync(statusJsonPath), 'status.json must be created by running host');
  assert.equal(octo.sessions().filter((s) => s.authenticated && s.open).length, 1);

  const initialStatusOnDisk = JSON.parse(readFileSync(statusJsonPath, 'utf8'));
  assert.equal(initialStatusOnDisk.schemaVersion, 2);
  assert.equal(initialStatusOnDisk.state, 'running');
  assert.equal(initialStatusOnDisk.pid, hostProc.pid);

  // 5. Second `node dist/cron/cli.js start` against same dataDir must fail closed without creating duplicate consumer
  const duplicateStart = await runCliChild([symlinkCliPath, 'start'], childEnv);
  assert.equal(duplicateStart.code, 1, 'Duplicate host start must exit with code 1');
  assert.match(duplicateStart.stderr, /Child lifecycle refused|LOCK_HELD|Startup ownership conflict/);
  assert.equal(hostProc.exitCode, null, 'Primary host process must stay alive after duplicate start rejection');
  assert.equal(octo.sessions().filter((s) => s.authenticated && s.open).length, 1);

  // 6. Live CLI `status --json` over authenticated control.sock
  const liveStatus = await runCliChild([symlinkCliPath, 'status', '--bot', botId, '--json'], childEnv);
  assert.equal(liveStatus.code, 0, `status command failed: ${liveStatus.stderr}`);
  const liveStatusPayload = JSON.parse(liveStatus.stdout);
  assert.equal(liveStatusPayload.schemaVersion, 2);
  assert.equal(liveStatusPayload.state, 'running');
  assert.equal(liveStatusPayload.botId, botId);

  // 7. Live CLI `cron remind` over control.sock without --channel/--session (local-only autonomous task)
  const liveAdd = await runCliChild(
    [
      symlinkCliPath,
      'cron',
      '--bot',
      botId,
      'remind',
      'in 1s',
      '--keep',
      '--delivery',
      'none',
      '--name',
      'Live Socket Local Task',
      '--',
      'Live socket autonomous task',
    ],
    childEnv,
  );
  assert.equal(liveAdd.code, 0, `Live add failed: ${liveAdd.stderr}`);
  const liveJobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(liveAdd.stdout)?.[1];
  assert.ok(liveJobId, `Expected live job id in: ${liveAdd.stdout}`);

  // 8. Wait for both offline-created and live-created local-only tasks to execute autonomously without any chat turn
  let offlineRunSucceeded = false;
  let liveRunSucceeded = false;
  const execDeadline = Date.now() + 12_000;
  while (Date.now() < execDeadline && (!offlineRunSucceeded || !liveRunSucceeded)) {
    const [offlineRunsRes, liveRunsRes] = await Promise.all([
      runCliChild([symlinkCliPath, 'cron', '--bot', botId, 'runs', offlineJobId], childEnv),
      runCliChild([symlinkCliPath, 'cron', '--bot', botId, 'runs', liveJobId], childEnv),
    ]);
    if (offlineRunsRes.code === 0 && /\bok\/succeeded\b/.test(offlineRunsRes.stdout)) {
      offlineRunSucceeded = true;
    }
    if (liveRunsRes.code === 0 && /\bok\/succeeded\b/.test(liveRunsRes.stdout)) {
      liveRunSucceeded = true;
    }
    if (!offlineRunSucceeded || !liveRunSucceeded) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  assert.ok(offlineRunSucceeded, 'Offline-created local-only task must execute autonomously to ok/succeeded');
  assert.ok(liveRunSucceeded, 'Live-created local-only task must execute autonomously to ok/succeeded');
  assert.equal(octo.requests('sendMessage').length, 0, 'delivery=none tasks must not emit any external message');

  const showLiveJob = await runCliChild([symlinkCliPath, 'cron', '--bot', botId, 'show', liveJobId], childEnv);
  assert.equal(showLiveJob.code, 0, `show command failed: ${showLiveJob.stdout}\n${showLiveJob.stderr}`);
  assert.match(showLiveJob.stdout, /last outcome: ok\/succeeded/);
  assert.match(showLiveJob.stdout, /delivery: none/);

  // 9. SIGTERM clean shutdown: exit 0, remove control.sock, mark status.json stopped
  const exitPromise = new Promise((resolvePromise) => {
    hostProc.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
  hostProc.kill('SIGTERM');
  const exitResult = await exitPromise;
  assert.equal(exitResult.code, 0, `Expected clean exit 0 on SIGTERM, got code=${exitResult.code} signal=${exitResult.signal}`);
  assert.equal(existsSync(sockPath), false, 'control.sock must be removed on SIGTERM shutdown');
  const stoppedStatus = JSON.parse(readFileSync(statusJsonPath, 'utf8'));
  assert.equal(stoppedStatus.state, 'stopped');
});

test('D1 regression: canonical group sessionKey across CLI/ControlSocket/CronService, startup migration of legacy group:<id> state, and ContextNotes consumption + /reset fencing', async (t) => {
  const h = await createCronHarness(t);
  const groupChannelId = 'f9e2c73f36a04308921387dce85f291d';

  // 1. CLI --channel <id> --channel-type 2 and --session group:<id> both canonicalize target_session to raw <id>
  const out = [];
  const err = [];
  const controlServer = new CronControlServer({
    dataDir: h.dataDir,
    service: h.service,
    scheduler: h.scheduler,
    getOwnerUid: () => 'owner-1',
  });
  await controlServer.start();
  t.after(async () => {
    await controlServer.close();
  });

  const code1 = await runCronSubcommand(
    [
      '--data-dir',
      h.dataDir,
      '--bot',
      h.botId,
      '--channel',
      groupChannelId,
      '--channel-type',
      '2',
      'add',
      'every 5m',
      '--name',
      'Canonical Group CLI Job',
      '--',
      'Summarize group status',
    ],
    { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
  );
  assert.equal(code1, 0, err.join('\n'));
  const job1Id = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(out.at(-1) ?? '')?.[1];
  assert.ok(job1Id);
  const job1 = h.store.get({ allConversations: true }, job1Id);
  assert.equal(job1?.target_session, groupChannelId);
  assert.equal(job1?.target_channel_id, groupChannelId);
  assert.equal(job1?.target_channel_type, 2);

  const code2 = await runCronSubcommand(
    [
      '--data-dir',
      h.dataDir,
      '--bot',
      h.botId,
      '--session',
      `group:${groupChannelId}`,
      'remind',
      'in 5m',
      '--name',
      'Prefixed Group CLI Reminder',
      '--',
      'Group reminder body',
    ],
    { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
  );
  assert.equal(code2, 0, err.join('\n'));
  const job2Id = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(out.at(-1) ?? '')?.[1];
  assert.ok(job2Id);
  const job2 = h.store.get({ allConversations: true }, job2Id);
  assert.equal(job2?.target_session, groupChannelId);
  assert.equal(job2?.target_channel_id, groupChannelId);
  assert.equal(job2?.target_channel_type, 2);

  // 2. Execute isolated job1 and verify ContextNote is published under canonical groupChannelId
  h.scheduler.start();
  h.clock.advance(5 * 60_000);
  h.scheduler.wake();
  for (let i = 0; i < 40 && h.isolatedCalls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));
  const gen0 = h.persistence.generation(groupChannelId);
  const turn0 = h.persistence.capture(groupChannelId, gen0, () => {});
  const notes0 = turn0.pendingContextNotes(5, 4096);
  assert.equal(notes0.length, 1);
  assert.match(notes0[0].text, /Isolated reply for/);
  turn0.consumeContextNotes(
    notes0.map((n) => n.id),
    'group-thread-1',
    'group-turn-1',
  );
  assert.equal(turn0.pendingContextNotes(5, 4096).length, 0);

  // 3. Simulate legacy persisted DB state with `group:<channelId>` rows across cron_jobs, sessions, session_generations, messages, and context_notes
  await controlServer.close();
  await h.stopLive();

  const legacyChan = 'legacy_grp_chan_42';
  const legacyKey = `group:${legacyChan}`;
  const rawDb = createAdapter(join(h.dataDir, 'cc-octo.db'));
  const now = Date.now();
  rawDb
    .prepare(
      'INSERT INTO sessions (id, channel_type, channel_id, created_at, updated_at) VALUES (?, 2, ?, ?, ?)',
    )
    .run(legacyKey, legacyChan, now - 10_000, now - 5_000);
  rawDb
    .prepare(
      'INSERT INTO session_generations (session_id, generation, updated_at) VALUES (?, 2, ?)',
    )
    .run(legacyKey, now - 5_000);
  rawDb
    .prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'legacy cron msg', ?)",
    )
    .run(legacyKey, now - 1_000);
  rawDb
    .prepare(
      "INSERT INTO context_notes (session_id, run_id, generation, kind, text, created_at, consumed_at) VALUES (?, 'r_legacy_note_1', 2, 'cron_result', 'Legacy group cron output', ?, NULL)",
    )
    .run(legacyKey, now - 1_000);
  rawDb
    .prepare('UPDATE cron_jobs SET target_session = ?, target_channel_id = ?, target_channel_type = 2 WHERE id = ?')
    .run(legacyKey, legacyChan, job1Id);
  rawDb.close();

  // Re-open through initializeSessionState and verify migration to canonical `legacyChan`
  const ownership2 = await BotStartupOwnership.acquire(h.dataDir, h.botId);
  const adapter2 = createAdapter(join(h.dataDir, 'cc-octo.db'));
  const sessionStore2 = new SessionStore(adapter2);
  const initialized2 = await initializeSessionState(
    ownership2,
    h.dataDir,
    h.botId,
    adapter2,
    sessionStore2,
    () => null,
  );
  try {
    const migratedJob = adapter2
      .prepare('SELECT target_session, target_channel_id FROM cron_jobs WHERE id = ?')
      .get(job1Id);
    assert.equal(migratedJob.target_session, legacyChan);
    assert.equal(migratedJob.target_channel_id, legacyChan);

    const genMigrated = initialized2.state.generation(legacyChan);
    assert.equal(genMigrated, 2);
    const turnMigrated = initialized2.state.capture(legacyChan, genMigrated, () => {});
    const migratedNotes = turnMigrated.pendingContextNotes(5, 4096);
    assert.equal(migratedNotes.length, 1);
    assert.match(migratedNotes[0].text, /Legacy group cron output/);

    // Verify `/reset` bumps generation and fences unconsumed ContextNotes from subsequent turns
    const nextGen = initialized2.state.reset(legacyChan, genMigrated, 1, () => {});
    assert.equal(nextGen, 3);
    const turnAfterReset = initialized2.state.capture(legacyChan, nextGen, () => {});
    assert.equal(turnAfterReset.pendingContextNotes(5, 4096).length, 0);
  } finally {
    initialized2.state.endIncarnation();
    sessionStore2.close();
    ownership2.release();
  }
});

test('D2 regression: one-shot at job with --keep that times out reserves +30s retry, survives intermediate ticks without schedule_error_count increment or schedule-errors auto-disable, and executes retry attempt 1 at +30s', async (t) => {
  const h = await createCronHarness(t);
  const caller = {
    senderUid: 'owner-1',
    isOwner: true,
    isCronManager: true,
    isGroup: true,
    sessionKey: 'f9e2c73f36a04308921387dce85f291d',
    channelId: 'f9e2c73f36a04308921387dce85f291d',
    channelType: 2,
  };

  let callCount = 0;
  h.setIsolatedHandler(async (input) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        kind: 'error',
        reason: 'timeout',
        error: 'Turn exceeded 5000ms ceiling (timeout)',
      };
    }
    return {
      kind: 'ok',
      text: `Recovered on retry attempt ${input.run.attempt}`,
      threadId: 'th-retry-ok',
      turnId: 'tu-retry-ok',
    };
  });

  const addRes = await h.service.executeSlashCommand(
    'add "in 10s" --keep --timeout 30 --name "QA Retry At Job" -- Run slow check',
    caller,
  );
  assert.equal(addRes.isError, false, addRes.reply);
  const jobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(addRes.reply)?.[1];
  assert.ok(jobId);

  h.scheduler.start();
  // Fire attempt 0 at +10s -> fails with timeout -> reserves retry attempt 1 at +30s
  h.clock.advance(10_000);
  h.scheduler.wake();
  for (let i = 0; i < 40 && callCount < 1; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));

  const jobAfterFail = h.store.get({ allConversations: true }, jobId);
  assert.equal(jobAfterFail?.enabled, 1);
  assert.equal(jobAfterFail?.schedule_error_count, 0);
  assert.equal(jobAfterFail?.auto_disabled_reason, null);
  assert.equal(jobAfterFail?.consecutive_errors, 1);

  const runsAfterFail = h.store.listRuns({ allConversations: true }, jobId, { limit: 10 });
  assert.equal(runsAfterFail.length, 2);
  assert.equal(runsAfterFail[0]?.attempt, 1);
  assert.equal(runsAfterFail[0]?.trigger, 'retry');
  assert.equal(runsAfterFail[0]?.status, 'queued');
  assert.equal(runsAfterFail[1]?.attempt, 0);
  assert.equal(runsAfterFail[1]?.status, 'error');
  assert.equal(runsAfterFail[1]?.reason, 'timeout');

  // Advance to +30s (retry ready_at) and wake multiple times to ensure no admitBase StoreConflict / schedule_error_count increment
  h.clock.advance(30_000);
  h.scheduler.wake();
  h.scheduler.wake();
  h.scheduler.wake();
  for (let i = 0; i < 40 && callCount < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(callCount, 2, 'Retry attempt 1 must execute at +30s');
  const jobAfterRetry = h.store.get({ allConversations: true }, jobId);
  assert.equal(jobAfterRetry?.schedule_error_count, 0, 'schedule_error_count must stay 0');
  assert.equal(jobAfterRetry?.auto_disabled_reason, null, 'auto_disabled_reason must stay null');
  assert.equal(jobAfterRetry?.enabled, 0, 'One-shot --keep job disables cleanly after terminal success');
  assert.equal(jobAfterRetry?.consecutive_errors, 0);

  const finalRuns = h.store.listRuns({ allConversations: true }, jobId, { limit: 10 });
  assert.equal(finalRuns.length, 2);
  assert.equal(finalRuns[0]?.attempt, 1);
  assert.equal(finalRuns[0]?.trigger, 'retry');
  assert.equal(finalRuns[0]?.status, 'ok');
  assert.equal(finalRuns[0]?.completion, 'succeeded');
});

test('D3 & D4 process-level regressions: compiled cli.js cron --help/-h side-effect-free exit 0 and host SIGKILL + immediate child stdio-EOF exit recovery with running cron run interrupted(restart)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'x-buddy-d3-d4-proc-'));
  const realCliPath = fileURLToPath(new URL('../../dist/cron/cli.js', import.meta.url));
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // 1. D4: `node dist/cron/cli.js cron --help` and `-h` without config/dataDir exit 0 with usage on stdout and zero side effects
  const nonexistentDataDir = join(root, 'should-not-be-created');
  for (const args of [
    [realCliPath, 'cron', '--help', '--data-dir', nonexistentDataDir],
    [realCliPath, 'cron', '-h', '--data-dir', nonexistentDataDir],
    [realCliPath, 'status', '--help', '--data-dir', nonexistentDataDir],
    [realCliPath, '--help'],
  ]) {
    const res = await runCliChild(args, {
      HOME: join(root, 'empty-home'),
      CODEX_OCTO_CONFIG: '',
    });
    assert.equal(res.code, 0, `Expected exit 0 for ${args.join(' ')}, got ${res.code} (stderr=${res.stderr})`);
    assert.match(res.stdout, /Usage:/);
    assert.equal(res.stderr, '');
    assert.equal(existsSync(nonexistentDataDir), false, '--help must not create dataDir or open SQLite DB');
  }

  // 2. D3: Host SIGKILL while real owned codex app-server child is executing an agentTurn cron run ->
  // child exits immediately on stdio EOF before replacement host2 starts -> replacement host2 reconciles
  // previous child via spawn-time native kqueue exit record and marks the interrupted cron run interrupted/restart.
  const octo = new FakeOctoServer().addBot({
    botToken: 'bf_d3_test',
    robotId: 'u_d3_bot',
    ownerUid: 'u_d3_owner',
    ownerChannelId: 'u_d3_owner',
  });
  await octo.start();

  const loopbackHost = ['127', '0', '0', '1'].join('.');
  const hangingSockets = new Set();
  const hangingModelServer = createHttpServer(() => {
    // Hold model request open so the cron agentTurn stays in 'running' state while host1 receives SIGKILL
  });
  hangingModelServer.on('connection', (sock) => {
    hangingSockets.add(sock);
    sock.on('close', () => hangingSockets.delete(sock));
  });
  await new Promise((resolvePromise) => hangingModelServer.listen(0, loopbackHost, resolvePromise));
  const modelPort = hangingModelServer.address().port;

  let host1 = null;
  let host2 = null;
  t.after(async () => {
    for (const proc of [host1, host2]) {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await new Promise((r) => proc.once('close', r));
      }
    }
    for (const sock of hangingSockets) {
      sock.destroy();
    }
    await new Promise((r) => hangingModelServer.close(() => r()));
    await octo.stop().catch(() => {});
  });

  const homeDir = join(root, 'home');
  const baseCfgDir = join(homeDir, '.codex-channel-octo');
  const botId = 'd3-bot';
  const botDir = join(baseCfgDir, botId);
  const botDataDir = join(botDir, 'data');
  const botWorkspaceDir = join(botDir, 'workspace');
  const botCodexHomeDir = join(botDir, 'codex-home');
  mkdirSync(botDataDir, { recursive: true, mode: 0o700 });
  chmodSync(botDataDir, 0o700);
  mkdirSync(botWorkspaceDir, { recursive: true, mode: 0o700 });
  chmodSync(botWorkspaceDir, 0o700);
  mkdirSync(botCodexHomeDir, { recursive: true, mode: 0o700 });
  chmodSync(botCodexHomeDir, 0o700);

  const globalConfigPath = join(baseCfgDir, 'config.json');
  writeFileSync(
    globalConfigPath,
    JSON.stringify(
      {
        apiUrl: octo.apiUrl,
        bots: [{ id: botId }],
        sdk: {
          codexBaseUrl: `http://${loopbackHost}:${modelPort}/v1`,
          codexApiKey: 'test-local-d3-token',
        },
        cron: {
          enabled: true,
          defaultTimezone: 'Asia/Shanghai',
          minIntervalMs: 1_000,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(botDir, 'config.json'),
    JSON.stringify({ botToken: 'bf_d3_test' }, null, 2),
    { mode: 0o600 },
  );

  const childEnv = {
    ...process.env,
    HOME: homeDir,
    CODEX_OCTO_CONFIG: globalConfigPath,
  };

  host1 = spawn(process.execPath, [realCliPath, 'start'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let host1Out = '';
  let host1Err = '';
  host1.stdout.setEncoding('utf8');
  host1.stderr.setEncoding('utf8');
  host1.stdout.on('data', (c) => {
    host1Out += c;
  });
  host1.stderr.on('data', (c) => {
    host1Err += c;
  });

  const sockPath = join(botDataDir, 'control.sock');
  const deadline1 = Date.now() + 10_000;
  while (Date.now() < deadline1) {
    if (host1.exitCode !== null) {
      assert.fail(`host1 exited early: code=${host1.exitCode}\nstdout=${host1Out}\nstderr=${host1Err}`);
    }
    if (existsSync(sockPath) && host1Out.includes('Ready — 1 bot(s) running')) break;
    await new Promise((r) => setTimeout(r, 40));
  }

  // Verify D4 while bot is running: `cron --help` exits 0 without touching control.sock
  const helpWhileRunning = await runCliChild([realCliPath, 'cron', '--bot', botId, '--help'], childEnv);
  assert.equal(helpWhileRunning.code, 0);
  assert.match(helpWhileRunning.stdout, /Usage:/);

  // Schedule a real isolated agentTurn cron job in 1s so host1 spawns its owned codex app-server child
  const addJobRes = await runCliChild(
    [
      realCliPath,
      'cron',
      '--bot',
      botId,
      '--channel',
      'f9e2c73f36a04308921387dce85f291d',
      '--channel-type',
      '2',
      'add',
      'in 1s',
      '--keep',
      '--delivery',
      'none',
      '--timeout',
      '60',
      '--name',
      'D3 Live Crash Recovery AgentTurn',
      '--',
      'Reply with PONG',
    ],
    childEnv,
  );
  assert.equal(addJobRes.code, 0, addJobRes.stderr);
  const d3JobId = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(addJobRes.stdout)?.[1];
  assert.ok(d3JobId);

  // Wait until host1 has spawned app-server-child.json (state === 'running') AND the cron run is 'running'
  const childRecordPath = join(botDataDir, 'app-server-child.json');
  let runningChildPid = null;
  const runStartDeadline = Date.now() + 12_000;
  while (Date.now() < runStartDeadline) {
    if (existsSync(childRecordPath)) {
      try {
        const rec = JSON.parse(readFileSync(childRecordPath, 'utf8'));
        const runsOut = await runCliChild([realCliPath, 'cron', '--bot', botId, 'runs', d3JobId], childEnv);
        if (rec.state === 'running' && rec.child?.pid && /\brunning\b/.test(runsOut.stdout)) {
          runningChildPid = rec.child.pid;
          break;
        }
      } catch {
        // retry
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!runningChildPid) {
    const runsDbg = await runCliChild([realCliPath, 'cron', '--bot', botId, 'runs', d3JobId], childEnv);
    const childRecDbg = existsSync(childRecordPath) ? readFileSync(childRecordPath, 'utf8') : 'MISSING';
    const dbgDb = createAdapter(join(botDataDir, 'cc-octo.db'));
    const runRowsDbg = dbgDb.prepare('SELECT status, reason, error FROM cron_runs WHERE job_id = ?').all(d3JobId);
    dbgDb.close();
    assert.fail(
      `Expected owned app-server child and running cron_runs row before SIGKILL\nchildRecord=${childRecDbg}\nrunRows=${JSON.stringify(runRowsDbg)}\nruns=${runsDbg.stdout}\nhost1Out=${host1Out}\nhost1Err=${host1Err}`,
    );
  }

  // SIGKILL host1 and wait for the owned child to exit on stdio EOF BEFORE starting host2
  const host1Exit = new Promise((r) => host1.once('close', r));
  host1.kill('SIGKILL');
  await host1Exit;

  const childExitDeadline = Date.now() + 5_000;
  let childGone = false;
  while (Date.now() < childExitDeadline) {
    try {
      process.kill(runningChildPid, 0);
      await new Promise((r) => setTimeout(r, 30));
    } catch (e) {
      if (e.code === 'ESRCH') {
        childGone = true;
        break;
      }
    }
  }
  assert.equal(childGone, true, 'Owned app-server child must exit on stdio EOF before host2 starts');

  // Wait briefly for the spawn-time native kqueue watcher to persist the exited record
  const recordPersistDeadline = Date.now() + 2_000;
  let persistedAfterCrash = null;
  while (Date.now() < recordPersistDeadline) {
    try {
      const rec = JSON.parse(readFileSync(childRecordPath, 'utf8'));
      if (rec.state === 'exited') {
        persistedAfterCrash = rec;
        break;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(persistedAfterCrash?.state, 'exited');
  assert.equal(persistedAfterCrash?.exit?.source, 'kqueue-note-exit');

  // Start replacement host2 and verify it reconciles cleanly and transitions the in-flight run to interrupted/restart
  host2 = spawn(process.execPath, [realCliPath, 'start'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let host2Out = '';
  let host2Err = '';
  host2.stdout.setEncoding('utf8');
  host2.stderr.setEncoding('utf8');
  host2.stdout.on('data', (c) => {
    host2Out += c;
  });
  host2.stderr.on('data', (c) => {
    host2Err += c;
  });

  const deadline2 = Date.now() + 10_000;
  while (Date.now() < deadline2) {
    if (host2.exitCode !== null) {
      assert.fail(`host2 exited early: code=${host2.exitCode}\nstdout=${host2Out}\nstderr=${host2Err}`);
    }
    if (host2Out.includes('Ready — 1 bot(s) running')) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(host2.exitCode, null);

  const runsAfterRestart = await runCliChild([realCliPath, 'cron', '--bot', botId, 'runs', d3JobId], childEnv);
  assert.equal(runsAfterRestart.code, 0, runsAfterRestart.stderr);
  assert.match(runsAfterRestart.stdout, /interrupted\/\S+\s+restart/);

  const host2Exit = new Promise((r) => host2.once('close', r));
  host2.kill('SIGTERM');
  await host2Exit;
});
