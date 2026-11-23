// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertStartupOwnership, BotStartupOwnership } from '../runtime/bootstrap.js';
import { initializeSessionState } from '../runtime/session-state.js';
import type { EgressSendResult, OctoEgress } from '../runtime/octo-egress.js';
import { CronStore } from './store/index.js';
import type { StoreDatabase } from './store/types.js';
import { resolveCronConfig, type CronConfigInput, type ResolvedCronConfig } from './config.js';
import { CronAdmissionIssuer, CronService, type CronCommandCallerContext } from './service.js';
import {
  CronControlServer,
  CronExecutor,
  CronScheduler,
  defaultCronClock,
  sendControlSocketRequest,
  writeBotStatusSnapshot,
  type BotStatusSnapshotV2,
  type CronStatusSummary,
  type CronTimerClock,
} from './scheduler.js';
import { createAdapter } from '../host/db-adapter.js';
import { SessionStore } from '../host/session-store.js';
import { DEFAULT_CONFIG_PATH, loadConfig, resolveBotConfigs, type Config } from '../host/config.js';

export interface CronCliOptions {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

interface ExtractedCliTarget {
  readonly botId?: string;
  readonly configPath?: string;
  readonly dataDir?: string;
  readonly sessionKey?: string;
  readonly channelId?: string;
  readonly channelType?: 1 | 2 | 5;
  readonly creatorId?: string;
  readonly json: boolean;
  readonly remainingArgs: string[];
}

function parseChannelTypeFlag(raw: string): 1 | 2 | 5 {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'dm' || normalized === 'direct' || normalized === 'todo') return 1;
  if (normalized === '2' || normalized === 'group') return 2;
  if (normalized === '5' || normalized === 'subgroup') return 5;
  throw new Error(`Invalid --channel-type '${raw}' (expected 1|2|5 or dm|group|subgroup)`);
}

function parseSessionKey(sessionKey: string): { channelType: 1 | 2 | 5; channelId: string } {
  const trimmed = sessionKey.trim();
  const octoMatch = /^octo:(todo|group|dm|subgroup):(.+)$/.exec(trimmed);
  if (octoMatch && octoMatch[2]) {
    const channelType =
      octoMatch[1] === 'group' ? 2 : octoMatch[1] === 'subgroup' ? 5 : 1;
    return { channelType, channelId: octoMatch[2] };
  }
  const groupMatch = /^group:(.+)$/.exec(trimmed);
  if (groupMatch && groupMatch[1]) {
    return { channelType: 2, channelId: groupMatch[1] };
  }
  const dmMatch = /^dm:(.+)$/.exec(trimmed);
  if (dmMatch && dmMatch[1]) {
    return { channelType: 1, channelId: dmMatch[1] };
  }
  return { channelType: 1, channelId: trimmed };
}

function extractCliTargetFlags(argv: readonly string[]): ExtractedCliTarget {
  let botId: string | undefined;
  let configPath: string | undefined;
  let dataDir: string | undefined;
  let sessionKey: string | undefined;
  let channelId: string | undefined;
  let channelType: 1 | 2 | 5 | undefined;
  let creatorId: string | undefined;
  let json = false;
  const remainingArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      remainingArgs.push(...argv.slice(i));
      break;
    }
    if (token === '--bot') {
      botId = argv[++i];
      if (!botId) throw new Error('--bot requires a value');
    } else if (token.startsWith('--bot=')) {
      botId = token.slice('--bot='.length);
    } else if (token === '--config') {
      configPath = argv[++i];
      if (!configPath) throw new Error('--config requires a value');
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token === '--data-dir') {
      dataDir = argv[++i];
      if (!dataDir) throw new Error('--data-dir requires a value');
    } else if (token.startsWith('--data-dir=')) {
      dataDir = token.slice('--data-dir='.length);
    } else if (token === '--target-session') {
      sessionKey = argv[++i];
      if (!sessionKey) throw new Error('--target-session requires a value');
    } else if (token.startsWith('--target-session=')) {
      sessionKey = token.slice('--target-session='.length);
    } else if (token === '--session') {
      const next = argv[i + 1];
      if (sessionKey === undefined && next !== undefined && !next.startsWith('-')) {
        sessionKey = argv[++i];
      } else {
        remainingArgs.push(token);
      }
    } else if (token.startsWith('--session=')) {
      sessionKey = token.slice('--session='.length);
    } else if (token === '--channel') {
      channelId = argv[++i];
      if (!channelId) throw new Error('--channel requires a value');
    } else if (token.startsWith('--channel=')) {
      channelId = token.slice('--channel='.length);
    } else if (token === '--channel-type') {
      const val = argv[++i];
      if (!val) throw new Error('--channel-type requires a value');
      channelType = parseChannelTypeFlag(val);
    } else if (token.startsWith('--channel-type=')) {
      channelType = parseChannelTypeFlag(token.slice('--channel-type='.length));
    } else if (token === '--creator') {
      creatorId = argv[++i];
      if (!creatorId) throw new Error('--creator requires a value');
    } else if (token.startsWith('--creator=')) {
      creatorId = token.slice('--creator='.length);
    } else if (token === '--json') {
      json = true;
    } else {
      remainingArgs.push(token);
    }
  }

  return {
    ...(botId !== undefined ? { botId } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(sessionKey !== undefined ? { sessionKey } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(channelType !== undefined ? { channelType } : {}),
    ...(creatorId !== undefined ? { creatorId } : {}),
    json,
    remainingArgs,
  };
}

function reconstructRawArgs(tokens: readonly string[]): string {
  const dashIdx = tokens.indexOf('--');
  const head = dashIdx >= 0 ? tokens.slice(0, dashIdx) : tokens;
  const tail = dashIdx >= 0 ? tokens.slice(dashIdx + 1) : [];
  const quoteToken = (t: string): string => {
    if (t.length === 0) return '""';
    if (/[\s"']/.test(t)) {
      return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return t;
  };
  const headStr = head.map(quoteToken).join(' ');
  if (dashIdx >= 0) {
    return `${headStr} -- ${tail.join(' ')}`.trim();
  }
  return headStr.trim();
}

function resolveTargetBotAndConfig(
  target: ExtractedCliTarget,
  env: NodeJS.ProcessEnv,
): {
  botId: string;
  dataDir: string;
  workingDir: string;
  cronConfig: ResolvedCronConfig;
  botConfig?: Config;
} {
  const defaultCfgPath =
    env.HOME && env.HOME !== process.env.HOME
      ? join(resolve(env.HOME), '.codex-channel-octo', 'config.json')
      : DEFAULT_CONFIG_PATH;
  const cfgPath = target.configPath ?? env.CODEX_OCTO_CONFIG ?? defaultCfgPath;
  if (target.dataDir && !existsSync(cfgPath)) {
    const resolvedDir = resolve(target.dataDir);
    return {
      botId: target.botId ?? 'default',
      dataDir: resolvedDir,
      workingDir: join(resolvedDir, 'workspace'),
      cronConfig: resolveCronConfig(undefined),
    };
  }
  if (existsSync(cfgPath)) {
    const cfg = loadConfig(cfgPath);
    const bots = resolveBotConfigs(cfg);
    const matched = target.botId ? bots.find((b) => (b.botId ?? 'default') === target.botId) : bots[0];
    if (!matched) {
      throw new Error(`Bot '${target.botId ?? 'default'}' not found in ${cfgPath}`);
    }
    const cronConfig = resolveCronConfig(
      matched.cron as CronConfigInput | undefined,
      matched.commands?.managers ?? [],
      Boolean(matched.cron?.explicitManagers),
    );
    return {
      botId: matched.botId ?? 'default',
      dataDir: target.dataDir ? resolve(target.dataDir) : matched.dataDir,
      workingDir: join(matched.dataDir, 'workspace'),
      cronConfig,
      botConfig: matched,
    };
  }
  if (target.dataDir) {
    const resolvedDir = resolve(target.dataDir);
    return {
      botId: target.botId ?? 'default',
      dataDir: resolvedDir,
      workingDir: join(resolvedDir, 'workspace'),
      cronConfig: resolveCronConfig(undefined),
    };
  }
  const fallbackDir = join(dirname(cfgPath), target.botId ?? 'default', 'data');
  return {
    botId: target.botId ?? 'default',
    dataDir: fallbackDir,
    workingDir: join(dirname(fallbackDir), 'workspace'),
    cronConfig: resolveCronConfig(undefined),
  };
}

function extractDeliveryFlag(tokens: readonly string[]): 'announce' | 'none' | undefined {
  const dashIdx = tokens.indexOf('--');
  const head = dashIdx >= 0 ? tokens.slice(0, dashIdx) : tokens;
  for (let i = 0; i < head.length; i += 1) {
    const t = head[i]!;
    if (t === '--delivery') {
      const val = head[i + 1];
      if (val === 'announce' || val === 'none') return val;
    } else if (t === '--delivery=announce') {
      return 'announce';
    } else if (t === '--delivery=none') {
      return 'none';
    }
  }
  return undefined;
}

function buildCliCallerContext(
  subcommand: string,
  target: ExtractedCliTarget,
  cronConfig: ResolvedCronConfig,
): CronCommandCallerContext {
  let channelType: 1 | 2 | 5 = 1;
  let channelId = 'local-operator';
  let sessionKey = 'local-operator';

  if (target.sessionKey) {
    const parsed = parseSessionKey(target.sessionKey);
    channelType = parsed.channelType;
    channelId = parsed.channelId;
    sessionKey = target.sessionKey.trim();
  } else if (target.channelId) {
    channelType = target.channelType ?? 1;
    channelId = target.channelId.trim();
    sessionKey = channelType === 1 ? channelId : `group:${channelId}`;
  } else if (
    (subcommand === 'add' || subcommand === 'remind') &&
    extractDeliveryFlag(target.remainingArgs) === 'announce'
  ) {
    throw new Error(
      '✗ CLI cron add/remind with --delivery announce requires --session <sessionKey> or --channel <id> [--channel-type <1|2|5>]',
    );
  }

  const senderUid = target.creatorId ?? cronConfig.managers[0] ?? 'local-operator';
  return {
    senderUid,
    isOwner: true,
    isCronManager: true,
    isGroup: channelType !== 1,
    sessionKey,
    channelId,
    channelType,
    allowGlobalOperator: true,
  };
}

export async function runCronSubcommand(
  argv: readonly string[],
  options: CronCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => console.log(text));
  const stderr = options.stderr ?? ((text: string) => console.error(text));
  const env = options.env ?? process.env;

  let target: ExtractedCliTarget;
  try {
    target = extractCliTargetFlags(argv);
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }

  const subcommand = (target.remainingArgs[0] ?? '').toLowerCase();
  if (!subcommand) {
    stderr(
      'Usage: codex-buddy cron <list|show|runs|enable|disable|rm|run|add|remind|edit> [--bot <id>] [--data-dir <dir>] [--session <key> | --channel <id> --channel-type <1|2|5>] ...',
    );
    return 2;
  }

  let resolved: ReturnType<typeof resolveTargetBotAndConfig>;
  try {
    resolved = resolveTargetBotAndConfig(target, env);
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }

  let callerCtx: CronCommandCallerContext;
  try {
    callerCtx = buildCliCallerContext(subcommand, target, resolved.cronConfig);
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }

  const tokens = [...target.remainingArgs];
  if (
    subcommand === 'list' &&
    !target.sessionKey &&
    !target.channelId &&
    !tokens.includes('--all-conversations')
  ) {
    tokens.push('--all-conversations');
  }
  if (
    (subcommand === 'add' || subcommand === 'remind') &&
    !target.sessionKey &&
    !target.channelId &&
    extractDeliveryFlag(tokens) === undefined
  ) {
    const dashIdx = tokens.indexOf('--');
    if (dashIdx >= 0) {
      tokens.splice(dashIdx, 0, '--delivery', 'none');
    } else {
      tokens.push('--delivery', 'none');
    }
  }
  const rawArgs = reconstructRawArgs(tokens);
  const socketPath = join(resolved.dataDir, 'control.sock');

  // 1. Try active control.sock first.
  if (existsSync(socketPath)) {
    try {
      const response = await sendControlSocketRequest(socketPath, {
        id: randomUUID(),
        method: 'cron.command',
        params: {
          command: rawArgs,
          sessionKey: callerCtx.sessionKey,
          channelId: callerCtx.channelId,
          channelType: callerCtx.channelType,
          ...(target.creatorId ? { creatorId: target.creatorId } : {}),
        },
      });
      if (response.ok) {
        stdout(response.reply ?? '');
        return 0;
      }
      if (response.reply) {
        stdout(response.reply);
        return 1;
      }
      stderr(response.error ?? 'Control socket error');
      return 1;
    } catch {
      // Fall through to offline DB fallback if socket is stale/not listening.
    }
  }

  // 2. Offline fallback when bot is stopped.
  const isReadOnly = subcommand === 'list' || subcommand === 'show' || subcommand === 'runs';
  const dbPath = join(resolved.dataDir, 'cc-octo.db');
  if (isReadOnly && !existsSync(dbPath)) {
    stdout('No scheduled tasks');
    return 0;
  }

  mkdirSync(resolved.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(resolved.dataDir, 0o700);
  const realDataDir = realpathSync(resolved.dataDir);
  let ownership: BotStartupOwnership | undefined;
  if (!isReadOnly) {
    try {
      ownership = await BotStartupOwnership.acquire(realDataDir, resolved.botId);
    } catch (err) {
      stderr(`Cannot execute offline cron mutation while bot lock is held: ${(err as Error).message}`);
      return 1;
    }
  }

  let adapter: ReturnType<typeof createAdapter> | undefined;
  let sessionStore: SessionStore | undefined;
  try {
    adapter = createAdapter(join(realDataDir, 'cc-octo.db'));
    sessionStore = new SessionStore(adapter);
    let getResetGeneration: (key: string) => number = () => 0;
    let incarnationId = `cli-${process.pid}`;
    if (ownership) {
      const initialized = await initializeSessionState(
        ownership,
        realDataDir,
        resolved.botId,
        adapter,
        sessionStore,
        () => null,
      );
      getResetGeneration = (key) => initialized.state.generation(key);
      incarnationId = ownership.incarnationId;
    }

    const issuer = new CronAdmissionIssuer(
      {
        botId: resolved.botId,
        getOwnerUid: () => callerCtx.senderUid,
        getRegisteredRobotId: () => resolved.botId,
        getIncarnationId: () => incarnationId,
        assertOwnershipHeld: () => {
          if (ownership) assertStartupOwnership(ownership, realDataDir, resolved.botId);
        },
        getResetGeneration,
        getRuntimeGeneration: () => 1,
      },
      resolved.cronConfig,
      defaultCronClock,
    );

    const store = new CronStore(
      adapter as unknown as StoreDatabase,
      defaultCronClock,
      {},
      issuer,
      ownership?.restartBinding,
    );
    const service = new CronService(store, resolved.cronConfig, issuer, defaultCronClock);
    const result = await service.executeSlashCommand(rawArgs, callerCtx);
    stdout(result.reply);
    return result.isError ? 1 : 0;
  } catch (err) {
    stderr((err as Error).message);
    return 1;
  } finally {
    try {
      sessionStore?.close();
    } catch {
      try {
        adapter?.close();
      } catch {
        // ignore
      }
    }
    try {
      ownership?.release();
    } catch {
      // ignore
    }
  }
}

export async function runStatusSubcommand(
  argv: readonly string[],
  options: CronCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => console.log(text));
  const stderr = options.stderr ?? ((text: string) => console.error(text));
  const env = options.env ?? process.env;

  let target: ExtractedCliTarget;
  try {
    target = extractCliTargetFlags(argv);
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }

  const resolved = resolveTargetBotAndConfig(target, env);
  const socketPath = join(resolved.dataDir, 'control.sock');
  const statusJsonPath = join(resolved.dataDir, 'status.json');

  let liveCronSummary: CronStatusSummary | undefined;
  if (existsSync(socketPath)) {
    try {
      const res = await sendControlSocketRequest(socketPath, {
        id: randomUUID(),
        method: 'cron.status',
      });
      if (res.ok && res.status) {
        liveCronSummary = res.status;
      }
    } catch {
      // ignore
    }
  }

  let snapshot: BotStatusSnapshotV2 | undefined;
  if (existsSync(statusJsonPath)) {
    try {
      snapshot = JSON.parse(readFileSync(statusJsonPath, 'utf8')) as BotStatusSnapshotV2;
    } catch {
      // ignore
    }
  }

  if (liveCronSummary && snapshot) {
    snapshot = {
      ...snapshot,
      state: 'running',
      cron: liveCronSummary,
    };
  } else if (!snapshot) {
    const dbPath = join(resolved.dataDir, 'cc-octo.db');
    let totalJobs = 0;
    let enabledJobs = 0;
    let runningRuns = 0;
    let nextWakeAt: number | null = null;
    if (existsSync(dbPath)) {
      const adapter = createAdapter(dbPath);
      try {
        const issuer = new CronAdmissionIssuer(
          {
            botId: resolved.botId,
            getOwnerUid: () => 'local-operator',
            getRegisteredRobotId: () => resolved.botId,
            getIncarnationId: () => `cli-${process.pid}`,
            assertOwnershipHeld: () => {},
            getResetGeneration: () => 0,
            getRuntimeGeneration: () => 1,
          },
          resolved.cronConfig,
          defaultCronClock,
        );
        const store = new CronStore(adapter as unknown as StoreDatabase, defaultCronClock, {}, issuer);
        const scope = { allConversations: true as const };
        totalJobs = store.countJobs(scope, { includeDisabled: true, includeDeleted: false });
        enabledJobs = store.countJobs(scope, { includeDisabled: false, includeDeleted: false });
        const jobs = store.list(scope, { includeDisabled: false, limit: 100 });
        for (const job of jobs) {
          if (job.next_run_at !== null && (nextWakeAt === null || job.next_run_at < nextWakeAt)) {
            nextWakeAt = job.next_run_at;
          }
        }
        const activeRuns = store.listNonTerminalRuns();
        runningRuns = activeRuns.filter((r) => r.status === 'running').length;
      } catch {
        // ignore if db not migrated yet
      } finally {
        adapter.close();
      }
    }
    snapshot = {
      schemaVersion: 2,
      botId: resolved.botId,
      pid: process.pid,
      updatedAt: Date.now(),
      state: liveCronSummary ? 'running' : 'stopped',
      executor: 'app-server',
      cron: liveCronSummary ?? {
        state: resolved.cronConfig.enabled ? 'enabled' : 'disabled',
        ...(resolved.cronConfig.enabled ? {} : { disabledReason: 'config-disabled' }),
        jobs: totalJobs,
        enabled: enabledJobs,
        nextWakeAt,
        running: runningRuns,
        lastErrors: [],
      },
    };
  }

  if (target.json) {
    stdout(JSON.stringify(snapshot, null, 2));
  } else {
    stdout(
      [
        `bot: ${snapshot.botId} (schemaVersion=${snapshot.schemaVersion}, state=${snapshot.state})`,
        `executor: ${snapshot.executor}`,
        `cron: ${snapshot.cron.state} (jobs=${snapshot.cron.jobs}, enabled=${snapshot.cron.enabled}, running=${snapshot.cron.running}, nextWakeAt=${snapshot.cron.nextWakeAt ?? 'none'})`,
      ].join('\n'),
    );
  }
  return 0;
}

export interface DeterministicCronFixtureResult {
  readonly botId: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly socketPath: string;
  readonly createdJobId: string;
  readonly deliveredTexts: readonly string[];
  readonly statusSnapshot: BotStatusSnapshotV2;
  readonly listOutput: string;
  readonly runsOutput: string;
}

/**
 * Self-contained deterministic test fixture for M2 scheduled tasks & notifications.
 * Exercises live CronStore, CronService, CronScheduler, CronControlServer, status.json v2,
 * and deterministic cron delivery end-to-end without external network dependencies.
 */
export async function runDeterministicCronFixture(options: {
  readonly dataDir: string;
  readonly botId?: string;
}): Promise<DeterministicCronFixtureResult> {
  const botId = options.botId ?? 'fixture-bot';
  const rawDataDir = resolve(options.dataDir);
  mkdirSync(rawDataDir, { recursive: true, mode: 0o700 });
  chmodSync(rawDataDir, 0o700);
  const dataDir = realpathSync(rawDataDir);
  const workingDir = join(dataDir, 'workspace');
  mkdirSync(workingDir, { recursive: true, mode: 0o700 });

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

  let currentNowMs = 1_760_000_000_000;
  const clock: CronTimerClock = {
    now: () => currentNowMs,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  const cronConfig = resolveCronConfig(
    {
      enabled: true,
      managers: ['owner-1'],
      defaultTimezone: 'Asia/Shanghai',
    },
    ['owner-1'],
    true,
  );

  const issuer = new CronAdmissionIssuer(
    {
      botId,
      getOwnerUid: () => 'owner-1',
      getRegisteredRobotId: () => botId,
      getIncarnationId: () => ownership.incarnationId,
      assertOwnershipHeld: () => assertStartupOwnership(ownership, dataDir, botId),
      getResetGeneration: (key) => initialized.state.generation(key),
      getRuntimeGeneration: () => 1,
    },
    cronConfig,
    clock,
  );

  const store = new CronStore(
    adapter as unknown as StoreDatabase,
    clock,
    {},
    issuer,
    ownership.restartBinding,
  );

  const refs: { scheduler?: CronScheduler; executor?: CronExecutor } = {};
  const service = new CronService(store, cronConfig, issuer, clock, {
    onWake: () => refs.scheduler?.wake(),
    onCancelActiveRun: (jobId, reason) => refs.executor?.cancelJob(jobId, reason),
  });

  const deliveredTexts: string[] = [];
  const fakeEgress = {
    async sendText(req: { content: string }): Promise<EgressSendResult> {
      deliveredTexts.push(req.content);
      return { deliveredSegments: 1, clientMsgNos: ['k1'], suppressedNoReply: false };
    },
    async sendSegments(req: {
      segments: readonly (string | { content: string })[];
      onSegmentDelivered?: (segmentIndex: number, clientMsgNo: string) => void;
    }): Promise<EgressSendResult> {
      const clientMsgNos: string[] = [];
      for (let i = 0; i < req.segments.length; i += 1) {
        const seg = req.segments[i]!;
        deliveredTexts.push(typeof seg === 'string' ? seg : seg.content);
        const msgNo = `k-${i}`;
        clientMsgNos.push(msgNo);
        req.onSegmentDelivered?.(i, msgNo);
      }
      return {
        deliveredSegments: req.segments.length,
        clientMsgNos,
        suppressedNoReply: false,
      };
    },
  } as unknown as OctoEgress;

  const executor = new CronExecutor({
    botId,
    botName: 'FixtureBot',
    cwdBase: workingDir,
    store,
    config: cronConfig,
    issuer,
    clock,
    egress: fakeEgress,
    getOwnerUid: () => 'owner-1',
    executeIsolatedTurn: async (input) => ({
      kind: 'ok',
      text: `Deterministic cron result for: ${input.prompt}`,
      threadId: 'thread-fixture-1',
      turnId: 'turn-fixture-1',
    }),
    executeSessionTurn: async (input) => ({
      kind: 'ok',
      text: `Deterministic session cron result for: ${input.prompt}`,
      threadId: 'thread-fixture-session-1',
      turnId: 'turn-fixture-session-1',
    }),
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

  const controlServer = new CronControlServer({
    dataDir,
    service,
    scheduler,
    getOwnerUid: () => 'owner-1',
  });

  try {
    await controlServer.start();
    scheduler.start();

    const addRes = await sendControlSocketRequest(controlServer.socketPath, {
      id: randomUUID(),
      method: 'cron.command',
      params: {
        command: 'remind "in 1m" --name "Fixture Reminder" -- Verify staging fixture',
        sessionKey: 'C_FIXTURE',
        channelId: 'C_FIXTURE',
        channelType: 1,
      },
    });
    if (!addRes.ok || !addRes.reply) {
      throw new Error(`Fixture add failed: ${addRes.error ?? addRes.reply ?? 'empty reply'}`);
    }
    const idMatch = /\b(j[23456789abcdefghjkmnpqrstvwxyz]{6})\b/.exec(addRes.reply);
    if (!idMatch?.[1]) {
      throw new Error(`Could not extract jobId from reply: ${addRes.reply}`);
    }
    const createdJobId = idMatch[1];

    currentNowMs += 60_000;
    scheduler.wake();
    // Wait briefly for the asynchronous reminder delivery and run finalization to complete
    for (
      let i = 0;
      i < 100 && (deliveredTexts.length === 0 || store.listNonTerminalRuns().length > 0);
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const statusSnapshot: BotStatusSnapshotV2 = {
      schemaVersion: 2,
      botId,
      pid: process.pid,
      updatedAt: currentNowMs,
      state: 'running',
      executor: 'app-server',
      cron: scheduler.statusSummary(),
    };
    writeBotStatusSnapshot(dataDir, statusSnapshot);
    const statusPath = join(dataDir, 'status.json');
    const persistedSnapshot = JSON.parse(readFileSync(statusPath, 'utf8')) as BotStatusSnapshotV2;

    const listRes = await sendControlSocketRequest(controlServer.socketPath, {
      id: randomUUID(),
      method: 'cron.command',
      params: {
        command: 'list --all --all-conversations',
        sessionKey: 'C_FIXTURE',
        channelId: 'C_FIXTURE',
        channelType: 1,
      },
    });
    const runsRes = await sendControlSocketRequest(controlServer.socketPath, {
      id: randomUUID(),
      method: 'cron.command',
      params: {
        command: `runs ${createdJobId}`,
        sessionKey: 'C_FIXTURE',
        channelId: 'C_FIXTURE',
        channelType: 1,
      },
    });

    return {
      botId,
      dataDir,
      statusPath,
      socketPath: controlServer.socketPath,
      createdJobId,
      deliveredTexts,
      statusSnapshot: persistedSnapshot,
      listOutput: listRes.reply ?? '',
      runsOutput: runsRes.reply ?? '',
    };
  } finally {
    await controlServer.close();
    await scheduler.shutdown();
    const stoppedSummary = scheduler.statusSummary();
    initialized.state.endIncarnation();
    sessionStore.close();
    writeBotStatusSnapshot(dataDir, {
      schemaVersion: 2,
      botId,
      pid: process.pid,
      updatedAt: currentNowMs,
      state: 'stopped',
      executor: 'app-server',
      cron: stoppedSummary,
    });
    ownership.release();
  }
}

function parseStartFlags(argv: readonly string[]): {
  readonly configPath?: string;
  readonly foreground: boolean;
} {
  let configPath: string | undefined;
  let foreground = true;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--foreground' || token === '-f') {
      foreground = true;
    } else if (token === '--config') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) {
        throw new Error('start: --config requires a value');
      }
      configPath = resolve(next);
    } else if (token.startsWith('--config=')) {
      const val = token.slice('--config='.length).trim();
      if (!val) {
        throw new Error('start: --config requires a value');
      }
      configPath = resolve(val);
    } else {
      throw new Error(`start: unknown option '${token}'`);
    }
  }
  return {
    ...(configPath !== undefined ? { configPath } : {}),
    foreground,
  };
}

const CLI_USAGE = [
  'Usage:',
  '  node dist/cron/cli.js cron <list|show|runs|enable|disable|rm|run|add|remind|edit> [options]',
  '  node dist/cron/cli.js status [--bot <id>] [--data-dir <dir>] [--config <path>] [--json]',
  '  node dist/cron/cli.js start [--config <path>] [--foreground]',
  '  node dist/cron/cli.js fixture --data-dir <dir> [--bot <id>]',
].join('\n');

export async function runCli(argv: readonly string[], options: CronCliOptions = {}): Promise<number> {
  const [cmd = '', ...rest] = argv;
  const stdout = options.stdout ?? ((text: string) => console.log(text));
  const stderr = options.stderr ?? ((text: string) => console.error(text));

  if (cmd === 'cron') {
    return runCronSubcommand(rest, options);
  }
  if (cmd === 'status') {
    return runStatusSubcommand(rest, options);
  }
  if (cmd === 'fixture') {
    const target = extractCliTargetFlags(rest);
    const dataDir = target.dataDir ?? join(process.cwd(), '.fixture-cron-data');
    const res = await runDeterministicCronFixture({
      dataDir,
      ...(target.botId ? { botId: target.botId } : {}),
    });
    stdout(JSON.stringify(res, null, 2));
    return 0;
  }
  if (cmd === 'start' || cmd === 'serve' || cmd === 'gateway') {
    let parsedStart: ReturnType<typeof parseStartFlags>;
    try {
      parsedStart = parseStartFlags(rest);
    } catch (err) {
      stderr((err as Error).message);
      return 2;
    }
    const env = options.env ?? process.env;
    const explicitConfigPath =
      parsedStart.configPath ??
      (env.CODEX_OCTO_CONFIG ? resolve(env.CODEX_OCTO_CONFIG) : undefined) ??
      (env.HOME && env.HOME !== process.env.HOME
        ? join(resolve(env.HOME), '.codex-channel-octo', 'config.json')
        : undefined);
    const hostIndexUrl = new URL('../host/index.js', import.meta.url).href;
    const hostModule = (await import(hostIndexUrl)) as {
      main?: (configPath?: string) => Promise<void>;
    };
    if (typeof hostModule.main !== 'function') {
      stderr('[codex-channel-octo] Fatal error: host entrypoint main() is not exported');
      return 1;
    }
    try {
      await hostModule.main(explicitConfigPath);
      return 0;
    } catch (err) {
      stderr(`[codex-channel-octo] Fatal error: ${String(err)}`);
      return 1;
    }
  }
  stderr(CLI_USAGE);
  return 2;
}

function isMainModule(argvPath: string): boolean {
  try {
    const resolvedArgv = pathToFileURL(realpathSync(argvPath)).href;
    const resolvedSelf = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return resolvedArgv === resolvedSelf;
  } catch {
    return import.meta.url === pathToFileURL(resolve(argvPath)).href;
  }
}

const entry = process.argv[1];
if (entry && isMainModule(entry)) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error('codex-buddy:', (err as Error).message);
      process.exit(1);
    });
}
