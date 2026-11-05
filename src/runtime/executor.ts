// SPDX-License-Identifier: Apache-2.0
/** Callable SDK-shaped boundary for an injected queryAgent caller. No host activation. */
import { isDeepStrictEqual } from 'node:util';
import { ExecEventProjector, type ExecEvent } from '../app-server/projection.js';
import { normalizeProcessParams, normalizeTurnParams } from '../app-server/params.js';
import type { CodexOptions, ThreadOptions } from '../app-server/params.js';
import type { AppServerClientOptions } from '../app-server/client.js';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import { EventQueue, runtimeError } from './support.js';
import { BotCodexRuntime } from './runtime.js';
import type { TurnHandle, TurnRequest, RuntimeOptions, RuntimeClient } from './types.js';

export type ExecutorKind = 'sdk' | 'app-server';
export interface ExecutorThread {
  runStreamed(prompt: string): Promise<{ events: AsyncIterable<ExecEvent> }>;
}
export interface QueryExecutor {
  startThread(options?: ThreadOptions): ExecutorThread;
  resumeThread(threadId: string, options?: ThreadOptions): ExecutorThread;
}
export interface AppServerBinding {
  runtime: Pick<BotCodexRuntime, 'openTurn'>;
  /** Host-owned trusted authority, resolved for each run (including recovery). */
  request: Omit<TurnRequest, 'prompt' | 'resumeThreadId' | 'threadParams' | 'turnParams' | 'onThread'>;
  assertCurrent: () => void;
}

export class HostExecutionRefusal extends Error {
  readonly status = 'NO-WRITES';
  constructor(readonly prerequisite: string) { super(`NO-WRITES: ${prerequisite}`); this.name = 'HostExecutionRefusal'; }
}

export function selectExecutor(env: NodeJS.ProcessEnv): ExecutorKind {
  const kind = env.CODEX_OCTO_EXECUTOR ?? 'app-server';
  if (kind !== 'sdk' && kind !== 'app-server') throw new Error('CODEX_OCTO_EXECUTOR must be sdk or app-server');
  return kind;
}

/** Scheduler admission must consume this policy; it never starts under SDK rollback. */
export function executorPolicy(kind: ExecutorKind) {
  return kind === 'sdk' ? { state: 'disabled' as const, disabledReason: 'executor-sdk' as const }
    : { state: 'available' as const };
}

export function createQueryExecutor(options: {
  env: NodeJS.ProcessEnv;
  codex?: CodexOptions;
  sdkFactory?: (options: CodexOptions) => QueryExecutor;
  appServer: (codex: CodexOptions, params: ThreadOptions) => AppServerBinding;
}): QueryExecutor {
  const kind = selectExecutor(options.env);
  // Selection happens once. A failed App Server run never constructs/reexecutes via SDK.
  if (kind === 'sdk') {
    if (!options.sdkFactory) throw new HostExecutionRefusal('sdk-constructor-unavailable');
    return options.sdkFactory(options.codex ?? {});
  }
  const thread = (resumeThreadId: string | undefined, params: ThreadOptions = {}): ExecutorThread => ({
    async runStreamed(prompt) {
      const normalized = normalizeTurnParams(params);
      const binding = options.appServer(options.codex ?? {}, params);
      binding.assertCurrent();
      const request = binding.request;
      return { events: projectedTurn(binding.runtime, { ...request, ...normalized, prompt, resumeThreadId }, binding.assertCurrent) };
    },
  });
  return { startThread: params => thread(undefined, params), resumeThread: (id, params) => thread(id, params) };
}

/** Per-bot callable factory for a host-owned constructor seam and lifecycle hook. */
export function createBotExecutorFactory(options: {
  env: NodeJS.ProcessEnv;
  bin: string;
  ownership: BotStartupOwnership;
  directory: string;
  botId: string;
  clientInfo: RuntimeOptions['client']['clientInfo'];
  vendorPathDirs?: readonly string[];
  runtime?: Omit<RuntimeOptions, 'client' | 'login' | 'clientFactory'>;
  appServerFactory?: (options: AppServerClientOptions, generation: number) => RuntimeClient;
  sdkFactory?: (codex: CodexOptions) => QueryExecutor;
  warn?: (message: string) => void;
}) {
  const env = { ...options.env };
  const kind = selectExecutor(env);
  let runtime: BotCodexRuntime | undefined;
  let processParams: ReturnType<typeof normalizeProcessParams> | undefined;
  let warned = false;
  let stopped = false;
  const clients = new Set<RuntimeClient>();
  return {
    kind, cron: executorPolicy(kind),
    create(codex: CodexOptions, request: AppServerBinding['request'], assertCurrent: () => void): QueryExecutor {
      if (stopped) throw runtimeError('RuntimeUnavailableError', 'executor stopped');
      assertStartupOwnership(options.ownership, options.directory, options.botId);
      assertCurrent();
      return createQueryExecutor({ env, codex, sdkFactory: options.sdkFactory, appServer: (settings, params) => {
        if (stopped) throw runtimeError('RuntimeUnavailableError', 'executor stopped');
        assertStartupOwnership(options.ownership, options.directory, options.botId);
        assertCurrent();
        if (!options.appServerFactory) throw new HostExecutionRefusal('app-server-constructor-unavailable');
        const normalized = normalizeProcessParams(settings, params, env, options.vendorPathDirs);
        if (processParams && !isDeepStrictEqual(normalized, processParams)) throw runtimeError('RuntimeUnavailableError', 'process settings changed; restart the bot');
        if (params.approvalPolicy && params.approvalPolicy !== 'never' && !warned) {
          warned = true; (options.warn ?? console.warn)('approvalPolicy is effectively never in exec-compatible mode');
        }
        if (!runtime) {
          processParams = normalized;
          const client: AppServerClientOptions = { bin: options.bin, args: normalized.args, env: normalized.env, clientInfo: options.clientInfo, lifecycle: options.ownership.lifecycle };
          runtime = new BotCodexRuntime({ ...options.runtime, client, login: normalized.login, clientFactory: generation => {
            assertStartupOwnership(options.ownership, options.directory, options.botId);
            const instance = options.appServerFactory!(client, generation); clients.add(instance); return instance;
          } });
        }
        return { runtime, request, assertCurrent };
      } });
    },
    async shutdown(grace = { interruptGraceMs: 5_000, exitGraceMs: 15_000 }): Promise<void> {
      stopped = true; await runtime?.shutdown(grace);
      await Promise.all([...clients].map(async client => { await client.close({ graceMs: grace.exitGraceMs }); await client.closed; }));
    },
    stats: () => runtime?.stats(),
  };
}

async function* projectedTurn(runtime: AppServerBinding['runtime'], request: TurnRequest, assertCurrent: () => void): AsyncGenerator<ExecEvent> {
  const queue = new EventQueue<ExecEvent>();
  const projector = new ExecEventProjector();
  let handle: TurnHandle | undefined;
  let failure: unknown;
  const push = (event: ExecEvent) => {
    assertCurrent();
    if (!queue.push(event)) throw runtimeError('TurnFailedError', 'executor event buffer overflow');
  };
  // The producer is always collected below, including abandoned consumers.
  const producer = (async () => {
    try {
      handle = runtime.openTurn({ ...request, onThread: threadId => push({ type: 'thread.started', thread_id: threadId }) });
      for await (const n of handle.events) for (const event of projector.project(n)) push(event);
      const result = await handle.done;
      if (result.error) throw runtimeError(result.error.class, result.error.message);
    } catch (error) {
      failure = error;
      if (error instanceof Error && ['ResetCancelledError', 'TurnInterruptedError', 'TurnCeilingError'].includes(error.name)) queue.end(true);
    }
    finally { queue.end(); }
  })();
  try {
    for await (const event of queue) { assertCurrent(); yield event; }
    await producer;
    if (failure) throw failure;
  } finally {
    await handle?.cancel('executor consumer abandoned');
    await producer;
  }
}
